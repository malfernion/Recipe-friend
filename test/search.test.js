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

// plan.js goes in because two of the sorts are orderings over recipes
// (J15.6), and orderings over recipes live here — the archive they read
// is handed in, so this file still knows nothing about where a book
// keeps its plans.
const win = loadApp("units.js", "scale.js", "storage.js", "plan.js", "search.js");
const { parseTerms, matchedTerms, matchesFilters, visibleRecipes, tagCounts, SORTS, readable } =
  win.RecipeSearch;
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
  assert.equal(matchesFilters(favSoup, { favoritesOnly: true, tags: ["quick"] }), true);
  assert.equal(matchesFilters(favSoup, { favoritesOnly: true, tags: ["vegan"] }), false);
  assert.equal(matchesFilters(SOUP, { favoritesOnly: true, tags: ["quick"] }), false);
  assert.equal(
    matchesFilters(favSoup, { favoritesOnly: true, tags: ["quick"], terms: ["curry"] }),
    false
  );
});

test("J15.3 · two tags mean both, never either", () => {
  // The curry carries both, the soup only one. "Either" would show both
  // recipes, which is a different question and not the one being asked.
  assert.equal(matchesFilters(CURRY, { tags: ["quick", "vegan"] }), true);
  assert.equal(matchesFilters(SOUP, { tags: ["quick", "vegan"] }), false);
  assert.deepEqual(
    visibleRecipes([SOUP, CURRY], { tags: ["quick", "vegan"] }).map((r) => r.name),
    ["Chickpea Curry"],
    "combining them narrows: a shorter list than either alone"
  );
  assert.deepEqual(
    visibleRecipes([SOUP, CURRY], { tags: ["quick"] }).map((r) => r.name),
    ["Tomato Soup", "Chickpea Curry"]
  );
});

