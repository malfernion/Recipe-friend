/**
 * js/plan.js — the plan itself: what is in it, how two copies of it come
 * back together, and what the archive remembers (J12, J14).
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/load.js");

const win = loadApp("units.js", "scale.js", "storage.js", "plan.js");
const {
  emptyPlan, addMeal, removeMeal, stepPortions, factorFor, prune,
  settledFor, outstandingFor, settle, unsettle, touchedAt, isPlanned, complete,
  mergePlans, generationAfter, plannedIndex, byLeastRecentlyPlanned, relativeWhen,
  plannedLabel,
} = win.RecipePlan;
const sanitize = win.RecipeStore.sanitizeRecipe;

const BOLOGNESE = sanitize({
  name: "Bolognese",
  servings: 4,
  ingredients: [{ amount: 4, unit: "", item: "onions" }],
  steps: ["Cook it."],
});
const CURRY = sanitize({
  name: "Curry",
  servings: 2,
  ingredients: [{ amount: 2, unit: "", item: "onion" }],
  steps: ["Cook it."],
});
const BREAD = sanitize({
  name: "Bread",
  ingredients: [{ amount: 500, unit: "g", item: "flour" }],
  steps: ["Bake it."],
});

const DAY = 24 * 60 * 60 * 1000;

test("J12.1 · a plan is a bag of meals, with nothing assigned to a day", () => {
  const plan = emptyPlan(1000);
  assert.deepEqual(plan.meals, []);
  assert.equal(plan.completedAt, null);

  // Nothing a meal carries names a day, a date, a slot or a mealtime.
  const meal = addMeal(plan, BOLOGNESE, 2000).meals[0];
  assert.deepEqual(
    Object.keys(meal).filter((k) => /day|date|slot|week|when|night|meal ?time/i.test(k)),
    []
  );

  // And nothing about the plan depends on when its meals went in: two
  // recipes added a month apart ask for exactly the same shop as two
  // added in the same second. The shop does not care which night the
  // curry is, and neither does the plan.
  const spread = addMeal(addMeal(plan, BOLOGNESE, 2000), CURRY, 2000 + 30 * DAY);
  const together = addMeal(addMeal(plan, BOLOGNESE, 5), CURRY, 6);
  const asked = (p) => p.meals.map((m) => [m.recipeId, m.portions, m.multiplier]);
  assert.deepEqual(asked(spread), asked(together));
});

test("J12.5 · portions default to the recipe's own servings", () => {
  const plan = addMeal(emptyPlan(1000), BOLOGNESE, 2000);
  assert.equal(plan.meals[0].portions, 4);
  assert.equal(factorFor(plan.meals[0], BOLOGNESE), 1);
});

test("J12.5 · portions step one serving at a time where servings are known", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 2000);
  const id = plan.meals[0].id;
  plan = stepPortions(plan, id, "up", BOLOGNESE, 3000);
  assert.equal(plan.meals[0].portions, 5);
  assert.equal(factorFor(plan.meals[0], BOLOGNESE), 1.25);
  for (let i = 0; i < 10; i += 1) plan = stepPortions(plan, id, "down", BOLOGNESE, 4000);
  assert.equal(plan.meals[0].portions, 1, "one serving is the floor");
});

test("J12.5 · a recipe with no servings steps half a batch at a time", () => {
  let plan = addMeal(emptyPlan(1000), BREAD, 2000);
  const id = plan.meals[0].id;
  assert.equal(plan.meals[0].portions, null);
  assert.equal(factorFor(plan.meals[0], BREAD), 1);
  plan = stepPortions(plan, id, "up", BREAD, 3000);
  assert.equal(factorFor(plan.meals[0], BREAD), 1.5);
  for (let i = 0; i < 4; i += 1) plan = stepPortions(plan, id, "down", BREAD, 4000);
  assert.equal(factorFor(plan.meals[0], BREAD), 0.5, "half a batch is the floor");
});

test("J12.5 · the plan holds the portions and the recipe is never edited", () => {
  const before = JSON.stringify(BOLOGNESE);
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 2000);
  plan = stepPortions(plan, plan.meals[0].id, "up", BOLOGNESE, 3000);
  assert.equal(JSON.stringify(BOLOGNESE), before);
});

test("J12.5 · portions are an absolute target, so editing the recipe's servings does not rescale the plan", () => {
  const plan = addMeal(emptyPlan(1000), BOLOGNESE, 2000); // four portions wanted
  const halved = { ...BOLOGNESE, servings: 2 };
  // Four portions of a recipe that now serves two is two batches; the
  // meal still means four portions, which is what was asked for.
  assert.equal(factorFor(plan.meals[0], halved), 2);
});

test("J12.6 · a recipe can be planned more than once, with its own portions each", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 2000);
  plan = addMeal(plan, BOLOGNESE, 2001);
  plan = stepPortions(plan, plan.meals[1].id, "up", BOLOGNESE, 2002);
  assert.equal(plan.meals.length, 2);
  assert.notEqual(plan.meals[0].id, plan.meals[1].id);
  assert.deepEqual(plan.meals.map((m) => m.portions), [4, 5]);
});

test("J14.12 · a meal keeps the recipe's name, so a deleted recipe leaves no blank line", () => {
  const plan = addMeal(emptyPlan(1000), CURRY, 2000);
  assert.equal(plan.meals[0].name, "Curry");
  // The name is a copy taken when it was added, not a look-up: the plan
  // still reads correctly with the recipe gone.
  const pruned = prune(plan, [], 3000);
  assert.equal(plan.meals[0].name, "Curry");
  assert.deepEqual(pruned.meals, []);
});

test("J12.8 · a recipe that leaves the book leaves the plan", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 2000);
  plan = addMeal(plan, CURRY, 2001);
  const pruned = prune(plan, [BOLOGNESE.id], 3000);
  assert.deepEqual(pruned.meals.map((m) => m.name), ["Bolognese"]);
  assert.equal(pruned.updatedAt, 3000);
});

test("J12.8 · a plan with nothing to prune does not start winning merges it should lose", () => {
  const plan = addMeal(emptyPlan(1000), BOLOGNESE, 2000);
  // Pruning runs whenever the recipes are read, which is constantly.
  const pruned = prune(plan, [BOLOGNESE.id], 9999);
  assert.equal(pruned.updatedAt, 2000, "reading the list is not editing the plan");

  // Which is the point: the other phone added the curry a moment ago, and
  // a plan re-stamped for nothing would beat it and throw the curry away.
  const theirs = addMeal(plan, CURRY, 5000);
  assert.deepEqual(mergePlans(pruned, theirs).meals.map((m) => m.name), ["Bolognese", "Curry"]);
});

test("J13.12 · removing the recipe that put onions on the list does not un-settle onions", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 2000);
  plan = settle(plan, "onion|unit:", "got", 4, 2500);
  const pruned = prune(plan, [], 3000);
  assert.deepEqual(pruned.meals, []);
  assert.deepEqual(settledFor(pruned, "onion|unit:"), { have: 0, got: 4 });
});

test("J13.9 · settling a line records how much of it is settled, not that it is done", () => {
  let plan = settle(emptyPlan(1000), "onion|unit:", "got", 3, 2000);
  assert.deepEqual(settledFor(plan, "onion|unit:"), { have: 0, got: 3 });
  // Three settled against a requirement of five leaves two to buy, not none.
  assert.equal(outstandingFor(plan, "onion|unit:", 5), 2);
  assert.equal(outstandingFor(plan, "onion|unit:", 3), 0);
});

test("J13.9 · ✗ and ✓ are counted together, each keeping its own amount", () => {
  let plan = settle(emptyPlan(1000), "onion|unit:", "have", 2, 2000);
  plan = settle(plan, "onion|unit:", "got", 3, 2100);
  assert.deepEqual(settledFor(plan, "onion|unit:"), { have: 2, got: 3 });
  assert.equal(outstandingFor(plan, "onion|unit:", 6), 1);
});

test("J13.11 · a settled amount is never reduced when the requirement falls", () => {
  let plan = settle(emptyPlan(1000), "onion|unit:", "got", 6, 2000);
  assert.equal(outstandingFor(plan, "onion|unit:", 4), 0, "dropping a recipe leaves nothing outstanding");
  assert.deepEqual(settledFor(plan, "onion|unit:"), { have: 0, got: 6 }, "and forgets nothing");
  assert.equal(outstandingFor(plan, "onion|unit:", 8), 2, "putting it back surfaces exactly the shortfall");
});

test("J13.14 · a removal can be taken back — ✗ is a fast gesture, and fast gestures are mistyped", () => {
  let plan = settle(emptyPlan(1000), "onion|unit:", "have", 4, 2000);
  plan = unsettle(plan, "onion|unit:", "have", 3000);
  assert.deepEqual(settledFor(plan, "onion|unit:"), { have: 0, got: 0 });
  assert.equal(outstandingFor(plan, "onion|unit:", 4), 4);
  // Written as a zero rather than deleted, so the retraction has a
  // timestamp to win the merge with.
  assert.equal(plan.settled["onion|unit:"].have.at, 3000);
});

test("J13.14 · putting a line back retracts the whole settlement, not part of an amount", () => {
  // The requirement grew between the ✗ and the tap that took it back; the
  // retraction is still the whole of that settlement, because the gesture
  // that made it was one tap and so is the gesture that undoes it.
  let plan = settle(emptyPlan(1000), "onion|unit:", "have", 3, 2000);
  plan = unsettle(plan, "onion|unit:", "have", 3000);
  assert.equal(outstandingFor(plan, "onion|unit:", 5), 5, "all five are back on the list");
});

test("J13.14 · the retraction is stamped like any other settlement, so it wins the merge", () => {
  const settled = settle(emptyPlan(1000), "onion|unit:", "have", 4, 2000);
  const retracted = unsettle(settled, "onion|unit:", "have", 3000);
  // The device that never saw the tap still holds the settlement it made.
  for (const merged of [mergePlans(settled, retracted), mergePlans(retracted, settled)]) {
    assert.deepEqual(settledFor(merged, "onion|unit:"), { have: 0, got: 0 },
      "an older device does not quietly put back what was just taken away");
  }
  // And a settlement made after the retraction is the later word again.
  const again = settle(retracted, "onion|unit:", "have", 4, 4000);
  assert.deepEqual(settledFor(mergePlans(retracted, again), "onion|unit:"), { have: 4, got: 0 });
});

test("J13.14 · a retraction in the same millisecond as the settlement still wins the merge", () => {
  // ✗ is a fast gesture, and a fast gesture can be taken back inside the
  // same millisecond. The merge breaks a tie on the larger amount, so a
  // tie here would be the settlement beating the tap that undid it.
  const settled = settle(emptyPlan(1000), "onion|unit:", "have", 4, 2000);
  const retracted = unsettle(settled, "onion|unit:", "have", 2000);
  assert.ok(retracted.settled["onion|unit:"].have.at > 2000,
    "one hand's stamps on one line strictly increase, so it cannot tie with itself");
  for (const merged of [mergePlans(settled, retracted), mergePlans(retracted, settled)]) {
    assert.deepEqual(settledFor(merged, "onion|unit:"), { have: 0, got: 0 });
  }
});

test("J13.14 · taking back somebody else's settlement wins from a phone whose clock is behind", () => {
  const base = emptyPlan(1000);
  const theirs = settle(base, "onion|unit:", "have", 4, 9000); // their clock runs ahead
  const merged = mergePlans(base, theirs);
  const retracted = unsettle(merged, "onion|unit:", "have", 3000); // ours is minutes behind
  assert.deepEqual(settledFor(mergePlans(retracted, theirs), "onion|unit:"), { have: 0, got: 0 },
    "the tap that put the line back is the last word, whatever the two clocks say");
});

test("J12.11 · settling a line does not make one device's meals win the merge", () => {
  const base = addMeal(emptyPlan(1000), BOLOGNESE, 1000);
  const shopper = settle(base, "onion|unit:", "got", 4, 5000);
  assert.equal(shopper.updatedAt, base.updatedAt, "a settlement is not an edit to the meals");
  assert.equal(touchedAt(shopper), 5000, "though sync still has a moment to push on");

  const planner = addMeal(base, CURRY, 3000);
  const merged = mergePlans(shopper, planner);
  assert.deepEqual(merged.meals.map((m) => m.name), ["Bolognese", "Curry"], "nobody races to add the curry");
  assert.deepEqual(settledFor(merged, "onion|unit:"), { have: 0, got: 4 });
});

test("J12.11 · one person settling while another adds a meal loses neither, whichever order the two copies meet in", () => {
  const base = addMeal(emptyPlan(1000), BOLOGNESE, 1000);
  const shopper = settle(base, "onion|unit:", "got", 4, 5000);
  const planner = addMeal(base, CURRY, 3000);
  for (const merged of [mergePlans(shopper, planner), mergePlans(planner, shopper)]) {
    assert.deepEqual(merged.meals.map((m) => m.name), ["Bolognese", "Curry"], "the curry is in the plan");
    assert.deepEqual(settledFor(merged, "onion|unit:"), { have: 0, got: 4 }, "and the onions are in the basket");
    assert.equal(touchedAt(merged), 5000, "with a moment for sync to push on that covers both");
  }
  // And merging what came out again settles nothing new either way round.
  const merged = mergePlans(shopper, planner);
  assert.deepEqual(mergePlans(merged, shopper), merged);
  assert.deepEqual(mergePlans(merged, planner), merged);
});

test("J12.11 · two people settling different items keep both settlements", () => {
  const base = addMeal(emptyPlan(1000), BOLOGNESE, 1000);
  const aisleOne = settle(base, "onion|unit:", "got", 4, 5000);
  const aisleTwo = settle(base, "tomato|mass", "have", 400, 5001);
  const merged = mergePlans(aisleOne, aisleTwo);
  assert.deepEqual(settledFor(merged, "onion|unit:"), { have: 0, got: 4 });
  assert.deepEqual(settledFor(merged, "tomato|mass"), { have: 400, got: 0 });
});

test("J12.11 · two people settling the same item, whoever's write lands last still says the right total", () => {
  const base = emptyPlan(1000);
  const first = settle(base, "onion|unit:", "got", 3, 5000);
  const second = settle(base, "onion|unit:", "got", 6, 5100);
  // The stored value is an amount rather than a step, so the later write
  // is the whole truth rather than double-counting the earlier one.
  assert.deepEqual(settledFor(mergePlans(first, second), "onion|unit:"), { have: 0, got: 6 });
  assert.deepEqual(settledFor(mergePlans(second, first), "onion|unit:"), { have: 0, got: 6 });
});

test("J12.11 · ✗ and ✓ on one item merge field by field, each on its own timestamp", () => {
  const base = emptyPlan(1000);
  const atHome = settle(base, "onion|unit:", "have", 2, 5000);
  const inTheBasket = settle(base, "onion|unit:", "got", 4, 4000);
  const merged = mergePlans(atHome, inTheBasket);
  assert.deepEqual(settledFor(merged, "onion|unit:"), { have: 2, got: 4 },
    "the older ✓ is not lost to the newer ✗ — they are different questions");
});

test("J12.11 · merging is symmetric, and merging twice changes nothing", () => {
  let a = addMeal(emptyPlan(1000), BOLOGNESE, 2000);
  a = settle(a, "onion|unit:", "got", 4, 5000);
  let b = addMeal(emptyPlan(1000), CURRY, 2001);
  b = settle(b, "onion|unit:", "have", 1, 4000);
  b = settle(b, "flour|mass", "got", 500, 6000);

  const ab = mergePlans(a, b);
  const ba = mergePlans(b, a);
  assert.deepEqual(ab.settled, ba.settled);
  assert.deepEqual(ab.meals, ba.meals);
  assert.deepEqual(mergePlans(ab, b), ab);
  assert.deepEqual(mergePlans(ab, a), ab);
});

test("J12.11 · however many copies of a plan meet, and in whatever order, they agree", () => {
  // The three laws the merge has to obey to be safe on a network where
  // devices meet each other in any order and more than once. Generations
  // are the thing this fuzz is here for: a plan id decides the whole
  // merge now, so a rule that was commutative per item has to still be
  // commutative per plan.
  let seed = 20260830;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

  // A plan id and the moment it began are one fact, exactly as they are
  // in life: an id is minted with its `createdAt` and neither changes.
  const generations = [emptyPlan(0), emptyPlan(1000), emptyPlan(2000)];
  const keys = ["onion|unit:", "tomato|mass", "flour|mass"];

  function aPlan() {
    let plan = pick(generations);
    for (let i = Math.floor(rnd() * 3); i > 0; i--) {
      plan = addMeal(plan, pick([BOLOGNESE, CURRY]), plan.createdAt + Math.floor(rnd() * 400));
    }
    for (let i = Math.floor(rnd() * 4); i > 0; i--) {
      plan = settle(plan, pick(keys), pick(["have", "got"]), Math.floor(rnd() * 5),
        Math.floor(rnd() * 8) * 100);
    }
    return rnd() < 0.15 ? complete(plan, plan.createdAt + 500) : plan;
  }

  const shape = (p) => JSON.stringify({
    id: p.id,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    completedAt: p.completedAt || null,
    meals: p.meals.map((m) => `${m.id}:${m.recipeId}:${m.portions}:${m.multiplier}`).sort(),
    settled: Object.keys(p.settled).sort().map((k) => [k, settledFor(p, k)]),
  });

  for (let i = 0; i < 3000; i++) {
    const [a, b, c] = [aPlan(), aPlan(), aPlan()];
    assert.equal(shape(mergePlans(a, b)), shape(mergePlans(b, a)),
      "two phones reach the same plan whichever of them syncs first");
    const ab = mergePlans(a, b);
    assert.equal(shape(mergePlans(ab, ab)), shape(ab), "and merging twice changes nothing");
    assert.equal(shape(mergePlans(ab, a)), shape(ab), "nor does meeting a copy already folded in");
    assert.equal(
      shape(mergePlans(mergePlans(a, b), c)),
      shape(mergePlans(a, mergePlans(b, c))),
      "and three phones agree however they pair off"
    );
  }
});

test("J14.4 · a plan cleared by a phone whose clock is behind still clears", () => {
  // Done stamped the fresh plan from the clock that pressed it. A second
  // phone, minutes behind, clears that plan: a replacement dated before
  // the plan it replaces would lose the merge and hand the old week
  // straight back, for ever.
  const live = emptyPlan(9_000_000);
  const cleared = emptyPlan(generationAfter(live, 8_000_000));
  assert.equal(mergePlans(cleared, live).id, cleared.id,
    "the week that never happened is the one that goes");
});

test("J13.9 · a settled amount named __proto__ settles onions and nothing else", () => {
  // "__proto__" is a thing somebody can write in an ingredient, and an
  // item as written is what a settlement is keyed on (J13.4).
  const plan = settle(emptyPlan(1000), "__proto__", "have", 3, 2000);
  assert.deepEqual(settledFor(plan, "__proto__"), { have: 3, got: 0 });
  assert.equal({}.have, undefined, "and Object.prototype is untouched");
  assert.equal(Object.getPrototypeOf(plan.settled), null);

  const merged = mergePlans(plan, settle(emptyPlan(1000, plan.id), "constructor", "got", 1, 3000));
  assert.deepEqual(settledFor(merged, "__proto__"), { have: 3, got: 0 });
  assert.deepEqual(settledFor(merged, "constructor"), { have: 0, got: 1 });
  assert.equal(Object.getPrototypeOf(merged.settled), null);
});

test("J9.3 · the meals in a plan merge whole, most recent edit winning", () => {
  const base = addMeal(emptyPlan(1000), BOLOGNESE, 1000);
  const older = addMeal(base, CURRY, 2000);
  const newer = removeMeal(base, base.meals[0].id, 3000);
  assert.deepEqual(mergePlans(older, newer).meals, [], "the later edit is the plan");
  assert.equal(mergePlans(older, newer).updatedAt, 3000);
});

test("J12.11 · two devices merging in either order reach the same plan on an identical timestamp", () => {
  const base = emptyPlan(1000);
  const a = addMeal(base, BOLOGNESE, 2000);
  const b = addMeal(base, CURRY, 2000); // the same millisecond, two clocks
  assert.deepEqual(mergePlans(a, b).meals, mergePlans(b, a).meals);
});

test("J14.1 · Done finishes the plan and stamps it with the date it was finished", () => {
  const plan = addMeal(emptyPlan(1000), BOLOGNESE, 2000);
  const done = complete(plan, 9000);
  assert.equal(done.completedAt, 9000);
  assert.equal(plan.completedAt, null, "the live plan is left alone");
});

test("J14.3 · finishing needs at least one recipe", () => {
  const empty = emptyPlan(1000);
  assert.equal(complete(empty, 9000).completedAt, null);
});

test("J14.8 · a recipe in the live plan can say so", () => {
  const plan = addMeal(emptyPlan(1000), BOLOGNESE, 2000);
  assert.equal(isPlanned(plan, BOLOGNESE.id), true);
  assert.equal(isPlanned(plan, CURRY.id), false);
});

test("J14.10 · how often a recipe has been planned is counted from the archive", () => {
  const week = (at, recipes) => ({
    ...emptyPlan(at),
    completedAt: at,
    meals: recipes.map((r, i) => ({ id: `m${at}-${i}`, recipeId: r.id, name: r.name, portions: r.servings, multiplier: null, addedAt: at })),
  });
  const index = plannedIndex([
    week(1000, [BOLOGNESE, CURRY]),
    week(2000, [BOLOGNESE]),
    week(3000, [BOLOGNESE, BOLOGNESE]), // two nights, two entries (J12.6)
  ]);
  assert.equal(index[BOLOGNESE.id].count, 4, "every appearance counts — that is what went on the list");
  assert.equal(index[CURRY.id].count, 1);
  assert.equal(index[BREAD.id], undefined);
  assert.equal(index[BOLOGNESE.id].lastPlannedAt, 3000, "and the last of them is when it was last planned");
});

test("J14.6 · the archive says when a recipe was last planned", () => {
  const week = (at, recipes) => ({
    ...emptyPlan(at),
    completedAt: at,
    meals: recipes.map((r, i) => ({ id: `m${at}-${i}`, recipeId: r.id, name: r.name, portions: null, multiplier: 1, addedAt: at })),
  });
  const now = Date.UTC(2026, 0, 22, 12);
  const index = plannedIndex([week(now - 40 * DAY, [BOLOGNESE]), week(now - 21 * DAY, [BOLOGNESE, CURRY])]);
  assert.equal(index[BOLOGNESE.id].lastPlannedAt, now - 21 * DAY);
  assert.equal(plannedLabel(index[BOLOGNESE.id].lastPlannedAt, now), "Planned 3 weeks ago");
});

test("J14.4 · Clear discards a plan without recording it", () => {
  const unfinished = { ...addMeal(emptyPlan(1000), BOLOGNESE, 2000), completedAt: null };
  assert.deepEqual(Object.keys(plannedIndex([unfinished])), []);
});

test("J14.11 · nothing about planning is stored on the recipe", () => {
  const before = JSON.stringify(BOLOGNESE);
  const finished = complete(addMeal(emptyPlan(1000), BOLOGNESE, 2000), 3000);
  const index = plannedIndex([finished]);
  assert.equal(JSON.stringify(BOLOGNESE), before, "the recipe is left alone");
  assert.equal(index[BOLOGNESE.id].count, 1, "the archive is the record");
});

test("J14.5 · the word is always planned, and the date is the date the plan was finished", () => {
  const now = Date.UTC(2026, 0, 22, 12);
  const label = plannedLabel(now - 2 * DAY, now);
  assert.match(label, /^Planned /);
  assert.doesNotMatch(label, /cook/i);
});

test("J14.6 · when it was last planned is said the ordinary way", () => {
  const now = Date.UTC(2026, 0, 22, 12);
  assert.equal(relativeWhen(now, now), "today");
  assert.equal(relativeWhen(now - 3 * 60 * 60 * 1000, now), "today");
  assert.equal(relativeWhen(now - 1 * DAY, now), "yesterday");
  assert.equal(relativeWhen(now - 3 * DAY, now), "3 days ago");
  assert.equal(relativeWhen(now - 7 * DAY, now), "1 week ago");
  assert.equal(relativeWhen(now - 21 * DAY, now), "3 weeks ago");
  assert.equal(relativeWhen(now - 45 * DAY, now), "1 month ago");
  assert.equal(relativeWhen(now - 200 * DAY, now), "6 months ago");
});

test("J14.7 · a recipe that has never been planned says nothing at all", () => {
  const index = plannedIndex([]);
  assert.equal(index[BOLOGNESE.id], undefined);
  assert.equal(plannedLabel(undefined, Date.now()), "");
  assert.equal(plannedLabel(0, Date.now()), "");
  assert.equal(relativeWhen(null, Date.now()), "");
});

test("J14.9 · not planned lately puts never-planned first, then least recently planned", () => {
  const index = { [BOLOGNESE.id]: { lastPlannedAt: 3000, count: 1 }, [CURRY.id]: { lastPlannedAt: 1000, count: 1 } };
  const order = byLeastRecentlyPlanned([BOLOGNESE, CURRY, BREAD], index);
  assert.deepEqual(order.map((r) => r.name), ["Bread", "Curry", "Bolognese"]);
});

test("J14.9 · recipes planned equally long ago keep the order they came in", () => {
  const order = byLeastRecentlyPlanned([BOLOGNESE, CURRY, BREAD], {});
  assert.deepEqual(order.map((r) => r.name), ["Bolognese", "Curry", "Bread"]);
});
