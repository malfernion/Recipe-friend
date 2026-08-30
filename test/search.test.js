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

// plan.js goes in because "not planned lately" is an ordering over
// recipes (J14.9), and orderings over recipes live here — the archive it
// reads is handed in, so this file still knows nothing about where a book
// keeps its plans.
const win = loadApp("units.js", "scale.js", "storage.js", "plan.js", "search.js");
const { parseTerms, matchedTerms, matchesFilters, visibleRecipes, readable } = win.RecipeSearch;
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
  // The criterion's own example, and the only shape that needs the stem:
  // a plural term against text that is singular throughout. Everything
  // else here would match as a plain substring anyway.
  const PUREE = recipe({
    name: "Ragu",
    ingredients: [{ amount: 400, unit: "g", item: "tomato purée" }],
    steps: ["Simmer."],
  });
  assert.deepEqual(matchedTerms(PUREE, ["tomatoes"]), ["tomatoes"],
    "plural term finds singular text");

  // The other direction needs no stem — a singular term is a substring of
  // its own plural — but it is the half people expect, so pin it too.
  assert.deepEqual(matchedTerms(SOUP, ["tomato"]), ["tomato"]);
  assert.deepEqual(matchedTerms(SOUP, ["tomatoes"]), ["tomatoes"]);
});

test("J3.4 · a stem too short to mean anything is not used", () => {
  // "ass" stems to "as", which is inside "chickpeas". The stem is only
  // tried when it is at least three characters, so this finds nothing —
  // while the term itself still matches as a plain substring wherever it
  // genuinely appears.
  assert.deepEqual(matchedTerms(CURRY, ["ass"]), []);
  assert.deepEqual(matchedTerms(CURRY, ["as"]), ["as"], "\"as\" is really in \"chickpeas\"");
});

test("J3.3 · a term matches anywhere the reader can see it, not only the ingredients", () => {
  // The one behaviour the merged search adds over the old pantry box: a
  // listed term reaches the name, description and tags too, exactly as a
  // plain search term always has (J3.1).
  assert.deepEqual(matchedTerms(CURRY, ["chickpea"]), ["chickpea"], "the name");
  assert.deepEqual(matchedTerms(CURRY, ["vegan"]), ["vegan"], "a tag");
  assert.deepEqual(matchedTerms(SOUP, ["vegan"]), []);
});

test("J3.3 · matching names every term the recipe uses", () => {
  assert.deepEqual(matchedTerms(CURRY, ["onion", "garlic", "beef"]).sort(),
    ["garlic", "onion"]);
});

test("a term matches the unit as well as the item", () => {
  // "cloves" is the unit on the garlic line, not part of the item.
  assert.deepEqual(matchedTerms(CURRY, ["cloves"]), ["cloves"]);
});

test("no terms means no opinion", () => {
  assert.deepEqual(matchedTerms(CURRY, []), []);
  assert.deepEqual(matchedTerms(CURRY, null), []);
});

test("a query is split on commas, trimmed, lowercased", () => {
  assert.deepEqual(parseTerms(" Onion , TOMATOES ,rice"), ["onion", "tomatoes", "rice"]);
});

test("blanks are dropped, single letters are not", () => {
  // The old pantry box dropped single letters, which mean nothing in a
  // list of ingredients. As the only term in a search box one is a
  // legitimate way to narrow a long list, so it survives.
  assert.deepEqual(parseTerms("a, , onion,,"), ["a", "onion"]);
  assert.deepEqual(parseTerms(""), []);
  assert.deepEqual(parseTerms(null), []);
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
  assert.equal(matchesFilters(favSoup, { favoritesOnly: true, tag: "quick", terms: ["curry"] }), false);
});

test("J3.1 · the search term is matched against text already lowercased", () => {
  // parseTerms lowercases what was typed before handing it over; the
  // haystack is lowercased here. A capitalised term would match nothing.
  assert.equal(matchesFilters(SOUP, { terms: ["tomato"] }), true);
  assert.equal(matchesFilters(SOUP, { terms: ["Tomato"] }), false);
});

