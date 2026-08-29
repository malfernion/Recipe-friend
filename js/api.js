/**
 * api.js — everything this app asks the server for.
 *
 * Books, members, invites, photos and profile preferences: all of it is
 * data access, and none of it is sync. It lived on RecipeSync because that
 * is where the Supabase client happened to be, which left books.js
 * reaching through an object called "sync" to mint an invite.
 *
 * Recipe reconciliation — the part that is genuinely about syncing, and
 * genuinely hard — stays in sync.js and calls through here.
 *
 * Nothing in this file knows about the local store, timers or status: it
 * takes arguments and returns rows.
 */
(function (global) {
  "use strict";

  const PHOTO_BUCKET = "recipe-photos";

  class RecipeApi {
    constructor(client) {
      this.client = client;
      this.userId = null;
    }

    /** The name a person's own first book gets: "Dave's recipes". */
    static ownBookName(displayName) {
      const who = String(displayName || "").trim().slice(0, 60);
      return who ? `${who}'s recipes` : "Recipes";
    }

    // --- recipes: the rows sync.js reconciles ---------------------------

    /** Every row in a book, tombstones included. */
    async fetchRecipes(bookId) {
      const { data, error } = await this.client
        .from("recipes")
        .select("id, data, updated_at, deleted_at")
        .eq("book_id", bookId);
      if (error) throw error;
      return data || [];
    }

    /** Send rows up. Upsert, so a push is safe to repeat. */
    async pushRecipes(rows) {
      const { error } = await this.client.from("recipes").upsert(rows);
      if (error) throw error;
    }

    /** The server's own copy of a recipe's data, or null if it has none. */
    async readRecipeData(recipeId) {
      const { data, error } = await this.client
        .from("recipes")
        .select("data")
        .eq("id", recipeId)
        .maybeSingle();
      if (error) throw error;
      return data;
    }

    /** Patch one row; returns how many it actually changed. */
    async patchRecipe(recipeId, patch) {
      const { data, error } = await this.client
        .from("recipes")
        .update(patch)
        .eq("id", recipeId)
        .select("id");
      if (error) throw error;
      return (data || []).length;
    }

    /**
     * Put a new recipe straight into another book, without disturbing the
     * local cache of the book we are looking at. The target book's cache
     * picks it up the next time it is opened.
     */
    async insertRecipe(bookId, id, data) {
      const { error } = await this.client
        .from("recipes")
        .insert({ id, book_id: bookId, data, updated_at: new Date().toISOString() });
      if (error) throw error;
      return id;
    }

    /**
     * Move a recipe to another book: one server-side step that inserts
     * the copy and tombstones the original, or does neither (006).
     * Refused unless you own the book it is leaving.
     */
    async moveRecipe(recipeId, targetBookId, newId, data) {
      const { data: moved, error } = await this.client.rpc("move_recipe", {
        recipe_id: recipeId,
        target_book: targetBookId,
        new_id: newId,
        new_data: data,
      });
      if (error) throw error;
      return moved || newId;
    }

    /** Copy a stored photo to a new path, e.g. when a recipe changes book. */
    async copyPhoto(fromPath, toPath) {
      const { error } = await this.client.storage.from(PHOTO_BUCKET).copy(fromPath, toPath);
      if (error) throw error;
    }

    // --- books and membership ------------------------------------------

    /**
     * Every book this user belongs to: [{id, name, role, isOwner}].
     *
     * `isOwner` comes from books.owner, never from the membership row's
     * `role`. Ownership is what the server actually enforces, and reading
     * it from the same place the policies do means the UI cannot be talked
     * into showing — or hiding — the wrong controls.
     */
    async listBooks() {
      const { data, error } = await this.client
        .from("book_members")
        .select("book_id, role, books(name, owner)")
        .eq("user_id", this.userId);
      if (error) throw error;
      return (data || []).map((m) => ({
        id: m.book_id,
        role: m.role,
        name: (m.books && m.books.name) || "Recipes",
        isOwner: Boolean(m.books && m.books.owner === this.userId),
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
      return { id: book.id, name: book.name, role: "owner", isOwner: true };
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

    // --- invites --------------------------------------------------------

    /**
     * Mint an invite code. Generated client-side so it is URL-safe — the
     * column default is base64, which can contain "+" and "/".
     *
     * An invite is a bearer token: whoever holds the link gets write access
     * to the book. So it is good for one join by default, and the server
     * counts uses rather than trusting this.
     */
    async createInvite(bookId, maxUses = 1) {
      const bytes = new Uint8Array(12);
      if (!global.crypto || !global.crypto.getRandomValues) {
        // No CSPRNG means a guessable invite. Refuse rather than mint one.
        throw new Error("this browser cannot generate a secure invite code");
      }
      global.crypto.getRandomValues(bytes);
      const code = btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      const { error } = await this.client
        .from("invites")
        .insert({
          code,
          book_id: bookId,
          created_by: this.userId,
          max_uses: Math.min(50, Math.max(1, Math.round(maxUses) || 1)),
        });
      if (error) throw error;
      return code;
    }

    /** Live invites for a book, newest first — owners only, by policy. */
    async listInvites(bookId) {
      const { data, error } = await this.client
        .from("invites")
        .select("code, expires_at, used_count, max_uses")
        .eq("book_id", bookId)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []).map((i) => ({
        code: i.code,
        expiresAt: i.expires_at,
        usedCount: i.used_count,
        maxUses: i.max_uses,
      }));
    }

    /** Tear up an invite that hasn't been used yet (or has been). */
    async revokeInvite(code) {
      const { error } = await this.client.from("invites").delete().eq("code", code);
      if (error) throw error;
    }

    /**
     * What an invite is offering, without accepting it. The holder has no
     * read access to the book yet, so this goes through a definer function
     * that returns only what is needed to decide.
     */
    async previewInvite(code) {
      const { data, error } = await this.client.rpc("preview_invite", { invite_code: code });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error("invalid or expired invite");
      return {
        bookName: row.book_name,
        ownerName: row.owner_name,
        alreadyMember: Boolean(row.already_member),
      };
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

    // --- photos in Storage ----------------------------------------------

    /**
     * Put a recipe photo in Storage and return its path. Keyed by book and
     * recipe, so re-saving replaces the old file rather than accumulating
     * orphans. The bucket is private, so a path — not a URL — is what gets
     * stored on the recipe; readable links are minted on demand below.
     */
    async uploadPhoto(bookId, recipeId, blob) {
      const path = `${bookId}/${recipeId}.jpg`;
      const { error } = await this.client.storage
        .from(PHOTO_BUCKET)
        .upload(path, blob, { contentType: "image/jpeg", upsert: true, cacheControl: "3600" });
      if (error) throw error;
      return path;
    }

    /**
     * A short-lived readable URL for a stored photo. Only members of the
     * owning book can mint one, and it expires, so nothing about a photo
     * is permanently public.
     */
    async signedPhotoUrl(path, expiresInSeconds = 3600) {
      const { data, error } = await this.client.storage
        .from(PHOTO_BUCKET)
        .createSignedUrl(path, expiresInSeconds);
      if (error) throw error;
      return data.signedUrl;
    }

    /** Remove a recipe's photo. Best effort — a leftover file is harmless. */
    async deletePhoto(bookId, recipeId) {
      const { error } = await this.client.storage
        .from(PHOTO_BUCKET)
        .remove([`${bookId}/${recipeId}.jpg`]);
      if (error) throw error;
    }

    // --- the person's own profile ----------------------------------------

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
  }

  global.RecipeApi = RecipeApi;
})(window);
