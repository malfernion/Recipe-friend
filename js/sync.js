/**
 * sync.js — two-way sync between the local recipe box and Supabase (M2).
 *
 * Only reconciliation lives here now. Everything else this app asks the
 * server for — books, members, invites, photos, preferences — is data
 * access rather than sync, and moved to api.js.
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
    constructor(store, api, onStatus) {
      this.store = store;
      this.api = api;
      this.onStatus = onStatus || (() => {});
      this.bookId = null;
      this.readOnly = false; // a book we may read and not write (J7.17)
      this.pending = false; // local edits waiting to go up
      this.running = false;
      this.timer = null;
    }

    /** Whose session this is. One copy of it, kept on the api. */
    get userId() {
      return this.api.userId;
    }
    set userId(id) {
      this.api.userId = id;
    }

    status(state, detail) {
      this.onStatus(state, detail);
    }



























    /**
     * What to call a book the app makes for someone rather than one they
     * named themselves — their first (J1.3), and any later replacement for
     * a book that has gone.
     */
    /**
     * Resolve which book this session syncs with, preferring the one the
     * user was last using on this device.
     */
    async resolveBook(userId, preferredId, displayName) {
      this.userId = userId;
      // Kept because a replacement book may have to be named long after
      // sign-in, when only the sync object is to hand.
      this.displayName = displayName || "";
      const books = await this.api.listBooks();
      if (books.length === 0) {
        // The signup trigger normally creates one; make our own if not.
        const book = await this.api.createBook(global.RecipeApi.ownBookName(displayName));
        this.bookId = book.id;
        return this.bookId;
      }
      const preferred = preferredId && books.find((b) => b.id === preferredId);
      const owned = books.find((b) => b.isOwner);
      this.bookId = (preferred || owned || books[0]).id;
      return this.bookId;
    }

    /**
     * The row a copy of this recipe would be, with its photo already
     * filed under the copy's own id.
     *
     * Copying and moving differ only in what happens to the original
     * afterwards, so the whole of the interesting part is here. A recipe
     * belongs to the book it was created in (006), so both make a new
     * recipe rather than relocating this one — which is also why the copy
     * needs an id of its own before anything else can happen.
     *
     * `forMove` is the difference in appetite between the two: a move is
     * about to remove the original, so it insists the server has the row
     * to tombstone and treats a photo that will not come across as a
     * reason to stop. A copy risks nothing by going without one, and says
     * so instead.
     */
    async prepareCopy(recipeId, targetBookId, { forMove = false } = {}) {
      // A recipe typed seconds ago may still be inside the push debounce
      // with no row on the server yet, and a move is about to ask the
      // server to tombstone it. Read the local copy afterwards, since the
      // sync may have changed it.
      if (this.pending) await this.syncNow();
      const local = this.store.getById(recipeId);
      if (!local) throw new Error("that recipe is not here");

      // A move needs the original to be there to tombstone, so it is
      // checked before any file is touched: a move that cannot happen
      // must not leave a stray photo in the other book. The server's own
      // data becomes the base, so an edit made on another device travels.
      let base = local;
      if (forMove) {
        const row = await this.api.readRecipeData(recipeId);
        if (!row) throw new Error("that recipe hasn't reached the server yet");
        base = { ...(row.data || local), id: recipeId };
      }

      const photoRequired = forMove;
      const newId = global.RecipeStore.newId();
      const oldPath = local.imagePath || "";
      const newPath = oldPath ? `${targetBookId}/${newId}.jpg` : "";
      let photoCopied = Boolean(oldPath);
      if (oldPath) {
        try {
          await this.api.copyPhoto(oldPath, newPath);
        } catch (err) {
          if (photoRequired) throw err;
          console.warn("Recipe Friend: the copy goes without its photo.", err);
          photoCopied = false;
        }
      }

      return {
        newId,
        oldPath,
        photoCopied,
        data: {
          ...base,
          id: newId,
          imagePath: photoCopied ? newPath : "",
          // A copy carries the recipe, not your relationship to it, and
          // not where it came from either (J6.5).
          favorite: false,
          sharedFrom: "",
          updatedAt: Date.now(),
        },
      };
    }

    /**
     * Put a copy of this recipe in another book, leaving this one alone.
     * The target book's local cache is not touched — it picks the copy up
     * the next time it is opened.
     */
    async copyRecipe(recipeId, targetBookId) {
      const { newId, data, photoCopied } = await this.prepareCopy(recipeId, targetBookId);
      await this.api.insertRecipe(targetBookId, newId, data);
      return { newId, photoCopied };
    }

    /**
     * Move a recipe to another book. The server does both halves or
     * neither, and refuses unless you own the book it is leaving (006).
     *
     * The caller tombstones the original locally afterwards. That is the
     * whole point of the rebuild: the id being tombstoned is genuinely
     * finished, so the delete can travel to the other members of the book
     * instead of their caches pushing the recipe back.
     */
    async moveRecipe(recipeId, targetBookId) {
      const fromBookId = this.bookId;
      const { newId, data, oldPath } = await this.prepareCopy(recipeId, targetBookId, {
        forMove: true,
      });
      await this.api.moveRecipe(recipeId, targetBookId, newId, data);

      // Only now is the old file safe to drop: until the move went
      // through, it was still the photo the recipe pointed at. A leftover
      // file costs a little quota, so a failure here isn't worth failing
      // a move that has already happened.
      if (oldPath) {
        try {
          await this.api.deletePhoto(fromBookId, recipeId);
        } catch (err) {
          console.warn("Recipe Friend: the moved recipe's old photo is left behind.", err);
        }
      }
      return { newId, photoCopied: true };
    }







    /**
     * Point sync at a different book; the caller swaps the local cache.
     * Whether we may write to it travels with it, because the answer is
     * per book, not per person.
     */
    setBook(bookId, { readOnly = false } = {}) {
      clearTimeout(this.timer);
      this.bookId = bookId;
      this.readOnly = readOnly;
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
        const rows = await this.api.fetchRecipes(this.bookId);

        const { recipes, tombstones, toPush } = this.merge(rows);
        this.store.applyMerge(recipes, tombstones);

        const pushed = this.readOnly ? 0 : toPush.length;
        if (pushed > 0) await this.api.pushRecipes(toPush);

        this.status("synced", { pushed, pulled: rows.length });
        return { pushed, pulled: rows.length };
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
      // Nothing local is going up from a book we can only read, and
      // trying is worse than not trying: the push fails on row-level
      // security, the status line parks on "Sync paused — will retry",
      // and read-only looks broken rather than restricted (J7.17).
      if (!this.bookId || this.readOnly) return;
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
