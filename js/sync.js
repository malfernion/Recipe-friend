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
   * May we write to this book at all? The same question `BooksUI.canEdit`
   * asks, asked here because `resolveBook` has the answer in its hands
   * one whole sync before the books UI gets round to it (J7.17). An agent
   * may (J16.3), which is why it is not simply `readOnly`.
   *
   * `BooksUI.canEdit` deliberately disagrees about `agent`: nothing an
   * agent runs loads the books UI, and a browser opened with an agent's
   * credential should draw the read-only screen rather than controls
   * whose writes the database would refuse.
   */
  function canWrite(book) {
    return Boolean(
      book &&
        (book.isOwner ||
          book.role === "owner" ||
          book.role === "editor" ||
          book.role === "agent")
    );
  }

  /**
   * Is this the narrow kind of write — add a recipe, work on the plan,
   * and nothing else (J16.3, J16.4)?
   *
   * There are three answers to "may this device write", not two, and
   * pretending otherwise is what makes an agent's sync park. An agent
   * that pushed like an editor would send an upsert against a row the
   * server already has, which is an UPDATE it has no policy for, and one
   * refusal fails the whole batch — every good insert beside it included.
   * The same for a finished plan it may hold and may not record.
   *
   * So this is asked in the two places that push, and nowhere else.
   */
  function addsOnly(book) {
    return Boolean(book && book.role === "agent");
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

  /** Nothing in it at all — no meal, no line added by hand, nothing settled. */
  function isBlank(plan) {
    return (
      plan.meals.length === 0 &&
      (plan.items || []).length === 0 &&
      Object.keys(plan.settled).length === 0
    );
  }

  function digest(plan) {
    const meals = plan.meals
      .map((m) => [m.id, m.recipeId, m.name, m.portions, m.multiplier, m.addedAt].join(":"))
      .sort();
    const settled = Object.keys(plan.settled || {})
      .sort()
      .map((key) => {
        const entry = plan.settled[key] || {};
        // The key as well as the amounts: ✗ on the onions and ✗ on the
        // tomatoes at the same moment are not the same list.
        return [key, ...["have", "got"]
          .map((f) => (entry[f] ? `${f}=${entry[f].amount}@${entry[f].at}` : ""))].join(",");
      });
    const items = (plan.items || [])
      .map((i) => [i.id, i.text, i.textAt, i.addedAt, i.state, i.at].join(":"))
      .sort();
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
      items,
    ]);
  }

  class RecipeSync {
    constructor(store, api, onStatus, planStore, listStore) {
      this.store = store;
      this.api = api;
      this.onStatus = onStatus || (() => {});
      // Optional, and absent everywhere plans are not in play — a share
      // link, the tests that only care about recipes. Everything to do
      // with plans below is a no-op without it.
      this.planStore = planStore || null;
      // The book's lists (J18), optional in the same way.
      this.listStore = listStore || null;
      this.listsBusy = false;
      this.listsAgain = false;
      this.listsSeed = false;
      this.bookId = null;
      this.readOnly = false; // a book we may read and not write (J7.17)
      this.addOnly = false; // an agent: adds recipes, never edits them (J16.3)
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
        this.addOnly = false;
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
      this.addOnly = addsOnly(chosen);
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
    setBook(bookId, { readOnly = false, addOnly = false } = {}) {
      clearTimeout(this.timer);
      this.bookId = bookId;
      this.readOnly = readOnly;
      this.addOnly = addOnly;
      // Each book keeps its own plan, so switching books switches plans
      // (J12.3). It is done here rather than left to every caller because
      // a plan pointed at the wrong book is a shopping list for somebody
      // else's week.
      if (this.planStore) this.planStore.useBook(bookId);
      if (this.listStore) this.listStore.useBook(bookId);
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

        // An agent may add a recipe and may not touch one that is there
        // (J16.3). `pushRecipes` sends an upsert, so a row the server
        // already has would go up as an UPDATE it has no policy for —
        // and one refusal fails the whole batch, taking every good
        // insert with it. So it pushes what the server has never seen
        // and leaves the rest where it is.
        const held = new Set(rows.map((r) => r.id));
        const mine = this.addOnly ? toPush.filter((r) => !held.has(r.id)) : toPush;

        const pushed = this.readOnly ? 0 : mine.length;
        if (pushed > 0) await this.api.pushRecipes(mine);

        const plans = await this.syncPlans();
        // The plan has just been pulled, so this is the one run that may
        // move it into Shopping (build step 1).
        const lists = await this.syncLists(null, { seed: true });

        this.status("synced", { pushed, pulled: rows.length, plans, lists });
        return { pushed, pulled: rows.length, plans, lists };
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

      // What this device held when the sync began. Everything below awaits
      // the network, and a tap in the meantime — ✓ on the last line, which
      // is Done (J14.2), or a line added — changes the plan under it. The
      // merge is taken against these, so it has to be taken again against
      // whatever is here by the time it is applied, or the tap is undone.
      const startedWith = this.planStore.plan;
      const archivedBefore = new Set(this.planStore.archive.map((p) => p.id));

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
      // An agent is excluded here for the same reason a viewer is, and it
      // matters more: it may write the live plan but not the archive
      // (J16.4). Taking this branch, it would clear its own live plan
      // locally and then be refused the record — leaving a week that
      // never happened and a sync parked for ever on a book that is
      // perfectly well. A person's device finishes the job.
      if (plan && plan.completedAt && !this.readOnly && !this.addOnly) {
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

      // Changed while the network was being asked: merge again, on top of
      // what is here now. `mergePlans` already knows the rules — a newer
      // generation (Done, Clear) wins whole, the list merges line by line
      // — so a Done pressed during the sync stays done. A plan recorded
      // here in the meantime is kept, and owed, rather than dropped from
      // the archive by a list that was read before it existed.
      //
      //
      // One case needs more than that. A phone that has never seen this
      // book's plan starts the sync holding the placeholder, stamped zero
      // so that it yields (planstore.js). A first line added while the
      // sync runs dates the placeholder "now", and as a generation it
      // would then replace the book's plan outright. It is not a new
      // week; it is an edit to the one the book is on, so it is replayed
      // onto the result as a copy of that plan — meals by their stamp, the
      // list line by line. Only then: an edit to a week that a newer one
      // replaced during the sync belongs to the week that is over, and the
      // generation rule is what keeps it there.
      const now = this.planStore.plan;
      if (now !== startedWith) {
        const firstEdit = !startedWith.createdAt && now.id === startedWith.id && plan;
        const edit = firstEdit ? { ...now, id: plan.id, createdAt: plan.createdAt } : now;
        plan = global.RecipePlan.mergePlans(edit, plan);
      }
      for (const mine of this.planStore.archive) {
        if (!archivedBefore.has(mine.id) && !here.has(mine.id)) here.set(mine.id, mine);
      }
      this.planStore.applyMerge(plan, [...here.values()]);
      // What goes up is what the device holds, which is the coerced plan
      // (planstore.js's `applyMerge`). A merge takes the union of two
      // plans' settled items, so its result can be larger than either
      // side and larger than the caps the client keeps — and those caps
      // are the arithmetic that keeps a plan inside the size migration
      // 007 will accept. Pushing the pre-coercion merge would put a plan
      // on the server this device would refuse to hold, and one the
      // server may refuse outright, which parks sync for ever.
      plan = this.planStore.plan;

      // Nothing local goes up from a book we may only read (J12.10,
      // J7.17). It would be refused, and a refused push parks the status
      // line on "Sync paused" and makes read-only look broken.
      if (this.readOnly) return { pushed: 0, pulled: missingHere.length, live: "read" };

      // An agent works on the live plan and never on the record (J16.4),
      // so the archive push below is not its errand. It has nothing owed
      // in any case — the branch that mints a debt is the one it did not
      // take above — and skipping it is what keeps that true even if a
      // debt arrives from somewhere else, which would otherwise be
      // pushed, refused, and park the sync.
      if (this.addOnly) {
        const blank = isBlank(plan);
        const live = (!remote && blank) || samePlan(plan, remote) ? "unchanged" : "pushed";
        if (live === "pushed") await this.api.pushLivePlan(this.bookId, plan);
        return { pushed: 0, pulled: missingHere.length, live };
      }

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
      const blank = isBlank(plan);
      const live = (!remote && blank) || samePlan(plan, remote) ? "unchanged" : "pushed";
      if (live === "pushed") await this.api.pushLivePlan(this.bookId, plan);
      return { pushed, pulled: missingHere.length, live };
    }

    /**
     * Record that a recipe was planned (J18.21): one archived plan holding
     * that one meal. Written to this device first and owed to the book, so
     * it works with no network and goes up on the usual push, retried
     * until it lands (J9.5). Returns the record's id, for Undo.
     */
    recordPlanned(recipe, portions, now = Date.now()) {
      if (!this.planStore || this.readOnly || this.addOnly) return null;
      const archived = this.planStore.archivePlan(global.RecipePlan.plannedMeal(recipe, portions, now));
      return archived ? archived.id : null;
    }

    /**
     * Take that record back (J18.21's Undo). The server first, then this
     * device, for the reason J7.11 gives: an archived plan is reconciled
     * by comparing ids, so one dropped here and not there is pulled
     * straight back. Offline this throws and leaves the record where it
     * is — except one the book was never told about, which has nothing to
     * delete there and just goes.
     */
    async unrecordPlanned(planId) {
      if (!this.planStore || !this.planStore.hasArchived(planId)) return false;
      if (this.readOnly || this.addOnly) return false;
      try {
        await this.api.deleteArchivedPlan(this.bookId, planId);
      } catch (err) {
        if (!this.planStore.owes(planId)) throw err;
      }
      this.planStore.removeArchived(planId);
      return true;
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
      if (this.listStore) this.listStore.useBook(null);
    }

    // -------------------------------------------------------------------
    // Lists (J18)
    // -------------------------------------------------------------------

    /**
     * Pull one list — or every list, with no id — merge, and push what
     * the server lacks. This is what the UI calls every few seconds while
     * a list is on screen and the tab is visible, and on focus (J18.24):
     * there is no realtime service, so "within seconds" is a poll.
     *
     * Quiet: it does not touch the status line, and a failure (no
     * signal, J18.22) is swallowed and answered with null, because the
     * next poll is the retry. The list itself never waits on it.
     *
     * It never moves the plan into Shopping: that waits for `syncNow`,
     * which pulls the plan first, so a stale copy is never what moves.
     */
    async pullLists(listId = null) {
      if (!this.listStore || !this.bookId) return null;
      try {
        return await this.syncLists(listId);
      } catch (err) {
        console.warn("Recipe Friend: could not pull lists.", err);
        return null;
      }
    }

    /**
     * Reconcile this book's lists with the server.
     *
     * Each list is one row (012) and merges with `RecipeLists.mergeLists`,
     * which never loses a fact either side holds. The merged copy goes
     * back only over the row it was merged with (compare-and-set on
     * updated_at); if somebody wrote in between, the row is read again
     * and merged again. Two phones saving at once therefore both keep
     * what they did (J18.23).
     *
     * A reader pushes nothing (J18.4). An agent pushes items and nothing
     * else: it may not make, rename or delete a list (J18.25), and the
     * database says the same.
     *
     * With `seed` — only `syncNow` passes it, after `syncPlans` has
     * pulled the plan in the same run — the first time an editor's device
     * finds the book with no list rows at all, the live plan moves into a
     * "Shopping" checklist (build step 1). Its ids are fixed by the plan,
     * so two devices doing it at once make one list. A deleted list
     * leaves a tombstone row, so a book whose Shopping list was deleted
     * is not seeded again.
     *
     * Tombstones older than 30 days are pruned on the way (RecipeLists.prune).
     *
     * One run at a time: a call that arrives while one is running asks
     * for another pass when it ends, and returns null.
     */
    async syncLists(onlyId = null, { seed = false } = {}) {
      const ls = this.listStore;
      if (!ls || !this.bookId) return null;
      if (this.listsBusy) {
        // Asked for again when the running pass ends — seeding included,
        // when this call was the one allowed to.
        this.listsAgain = true;
        this.listsSeed = this.listsSeed || seed;
        return null;
      }
      this.listsBusy = true;
      try {
        let result = await this.reconcileLists(onlyId, seed);
        while (this.listsAgain) {
          const again = this.listsSeed;
          this.listsAgain = false;
          this.listsSeed = false;
          result = await this.reconcileLists(null, again);
        }
        return result;
      } finally {
        this.listsBusy = false;
        this.listsAgain = false;
        this.listsSeed = false;
      }
    }

    async reconcileLists(onlyId, seed = false) {
      const Lists = global.RecipeLists;
      const ls = this.listStore;
      const bookId = this.bookId;
      const canWrite = !this.readOnly;
      const canMake = !this.readOnly && !this.addOnly;
      const fromRow = (row) =>
        Lists.sanitizeList({
          id: row.id,
          name: row.name,
          nameAt: row.name_at,
          kind: row.kind,
          createdAt: toMillis(row.created_at),
          prunedTo: row.pruned_to,
          items: row.items,
        });

      const rows = onlyId
        ? [await this.api.fetchList(bookId, onlyId)].filter(Boolean)
        : await this.api.fetchLists(bookId);
      // The book changed under the request: these rows are another book's.
      if (this.bookId !== bookId) return null;
      const changed = new Set();
      let pushed = 0;

      if (!onlyId) {
        if (rows.length > 0) ls.markSeeded();
        else if (seed && canMake && !ls.seeded) {
          const recipes = this.store && this.store.recipes ? this.store.recipes : [];
          const prefs = this.store && this.store.prefs ? this.store.prefs : {};
          const seeded = ls.seedFromPlan(bookId, this.planStore ? this.planStore.plan : null, recipes, prefs);
          if (seeded) changed.add(seeded.id);
        }
      }

      const onServer = new Map();
      for (const row of rows) {
        if (row.deleted_at) {
          if (ls.drop(row.id)) changed.add(row.id);
          continue;
        }
        const remote = fromRow(row);
        if (remote) onServer.set(remote.id, { remote, seenAt: row.updated_at });
      }

      // Deleted here: the tombstone goes up.
      if (canMake) {
        for (const id of ls.owed) {
          if (onlyId && id !== onlyId) continue;
          await this.api.deleteList(bookId, id);
          ls.settleOwed(id);
          onServer.delete(id);
          pushed++;
        }
      }

      // Here and not there: new here, or gone from the server.
      for (const local of ls.lists) {
        if ((onlyId && local.id !== onlyId) || onServer.has(local.id)) continue;
        if (ls.isKnown(local.id)) {
          if (ls.drop(local.id)) changed.add(local.id);
          continue;
        }
        if (!canMake) continue;
        await this.api.insertList(bookId, local);
        ls.markKnown(local.id);
        pushed++;
      }

      // On both: merge, keep, and write back what the server lacks.
      for (const [id, entry] of onServer) {
        let server = entry.remote;
        let seen = entry.seenAt;
        for (let attempt = 0; attempt < 3; attempt++) {
          ls.markKnown(id);
          if (ls.applyRemote(Lists.prune(Lists.mergeLists(ls.get(id), server), Date.now()))) changed.add(id);
          const held = ls.get(id);
          if (!held || !canWrite) break;
          const fields = {};
          if (!Lists.sameItems(held, server)) {
            fields.items = held.items;
            fields.pruned_to = held.prunedTo;
          }
          if (canMake && (held.name !== server.name || held.nameAt !== server.nameAt)) {
            fields.name = held.name;
            fields.name_at = held.nameAt;
          }
          if (Object.keys(fields).length === 0) break;
          if (await this.api.updateList(bookId, id, fields, seen)) {
            pushed++;
            break;
          }
          // Somebody wrote in between: read it again and merge with that.
          const row = await this.api.fetchList(bookId, id);
          if (!row || row.deleted_at) {
            if (ls.drop(id)) changed.add(id);
            break;
          }
          server = fromRow(row);
          seen = row.updated_at;
        }
      }

      ls.announce([...changed]);
      return { pulled: rows.length, pushed, changed: [...changed] };
    }
  }

  global.RecipeSync = RecipeSync;
})(window);
