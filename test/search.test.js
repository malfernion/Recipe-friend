/**
 * js/search.js — the J3 decisions, now askable directly.
 *
 * test/app-search.test.js covers the same ground through the app itself.
 * These add the edges that are awkward to reach by typing.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp, aRecipe } = require("./helpers/load.js");

const win = loadApp("units.js", "scale.js", "storage.js", "search.js");
const { parsePantryTerms, pantryMatches, matchesFilters, visibleRecipes, readable } = win.RecipeSearch;
const sanitize = win.RecipeStore.sanitizeRecipe;

const recipe = (over) => sanitize(aRecipe(over));

const SOUP = recipe({
  name: "Tomato Soup",
  ingredients: [
    { amount: 400, unit: "g", item: "tomatoes" },
    { amount: 1, unit: "", item: "onion" },
  ],
  steps: ["Simmer."],
  tags: ["quick"],
});
const CURRY = recipe({
  name: "Chickpea Curry",
  ingredients: [
    { amount: 400, unit: "g", item: "chickpeas" },
    { amount: 1, unit: "", item: "onion" },
    { amount: 2, unit: "cloves", item: "garlic" },
  ],
  steps: ["Cook."],
  tags: ["quick", "vegan"],
});

test("J3.4 · plural tolerance works in both directions", () => {
  assert.deepEqual(pantryMatches(SOUP, ["tomatoes"]), ["tomatoes"]);
  assert.deepEqual(pantryMatches(SOUP, ["tomato"]), ["tomato"]);
  assert.deepEqual(pantryMatches(CURRY, ["chickpea"]), ["chickpea"]);
});

test("J3.4 · a stem too short to mean anything is not used", () => {
  // "ass" stems to "as", which is inside "chickpeas". The stem is only
  // tried when it is at least three characters, so this finds nothing —
  // while the term itself still matches as a plain substring wherever it
  // genuinely appears.
  assert.deepEqual(pantryMatches(CURRY, ["ass"]), []);
  assert.deepEqual(pantryMatches(CURRY, ["as"]), ["as"], "\"as\" is really in \"chickpeas\"");
});

test("J3.3 · matching names every term the recipe uses", () => {
  assert.deepEqual(pantryMatches(CURRY, ["onion", "garlic", "beef"]).sort(),
    ["garlic", "onion"]);
});

test("a term matches the unit as well as the item", () => {
  // "cloves" is the unit on the garlic line, not part of the item.
  assert.deepEqual(pantryMatches(CURRY, ["cloves"]), ["cloves"]);
});

test("no pantry terms means no pantry opinion", () => {
  assert.deepEqual(pantryMatches(CURRY, []), []);
  assert.deepEqual(pantryMatches(CURRY, null), []);
});

test("pantry input is split on commas, trimmed, lowercased", () => {
  assert.deepEqual(parsePantryTerms(" Onion , TOMATOES ,rice"), ["onion", "tomatoes", "rice"]);
});

test("single letters and blanks are dropped from pantry input", () => {
  assert.deepEqual(parsePantryTerms("a, , onion,,x"), ["onion"]);
  assert.deepEqual(parsePantryTerms(""), []);
  assert.deepEqual(parsePantryTerms(null), []);
});

test("no criteria at all matches everything", () => {
  assert.equal(matchesFilters(SOUP, {}), true);
  assert.equal(matchesFilters(SOUP, null), true);
});

test("J3.2 · filters combine — all must pass", () => {
  const favSoup = { ...SOUP, favorite: true };
  assert.equal(matchesFilters(favSoup, { favoritesOnly: true, tag: "quick" }), true);
  assert.equal(matchesFilters(favSoup, { favoritesOnly: true, tag: "vegan" }), false);
  assert.equal(matchesFilters(SOUP, { favoritesOnly: true, tag: "quick" }), false);
  assert.equal(matchesFilters(favSoup, { favoritesOnly: true, tag: "quick", query: "curry" }), false);
});

test("J3.1 · the search term is matched against text already lowercased", () => {
  // app.js lowercases what was typed before handing it over; the haystack
  // is lowercased here. A capitalised query would silently match nothing.
  assert.equal(matchesFilters(SOUP, { query: "tomato" }), true);
  assert.equal(matchesFilters(SOUP, { query: "Tomato" }), false);
});

test("J3.3 · ranking puts the best match first and is stable below that", () => {
  const both = recipe({ name: "Both", ingredients: [
    { amount: 1, unit: "", item: "onion" }, { amount: 1, unit: "", item: "rice" }] , steps: ["x"] });
  const one = recipe({ name: "One", ingredients: [{ amount: 1, unit: "", item: "onion" }], steps: ["x"] });
  const alsoOne = recipe({ name: "AlsoOne", ingredients: [{ amount: 1, unit: "", item: "rice" }], steps: ["x"] });

  const out = visibleRecipes([one, both, alsoOne], { pantryTerms: ["onion", "rice"] });
  assert.deepEqual(out.map((r) => r.name), ["Both", "One", "AlsoOne"],
    "two matches first; the two one-match recipes keep their original order");
});

test("J3.3 · a recipe using none of your ingredients drops out entirely", () => {
  const out = visibleRecipes([SOUP, CURRY], { pantryTerms: ["chickpeas"] });
  assert.deepEqual(out.map((r) => r.name), ["Chickpea Curry"]);
});

test("without pantry terms the collection keeps its own order", () => {
  const out = visibleRecipes([CURRY, SOUP], {});
  assert.deepEqual(out.map((r) => r.name), ["Chickpea Curry", "Tomato Soup"]);
});

test("J3.1 · what search reads is exactly what the screen shows", () => {
  const prefs = { mass: "imperial", volume: "us" };
  const ing = { amount: 400, unit: "g", item: "tomatoes" };

  // 400g converts to 14.1oz, which then renders as a kitchen fraction —
  // so the text search runs against is the fraction, not the decimal.
  assert.equal(readable(ing, prefs), "14⅛ oz tomatoes");
  assert.equal(matchesFilters(SOUP, { query: "14⅛ oz", prefs }), true);
  assert.equal(matchesFilters(SOUP, { query: "oz", prefs }), true);

  // The decimal it passed through on the way is not what anyone sees, and
  // so is not what anyone can search for.
  assert.equal(matchesFilters(SOUP, { query: "14.1", prefs }), false);

  // The units as written stay searchable whatever the reader prefers.
  assert.equal(matchesFilters(SOUP, { query: "400 g", prefs }), true);
});
