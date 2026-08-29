/**
 * plan.js — the plan a book is shopping for, and its arithmetic (J12, J14).
 *
 * A plan is a bag of meals, not a calendar (J12.1): recipes go in with the
 * portions wanted and nothing is assigned to a day. Everything here is a
 * pure function over plain objects — no DOM, no storage, no network — so
 * the same question can be asked from a test as from a tap. Persistence
 * and sync live elsewhere and hand these functions the data.
 *
 * Plan shape:
 *   {
 *     id, createdAt, updatedAt,
 *     completedAt: null,          // set when finished; archived plans carry it
 *     meals:   [ {id, recipeId, name, portions, multiplier, addedAt} ],
 *     settled: { [itemKey]: { have: {amount, at}, got: {amount, at} } }
 *   }
 *
 * `meals[].name` is a copy of the recipe's name taken when it was added,
 * so an archived plan still reads correctly after the recipe is deleted
 * (J14.12). `portions` is an absolute target — 4 servings, not ×2 — so it
 * survives somebody editing the recipe's servings; where a recipe has no
 * servings there is nothing absolute to hold and `multiplier` carries the
 * factor instead, exactly as the recipe view's stepper does (J4.2, J12.5).
 */
(function (global) {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;

  /**
   * Ids for a plan and its meals. Both are real uuids, and the plan's has
   * to be: it is the primary key of an archived plan's row (007), and
   * `plan-1750000000000` is not a uuid. The browser without
   * `crypto.randomUUID` is the case that used to fall back to one, which
   * is precisely the browser whose plans would then fail to archive.
   * `RecipeStore.newId` already solves this for recipes, and one answer to
   * "where do ids come from" is better than two.
   */
  function newId() {
    return global.RecipeStore.newId();
  }

  function emptyPlan(now = Date.now(), id) {
    return {
      id: id || newId(),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      meals: [],
      settled: Object.create(null),
    };
  }

  /**
   * How much of a recipe this meal asks for. Portions are absolute, so the
   * factor is worked out against the recipe as it stands now — editing a
   * recipe from serving 4 to serving 2 doubles what a "serves 4" meal
   * cooks, which is what somebody who planned four portions meant.
   */
  function factorFor(meal, recipe) {
    if (!meal) return 1;
    const servings = recipe && Number(recipe.servings) > 0 ? Number(recipe.servings) : 0;
    if (servings && Number(meal.portions) > 0) return Number(meal.portions) / servings;
    if (Number(meal.multiplier) > 0) return Number(meal.multiplier);
    return 1;
  }

  /**
   * Add a recipe to the plan. Portions default to the recipe's own
   * servings (J12.5); the same recipe can be added again for another
   * night and gets an entry of its own (J12.6).
   */
  function addMeal(plan, recipe, now = Date.now()) {
    const servings = Number(recipe && recipe.servings) > 0 ? Number(recipe.servings) : null;
    const meal = {
      id: newId(),
      recipeId: recipe.id,
      // Copied, not looked up: J14.12 wants an archived plan to still read
      // correctly after the recipe has been deleted.
      name: String(recipe.name || ""),
      portions: servings,
      multiplier: servings ? null : 1,
      addedAt: now,
    };
    return { ...plan, meals: [...plan.meals, meal], updatedAt: now };
  }

  function removeMeal(plan, id, now = Date.now()) {
    const meals = plan.meals.filter((m) => m.id !== id);
    if (meals.length === plan.meals.length) return plan;
    return { ...plan, meals, updatedAt: now };
  }

  /**
   * Step one meal's portions the way the recipe view steps them (J4.2,
   * J12.5): one serving at a time where servings are known, half a batch
   * where they are not. The recipe is never edited (J4.3) — the plan holds
   * the portions.
   */
  function stepPortions(plan, id, direction, recipe, now = Date.now()) {
    const meal = plan.meals.find((m) => m.id === id);
    if (!meal) return plan;
    const up = direction === "up";
    let next;
    if (Number(recipe && recipe.servings) > 0 && Number(meal.portions) > 0) {
      const current = Math.round(Number(meal.portions));
      next = { ...meal, portions: up ? current + 1 : Math.max(1, current - 1) };
    } else {
      const current = Number(meal.multiplier) > 0 ? Number(meal.multiplier) : 1;
      const stepped = up ? current + 0.5 : current - 0.5;
      next = { ...meal, portions: null, multiplier: Math.min(8, Math.max(0.5, stepped)) };
    }
    if (next.portions === meal.portions && next.multiplier === meal.multiplier) return plan;
    return { ...plan, meals: plan.meals.map((m) => (m.id === id ? next : m)), updatedAt: now };
  }

  /**
   * Drop meals whose recipe has left the book (J12.8) — deleted, or moved
   * out by its owner. `settled` is deliberately left alone: settled
   * amounts are held per item, not per recipe, so removing the recipe that
   * put onions on the list does not un-settle onions (J13.11).
   *
   * An unchanged plan is returned as-is rather than re-stamped. Pruning
   * runs whenever the recipe list is read, and a plan that bumped its
   * `updatedAt` for nothing would start winning merges it should lose.
   */
  function prune(plan, availableRecipeIds, now = Date.now()) {
    const have = availableRecipeIds instanceof Set ? availableRecipeIds : new Set(availableRecipeIds || []);
    const meals = plan.meals.filter((m) => have.has(m.recipeId));
    if (meals.length === plan.meals.length) return plan;
    return { ...plan, meals, updatedAt: now };
  }

  /** What has been said about one item so far, in base units. */
  function settledFor(plan, itemKey) {
    const entry = (plan && plan.settled && plan.settled[itemKey]) || null;
    return {
      have: entry && entry.have && Number(entry.have.amount) > 0 ? Number(entry.have.amount) : 0,
      got: entry && entry.got && Number(entry.got.amount) > 0 ? Number(entry.got.amount) : 0,
    };
  }

  /** What is left to buy for one item (J13.9). */
  function outstandingFor(plan, itemKey, required) {
    const s = settledFor(plan, itemKey);
    return Math.max(0, (Number(required) || 0) - s.have - s.got);
  }

  /**
   * Record a settlement. `field` is "have" (✗, we already have this) or
   * "got" (✓, this is in the basket), and `amount` is an **absolute**
   * amount in base units, never an increment — that is what makes two
   * people settling the same line at the same time come out right,
   * because whichever write lands last still says the right total
   * (J12.11). It is also what keeps a settled amount from being reduced
   * when the requirement falls (J13.10): nothing here reads the
   * requirement at all.
   *
   * The plan's own `updatedAt` is deliberately **not** touched. Meals
   * merge whole with the most recent edit winning (J9.3, J12.11); if
   * settling a line bumped that timestamp, somebody ticking off onions in
   * the shop would beat somebody else adding the curry, which is exactly
   * the race J12.11 exists to avoid. Settlements carry their own `at` and
   * merge on it. Sync should push on `touchedAt`, below.
   *
   * The stamp is forced past whatever this line already said, which is
   * what makes J13.13 true. A settlement and the tap that retracts it can
   * land in the same millisecond — ✗ is a fast gesture — and the merge
   * broke that tie on the larger amount, so the retraction lost to the
   * settlement it was undoing. Stamping one millisecond after the value
   * being replaced means the same hand cannot tie with itself.
   *
   * Per item and field rather than per device on purpose. A device-wide
   * counter would fix the same-hand tie and nothing else; this also
   * covers the case that matters more, which is retracting a settlement
   * that arrived from somebody else's phone: their stamp is now the one
   * to beat, and a device whose clock is a few seconds behind would
   * otherwise take a line back and watch it come straight back.
   */
  function settle(plan, itemKey, field, amount, now = Date.now()) {
    if (field !== "have" && field !== "got") return plan;
    const settled = Object.assign(Object.create(null), plan.settled);
    const entry = settled[itemKey] || {};
    const previous = entry[field] && Number(entry[field].at);
    const at = Number.isFinite(previous) ? Math.max(Number(now) || 0, previous + 1) : Number(now) || 0;
    settled[itemKey] = { ...entry, [field]: { amount: Math.max(0, Number(amount) || 0), at } };
    return { ...plan, settled };
  }

  /**
   * Take a settlement back — ✗ is a fast gesture, and fast gestures are
   * mistyped (J13.13). Writing a zero rather than deleting the key is
   * what lets the retraction win the merge against the settlement it
   * undoes; a deletion has no timestamp to compare.
   */
  function unsettle(plan, itemKey, field, now = Date.now()) {
    return settle(plan, itemKey, field, 0, now);
  }

  /**
   * The last moment anything in this plan changed, settlements included.
   * `updatedAt` alone would miss a shop's worth of ticked-off lines.
   */
  function touchedAt(plan) {
    let at = Number(plan && plan.updatedAt) || 0;
    for (const key of Object.keys((plan && plan.settled) || {})) {
      const entry = plan.settled[key] || {};
      for (const field of ["have", "got"]) {
        if (entry[field] && Number(entry[field].at) > at) at = Number(entry[field].at);
      }
    }
    return at;
  }

  /** Is this recipe in the live plan (J14.8)? */
  function isPlanned(plan, recipeId) {
    return Boolean(plan && plan.meals.some((m) => m.recipeId === recipeId));
  }

  /** Finish a plan: it is archived as it stands, stamped with the date (J14.1, J14.5). */
  function complete(plan, now = Date.now()) {
    if (!plan || plan.meals.length === 0) return plan; // J14.3 — nothing to record
    return { ...plan, completedAt: now, updatedAt: now };
  }

  // ---------------------------------------------------------------------
  // Merging two copies of the plan (J12.11)
  // ---------------------------------------------------------------------

  /**
   * Two devices holding the same plan, neither having seen the other.
   *
   * `settled` merges per item key **and per field**: `have` and `got` each
   * win by their own `at`, independently of each other and of every other
   * item. Because what is stored is an absolute amount rather than a step,
   * the later write is still the right answer — one person saying "we have
   * three onions" and the other "two are in the basket" both survive.
   *
   * Everything else merges whole, most recent `updatedAt` winning, the way
   * a recipe does (J9.3): a shopping list has two people in one aisle, but
   * nobody races to add the curry.
   */
  function mergePlans(local, remote) {
    if (!local) return remote;
    if (!remote) return local;

    // Two ids are two plans, not two copies of one, and the later of them
    // is the plan this book is shopping for. Clear and Done both put a
    // new plan in the live row (J14.1, J14.4), so this is the rule that
    // makes them stick: without it a device still holding the old plan
    // merged its settled amounts into the fresh one, and "we have onions"
    // — said about a shop that is over — came back on the next list. That
    // is the resurrection J9.4 tombstones recipes to prevent, arriving
    // through the settlements rather than through the meals, and it is
    // why clearing a plan needs no tombstone of its own: an id is a
    // generation, and a generation carries the moment it began.
    //
    // `createdAt` decides, not `updatedAt`: a device that was offline
    // when the plan was finished can go on editing the old one for days,
    // and a plan that is already archived must not come back because
    // somebody added a curry to it afterwards. A tie goes to the higher
    // id, so two devices reach the same plan whichever order they meet in.
    //
    // A plan nobody has started is not a generation at all: the
    // placeholder a device holds before it has ever seen this book's plan
    // is stamped zero, so it yields here rather than announcing itself as
    // the newest plan in the book (see planstore.js). What that leaves is
    // one honest cost — a device that has never synced, planning offline,
    // starts a plan of its own, and one of the two plans goes when they
    // meet. Both really are plans, and a book has one (J12.2).
    if (local.id && remote.id && local.id !== remote.id) {
      const lc = Number(local.createdAt) || 0;
      const rc = Number(remote.createdAt) || 0;
      if (lc !== rc) return lc > rc ? local : remote;
      return String(local.id) >= String(remote.id) ? local : remote;
    }

    const winner = newerBody(local, remote);
    const settled = Object.create(null);
    for (const key of new Set([...Object.keys(local.settled || {}), ...Object.keys(remote.settled || {})])) {
      const a = (local.settled && local.settled[key]) || {};
      const b = (remote.settled && remote.settled[key]) || {};
      const entry = {};
      for (const field of ["have", "got"]) {
        const pick = laterSettlement(a[field], b[field]);
        if (pick) entry[field] = { amount: pick.amount, at: pick.at };
      }
      settled[key] = entry;
    }

    return {
      ...winner,
      // The plan was created once; the earlier of the two claims is it.
      createdAt: Math.min(Number(local.createdAt) || 0, Number(remote.createdAt) || 0) || winner.createdAt,
      updatedAt: Math.max(Number(local.updatedAt) || 0, Number(remote.updatedAt) || 0),
      settled,
    };
  }

  function laterSettlement(a, b) {
    const av = a && Number.isFinite(Number(a.at)) ? { amount: Math.max(0, Number(a.amount) || 0), at: Number(a.at) } : null;
    const bv = b && Number.isFinite(Number(b.at)) ? { amount: Math.max(0, Number(b.amount) || 0), at: Number(b.at) } : null;
    if (!av) return bv;
    if (!bv) return av;
    if (av.at !== bv.at) return av.at > bv.at ? av : bv;
    // The same millisecond, from two clocks that cannot be separated.
    // Take the larger amount so both devices land on the same answer
    // whichever order they merge in, and so nothing already settled is
    // quietly forgotten.
    return av.amount >= bv.amount ? av : bv;
  }

  /**
   * Which side's meals win. `updatedAt` decides it; a tie is broken on the
   * meals themselves so that both devices reach the same result whichever
   * order they merge in, and so merging twice changes nothing.
   */
  function newerBody(a, b) {
    const at = Number(a.updatedAt) || 0;
    const bt = Number(b.updatedAt) || 0;
    if (at !== bt) return at > bt ? a : b;
    return fingerprint(a) >= fingerprint(b) ? a : b;
  }

  function fingerprint(plan) {
    return [
      plan.completedAt || 0,
      ...plan.meals.map((m) => `${m.id}:${m.recipeId}:${m.portions}:${m.multiplier}`).sort(),
    ].join("|");
  }

  // ---------------------------------------------------------------------
  // What the archive remembers (J14)
  // ---------------------------------------------------------------------

  /**
   * Everything the app knows about when recipes were planned, worked out
   * from the archived plans and nothing else. Nothing about planning is
   * ever written onto a recipe (J14.11): a stamp there would bump its
   * `updatedAt`, reorder the list, and let finishing a plan overwrite an
   * edit made on another device.
   *
   * Returns { [recipeId]: {lastPlannedAt, count} }. `count` is derived
   * here every time rather than stored (J14.10), and every appearance
   * counts: a recipe put in a plan twice (J12.6) is about to be eaten
   * twice, and a plan is a bag with no dates on it (J12.1), so there is
   * no week to count once instead.
   */
  function plannedIndex(archivedPlans) {
    const index = Object.create(null);
    for (const plan of archivedPlans || []) {
      const at = Number(plan && plan.completedAt) || 0;
      // Only a finished plan is a record. Clear discards a plan without
      // recording it — a week that never happened should not claim to
      // have been planned (J14.4).
      if (!at) continue;
      for (const meal of plan.meals || []) {
        const entry = index[meal.recipeId] || (index[meal.recipeId] = { lastPlannedAt: 0, count: 0 });
        entry.count += 1;
        if (at > entry.lastPlannedAt) entry.lastPlannedAt = at;
      }
    }
    return index;
  }

  /**
   * Least recently planned first, never-planned before them (J14.9). The
   * incoming order is kept between equals, so the chip narrows the list
   * rather than shuffling it.
   */
  function byLeastRecentlyPlanned(recipes, index) {
    const at = (r) => {
      const entry = index && index[r.id];
      return entry && entry.lastPlannedAt ? entry.lastPlannedAt : 0;
    };
    return recipes
      .map((r, i) => ({ r, i }))
      .sort((x, y) => at(x.r) - at(y.r) || x.i - y.i)
      .map((x) => x.r);
  }

  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /**
   * How long ago, said the ordinary way — "today", "yesterday", "3 days
   * ago", "3 weeks ago", "2 months ago" (J14.6). Counted in whole days
   * from midnight to midnight, because "yesterday" is a date and not
   * twenty-four hours.
   */
  function relativeWhen(at, now = Date.now()) {
    if (!at) return "";
    const days = Math.floor((startOfDay(now) - startOfDay(at)) / DAY_MS);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 7) return `${days} days ago`;
    if (days < 30) {
      const weeks = Math.floor(days / 7);
      return `${weeks} ${weeks === 1 ? "week" : "weeks"} ago`;
    }
    const months = Math.max(1, Math.floor(days / 30));
    return `${months} ${months === 1 ? "month" : "months"} ago`;
  }

  /**
   * What a card says about planning (J14.6). The word is always
   * "planned", never "cooked": this is a planner, not an oven, and
   * nothing here can know whether a pan was ever used (J14.5).
   *
   * A recipe that has never been planned says nothing at all — an empty
   * string, not "Never planned", which reads as a reproach on a recipe
   * typed in five minutes ago (J14.7).
   */
  function plannedLabel(at, now = Date.now()) {
    const when = relativeWhen(at, now);
    return when ? `Planned ${when}` : "";
  }

  global.RecipePlan = {
    emptyPlan,
    addMeal,
    removeMeal,
    stepPortions,
    factorFor,
    prune,
    settledFor,
    outstandingFor,
    settle,
    unsettle,
    touchedAt,
    isPlanned,
    complete,
    mergePlans,
    plannedIndex,
    byLeastRecentlyPlanned,
    relativeWhen,
    plannedLabel,
  };
})(window);
