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
 * The book's plan syncs here too, on the same trip and the same status
 * line, and reconciles differently because it is a different shape: one
 * live row per book merged per item (J12.11), and an insert-only archive
 * of the plans that were finished, reconciled by comparing ids (J14.1).
 *
 * Signed out, nothing here runs and the app is purely local.
 */
(function (global) {
  "use strict";

  const PUSH_DEBOUNCE_MS = 1200;

  const toMillis = (iso) => (iso ? new Date(iso).getTime() : 0);
  const toIso = (ms) => new Date(ms || Date.now()).toISOString();

  /**
   * May we write to this book? The same question `BooksUI.canEdit` asks,
   * asked here because `resolveBook` has the answer in its hands one
   * whole sync before the books UI gets round to it (J7.17).
   */
  function canWrite(book) {
    return Boolean(book && (book.isOwner || book.role === "owner" || book.role === "editor"));
  }

  /**
   * Is the plan we ended up with the one the server already holds?
   *
   * Compared in full rather than on a timestamp. A merge can produce
   * something neither side had — my ✗ on the onions and your ✓ on the
   * tomatoes — and the newest stamp in it may well be yours, so "is mine
   * newer than theirs" answers no and the onions never leave this phone.
   */
  function samePlan(a, b) {
    return Boolean(a) && Boolean(b) && digest(a) === digest(b);
  }

  function digest(plan) {
    const meals = plan.meals
      .map((m) => [m.id, m.recipeId, m.name, m.portions, m.multiplier, m.addedAt].join(":"))
      .sort();
    const settled = Object.keys(plan.settled || {})
      .sort()
      .map((key) => {
        const entry = plan.settled[key] || {};
        return ["have", "got"]
          .map((f) => (entry[f] ? `${f}=${entry[f].amount}@${entry[f].at}` : ""))
          .join(",");
      });
    // `createdAt` is in here because it is the generation the merge
    // decides on, not decoration: two copies of one id that disagree
    // about when it began are not the same plan to `mergePlans`, and
    // leaving it out would call them identical and never push the fix up.
    return JSON.stringify([
      plan.id,
      plan.createdAt,
      plan.updatedAt,
      plan.completedAt,
      meals,
      settled,
    ]);
  }

  class RecipeSync {
    constructor(store, api, onStatus, planStore) {
      this.store = store;
      this.api = api;
      this.onStatus = onStatus || (() => {});
      // Optional, and absent everywhere plans are not in play — a share
      // link, the tests that only care about recipes. Everything to do
      // with plans below is a no-op without it.
      this.planStore = planStore || null;
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
        this.readOnly = false; // our own, so ours to write in
        return this.bookId;
      }
      const preferred = preferredId && books.find((b) => b.id === preferredId);
      const owned = books.find((b) => b.isOwner);
      const chosen = preferred || owned || books[0];
      this.bookId = chosen.id;
      // Whether we may write to this book is settled here rather than
      // left to `BooksUI.applyRole`, which runs on a refresh that comes
      // *after* the first sync. A device whose role was taken down to
      // viewer since it last ran holds a plan of its own and pushes it on
      // that first trip, row-level security refuses it, and the status
      // line parks on "Sync paused — will retry": read-only looking
      // broken rather than restricted, which is the one thing J7.17 says
      // not to do (J12.10). The book list is already in hand here, and it
      // carries the answer.
      this.readOnly = !canWrite(chosen);
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
      // Each book keeps its own plan, so switching books switches plans
      // (J12.3). It is done here rather than left to every caller because
      // a plan pointed at the wrong book is a shopping list for somebody
      // else's week.
      if (this.planStore) this.planStore.useBook(bookId);
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

        const plans = await this.syncPlans();

        this.status("synced", { pushed, pulled: rows.length, plans });
        return { pushed, pulled: rows.length, plans };
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

    // -------------------------------------------------------------------
    // The plan (J12, J13, J14)
    // -------------------------------------------------------------------

    /**
     * Reconcile this book's plan, and the plans it has finished.
     *
     * Two halves, and they are reconciled differently on purpose. The live
     * plan is one row (007) and merges with `RecipePlan.mergePlans` —
     * meals whole, settled amounts per item, because a shopping list has
     * two people in one aisle (J12.11). The archive is insert-only, so
     * reconciling it is comparing two sets of ids: nothing there can be
     * edited, so nothing there can be stale.
     *
     * Runs inside `syncNow`, on the same debounce and the same status
     * line as everything else. A second timer would have meant a second
     * "Syncing…", two things to fail independently, and a plan that was
     * saved when the recipes were not.
     */
    async syncPlans() {
      if (!this.planStore || !this.bookId) return null;

      const row = await this.api.fetchLivePlan(this.bookId);
      const remote = row ? global.RecipePlanStore.sanitizePlan(row.data) : null;
      let plan = global.RecipePlan.mergePlans(this.planStore.plan, remote);
      let archived = null;

      // A live plan carrying `completedAt` is a completion that got half
      // way: the plan was recorded, and the empty one that should have
      // replaced it never landed. Anybody who *can write* may finish the
      // job, and doing so is safe from any number of devices at once,
      // because recording a plan is keyed by the book and the plan's own
      // id (007) and the plan that replaces it is a later generation than
      // the one it replaces. Left alone it would be a finished plan that
      // the book goes on shopping for.
      //
      // A viewer leaves it exactly as it is (J12.10). Finishing the job
      // is two writes they are not allowed to make, and doing the local
      // half alone would put them on a fresh generation of their own
      // that they can never push — an empty list on their phone while
      // the household is still shopping from the one the book holds.
      if (plan && plan.completedAt && !this.readOnly) {
        archived = plan;
        plan = global.RecipePlan.emptyPlan(global.RecipePlan.generationAfter(plan));
      }

      // Archived plans: what each side has that the other has not.
      const serverIds = await this.api.fetchArchivedPlanIds(this.bookId);
      const onServer = new Set(serverIds);

      // The server is the shared record of what this book has finished,
      // and the only local additions to it are plans this device has
      // recorded and not yet got up. A plan held here that the server
      // does not have and that this device does not owe is one somebody
      // took back with Undo (J14.2): keeping it would put it on the next
      // push and hand their Undo straight back to them, because an
      // insert-only archive has no tombstone to argue with. That was the
      // whole hole in "Undo needs the network" — reaching the server is
      // not enough if the other phone had already pulled the record.
      const here = new Map();
      for (const mine of this.planStore.archive) {
        if (onServer.has(mine.id) || this.planStore.owes(mine.id)) here.set(mine.id, mine);
      }
      if (archived) {
        here.set(archived.id, archived);
        this.planStore.owe(archived.id);
      }

      const missingHere = serverIds.filter((id) => !here.has(id));
      for (const fetched of await this.api.fetchArchivedPlans(this.bookId, missingHere)) {
        const clean = global.RecipePlanStore.sanitizeArchived(fetched.data);
        if (clean) here.set(clean.id, clean);
      }

      this.planStore.applyMerge(plan, [...here.values()]);

      // Nothing local goes up from a book we may only read (J12.10,
      // J7.17). It would be refused, and a refused push parks the status
      // line on "Sync paused" and makes read-only look broken.
      if (this.readOnly) return { pushed: 0, pulled: missingHere.length, live: "read" };

      // The record first, the live row second, and that order is the whole
      // of what makes a half-finished Done safe. Recording a plan and then
      // failing to clear it leaves a plan that is on the record and still
      // live, which the next sync — this one's, or the other phone's —
      // finishes above. Clearing it and then failing to record it would
      // leave a week that quietly never happened, which nothing can
      // recover, because there is nothing left to recover it from (J14.1
      // against J14.4).
      let pushed = 0;
      for (const mine of this.planStore.archive) {
        if (onServer.has(mine.id)) {
          this.planStore.settleOwed(mine.id);
          continue;
        }
        if (!this.planStore.owes(mine.id)) continue;
        if (await this.api.insertArchivedPlan(this.bookId, mine)) pushed++;
        // Either it went up or the book already had it. A throw leaves
        // the debt standing, so an offline Done is retried (J9.5).
        this.planStore.settleOwed(mine.id);
      }

      // A book nobody has planned in yet needs no row saying so.
      const blank = plan.meals.length === 0 && Object.keys(plan.settled).length === 0;
      const live = (!remote && blank) || samePlan(plan, remote) ? "unchanged" : "pushed";
      if (live === "pushed") await this.api.pushLivePlan(this.bookId, plan);
      return { pushed, pulled: missingHere.length, live };
    }

    /**
     * Done: the plan is recorded and an empty one takes its place (J14.1).
     *
     * Two writes, and they happen the way every other local change here
     * does — the device's own copy first, the server on the usual
     * debounce — because the plan has to work with no network at all
     * (J12.12), and the supermarket is where a plan is most likely to be
     * finished and least likely to have signal.
     *
     * That is safe rather than optimistic, and it is worth saying why,
     * because J7.11 says a move that did not reach the server must leave
     * the recipe exactly where it was. A move can lose a recipe: it takes
     * one book's row away on the strength of another book's arriving.
     * Finishing a plan takes nothing away. The plan moves from one local
     * list to another, both of them saved, both of them pushed by the
     * ordinary retry — so there is no state here where the thing is gone
     * from one place and not yet in the other. What could go wrong twice
     * is recording the same plan twice, and the archive row is keyed by
     * the plan's own id so that it cannot.
     */
    async completePlan(now = Date.now()) {
      if (!this.planStore) return null;
      const live = this.planStore.plan;
      const finished = global.RecipePlan.complete(live, now);
      // An empty plan has nothing to record and offers no Done (J14.3).
      if (!finished || finished === live) return null;
      if (this.readOnly) throw new Error("this is a book you read, not one you plan");

      // Strictly later than the plan it replaces, so the two are ordered
      // as generations on every device that meets them (see mergePlans).
      const fresh = global.RecipePlan.emptyPlan(global.RecipePlan.generationAfter(finished, now));
      this.planStore.archivePlan(finished);
      this.planStore.setPlan(fresh);
      await this.syncNow();
      return { archived: finished, plan: fresh };
    }

    /**
     * Undo, offered in the moment after Done (J14.2): the record goes,
     * and the plan comes back.
     *
     * The server first, and only then this device — the one place in the
     * plan that does not work offline, and the J7.11 rule is why. An
     * archived plan is reconciled by comparing ids, so a record dropped
     * here and not there is one the next sync pulls straight back in;
     * dropping it locally on the strength of a delete that did not happen
     * would undo the undo a few seconds later. Refusing is honest, and it
     * costs a gesture that is always seconds old and always beside a
     * network that just carried the completion up.
     *
     * The plan comes back as a new generation rather than the one that was
     * archived: the empty plan that replaced it may already be on another
     * phone, and a restored plan that is older than it would lose the
     * merge and vanish again.
     */
    async undoComplete(planId, now = Date.now()) {
      if (!this.planStore) return null;
      const archived = this.planStore.archive.find((p) => p.id === planId);
      if (!archived) return null;
      if (this.readOnly) throw new Error("this is a book you read, not one you plan");

      await this.api.deleteArchivedPlan(this.bookId, planId);
      this.planStore.removeArchived(planId);
      const createdAt = global.RecipePlan.generationAfter(this.planStore.plan, now);
      const restored = {
        ...archived,
        id: global.RecipeStore.newId(),
        createdAt,
        // Never before the plan began: a clock behind the one that
        // finished this week would otherwise date the restored plan's
        // last edit before its own birthday, and `touchedAt` reads it.
        updatedAt: Math.max(now, createdAt),
        completedAt: null,
      };
      this.planStore.setPlan(restored);
      await this.syncNow();
      return restored;
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
      if (this.planStore) this.planStore.useBook(null);
    }
  }

  global.RecipeSync = RecipeSync;
})(window);
