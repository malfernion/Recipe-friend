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
 *   { version: 1, plan: <the live plan>, archive: [<finished plans>] }
 */
(function (global) {
  "use strict";

  const PLAN_KEY = "recipe-friend:plan:v1";

  // A plan arrives from the server, where another member of the book put
  // it, and is untrusted for exactly the reason a recipe is. Caps far above
  // any real week: a household plans a handful of meals and settles a few
  // dozen lines.
  const MAX_MEALS = 200;
  const MAX_SETTLED = 500;
  const MAX_KEY_CHARS = 240;
  const MAX_NAME_CHARS = 120;
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
    return {
      version: 1,
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
      this._persist();
      return clean;
    }

    /** Take a finished plan back out of the record (J14.2's Undo). */
    removeArchived(id) {
      const before = this.state.archive.length;
      this.state.archive = this.state.archive.filter((p) => p.id !== id);
      if (this.state.archive.length === before) return false;
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
      if (plan) this.state.plan = plan;
      if (archive) {
        this.state.archive = archive
          .slice()
          .sort((a, b) => b.completedAt - a.completedAt)
          .slice(0, MAX_ARCHIVE);
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

  global.RecipePlanStore = RecipePlanStore;
})(window);
