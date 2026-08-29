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
  mergePlans, plannedIndex, byLeastRecentlyPlanned, relativeWhen, plannedLabel,
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
  // Nothing in a meal names a day, a slot or a date beyond when it went in.
  const withMeal = addMeal(plan, BOLOGNESE, 2000);
  assert.deepEqual(Object.keys(withMeal.meals[0]).sort(),
    ["addedAt", "id", "multiplier", "name", "portions", "recipeId"]);
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

test("J12.8 · a plan with nothing to prune is left exactly as it was", () => {
  const plan = addMeal(emptyPlan(1000), BOLOGNESE, 2000);
  // Pruning runs whenever the recipes are read; re-stamping a plan that
  // did not change would let it start winning merges it should lose.
  assert.equal(prune(plan, [BOLOGNESE.id], 9999), plan);
});

test("J13.11 · removing the recipe that put onions on the list does not un-settle onions", () => {
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

test("J13.10 · a settled amount is never reduced when the requirement falls", () => {
  let plan = settle(emptyPlan(1000), "onion|unit:", "got", 6, 2000);
  assert.equal(outstandingFor(plan, "onion|unit:", 4), 0, "dropping a recipe leaves nothing outstanding");
  assert.deepEqual(settledFor(plan, "onion|unit:"), { have: 0, got: 6 }, "and forgets nothing");
  assert.equal(outstandingFor(plan, "onion|unit:", 8), 2, "putting it back surfaces exactly the shortfall");
});

test("J13.13 · a removal can be taken back — ✗ is a fast gesture, and fast gestures are mistyped", () => {
  let plan = settle(emptyPlan(1000), "onion|unit:", "have", 4, 2000);
  plan = unsettle(plan, "onion|unit:", "have", 3000);
  assert.deepEqual(settledFor(plan, "onion|unit:"), { have: 0, got: 0 });
  assert.equal(outstandingFor(plan, "onion|unit:", 4), 4);
  // Written as a zero rather than deleted, so the retraction has a
  // timestamp to win the merge with.
  assert.equal(plan.settled["onion|unit:"].have.at, 3000);
});

test("J13.13 · putting a line back retracts the whole settlement, not part of an amount", () => {
  // The requirement grew between the ✗ and the tap that took it back; the
  // retraction is still the whole of that settlement, because the gesture
  // that made it was one tap and so is the gesture that undoes it.
  let plan = settle(emptyPlan(1000), "onion|unit:", "have", 3, 2000);
  plan = unsettle(plan, "onion|unit:", "have", 3000);
  assert.equal(outstandingFor(plan, "onion|unit:", 5), 5, "all five are back on the list");
});

test("J13.13 · the retraction is stamped like any other settlement, so it wins the merge", () => {
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