test("J3.3 · ranking puts the best match first and is stable below that", () => {
  const both = recipe({ name: "Both", ingredients: [
    { amount: 1, unit: "", item: "onion" }, { amount: 1, unit: "", item: "rice" }] , steps: ["x"] });
  const one = recipe({ name: "One", ingredients: [{ amount: 1, unit: "", item: "onion" }], steps: ["x"] });
  const alsoOne = recipe({ name: "AlsoOne", ingredients: [{ amount: 1, unit: "", item: "rice" }], steps: ["x"] });

  const out = visibleRecipes([one, both, alsoOne], { terms: ["onion", "rice"] });
  assert.deepEqual(out.map((r) => r.name), ["Both", "One", "AlsoOne"],
    "two matches first; the two one-match recipes keep their original order");
});

test("J3.3 · a recipe matching none of the terms drops out entirely", () => {
  const out = visibleRecipes([SOUP, CURRY], { terms: ["chickpeas"] });
  assert.deepEqual(out.map((r) => r.name), ["Chickpea Curry"]);
});

test("J3.3 · one term leaves the collection in its own order", () => {
  // Nothing here can distinguish ranking from not ranking: with one term
  // every visible recipe matches exactly once, so sorting by count is a
  // no-op on a stable sort. visibleRecipes skips the sort anyway, to avoid
  // recomputing the matches for every recipe — an optimisation, not a
  // behaviour, and recorded as such so nobody defends it as one.
  const out = visibleRecipes([CURRY, SOUP], { terms: ["onion"] });
  assert.deepEqual(out.map((r) => r.name), ["Chickpea Curry", "Tomato Soup"]);
});

test("without any terms the collection keeps its own order", () => {
  const out = visibleRecipes([CURRY, SOUP], {});
  assert.deepEqual(out.map((r) => r.name), ["Chickpea Curry", "Tomato Soup"]);
});

test("J3.1 · what search reads is exactly what the screen shows", () => {
  const prefs = { mass: "imperial", volume: "us" };
  const ing = { amount: 400, unit: "g", item: "tomatoes" };

  // 400g converts to 14.1oz, which then renders as a kitchen fraction —
  // so the text search runs against is the fraction, not the decimal.
  assert.equal(readable(ing, prefs), "14⅛ oz tomatoes");
  assert.equal(matchesFilters(SOUP, { terms: ["14⅛ oz"], prefs }), true);
  assert.equal(matchesFilters(SOUP, { terms: ["oz"], prefs }), true);

  // The decimal it passed through on the way is not what anyone sees, and
  // so is not what anyone can search for.
  assert.equal(matchesFilters(SOUP, { terms: ["14.1"], prefs }), false);

  // The units as written stay searchable whatever the reader prefers.
  assert.equal(matchesFilters(SOUP, { terms: ["400 g"], prefs }), true);
});

test("J14.9 · not planned lately orders the list without narrowing it", () => {
  const NEVER = recipe({ name: "Pancakes", steps: ["Whisk."], tags: ["quick"] });
  const index = { [SOUP.id]: { lastPlannedAt: 2000, count: 1 }, [CURRY.id]: { lastPlannedAt: 1000, count: 2 } };
  const criteria = { notPlannedLately: true, plannedIndex: index };

  assert.deepEqual(
    visibleRecipes([SOUP, CURRY, NEVER], criteria).map((r) => r.name),
    ["Pancakes", "Chickpea Curry", "Tomato Soup"],
    "never planned first, then least recently planned — and nothing is hidden"
  );
});

test("J14.9, J3.2 · not planned lately combines with the filters rather than replacing them", () => {
  const NEVER = recipe({ name: "Pancakes", steps: ["Whisk."], tags: ["vegan"] });
  const index = { [SOUP.id]: { lastPlannedAt: 2000, count: 1 }, [CURRY.id]: { lastPlannedAt: 1000, count: 2 } };

  assert.deepEqual(
    visibleRecipes([SOUP, CURRY, NEVER], {
      notPlannedLately: true,
      plannedIndex: index,
      tag: "quick",
    }).map((r) => r.name),
    ["Chickpea Curry", "Tomato Soup"],
    "the tag narrows, the chip orders what is left"
  );
});

test("J14.9 · a ranked search still decides between two recipes planned the same day", () => {
  const index = { [SOUP.id]: { lastPlannedAt: 1000, count: 1 }, [CURRY.id]: { lastPlannedAt: 1000, count: 1 } };

  assert.deepEqual(
    visibleRecipes([SOUP, CURRY], {
      terms: ["onion", "chickpeas"],
      notPlannedLately: true,
      plannedIndex: index,
    }).map((r) => r.name),
    ["Chickpea Curry", "Tomato Soup"],
    "the better match wins a tie the archive cannot break"
  );
});
