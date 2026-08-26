/**
 * J3 · Finding something to cook — driven through the app itself.
 *
 * These go in the front door: type in the search box, click a chip, and
 * read what the list shows. They are deliberately written at that level so
 * they keep their meaning when the code behind them moves — the same
 * assertions ran green before the search logic was lifted out of app.js
 * and after it.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadUI, aRecipe } = require("./helpers/load.js");

/** A loaded app holding the given recipes, plus ways to poke it. */
function appWith(recipes) {
  const ui = loadUI();
  for (const r of recipes) ui.store.add(r);
  ui.app.render();

  const titles = () => {
    const out = [];
    const re = /<h3 class="card-title">([^<]*)<\/h3>/g;
    let m;
    while ((m = re.exec(ui.el("recipe-list").innerHTML))) out.push(m[1]);
    return out;
  };
  const search = (text) => {
    ui.el("search-input").value = text;
    ui.el("search-input").fire("input");
  };
  const pantry = (text) => {
    ui.el("pantry-toggle").fire("click");
    ui.el("pantry-input").value = text;
    ui.el("pantry-input").fire("input");
  };
  return { ...ui, titles, search, pantry };
}

const ROAST = aRecipe({
  name: "Sunday Roast",
  description: "A proper one",
  ingredients: [{ amount: 2, unit: "kg", item: "beef topside" }],
  steps: ["Roast it."],
  tags: ["sunday", "beef"],
});
const SOUP = aRecipe({
  name: "Tomato Soup",
  description: "Quick weeknight",
  ingredients: [
    { amount: 400, unit: "g", item: "tomatoes" },
    { amount: 1, unit: "", item: "onion" },
  ],
  steps: ["Simmer."],
  tags: ["quick"],
});
const CURRY = aRecipe({
  name: "Chickpea Curry",
  ingredients: [
    { amount: 400, unit: "g", item: "chickpeas" },
    { amount: 2, unit: "cloves", item: "garlic" },
    { amount: 1, unit: "", item: "onion" },
  ],
  steps: ["Cook."],
  tags: ["quick", "vegan"],
});

test("J3.1 · search matches a recipe name", () => {
  const app = appWith([ROAST, SOUP]);
  app.search("roast");
  assert.deepEqual(app.titles(), ["Sunday Roast"]);
});

test("J3.1 · search matches descriptions, ingredients and tags", () => {
  const app = appWith([ROAST, SOUP, CURRY]);

  app.search("weeknight");
  assert.deepEqual(app.titles(), ["Tomato Soup"], "description");

  app.search("chickpeas");
  assert.deepEqual(app.titles(), ["Chickpea Curry"], "ingredient");

  app.search("vegan");
  assert.deepEqual(app.titles(), ["Chickpea Curry"], "tag");
});

test("J3.1 · search is case-insensitive and matches partial words", () => {
  const app = appWith([ROAST, SOUP]);
  app.search("TOMATO");
  assert.deepEqual(app.titles(), ["Tomato Soup"]);
  app.search("tops");
  assert.deepEqual(app.titles(), ["Sunday Roast"]);
});

test("J3.1 · an ingredient matches as you see it, not only as written", () => {
  const app = appWith([SOUP]);
  // Stored in grams. Read by someone who prefers ounces, "oz" should find it.
  app.store.setPrefs({ mass: "imperial", volume: "us" });
  app.app.render();
  app.search("oz");
  assert.deepEqual(app.titles(), ["Tomato Soup"]);

  // And it is still findable by the units it was written in.
  app.search("400 g");
  assert.deepEqual(app.titles(), ["Tomato Soup"]);
});

test("J3.2 · a tag chip narrows the list, and clicking it again clears it", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  app.el("tag-filters").fire("click", {
    target: { closest: () => ({ dataset: { tag: "quick" } }) },
  });
  assert.deepEqual(app.titles().sort(), ["Chickpea Curry", "Tomato Soup"]);
});

test("J3.2 · the favourites filter narrows the list, and combines with search", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  // update() deliberately preserves `favorite` — starring has its own path.
  const soup = app.store.recipes.find((r) => r.name === "Tomato Soup");
  app.store.toggleFavorite(soup.id);

  app.el("favorites-filter").fire("click");
  assert.deepEqual(app.titles(), ["Tomato Soup"]);

  app.search("curry");
  assert.deepEqual(app.titles(), [], "a favourites filter and a search both apply");
});

test("J3.3 · what can I cook ranks by how many of your ingredients are used", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  app.pantry("onion, chickpeas");
  // Curry uses both, soup uses one, roast uses neither and drops out.
  assert.deepEqual(app.titles(), ["Chickpea Curry", "Tomato Soup"]);
});

test("J3.3 · a card names which of your ingredients it uses", () => {
  const app = appWith([CURRY]);
  app.pantry("chickpeas");
  assert.match(app.el("recipe-list").innerHTML, /chickpeas/);
});

test("J3.4 · ingredient matching tolerates simple plurals", () => {
  const app = appWith([SOUP]);
  app.pantry("tomatoes");
  assert.deepEqual(app.titles(), ["Tomato Soup"], "plural term finds singular ingredient");

  const app2 = appWith([SOUP]);
  app2.pantry("tomato");
  assert.deepEqual(app2.titles(), ["Tomato Soup"], "singular term finds plural ingredient");
});

test("a search matching nothing says so rather than showing an empty page", () => {
  const app = appWith([ROAST]);
  app.search("zzzz");
  assert.deepEqual(app.titles(), []);
  assert.match(app.el("recipe-list").innerHTML, /No recipes match/);
});

test("clearing the search brings everything back", () => {
  const app = appWith([ROAST, SOUP]);
  app.search("roast");
  assert.equal(app.titles().length, 1);
  app.search("");
  assert.equal(app.titles().length, 2);
});
