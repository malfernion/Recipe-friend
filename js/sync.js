/**
 * sync.js — two-way sync between the local recipe box and Supabase (M2).
 *
 * Model: localStorage stays the working copy so the app renders instantly
 * and works offline; the server is the shared truth between devices.
 * Reconciliation is last-write-wins per recipe, comparing the local
 * `updatedAt` against the row's `updated_at`. Deletes travel as tombstones
 * (a row with `deleted_at` set) so a delete on one device isn't undone by
 * another device's stale cache.
 *
 * Signed out, nothing here runs and the app is purely local.
 */
(function (global) {
  "use strict";

  const PUSH_DEBOUNCE_MS = 1200;
  const PHOTO_BUCKET = "recipe-photos";

  const toMillis = (iso) => (iso ? new Date(iso).getTime() : 0);
  const toIso = (ms) => new Date(ms || Date.now()).toISOString();

  class RecipeSync {
    constructor(store, client, onStatus) {
      this.store = store;
      this.client = client;
      this.onStatus = onStatus || (() => {});
      this.bookId = null;
      this.userId = null;
      this.pending = false; // local edits waiting to go up
      this.running = false;
      this.timer = null;
    }

    status(state, detail) {
      this.onStatus(state, detail);
    }

    /** Every book this user belongs to: [{id, name, role}]. */
    async listBooks() {
      const { data, error } = await this.client
        .from("book_members")
        .select("book_id, role, books(name)")
        .eq("user_id", this.userId);
      if (error) throw error;
      return (data || []).map((m) => ({
        id: m.book_id,
        role: m.role,
        name: (m.books && m.books.name) || "Recipes",
      }));
    }

    /** Create a book owned by this user and join it. */
    async createBook(name) {
      const { data: book, error } = await this.client
        .from("books")
        .insert({ name: String(name).trim().slice(0, 80) || "Recipes", owner: this.userId })
        .select("id, name")
        .single();
      if (error) throw error;
      const { error: memberErr } = await this.client
        .from("book_members")
        .insert({ book_id: book.id, user_id: this.userId, role: "owner" });
      if (memberErr) throw memberErr;
      return { id: book.id, name: book.name, role: "owner" };
    }

    async renameBook(bookId, name) {
      const { error } = await this.client
        .from("books")
        .update({ name: String(name).trim().slice(0, 80) })
        .eq("id", bookId);
      if (error) throw error;
    }

    /** Everyone in a book, with display names where visible. */
    async listMembers(bookId) {
      const { data, error } = await this.client
        .from("book_members")
        .select("user_id, role, profiles(display_name)")
        .eq("book_id", bookId);
      if (error) throw error;
      return (data || []).map((m) => ({
        userId: m.user_id,
        role: m.role,
        name: (m.profiles && m.profiles.display_name) || "Someone",
        isMe: m.user_id === this.userId,
      }));
    }

    /**
     * Mint an invite code. Generated client-side so it is URL-safe — the
     * column default is base64, which can contain "+" and "/".
     */
    async createInvite(bookId) {
      const bytes = new Uint8Array(12);
      (global.crypto || {}).getRandomValues
        ? global.crypto.getRandomValues(bytes)
        : bytes.forEach((_, i) => (bytes[i] = Math.floor(Math.random() * 256)));
      const code = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      const { error } = await this.client
        .from("invites")
        .insert({ code, book_id: bookId, created_by: this.userId });
      if (error) throw error;
      return code;
    }

    /** Join a book from an invite code (validated server-side). */
    async redeemInvite(code) {
      const { data, error } = await this.client.rpc("redeem_invite", { invite_code: code });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error("invalid or expired invite");
      return { id: row.book_id, name: row.book_name };
    }

    async leaveBook(bookId) {
      const { error } = await this.client
        .from("book_members")
        .delete()
        .eq("book_id", bookId)
        .eq("user_id", this.userId);
      if (error) throw error;
    }

    /** How many live recipes a book holds — used to warn before deleting. */
    async countRecipes(bookId) {
      const { data, error } = await this.client
        .from("recipes")
        .select("id")
        .eq("book_id", bookId)
        .is("deleted_at", null);
      if (error) throw error;
      return (data || []).length;
    }

    /**
     * Delete a book. Its recipes, members and invites cascade away in the
     * database, so this destroys the collection for everyone in it.
     */
    async deleteBook(bookId) {
      const { error } = await this.client.from("books").delete().eq("id", bookId);
      if (error) throw error;
    }

    async removeMember(bookId, userId) {
      const { error } = await this.client
        .from("book_members")
        .delete()
        .eq("book_id", bookId)
        .eq("user_id", userId);
      if (error) throw error;
    }

    /**
     * Resolve which book this session syncs with, preferring the one the
     * user was last using on this device.
     */
    async resolveBook(userId, preferredId, displayName) {
      this.userId = userId;
      const books = await this.listBooks();
      if (books.length === 0) {
        // The signup trigger normally creates one; make our own if not.
        const who = String(displayName || "").trim().slice(0, 60);
        const book = await this.createBook(who ? `${who}'s recipes` : "Recipes");
        this.bookId = book.id;
        return this.bookId;
      }
      const preferred = preferredId && books.find((b) => b.id === preferredId);
      const owned = books.find((b) => b.role === "owner");
      this.bookId = (preferred || owned || books[0]).id;
      return this.bookId;
    }

    /**
     * Move a recipe into another book. The row keeps its id and simply
     * changes book — RLS allows it because the check runs against both the
     * old and the new book, and you must belong to both.
     */
    async moveRecipe(recipeId, targetBookId) {
      const { error } = await this.client
        .from("recipes")
        .update({ book_id: targetBookId, updated_at: new Date().toISOString() })
        .eq("id", recipeId);
      if (error) throw error;
    }

    /**
     * Put a recipe photo in Storage and return its public URL. Keyed by
     * book and recipe, so re-saving a photo replaces the old one rather
     * than accumulating orphans.
     */
    async uploadPhoto(bookId, recipeId, blob) {
      const path = `${bookId}/${recipeId}.jpg`;
      const { error } = await this.client.storage
        .from(PHOTO_BUCKET)
        .upload(path, blob, { contentType: "image/jpeg", upsert: true, cacheControl: "3600" });
      if (error) throw error;
      const { data } = this.client.storage.from(PHOTO_BUCKET).getPublicUrl(path);
      // Cache-bust so a replaced photo doesn't show the old one.
      return `${data.publicUrl}?v=${Date.now().toString(36)}`;
    }

    /** Remove a recipe's photo. Best effort — a leftover file is harmless. */
    async deletePhoto(bookId, recipeId) {
      const { error } = await this.client.storage
        .from(PHOTO_BUCKET)
        .remove([`${bookId}/${recipeId}.jpg`]);
      if (error) throw error;
    }

    /** Point sync at a different book; the caller swaps the local cache. */
    setBook(bookId) {
      clearTimeout(this.timer);
      this.bookId = bookId;
    }

    /** The signed-in user's stored unit preferences, or null if unset. */
    async pullPrefs() {
      const { data, error } = await this.client
        .from("profiles")
        .select("unit_prefs")
        .eq("user_id", this.userId);
      if (error) throw error;
      const row = data && data[0];
      return (row && row.unit_prefs) || null;
    }

    /** Preferences follow the person, not the recipe book. */
    async pushPrefs(prefs) {
      const { error } = await this.client
        .from("profiles")
        .update({ unit_prefs: { mass: prefs.mass || "", volume: prefs.volume || "" } })
        .eq("user_id", this.userId);
      if (error) throw error;
    }

    /**
     * Merge server rows with the local box, then push whatever the server
     * is missing or has an older copy of.
     */
    async syncNow() {
      if (!this.bookId || this.running) return;
      this.running = true;
      this.pending = false;
      this.status("syncing");
      try {
        const { data: rows, error } = await this.client
          .from("recipes")
          .select("id, data, updated_at, deleted_at")
          .eq("book_id", this.bookId);
        if (error) throw error;

        const { recipes, tombstones, toPush } = this.merge(rows || []);
        this.store.applyMerge(recipes, tombstones);

        if (toPush.length > 0) {
          const { error: pushErr } = await this.client.from("recipes").upsert(toPush);
          if (pushErr) throw pushErr;
        }
        this.status("synced", { pushed: toPush.length, pulled: (rows || []).length });
        return { pushed: toPush.length, pulled: (rows || []).length };
      } catch (err) {
        console.warn("Recipe Friend: sync failed.", err);
        this.pending = true; // retry on the next local change or sign-in
        this.status("error", err && err.message);
        return null;
      } finally {
        this.running = false;
      }
    }

    /**
     * Pure reconciliation: for each id, the most recently touched version
     * wins, whether that's a local edit, a remote edit, or either side's
     * delete.
     */
    merge(rows) {
      const local = new Map();
      for (const r of this.store.recipes) local.set(r.id, { at: r.updatedAt || 0, recipe: r });
      const localDeleted = new Map();
      for (const t of this.store.tombstones) localDeleted.set(t.id, t.deletedAt || 0);

      const remote = new Map();
      for (const row of rows) {
        const deletedAt = toMillis(row.deleted_at);
        remote.set(row.id, {
          at: Math.max(toMillis(row.updated_at), deletedAt),
          deleted: Boolean(row.deleted_at),
          data: row.data,
        });
      }

      const ids = new Set([...local.keys(), ...localDeleted.keys(), ...remote.keys()]);
      const recipes = [];
      const tombstones = [];
      const toPush = [];

      for (const id of ids) {
        const l = local.get(id);
        const lDel = localDeleted.get(id);
        const localAt = Math.max(l ? l.at : 0, lDel || 0);
        const localIsDelete = (lDel || 0) > (l ? l.at : 0);
        const r = remote.get(id);
        const remoteAt = r ? r.at : 0;

        if (localAt >= remoteAt) {
          // Local wins (or the server has never seen this recipe).
          if (localIsDelete) {
            tombstones.push({ id, deletedAt: lDel });
            if (!r || !r.deleted) {
              toPush.push({
                id,
                book_id: this.bookId,
                data: (l && l.recipe) || { name: "", ingredients: [], steps: [] },
                updated_at: toIso(lDel),
                deleted_at: toIso(lDel),
              });
            }
          } else if (l) {
            recipes.push(l.recipe);
            if (!r || remoteAt < l.at) {
              toPush.push({
                id,
                book_id: this.bookId,
                data: l.recipe,
                updated_at: toIso(l.at),
                deleted_at: null,
              });
            }
          }
        } else {
          // Server wins.
          if (r.deleted) {
            tombstones.push({ id, deletedAt: r.at });
          } else {
            const recipe = global.RecipeStore.sanitizeRecipe({ ...r.data, id });
            if (recipe) {
              recipe.updatedAt = r.at;
              recipes.push(recipe);
            }
          }
        }
      }

      // Newest first, matching how the app lists recipes.
      recipes.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return { recipes, tombstones, toPush };
    }

    /** Local edit happened: coalesce rapid changes into one round trip. */
    schedulePush() {
      if (!this.bookId) return;
      this.pending = true;
      this.status("pending");
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.syncNow(), PUSH_DEBOUNCE_MS);
    }

    stop() {
      clearTimeout(this.timer);
      this.bookId = null;
      this.userId = null;
    }
  }

  global.RecipeSync = RecipeSync;
})(window);
