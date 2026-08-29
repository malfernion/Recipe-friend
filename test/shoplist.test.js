/**
 * js/shoplist.js — the shop a plan adds up to (J13), and the settling
 * that turns it into what is actually left to buy.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/load.js");

const win = loadApp("units.js", "scale.js", "storage.js", "plan.js", "shoplist.js");
const { emptyPlan, addMeal, removeMeal, stepPortions, prune, settledFor } = win.RecipePlan;
const { build, copyText, itemKey, stemWord, settleAmount, settleLine, unsettleLine } = win.RecipeShopList;
const sanitize = win.RecipeStore.sanitizeRecipe;

const METRIC = { mass: "metric", volume: "metric" };
const IMPERIAL = { mass: "imperial", volume: "us" };

const BOLOGNESE = sanitize({
  name: "Bolognese",
  servings: 4,
  ingredients: [
    { amount: 3, unit: "", item: "onions" },
    { amount: 400, unit: "g", item: "tomatoes" },
    { amount: 1, unit: "tbsp", item: "olive oil" },
    { amount: null, unit: "", item: "salt" },
  ],
  steps: ["Cook it."],
});
const CURRY = sanitize({
  name: "Curry",
  servings: 2,
  ingredients: [
    { amount: 2, unit: "", item: "onion" },
    { amount: 1, unit: "tin", item: "tomatoes" },
    { amount: 3, unit: "tsp", item: "olive oil" },
    { amount: null, unit: "", item: "salt" },
  ],
  steps: ["Cook it."],
});
// Twelve servings of half a teaspoon: one portion of it is an amount the
// app cannot render at all (J4.8), which is the point of J13.2 and J13.3.
const CAKE = sanitize({
  name: "Cake",
  servings: 12,
  ingredients: [{ amount: 0.5, unit: "tsp", item: "bicarbonate of soda" }],
  steps: ["Bake it."],
});

const BOOK = [BOLOGNESE, CURRY, CAKE];

/** Step a meal down to the portions a test wants, the way a tap would. */
function toPortions(plan, mealId, recipe, target) {
  let next = plan;
  let guard = 100;
  while (next.meals.find((m) => m.id === mealId).portions > target && guard--) {
    next = stepPortions(next, mealId, "down", recipe, 1);
  }
  return next;
}

const lineFor = (list, key) => list.lines.find((l) => l.key === key);
const onions = (list) => lineFor(list, "onion|unit:");

test("J13.1 · the list is every planned recipe's ingredients, scaled to the portions planned, summed", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  plan = addMeal(plan, CURRY, 1002);
  const list = build(plan, BOOK, METRIC);
  assert.equal(onions(list).text, "5 onions");
  assert.deepEqual(list.lines.map((l) => l.text).sort(), [
    "1 tbsp olive oil", "1 tin tomatoes", "3 tsp olive oil", "400 g tomatoes", "5 onions", "salt",
  ]);
});

test("J13.1 · doubling the portions doubles what to buy", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  const id = plan.meals[0].id;
  for (let i = 0; i < 4; i += 1) plan = stepPortions(plan, id, "up", BOLOGNESE, 1002);
  const list = build(plan, BOOK, METRIC);
  assert.equal(onions(list).text, "6 onions");
  assert.equal(lineFor(list, "tomato|mass").text, "800 g tomatoes");
});

test("J12.6 · a recipe planned twice sums without the list caring", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  plan = addMeal(plan, BOLOGNESE, 1002);
  const list = build(plan, BOOK, METRIC);
  assert.equal(onions(list).text, "6 onions");
  assert.equal(onions(list).from.length, 2, "two nights, two entries");
});

test("J13.2 · summing happens in base units and is formatted once, at the end", () => {
  // Three single portions of a cake serving twelve: each is 1/24 tsp,
  // which J4.8 renders as "0". Formatting first and adding the results
  // would lose the ingredient; summing first finds an eighth of a spoon.
  let plan = emptyPlan(1000);
  for (let i = 0; i < 3; i += 1) {
    plan = addMeal(plan, CAKE, 1000 + i);
    plan = toPortions(plan, plan.meals[i].id, CAKE, 1);
  }
  const line = build(plan, BOOK, METRIC).lines[0];
  assert.equal(line.text, "⅛ tsp bicarbonate of soda");
  assert.ok(Math.abs(line.required - 0.125) < 1e-9);
  assert.deepEqual(line.from.map((c) => c.text), ["", "", ""], "each on its own would say nothing");
});

