/**
 * planstore.js — where a book's plan is kept between taps (J12.2, J12.3).
 *
 * The same shape as RecipeStore, and for the same reasons: localStorage is
 * the working copy so the plan renders instantly and works with no network
 * — which matters more here than anywhere else, because the supermarket is
 * the one building where the phone has no signal (J12.12) — and each book
 * gets its own key, so switching books switches plans and never mixes them
 * (J9.7, J12.3). A book that goes away takes its plan with it (J7.13).
 *
 * Kept apart from storage.js rather than folded into it. A plan is not a
 * recipe with different fields: there is exactly one live one per book, it
 * has no tombstones, and its archive is insert-only. `RecipeStore` would
 * have gained a second state machine sharing nothing with the first but
 * the word "store", and every method on it would have had to say which of
 * the two it meant.
 *
 * State:
 *   { version: 1, plan: <the live plan>, archive: [<finished plans>],
 *     owed: [<ids of finished plans the server is not known to hold>] }
 */
(function (global) {
  "use strict";

  const PLAN_KEY = "recipe-friend:plan:v1";

  // A plan arrives from the server, where another member of the book put
  // it, and is untrusted for exactly the reason a recipe is. Caps far above
  // any real week: a household plans a handful of meals and settles a few
  // dozen lines.
  //
  // They are also what keeps a plan small enough for the server to accept,
  // and that is the harder of the two jobs. Migration 007 checks
  // `pg_column_size(data) <= 200000` on both plan tables, and a plan this
  // client is happy to hold but the server refuses is the worst failure
  // shape the app has: the push fails for ever, sync parks on an error,
  // and the person cannot even see why — the plan looks fine on their
  // phone. So the caps below are chosen to fit inside 200000 by
  // arithmetic rather than by hope.
  //
  // `pg_column_size` measures the stored jsonb, so the sum is done in
  // jsonb's terms, with each term rounded up:
  //
  //   · a string of N UTF-16 units is at most 3N bytes of UTF-8 (a
  //     surrogate pair is two units and four bytes, so 3 per unit is the
  //     ceiling);
  //   · a number is at most 24 bytes as a numeric — a double carries 17
  //     significant digits, which is five base-10000 groups and a header;
  //   · every element — each container, each key, each value — costs at
  //     most 8 bytes of jsonb bookkeeping (a 4-byte JEntry, and alignment
  //     padding that cannot exceed another 3).
  //
  // One meal is an object of six fields: 13 elements (the object, six
  // keys, six values) at 8 = 104, its key names 39, two uuids 72, a name
  // of at most MAX_NAME_CHARS units 360, and three numbers 72 — 647
  // bytes, called 700.
  //
  // One settled item is a key and an object of two fields, each an object
  // of two: 14 elements at 8 = 112, a key of at most MAX_KEY_CHARS units
  // 720, the inner key names 23, and four numbers 96 — 951 bytes, called
  // 1000.
  //
  // The plan around them — id, three stamps, and the two containers — is
  // 271 bytes, called 300.
  //
  //    60 meals   ×  700  =   42000      <- MAX_MEALS
  //   120 settled × 1000  =  120000      <- MAX_SETTLED
  //   the plan itself     =     300
  //                          -------
  //                          162300  <=  200000, with 37700 to spare
  //
  // An archived plan is the same shape and goes into a row with the same
  // check, so the same sum covers it; MAX_ARCHIVE is about this device's
  // localStorage rather than about any one row.
  //
  // Every plan that reaches the state passes through `sanitizePlan`,
  // including the result of a merge — see `applyMerge`, which is where
  // the union of two plans' settled items would otherwise slip past
  // these numbers.
  //
  // A key is 240 because that is what the app can actually generate — an
  // item is capped at 200 characters (storage.js) and a unit at 24, and
  // shoplist.js keys a line on the pair. Trimming that would silently
  // drop the settlement on a long-named item instead. The counts are
  // what gave way, and they had the room to. 60 meals is two months of
  // dinners in one plan. Settled lines get the larger share of the
  // budget because they are the half a real shop can approach — every
  // distinct thing on the list can be ticked, and a big week's list runs
  // to a few dozen.
  const MAX_MEALS = 60;
  const MAX_SETTLED = 120;
  const MAX_KEY_CHARS = 240;
  const MAX_NAME_CHARS = 120;
  // The server's own limit, restated here as the thing the sum above has
  // to come in under. Exported for the test that does the sum.
  const SERVER_MAX_BYTES = 200000;
  // Roughly eight years of weekly shopping. The server keeps every plan
  // (007); this is only what one device carries around to answer "when was
  // this last planned" (J14.6) without asking.
  const MAX_ARCHIVE = 400;
  const MAX_PORTIONS = 9999;
  const MAX_MULTIPLIER = 8;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

  /**
   * A finite, non-negative moment, or null where there is not one. Zero is
   * a moment here and not an absence — a plan nobody has started yet is
   * stamped zero on purpose (see `load`), and `|| Date.now()` would undo
   * that every time the page was opened.
   */
  function moment(value) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  }

  function positive(value, max) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : null;
  }

  /**
   * One meal, or null if it is not one. A meal whose recipeId is not a
   * uuid is dropped rather than kept: it can never match a recipe in this
   * book, so it would sit in the plan contributing nothing to the list and
   * refusing to be pruned.
   */
  function sanitizeMeal(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (!isUuid(raw.recipeId)) return null;
    const portions = positive(raw.portions, MAX_PORTIONS);
    const multiplier = positive(raw.multiplier, MAX_MULTIPLIER);
    return {
      id: isUuid(raw.id) ? raw.id : global.RecipeStore.newId(),
      recipeId: raw.recipeId,
      name: String(raw.name || "").trim().slice(0, MAX_NAME_CHARS),
      portions,
      // A meal has to ask for some amount of its recipe. With neither
      // number readable it asks for one batch, which is what `factorFor`
      // falls back to anyway.
      multiplier: portions ? multiplier : multiplier || 1,
      addedAt: moment(raw.addedAt) ?? 0,
    };
  }

  /**
   * The settled amounts, per item and per field. Both halves of an entry
   * are optional — a line can have been ✗'d and never ✓'d — but a field
   * without a readable moment is dropped, because `at` is the whole of how
   * two of them merge (J12.11) and one that cannot be compared would win
   * or lose at random.
   */
  function sanitizeSettled(raw) {
    const settled = Object.create(null);
    if (!raw || typeof raw !== "object") return settled;
    let kept = 0;
    for (const key of Object.keys(raw)) {
      if (kept >= MAX_SETTLED) break;
      if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_CHARS) continue;
      const entry = raw[key];
      if (!entry || typeof entry !== "object") continue;
      const clean = {};
      for (const field of ["have", "got"]) {
        const value = entry[field];
        if (!value || typeof value !== "object") continue;
        const at = moment(value.at);
        const amount = Number(value.amount);
        if (at === null || !Number.isFinite(amount)) continue;
        clean[field] = { amount: Math.max(0, amount), at };
      }
      if (Object.keys(clean).length === 0) continue;
      settled[key] = clean;
      kept++;
    }
    return settled;
  }

  /**
   * Coerce an untrusted object — off this device's storage, or off the
   * server, where another member of the book wrote it — into a plan, or
   * null if there is nothing usable in it.
   *
   * Increment 1 left this out deliberately, because nothing had yet
   * handed plan.js anything it had not made itself. A plan crossing the
   * network is exactly as untrusted as a recipe, and is coerced the same
   * way `RecipeStore.sanitizeRecipe` coerces one.
   */
  function sanitizePlan(raw) {
    if (!raw || typeof raw !== "object") return null;
    const now = Date.now();
    const meals = Array.isArray(raw.meals)
      ? raw.meals.slice(0, MAX_MEALS).map(sanitizeMeal).filter(Boolean)
      : [];
    const createdAt = moment(raw.createdAt) ?? now;
    return {
      // An id that is not a uuid cannot be an archived plan's primary key
      // (007), so it is replaced rather than carried.
      id: isUuid(raw.id) ? raw.id : global.RecipeStore.newId(),
      createdAt,
      updatedAt: moment(raw.updatedAt) ?? createdAt,
      completedAt: moment(raw.completedAt) || null,
      meals,
      settled: sanitizeSettled(raw.settled),
    };
  }

  /** An archived plan is one that was finished; anything else is not one (J14.4). */
  function sanitizeArchived(raw) {
    const plan = sanitizePlan(raw);
    return plan && plan.completedAt ? plan : null;
  }

  function load(key) {
    let parsed;
    try {
      parsed = JSON.parse(global.localStorage.getItem(key));
    } catch (err) {
      // Private browsing, disabled storage, or corrupted JSON — start with
      // an empty plan in memory rather than losing the app.
      console.warn("Recipe Friend: could not read the saved plan.", err);
      parsed = null;
    }
    const archive = (Array.isArray(parsed && parsed.archive) ? parsed.archive : [])
      .map(sanitizeArchived)
      .filter(Boolean)
      .sort((a, b) => b.completedAt - a.completedAt)
      .slice(0, MAX_ARCHIVE);
    const owed = (Array.isArray(parsed && parsed.owed) ? parsed.owed : [])
      .filter(isUuid)
      .slice(0, MAX_ARCHIVE);
    return {
      version: 1,
      // Which of those the server is not yet known to hold. It survives
      // being closed and reopened because a Done pressed with no signal
      // does: the plan is recorded here and owed to the book until a sync
      // gets it up (J14.1, J12.12).
      owed,
      // A device that has never seen this book's plan holds a placeholder,
      // and a placeholder is stamped zero because it has not begun. Two
      // plan ids are two plans and the later one is the one the book is on
      // (see mergePlans), so a placeholder made "just now" would be the
      // newest plan in the book and would wipe the week everybody else is
      // shopping for the first time a new phone signed in.
      plan: (parsed && sanitizePlan(parsed.plan)) || global.RecipePlan.emptyPlan(0),
      archive,
    };
  }

  function persist(state, key) {
    try {
      global.localStorage.setItem(key, JSON.stringify(state));
      return true;
    } catch (err) {
      console.warn("Recipe Friend: could not save the plan.", err);
      return false;
    }
  }

  class RecipePlanStore {
    constructor() {
      this.key = PLAN_KEY;
      this.state = load(this.key);
      // False when the last write failed (storage full or blocked), so the
      // UI can say the plan is in memory only.
      this.persistOk = true;
      // Sync listens here to push, exactly as it does on RecipeStore.
      this.onChange = null;
      this._applying = false;
    }

    /** Persist without telling sync: this is bookkeeping, not an edit. */
    _quietly(change) {
      const was = this._applying;
      this._applying = true;
      change();
      this._persist();
      this._applying = was;
    }

    _persist() {
      this.persistOk = persist(this.state, this.key);
      if (this.onChange && !this._applying) this.onChange();
      return this.persistOk;
    }

    get plan() {
      return this.state.plan;
    }

    /** Every finished plan this device knows about, newest first. */
    get archive() {
      return this.state.archive;
    }

    /**
     * Is this a plan this device recorded and still owes the book?
     *
     * Sync asks before pushing an archived plan the server does not have,
     * because there are two reasons it might not have one and they want
     * opposite things. A plan recorded here offline is owed and must go
     * up. A plan pulled from the server and since deleted there was taken
     * back with Undo (J14.2) — pushing it would undo somebody's Undo, and
     * an insert-only archive has no tombstone to argue with.
     */
    owes(id) {
      return this.state.owed.includes(id);
    }

    /** This device has a finished plan the book has not been told about. */
    owe(id) {
      if (!isUuid(id) || this.state.owed.includes(id)) return;
      this._quietly(() => {
        this.state.owed = [id, ...this.state.owed].slice(0, MAX_ARCHIVE);
      });
    }

    /** The book has it now — by our push, or by somebody else's. */
    settleOwed(id) {
      if (!this.state.owed.includes(id)) return;
      this._quietly(() => {
        this.state.owed = this.state.owed.filter((p) => p !== id);
      });
    }

    /**
     * Point the cache at a book. There is no adopting of a pre-account
     * plan the way RecipeStore adopts a pre-account box: a plan belongs to
     * a book (J12.2), so one made before there was a book to put it in
     * belongs nowhere, and signed-out use is not a journey (J1.6).
     */
    useBook(bookId) {
      const nextKey = bookId ? `${PLAN_KEY}:book:${bookId}` : PLAN_KEY;
      if (nextKey === this.key) return;
      this.key = nextKey;
      this.state = load(this.key);
    }

    /** Drop a book's plan — the book was deleted, or you were removed (J7.13). */
    forgetBook(bookId) {
      try {
        global.localStorage.removeItem(`${PLAN_KEY}:book:${bookId}`);
      } catch {
        /* nothing to clear */
      }
    }

    /** A local edit to the plan: persisted, and pushed on the usual debounce. */
    setPlan(plan) {
      const clean = sanitizePlan(plan);
      if (!clean) return this.state.plan;
      // A plan begins when something first goes into it. Until then it is
      // the placeholder above, stamped zero so that it yields to whatever
      // the book is already shopping for; the moment somebody puts a meal
      // in it, it is this book's plan and dates from now.
      if (!clean.createdAt && (clean.meals.length > 0 || Object.keys(clean.settled).length > 0)) {
        clean.createdAt = global.RecipePlan.touchedAt(clean) || Date.now();
      }
      this.state.plan = clean;
      this._persist();
      return this.state.plan;
    }

    /**
     * Put a finished plan in the archive. Keyed by the plan's own id and
     * idempotent, which is what makes pressing Done twice — a retry, or
     * the other phone finishing a completion this one half-landed —
     * record one plan rather than two. J14.10 counts every appearance, so
     * a second copy would be a lie about how often something is cooked.
     */
    archivePlan(plan) {
      const clean = sanitizeArchived(plan);
      if (!clean) return null;
      if (this.state.archive.some((p) => p.id === clean.id)) return clean;
      this.state.archive = [clean, ...this.state.archive]
        .sort((a, b) => b.completedAt - a.completedAt)
        .slice(0, MAX_ARCHIVE);
      // Recorded here; the book has not been told yet.
      if (!this.state.owed.includes(clean.id)) {
        this.state.owed = [clean.id, ...this.state.owed].slice(0, MAX_ARCHIVE);
      }
      this._persist();
      return clean;
    }

    /** Take a finished plan back out of the record (J14.2's Undo). */
    removeArchived(id) {
      const before = this.state.archive.length;
      this.state.archive = this.state.archive.filter((p) => p.id !== id);
      if (this.state.archive.length === before) return false;
      // Nothing is owed on a record that has been taken back, even one
      // that never reached the server: a debt left here would push it
      // straight back up on the next sync.
      this.state.owed = this.state.owed.filter((p) => p !== id);
      this._persist();
      return true;
    }

    hasArchived(id) {
      return this.state.archive.some((p) => p.id === id);
    }

    /**
     * Replace everything with the result of a sync. Does not notify
     * onChange — the caller already knows, and echoing a merge straight
     * back to the server is how a push loop starts.
     */
    applyMerge(plan, archive) {
      this._applying = true;
      // Coerced on the way in, like everything else that did not come
      // from this device. A merge is not a copy of either side: settled
      // items merge per key and the result holds the *union* of the two
      // (J12.11), so two plans each at the cap would make one at twice
      // it — and the sum the caps are chosen by, up at the top of this
      // file, would be a fiction the moment two phones met. Sanitising
      // here is what keeps it arithmetic.
      if (plan) this.state.plan = sanitizePlan(plan) || this.state.plan;
      if (archive) {
        // The record gets the same treatment for the same reason. A plan
        // that was finished after a merge carries that merge's union of
        // settled items, and it goes into a row with the same size check
        // as the live one (007) — so an archive taken on trust is the
        // hole the paragraph above closes, moved one table across.
        this.state.archive = archive
          .map(sanitizeArchived)
          .filter(Boolean)
          .sort((a, b) => b.completedAt - a.completedAt)
          .slice(0, MAX_ARCHIVE);
        // A debt on a plan this device no longer holds can never be paid:
        // the push reads the archive, and the slice above is what drops
        // the oldest of them. Owing something unreachable for ever would
        // only fill the list up.
        const held = new Set(this.state.archive.map((p) => p.id));
        this.state.owed = this.state.owed.filter((id) => held.has(id));
      }
      this._persist();
      this._applying = false;
    }

    /**
     * When each recipe was last planned and how often (J14.6, J14.9,
     * J14.10), worked out from the archive and nothing else — nothing
     * about planning is ever written onto a recipe (J14.11).
     */
    plannedIndex() {
      return global.RecipePlan.plannedIndex(this.state.archive);
    }
  }

  // Exposed for the same reason RecipeStore.sanitizeRecipe is: sync has to
  // coerce a row before it believes a word of it.
  RecipePlanStore.sanitizePlan = sanitizePlan;
  RecipePlanStore.sanitizeArchived = sanitizeArchived;
  // What the caps above are arithmetic about, so a test can do the sum
  // against the real numbers rather than a copy of them.
  RecipePlanStore.limits = {
    MAX_MEALS,
    MAX_SETTLED,
    MAX_KEY_CHARS,
    MAX_NAME_CHARS,
    MAX_ARCHIVE,
    SERVER_MAX_BYTES,
  };

  global.RecipePlanStore = RecipePlanStore;
})(window);
