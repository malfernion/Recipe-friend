/**
 * mcp/tools-write.js — the three tools that change something.
 *
 * The interesting assertions here are about what an agent must *not* do:
 * never record a plan (J16.4), never send up a row the server already has
 * (J16.3), never leave somebody believing a recipe landed when it did
 * not, and never offer a tool for a permission it has not got.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { agentBook, BOOK } = require("./helpers/agent.js");
const write = require("../mcp/tools-write.js");
const read = require("../mcp/tools-read.js");

const by = (name) => [...write, ...read].find((t) => t.name === name);

const PIE = {
  name: "Chicken pie",
  servings: 4,
  ingredients: [
    { amount: 500, unit: "g", item: "chicken" },
    { amount: 1, unit: "", item: "onion" },
  ],
  steps: ["Bake it."],
};
const SOUP = {
  name: "Lentil soup",
  servings: 2,
  ingredients: [
    { amount: 200, unit: "g", item: "lentils" },
    { amount: 2, unit: "", item: "onions" },
  ],
  steps: ["Simmer it."],
};

const aBook = () => agentBook({ recipes: [PIE, SOUP] });

test("J12.4 · a meal goes in at what the recipe serves unless asked otherwise", async () => {
  const { book, idOf, sent } = await aBook();

  const out = await by("add_to_plan").run(book, { meals: [{ recipeId: idOf("Chicken pie") }] });

  assert.deepEqual(out.added.map((m) => [m.name, m.portions]), [["Chicken pie", 4]]);
  assert.equal(sent.livePlans.length, 1, "the plan belongs to the book, so it goes up now");
  assert.deepEqual(sent.livePlans[0].meals.map((m) => m.name), ["Chicken pie"]);
});

test("portions are stepped the way a tap steps them, not written into the meal", async () => {
  const { book, idOf } = await aBook();

  const out = await by("add_to_plan").run(book, {
    meals: [{ recipeId: idOf("Chicken pie"), portions: 6 }, { recipeId: idOf("Lentil soup"), portions: 1 }],
  });

  assert.deepEqual(out.added.map((m) => [m.name, m.portions]), [["Chicken pie", 6], ["Lentil soup", 1]]);
  // And the list is the arithmetic those portions imply, not the recipe's.
  assert.ok(out.plan.toBuy.includes("750 g chicken"), out.plan.toBuy.join(" · "));
});

test("a recipe that is not in the book is reported rather than silently skipped", async () => {
  const { book, idOf } = await aBook();

  const out = await by("add_to_plan").run(book, {
    meals: [{ recipeId: idOf("Lentil soup") }, { recipeId: "gone" }],
  });

  assert.deepEqual(out.added.map((m) => m.name), ["Lentil soup"]);
  assert.deepEqual(out.missing, ["gone"]);
});

test("J14.4 · a meal can come back out, and nothing is written down about it", async () => {
  const { book, idOf, sent } = await aBook();
  const added = await by("add_to_plan").run(book, { meals: [{ recipeId: idOf("Chicken pie") }] });

  const out = await by("remove_from_plan").run(book, { mealIds: [added.added[0].mealId] });

  assert.deepEqual(out.removed.map((m) => m.name), ["Chicken pie"]);
  assert.deepEqual(out.plan.meals, []);
  assert.deepEqual(sent.archived, [], "clearing records nothing");
});

test("a mealId that is not in the plan is an answer, not a failure", async () => {
  const { book } = await aBook();

  const out = await by("remove_from_plan").run(book, { mealIds: ["not-a-meal"] });

  assert.deepEqual(out.removed, []);
  assert.deepEqual(out.missing, ["not-a-meal"]);
});

test("J12.11 · a meal somebody added from a phone survives the agent's write", async () => {
  const { book, win, idOf, setRemotePlan, sent } = await aBook();

  // The agent plans a soup, and it goes up.
  await by("add_to_plan").run(book, { meals: [{ recipeId: idOf("Lentil soup") }] });
  const asPushed = sent.livePlans.at(-1);

  // Then a phone puts a pie in the same plan, a moment later, and that
  // is what the book now holds. Meals do not merge — for one plan the
  // more recently touched body wins whole — so a tool that wrote onto
  // the copy it read a minute ago would eat that pie.
  const pie = book.recipes.find((r) => r.name === "Chicken pie");
  setRemotePlan(win.RecipePlan.addMeal(asPushed, pie, asPushed.updatedAt + 1));
  // Let the clock past the phone's write, so the agent's own is the
  // later one when it comes to push. Milliseconds, and real ones: this
  // is the ordering the app itself runs on.
  await new Promise((resume) => setTimeout(resume, 5));

  await by("add_to_plan").run(book, { meals: [{ recipeId: idOf("Lentil soup") }] });

  assert.deepEqual(
    sent.livePlans.at(-1).meals.map((m) => m.name).sort(),
    ["Chicken pie", "Lentil soup", "Lentil soup"]
  );
});

test("J16.3 · a filed recipe goes up as a row the server has never seen", async () => {
  const { book, sent } = await aBook();

  const out = await by("add_recipe").run(book, {
    name: "Dal",
    servings: 2,
    ingredients: [{ amount: 200, unit: "g", item: "red lentils" }],
    steps: ["Simmer it."],
    tags: ["quick"],
  });

  assert.equal(out.added.name, "Dal");
  assert.match(out.note, /cannot delete/);
  assert.deepEqual(sent.recipes.map((r) => r.data.name), ["Dal"], "and nothing else went with it");
  assert.equal(sent.recipes[0].book_id, BOOK, "as a row for this book, built by sync");
});

test("J16.11 · a recipe below the floor is refused, the same as from anybody", async () => {
  const { book, sent } = await aBook();

  for (const short of [
    { name: "", ingredients: [{ item: "x" }], steps: ["do"] },
    { name: "No steps", ingredients: [{ item: "x" }], steps: [] },
    { name: "No ingredients", ingredients: [], steps: ["do"] },
  ]) {
    const out = await by("add_recipe").run(book, short);
    assert.match(out.error, /needs a name, at least one ingredient and at least one step/);
  }
  assert.deepEqual(sent.recipes, [], "nothing refused was sent anywhere");
});

test("a recipe that could not be sent does not leave somebody thinking it landed", async () => {
  const { book, breakNetwork } = await aBook();
  breakNetwork();

  await assert.rejects(
    () =>
      by("add_recipe").run(book, {
        name: "Dal",
        ingredients: [{ amount: 200, unit: "g", item: "red lentils" }],
        steps: ["Simmer it."],
      }),
    /Could not reach the book/
  );

  // The cache is memory and dies with the process, so a row left in it
  // would be a recipe somebody was told they had.
  assert.deepEqual(book.recipes.map((r) => r.name).sort(), ["Chicken pie", "Lentil soup"]);
});

test("J16.4 · no tool exists for anything the credential cannot do", () => {
  const names = [...read, ...write].map((t) => t.name);

  assert.deepEqual(names.filter((n) => /edit|update|delete|remove_recipe|favourite|favorite|star|done|finish|complete/.test(n)), []);
  // A tool that is always refused is worse than one that is not there:
  // the model keeps trying it and reads the refusal as its own mistake.
  assert.deepEqual(names.sort(), [
    "add_recipe", "add_to_plan", "find_recipes", "get_plan", "get_recipe",
    "list_recipes", "planning_history", "recipes_sharing_ingredients", "remove_from_plan",
  ]);
});

test("the one-way tool says so twice: to the client in a hint, to the model in words", () => {
  const filing = by("add_recipe");
  assert.equal(filing.annotations.readOnlyHint, false);
  assert.equal(filing.annotations.destructiveHint, true);
  assert.match(filing.description, /cannot be undone/i);
  assert.match(filing.description, /permanent until a person removes it/);

  // The plan tools are reversible and must not claim otherwise, or a
  // host asks about every one of them and nobody reads the questions.
  for (const name of ["add_to_plan", "remove_from_plan"]) {
    assert.equal(by(name).annotations.readOnlyHint, false, name);
    assert.equal(by(name).annotations.destructiveHint, false, name);
  }
});