test("J13.3 · a shopping quantity is never rendered as 0", () => {
  let plan = addMeal(emptyPlan(1000), CAKE, 1001);
  plan = toPortions(plan, plan.meals[0].id, CAKE, 1);
  const line = build(plan, BOOK, METRIC).lines[0];
  assert.equal(line.amount, null);
  assert.equal(line.unit, "", "and no bare unit either — 'tsp bicarbonate of soda' is no better");
  assert.equal(line.text, "bicarbonate of soda");
  assert.doesNotMatch(copyText(build(plan, BOOK, METRIC)), /0/);
});

test("J13.4 · lines combine on the item as written, tolerating simple plurals", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001); // "onions"
  plan = addMeal(plan, CURRY, 1002); // "onion"
  const list = build(plan, BOOK, METRIC);
  assert.equal(list.lines.filter((l) => l.item.startsWith("onion")).length, 1);
  assert.equal(onions(list).required, 5);
  // The same word, however it was typed — one rule, and it is search's.
  assert.equal(stemWord("tomatoes"), stemWord("tomato"));
  assert.equal(stemWord("limes"), stemWord("lime"));
  assert.equal(stemWord("Cloves "), stemWord("clove"));
  assert.notEqual(stemWord("onion"), stemWord("garlic"));
});

test("J13.5 · 400 g tomatoes and 1 tin tomatoes are two lines", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  plan = addMeal(plan, CURRY, 1002);
  const list = build(plan, BOOK, METRIC);
  const tomatoes = list.lines.filter((l) => l.item === "tomatoes");
  assert.deepEqual(tomatoes.map((l) => l.text), ["400 g tomatoes", "1 tin tomatoes"]);
  assert.notEqual(tomatoes[0].key, tomatoes[1].key, "and they settle separately");
});

test("J13.5 · three teaspoons and a tablespoon are two lines, and that is the same decision as the tin", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001); // 1 tbsp oil
  plan = addMeal(plan, CURRY, 1002); // 3 tsp oil
  const list = build(plan, BOOK, METRIC);
  const oil = list.lines.filter((l) => l.item === "olive oil");
  assert.deepEqual(oil.map((l) => l.text), ["1 tbsp olive oil", "3 tsp olive oil"]);
});

test("J13.5 · mass combines with mass and volume with volume, since those convert", () => {
  const kilos = sanitize({
    name: "Kilos", servings: 1,
    ingredients: [{ amount: 1, unit: "kg", item: "flour" }, { amount: 8, unit: "oz", item: "flour" }],
    steps: ["Mix."],
  });
  const plan = addMeal(emptyPlan(1000), kilos, 1001);
  const list = build(plan, [kilos], METRIC);
  assert.equal(list.lines.length, 1);
  assert.equal(list.lines[0].text, "1¼ kg flour", "one kilo and eight ounces, said once");
});

test("J13.6 · amounts are shown in the reader's preferred units", () => {
  const plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  assert.equal(lineFor(build(plan, BOOK, METRIC), "tomato|mass").text, "400 g tomatoes");
  assert.equal(lineFor(build(plan, BOOK, IMPERIAL), "tomato|mass").text, "14⅛ oz tomatoes");
  // The line is the same line either way: settling it in one book from
  // one phone settles it for the other reader too.
  assert.equal(
    lineFor(build(plan, BOOK, METRIC), "tomato|mass").key,
    lineFor(build(plan, BOOK, IMPERIAL), "tomato|mass").key
  );
});

test("J13.7 · every line says what it is made of", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  plan = addMeal(plan, CURRY, 1002);
  const line = onions(build(plan, BOOK, METRIC));
  assert.deepEqual(line.from.map((c) => `${c.name} ${c.text}`), ["Bolognese 3", "Curry 2"]);
});