test("J15.3 · no tags at all is no opinion about tags", () => {
  assert.equal(matchesFilters(SOUP, { tags: [] }), true);
  assert.equal(matchesFilters(SOUP, {}), true);
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

// --- the sorts (J15.6) and what they do to a ranked search (J15.7) ----

const PANCAKES = recipe({
  name: "Pancakes",
  ingredients: [{ amount: 300, unit: "g", item: "flour" }],
  steps: ["Whisk."],
  tags: ["quick"],
  prepMinutes: 5,
  cookMinutes: 5,
});
const STEW = recipe({
  name: "Beef Stew",
  ingredients: [{ amount: 1, unit: "kg", item: "beef" }],
  steps: ["Wait."],
  prepMinutes: 20,
  cookMinutes: 160,
});
const UNTIMED = recipe({
  name: "Zabaglione",
  ingredients: [{ amount: 3, unit: "", item: "eggs" }],
  steps: ["Whisk."],
});

const ARCHIVE = {
  [SOUP.id]: { lastPlannedAt: 2000, count: 1 },
  [CURRY.id]: { lastPlannedAt: 1000, count: 5 },
  [PANCAKES.id]: { lastPlannedAt: 3000, count: 2 },
};

test("J15.6 · the sorts are a small closed set, and recently added is the default", () => {
  assert.deepEqual(
    SORTS.map((s) => s.id),
    ["added", "name", "least-planned", "most-planned", "quickest"]
  );
  const box = [CURRY, SOUP, PANCAKES];
  assert.deepEqual(
    visibleRecipes(box, {}).map((r) => r.name),
    visibleRecipes(box, { sort: "added" }).map((r) => r.name),
    "no sort chosen and 'recently added' are the same list — the collection's own order"
  );
  assert.deepEqual(visibleRecipes(box, { sort: "added" }).map((r) => r.name),
    ["Chickpea Curry", "Tomato Soup", "Pancakes"]);
});

test("J15.6 · name A to Z puts the list in the order a person would read it out", () => {
  assert.deepEqual(
    visibleRecipes([SOUP, CURRY, PANCAKES], { sort: "name" }).map((r) => r.name),
    ["Chickpea Curry", "Pancakes", "Tomato Soup"]
  );
});

test("J15.6 · least recently planned first, never-planned before them", () => {
  // The same ordering J14.9 names, taken from plan.js rather than
  // defined a second time here.
  assert.deepEqual(
    visibleRecipes([SOUP, CURRY, PANCAKES, STEW], {
      sort: "least-planned",
      plannedIndex: ARCHIVE,
    }).map((r) => r.name),
    ["Beef Stew", "Chickpea Curry", "Tomato Soup", "Pancakes"],
    "the one nobody has ever planned, then the oldest, and nothing is hidden"
  );
});

test("J15.6 · most often planned counts every appearance, never-planned last", () => {
  assert.deepEqual(
    visibleRecipes([SOUP, CURRY, PANCAKES, STEW], {
      sort: "most-planned",
      plannedIndex: ARCHIVE,
    }).map((r) => r.name),
    ["Chickpea Curry", "Pancakes", "Tomato Soup", "Beef Stew"]
  );
});

test("J15.6 · quickest first, and a recipe that does not say goes last", () => {
  // No timings is not the same claim as ten minutes: a list of quick
  // suppers headed by everything nobody has filled in is not the list
  // that was asked for.
  assert.deepEqual(
    visibleRecipes([STEW, UNTIMED, PANCAKES], { sort: "quickest" }).map((r) => r.name),
    ["Pancakes", "Beef Stew", "Zabaglione"]
  );
});

test("J15.6 · a recipe that gives half its timings is sorted on the half it gives", () => {
  // Half a timing is still something a recipe says about how long it
  // takes; nothing at all is not, and only that goes last.
  const PREP_ONLY = recipe({ name: "Salad", prepMinutes: 8 });
  const COOK_ONLY = recipe({ name: "Boiled Egg", cookMinutes: 4 });
  assert.deepEqual(
    visibleRecipes([UNTIMED, PANCAKES, PREP_ONLY, COOK_ONLY], { sort: "quickest" }).map((r) => r.name),
    ["Boiled Egg", "Salad", "Pancakes", "Zabaglione"]
  );
});

test("J15.6 · a page without the planner still draws a list", () => {
  // plan.js is what the two planned sorts read. Where it never loaded,
  // the menu does not offer them — and asking anyway gets the order the
  // list already had rather than nothing at all.
  const bare = loadApp("units.js", "scale.js", "storage.js", "search.js");
  assert.deepEqual(
    bare.RecipeSearch.visibleRecipes([SOUP, CURRY], {
      sort: "least-planned",
      plannedIndex: ARCHIVE,
    }).map((r) => r.name),
    ["Tomato Soup", "Chickpea Curry"]
  );
});

// Ids are uuids once sanitized, so the archive is keyed off the stored
// recipes rather than off names invented here.
const BOTH = recipe({ name: "chicken rice bowl" });
const BOTH_OLD = recipe({ name: "chicken and rice soup" });
const ONE_TERM = recipe({ name: "rice pudding" });

test("J15.7 · a chosen sort outranks the search's ranking, which breaks its ties", () => {
  const plannedIndex = {
    [BOTH.id]: { lastPlannedAt: 10, count: 1 },
    [BOTH_OLD.id]: { lastPlannedAt: 2, count: 1 },
    [ONE_TERM.id]: { lastPlannedAt: 2, count: 1 },
  };
  // ONE_TERM and BOTH_OLD were last planned on the same day, so the sort
  // has nothing to say about the pair: the ranking decides, and the
  // recipe answering both terms goes above the one answering one.
  assert.deepEqual(
    visibleRecipes([BOTH, ONE_TERM, BOTH_OLD], {
      terms: ["chicken", "rice"],
      sort: "least-planned",
      plannedIndex,
    }).map((r) => r.name),
    ["chicken and rice soup", "rice pudding", "chicken rice bowl"],
    "the sort has the last word; the ranking decides only between recipes it tied"
  );
});

test("J3.3, J15.7 · where no sort is chosen, a listed search ranks as it always has", () => {
  assert.deepEqual(
    visibleRecipes([BOTH, ONE_TERM, BOTH_OLD], { terms: ["chicken", "rice"] }).map((r) => r.name),
    ["chicken rice bowl", "chicken and rice soup", "rice pudding"],
    "best match first, and the two-term pair keep the order they came in"
  );
});

// --- the size of the list with a tag on (J15.4, J15.5) ----------------

test("J15.4 · each tag says the size of the list with that tag on", () => {
  const box = [SOUP, CURRY, PANCAKES];
  assert.deepEqual(tagCounts(box, {}), [
    { tag: "quick", count: 3, active: false },
    { tag: "vegan", count: 1, active: false },
  ]);
});

test("J15.4 · the count is what the other filters and the search have left", () => {
  const box = [SOUP, CURRY, PANCAKES];
  // A search for chickpeas leaves the curry, so the list with "quick" on
  // is one recipe rather than three — counted against what the rest of
  // the toolbar has already left, so it is not a promise it has broken.
  assert.deepEqual(tagCounts(box, { terms: ["chickpeas"] }), [
    { tag: "quick", count: 1, active: false },
    { tag: "vegan", count: 1, active: false },
  ]);

  const favCurry = { ...CURRY, favorite: true };
  assert.deepEqual(tagCounts([SOUP, favCurry, PANCAKES], { favoritesOnly: true }), [
    { tag: "quick", count: 1, active: false },
    { tag: "vegan", count: 1, active: false },
  ]);
});

test("J15.4 · the count is taken with the tag filter itself set aside", () => {
  const box = [SOUP, CURRY, PANCAKES];
  // "vegan" is on. Its own count is the list as it stands rather than
  // nothing, and "quick" reads as what adding it would leave — the curry,
  // which carries both — rather than as the three recipes the book has.
  assert.deepEqual(tagCounts(box, { tags: ["vegan"] }), [
    { tag: "quick", count: 1, active: false },
    { tag: "vegan", count: 1, active: true },
  ]);
});

test("J15.5 · a tag that would leave nothing is still listed, with its nought", () => {
  const box = [SOUP, CURRY, PANCAKES];
  // Nothing is both vegan and a Sunday roast. "sunday" stays in the
  // menu saying 0 — a tag vanishing as you filter reads as a book losing
  // things, where a nought reads as an answer.
  const ROAST = recipe({ name: "Sunday Roast", steps: ["Roast."], tags: ["sunday"] });
  const counts = tagCounts([...box, ROAST], { tags: ["vegan"] });
  assert.deepEqual(counts.map((c) => c.tag), ["quick", "sunday", "vegan"]);
  assert.equal(counts.find((c) => c.tag === "sunday").count, 0);
});

test("J15.6 · the tag menu files words the way the A to Z sort does", () => {
  const accented = recipe({ name: "Épicé", tags: ["épicé"] });
  const zest = recipe({ name: "Zest", tags: ["zeste"] });
  const apple = recipe({ name: "Apple", tags: ["apple"] });
  const order = tagCounts([apple, zest, accented], {}).map((t) => t.tag);
  assert.deepEqual(order, ["apple", "épicé", "zeste"],
    "codepoint order files an accented word after z, which is not where a reader looks for it");
});
