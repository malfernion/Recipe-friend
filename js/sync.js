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

    /** Resolve which book this session syncs with (M3 adds switching). */
    async resolveBook(userId) {
      this.userId = userId;
      const { data, error } = await this.client
        .from("book_members")
        .select("book_id, role")
        .eq("user_id", userId);
      if (error) throw error;
      if (!data || data.length === 0) {
        // The signup trigger normally creates one; make our own if not.
        const { data: book, error: bookErr } = await this.client
          .from("books")
          .insert({ name: "My recipes", owner: userId })
          .select("id")
          .single();
        if (bookErr) throw bookErr;
        const { error: memberErr } = await this.client
          .from("book_members")
          .insert({ book_id: book.id, user_id: userId, role: "owner" });
        if (memberErr) throw memberErr;
        this.bookId = book.id;
        return this.bookId;
      }
      const owned = data.find((m) => m.role === "owner");
      this.bookId = (owned || data[0]).book_id;
      return this.bookId;
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