test("J13.7 · what a line is made of is counted in the unit the line is shown in", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  plan = addMeal(plan, BOLOGNESE, 1002);
  const line = lineFor(build(plan, BOOK, IMPERIAL), "tomato|mass");
  assert.equal(line.text, "1¾ lb tomatoes");
  // Halves of a pound, not four hundreds of a gram: the line reads in
  // pounds, so what it is made of does too.
  assert.deepEqual(line.from.map((c) => c.text), ["⅞", "⅞"]);
});

test("J13.8 · lines with no amount are grouped at the end and never summed", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  plan = addMeal(plan, CURRY, 1002);
  const list = build(plan, BOOK, METRIC);
  assert.equal(list.lines[list.lines.length - 1].item, "salt", "grouped at the end");
  const salt = list.lines[list.lines.length - 1];
  assert.equal(salt.toTaste, true);
  assert.equal(salt.text, "salt", "a thing you might be out of, not a quantity");
  assert.equal(salt.required, 1, "two recipes wanting salt want salt once");
});

test("J13.8 · settling a to-taste line is not undone by a second recipe wanting it", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  let list = build(plan, BOOK, METRIC);
  const salt = list.lines.find((l) => l.toTaste);
  plan = settleLine(plan, salt, "have", 2000);
  plan = addMeal(plan, CURRY, 2001);
  list = build(plan, BOOK, METRIC);
  assert.equal(list.lines.find((l) => l.toTaste).outstanding, 0);
  assert.equal(list.lines.find((l) => l.toTaste).settled, "have");
});

test("J13.9 · settling a line records how much of it is settled, not that it is done", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001); // three onions
  let list = build(plan, BOOK, METRIC);
  plan = settleLine(plan, onions(list), "got", 2000);
  assert.equal(onions(build(plan, BOOK, METRIC)).outstanding, 0);

  plan = addMeal(plan, CURRY, 3000); // wants two more
  list = build(plan, BOOK, METRIC);
  assert.equal(onions(list).required, 5);
  assert.equal(onions(list).outstanding, 2, "planning another recipe brings two onions back");
  assert.equal(onions(list).got, 3, "and leaves the three already settled undisturbed");
  assert.equal(onions(list).settled, "", "so it is back on the list");
});

test("J13.9 · ✓ on a line half of which is already at home asks for the half that is not", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  plan = addMeal(plan, CURRY, 1002); // five onions between them
  let list = build(plan, BOOK, METRIC);
  plan = win.RecipePlan.settle(plan, onions(list).key, "have", 2, 2000);
  list = build(plan, BOOK, METRIC);
  assert.equal(settleAmount(onions(list), "got"), 3, "three, not five");
  plan = settleLine(plan, onions(list), "got", 2100);
  assert.deepEqual(settledFor(plan, onions(list).key), { have: 2, got: 3 });
  assert.equal(onions(build(plan, BOOK, METRIC)).outstanding, 0);
});

test("J13.10 · a settled amount is never reduced when the requirement falls", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  plan = addMeal(plan, CURRY, 1002);
  let list = build(plan, BOOK, METRIC);
  const key = onions(list).key;
  plan = win.RecipePlan.settle(plan, key, "got", 3, 2000); // three of the five

  const curryId = plan.meals[1].id;
  const without = removeMeal(plan, curryId, 3000);
  assert.equal(onions(build(without, BOOK, METRIC)).outstanding, 0, "dropping a recipe leaves nothing outstanding");
  assert.equal(settledFor(without, key).got, 3, "and nothing is forgotten");

  const back = addMeal(without, CURRY, 4000);
  assert.equal(onions(build(back, BOOK, METRIC)).outstanding, 2, "putting it back surfaces exactly the shortfall");
});

test("J13.11 · settled amounts are held per item, so removing the recipe that put onions on the list does not un-settle onions", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  plan = addMeal(plan, CURRY, 1002);
  let list = build(plan, BOOK, METRIC);
  plan = settleLine(plan, onions(list), "got", 2000); // all five

  // J12.8: the recipe leaves the book, so it leaves the plan.
  const pruned = prune(plan, [CURRY.id, CAKE.id], 3000);
  list = build(pruned, BOOK, METRIC);
  assert.equal(onions(list).required, 2);
  assert.equal(onions(list).got, 5);
  assert.equal(onions(list).outstanding, 0);
});

test("J12.8 · a plan naming a recipe the book no longer has contributes nothing to the list", () => {
  const plan = addMeal(emptyPlan(1000), CURRY, 1001);
  assert.deepEqual(build(plan, [BOLOGNESE], METRIC).lines, []);
});

test("J13.12 · copy gives what is left, one line per item, amount first", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  const list = build(plan, BOOK, METRIC);
  assert.equal(copyText(list), "3 onions\n400 g tomatoes\n1 tbsp olive oil\nsalt");
});

test("J13.12 · copying twice never asks for the same thing twice", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  let list = build(plan, BOOK, METRIC);
  const first = copyText(list);
  assert.match(first, /3 onions/);

  plan = settleLine(plan, onions(list), "got", 2000); // into the basket
  plan = settleLine(plan, lineFor(list, "tomato|mass"), "have", 2001); // already at home
  list = build(plan, BOOK, METRIC);
  const second = copyText(list);
  assert.doesNotMatch(second, /onion/, "what is in the basket is not asked for again");
  assert.doesNotMatch(second, /tomato/, "and neither is what was removed");
  assert.equal(second, "1 tbsp olive oil\nsalt");
});

test("J13.9 · a settled line reports which gesture settled it", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  let list = build(plan, BOOK, METRIC);
  plan = settleLine(plan, onions(list), "got", 2000);
  plan = settleLine(plan, lineFor(list, "tomato|mass"), "have", 2001);
  list = build(plan, BOOK, METRIC);
  assert.deepEqual(list.inBasket.map((l) => l.item), ["onions"], "struck out in place");
  assert.deepEqual(list.alreadyHave.map((l) => l.item), ["tomatoes"], "collapsed into what you already have");
  assert.deepEqual(list.toBuy.map((l) => l.item), ["olive oil", "salt"]);
});

test("J13.13 · removed lines are not gone, and one tap puts one back", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  let list = build(plan, BOOK, METRIC);
  plan = settleLine(plan, onions(list), "have", 2000);
  list = build(plan, BOOK, METRIC);
  assert.equal(list.alreadyHave.length, 1);

  plan = unsettleLine(plan, onions(list), "have", 3000);
  list = build(plan, BOOK, METRIC);
  assert.equal(list.alreadyHave.length, 0);
  assert.equal(onions(list).outstanding, 3, "back on the list, in full");
});

test("J14.2 · a plan is finished by itself when the last outstanding line is settled", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  let list = build(plan, BOOK, METRIC);
  assert.equal(list.allSettled, false);
  for (const line of list.lines) plan = settleLine(plan, line, "got", 2000);
  assert.equal(build(plan, BOOK, METRIC).allSettled, true);
});

test("J14.2 · settling the last line with ✗ counts — a week you already had everything for was still planned", () => {
  let plan = addMeal(emptyPlan(1000), BOLOGNESE, 1001);
  const list = build(plan, BOOK, METRIC);
  for (const line of list.lines) plan = settleLine(plan, line, "have", 2000);
  assert.equal(build(plan, BOOK, METRIC).allSettled, true);
});

test("J14.3 · an empty plan has nothing to record and is never all settled", () => {
  const list = build(emptyPlan(1000), BOOK, METRIC);
  assert.deepEqual(list.lines, []);
  assert.equal(list.allSettled, false);
});

test("J13.4 · the item key is the item and what it is measured in, and nothing else", () => {
  assert.equal(itemKey("Tomatoes", "g"), itemKey("tomato", "kg"), "mass keys with mass");
  assert.equal(itemKey("milk", "ml"), itemKey("Milk", "l"), "volume with volume");
  assert.notEqual(itemKey("tomatoes", "g"), itemKey("tomatoes", "tin"));
  assert.notEqual(itemKey("cumin", "tsp"), itemKey("cumin", "tbsp"));
  assert.equal(itemKey("garlic", "cloves"), itemKey("garlic", "clove"));
  assert.notEqual(itemKey("salt", "", true), itemKey("salt", "tsp"), "to taste is not a quantity");
});
