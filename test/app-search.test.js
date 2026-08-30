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
  // The toolbar's three delegated handlers, driven the way a thumb does:
  // pick a tag out of the Filter menu, an order out of Sort, and take one
  // thing off in the row underneath (J15.1, J15.2).
  const tapTag = (tag) =>
    ui.el("tag-menu").fire("click", {
      target: { closest: (sel) => (sel === "[data-tag]" ? { dataset: { tag } } : null) },
    });
  const chooseSort = (sort) =>
    ui.el("sort-options").fire("click", {
      target: { closest: (sel) => (sel === "[data-sort]" ? { dataset: { sort } } : null) },
    });
  const tapRow = (remove, tag) =>
    ui.el("active-filters").fire("click", {
      target: { closest: (sel) => (sel === "[data-remove]" ? { dataset: { remove, tag } } : null) },
    });
  const tapEmpty = (remove) =>
    ui.el("recipe-list").fire("click", {
      target: { closest: (sel) => (sel === "[data-remove]" ? { dataset: { remove } } : null) },
    });
  const row = () => ui.el("active-filters").innerHTML;
  const menu = () => ui.el("tag-menu").innerHTML;
  return { ...ui, titles, search, tapTag, chooseSort, tapRow, tapEmpty, row, menu };
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

test("J3.2 · a tag from the menu narrows the list, and picking it again clears it", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  app.tapTag("quick");
  assert.deepEqual(app.titles().sort(), ["Chickpea Curry", "Tomato Soup"]);
  app.tapTag("quick");
  assert.deepEqual(app.titles().length, 3);
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

test("J3.3 · a list of terms ranks by how many each recipe matches", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  app.search("onion, chickpeas");
  // Curry matches both, soup matches one, roast matches neither and drops.
  assert.deepEqual(app.titles(), ["Chickpea Curry", "Tomato Soup"]);
});

test("J3.3 · a card names which of the terms it matched", () => {
  const app = appWith([CURRY]);
  app.search("chickpeas, garlic");
  const html = app.el("recipe-list").innerHTML;
  assert.match(html, /Matches[^<]*chickpeas/);
  assert.match(html, /Matches[^<]*garlic/);
});

test("J3.3 · one term names nothing — every result matches it", () => {
  // The annotation explains a ranking. With one term there is no ranking
  // and nothing to explain, so it would just repeat what was typed.
  const app = appWith([CURRY]);
  app.search("chickpeas");
  assert.deepEqual(app.titles(), ["Chickpea Curry"]);
  assert.doesNotMatch(app.el("recipe-list").innerHTML, /card-matches/);
});

test("J3.3 · a search that is one term still behaves as it always did", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  app.search("onion");
  assert.deepEqual(app.titles(), ["Chickpea Curry", "Tomato Soup"],
    "filtered, and left in the collection's own order — newest first, unranked");
});

test("J3.4 · matching tolerates simple plurals", () => {
  const app = appWith([SOUP]);
  app.search("tomatoes");
  assert.deepEqual(app.titles(), ["Tomato Soup"], "plural term finds singular ingredient");

  const app2 = appWith([SOUP]);
  app2.search("tomato");
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

test("J3.5 · search covers the current book only", () => {
  const app = appWith([]);
  // Start in a book, so this is a genuine switch rather than the one-off
  // path that adopts a pre-account box into your first book.
  app.store.useBook("11111111-1111-4111-8111-111111111111");
  app.store.add(ROAST);

  // A second book keeps its own cache, so switching changes what exists to
  // be searched at all. Deliberate: a cross-book hit would be ambiguous
  // about where the recipe lives.
  app.store.useBook("22222222-2222-4222-8222-222222222222");
  app.store.add(SOUP);
  app.app.render();

  app.search("roast");
  assert.deepEqual(app.titles(), [], "the other book's recipes are not reachable from here");
  app.search("tomato");
  assert.deepEqual(app.titles(), ["Tomato Soup"]);
});

test("J3.6 · a favourite belongs to the recipe, so a book shares it", () => {
  const app = appWith([SOUP]);
  const soup = app.store.recipes[0];
  app.store.toggleFavorite(soup.id);

  // It rides on the recipe itself, which is what syncs to everyone in the
  // book — there is no per-person list anywhere to diverge from it.
  assert.equal(app.store.getById(soup.id).favorite, true);
  assert.match(app.store.exportJSON(), /"favorite": true/,
    "and it travels with the recipe rather than with the device");
});

// --- J15 · choosing what to look at -------------------------------------

/** One tag's entry in the Filter menu, as markup. */
function option(app, tag) {
  const m = new RegExp(`<button[^>]*data-tag="${tag}"[\\s\\S]*?</button>`).exec(app.menu());
  return m ? m[0] : "";
}
/** The number beside it — the size of the list with that tag on (J15.4). */
const leaves = (app, tag) => Number((/tag-option-count">(\d+)</.exec(option(app, tag)) || [])[1]);

test("J15.1 · the two menus each say what they are doing in their own label", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  assert.equal(app.el("filter-summary").textContent, "Filter");
  assert.equal(app.el("sort-summary").textContent, "Sort · Newest",
    "the default is an answer like any other, so it is said rather than left blank");

  app.tapTag("quick");
  assert.equal(app.el("filter-summary").textContent, "Filter · 1");
  app.tapTag("vegan");
  assert.equal(app.el("filter-summary").textContent, "Filter · 2");
  app.chooseSort("name");
  assert.equal(app.el("sort-summary").textContent, "Sort · A–Z");
});

test("J15.3 · two tags mean both, and combining them narrows", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  app.tapTag("quick");
  assert.deepEqual(app.titles().sort(), ["Chickpea Curry", "Tomato Soup"]);
  app.tapTag("vegan");
  assert.deepEqual(app.titles(), ["Chickpea Curry"],
    "a shorter list than either alone, not the two put together");
});

test("J15.2 · the row shows only what is on, and nothing at all when nothing is", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  assert.equal(app.el("active-filters").hidden, true, "nothing on, nothing there");
  assert.equal(app.row(), "");

  app.tapTag("quick");
  assert.equal(app.el("active-filters").hidden, false);
  assert.match(app.row(), /data-tag="quick"/);
  assert.doesNotMatch(app.row(), /data-tag="vegan"/,
    "the row is what is on, not what could be — the tags it does not name are in the menu");
});

test("J15.2 · each filter comes off on its own, and one control clears the lot", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  const soup = app.store.recipes.find((r) => r.name === "Tomato Soup");
  app.store.toggleFavorite(soup.id);

  app.el("favorites-filter").fire("click");
  app.tapTag("quick");
  assert.match(app.row(), /Favourites/);
  assert.match(app.row(), /data-tag="quick"/);

  app.tapRow("tag", "quick");
  assert.doesNotMatch(app.row(), /data-tag="quick"/, "that one off");
  assert.match(app.row(), /Favourites/, "and the other still on");

  app.tapTag("quick");
  app.tapRow("filters");
  assert.equal(app.el("active-filters").hidden, true);
  assert.deepEqual(app.titles().length, 3, "and the whole book is back");
});

test("J15.4 · each tag says the size of the list with that tag on", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  assert.equal(leaves(app, "quick"), 2);
  assert.equal(leaves(app, "vegan"), 1);
  assert.equal(leaves(app, "beef"), 1);
});

test("J15.4 · the number beside a tag counts recipes, not the times it is written", () => {
  // "Vegan, vegan" is one word typed twice — a thumb, a paste, or an
  // import that spells it both ways — and lowercasing (J2.6) is what
  // makes the pair. Counted twice, the menu promised two recipes and the
  // tap gave one.
  const app = appWith([aRecipe({ name: "Dal", steps: ["Simmer."], tags: ["Vegan", "vegan"] })]);
  assert.equal(leaves(app, "vegan"), 1);
  app.tapTag("vegan");
  assert.deepEqual(app.titles(), ["Dal"], "and the list is the length the menu said it was");
});

test("J15.4 · the count is what the rest of the toolbar has left, not what the book holds", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  app.search("chickpeas");
  assert.equal(leaves(app, "quick"), 1,
    "the size of the list the tap would give you, not the two the book has");

  app.search("");
  app.tapTag("vegan");
  assert.equal(leaves(app, "quick"), 1, "and the tags already on count too");
  assert.equal(leaves(app, "vegan"), 1,
    "with the tag filter itself set aside, so the one that is on reads as the list it left");
});

test("J15.5 · a tag that would leave nothing is shown and cannot be chosen", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  app.tapTag("vegan");
  // Nothing is both vegan and a Sunday roast.
  assert.match(option(app, "beef"), /disabled/, "greyed with a nought beside it");
  assert.equal(leaves(app, "beef"), 0);
  assert.match(app.menu(), /data-tag="beef"/,
    "still listed — a tag vanishing as you filter reads as a book losing things");
});

test("J15.5 · a tag already on is always choosable, whatever its count", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  app.tapTag("quick");
  // A search matching nothing takes every count to nought, and the tag
  // that is on is the way back out: greying it there would shut the door
  // on somebody standing in an empty list.
  app.search("zzzz");
  assert.equal(leaves(app, "quick"), 0);
  assert.doesNotMatch(option(app, "quick"), /disabled/,
    "the tap that takes it off is not the tap the nought is about");
  assert.match(option(app, "sunday"), /disabled/, "where one that is off at nought is shut");

  app.tapTag("quick");
  assert.equal(app.el("active-filters").hidden, true, "and the tap really does take it off");
});

test("J15.6 · the list can be put in name order, and back", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  assert.deepEqual(app.titles(), ["Chickpea Curry", "Tomato Soup", "Sunday Roast"],
    "the collection's own order, newest first");
  app.chooseSort("name");
  assert.deepEqual(app.titles(), ["Chickpea Curry", "Sunday Roast", "Tomato Soup"]);
  app.chooseSort("added");
  assert.deepEqual(app.titles(), ["Chickpea Curry", "Tomato Soup", "Sunday Roast"]);
});

test("J15.7 · a sort chosen by name outranks the search's ranking", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  // The soup answers both terms and the curry only one, so the ranking
  // wants the soup first — and A to Z wants it last. The two orders
  // disagree on purpose: an order they happen to share would pass this
  // test with the sort thrown away entirely.
  app.search("onion, tomatoes");
  assert.deepEqual(app.titles(), ["Tomato Soup", "Chickpea Curry"], "ranked, best first");

  app.chooseSort("name");
  assert.deepEqual(app.titles(), ["Chickpea Curry", "Tomato Soup"],
    "the sort has the last word, against what the ranking asked for");

  app.chooseSort("added");
  assert.deepEqual(app.titles(), ["Tomato Soup", "Chickpea Curry"],
    "and where no sort is chosen the ranking decides again, exactly as it always has");
});

test("J15.8 · switching books forgets the search, the filters and the sort", () => {
  const app = appWith([]);
  app.store.useBook("11111111-1111-4111-8111-111111111111");
  app.store.add(ROAST);
  app.store.add(SOUP);
  app.app.render();

  app.search("roast");
  app.tapTag("sunday");
  app.el("favorites-filter").fire("click");
  app.chooseSort("name");

  // Every way into another book goes through this — switching, deleting
  // one, leaving one, being removed from one.
  app.store.useBook("22222222-2222-4222-8222-222222222222");
  app.store.add(CURRY);
  app.app.render();

  assert.equal(app.el("search-input").value, "", "the box is empty");
  assert.equal(app.el("active-filters").hidden, true, "and so is the row");
  assert.equal(app.el("sort-summary").textContent, "Sort · Newest");
  assert.equal(app.el("filter-summary").textContent, "Filter");
  assert.deepEqual(app.titles(), ["Chickpea Curry"],
    "the list you open is your whole book, not a third of it for reasons set last week");
});

test("J15.8 · walking out of your last book clears the toolbar with it", () => {
  // Leaving or deleting the book you were in, with none left to go to,
  // points the cache back at the keyless one it had before there was a
  // book. That is a different list like any other, and the toolbar
  // belonged to the one that has gone.
  const app = appWith([]);
  app.store.useBook("11111111-1111-4111-8111-111111111111");
  app.store.add(ROAST);
  app.app.render();
  app.search("roast");
  app.tapTag("sunday");
  app.chooseSort("name");

  app.store.useBook(null);
  app.app.render();

  assert.equal(app.el("search-input").value, "");
  assert.equal(app.el("active-filters").hidden, true);
  assert.equal(app.el("sort-summary").textContent, "Sort · Newest");
});

test("J15.10 · where the filters leave nothing, the list offers to clear them", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  app.tapTag("vegan");
  app.el("favorites-filter").fire("click");
  assert.deepEqual(app.titles(), []);
  assert.match(app.el("recipe-list").innerHTML, /No recipes match these filters/);
  assert.match(app.el("recipe-list").innerHTML, /Clear the filters/);

  app.tapEmpty("all");
  assert.deepEqual(app.titles().length, 3, "the way out of an empty list is in the empty list");
});

test("J15.10 · the way out is named after what it would clear", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  app.search("zzzz");
  assert.match(app.el("recipe-list").innerHTML, /Clear the search</,
    "a search is what emptied this one, and the button says so");

  // Picked while it still had a recipe behind it, then searched into
  // nothing — the order a person would actually arrive this way.
  app.search("");
  app.tapTag("vegan");
  app.search("zzzz");
  assert.match(app.el("recipe-list").innerHTML, /Clear the search and filters</);

  app.tapEmpty("all");
  assert.equal(app.el("search-input").value, "");
  assert.deepEqual(app.titles().length, 3);
});

// --- the search result count, for anyone who cannot see the list --------

test("the count is announced, not the whole grid", () => {
  const app = appWith([ROAST, SOUP, CURRY]);
  assert.equal(app.el("result-count").textContent, "3 recipes");

  app.search("onion");
  assert.equal(app.el("result-count").textContent, "2 recipes");

  app.search("curry");
  assert.equal(app.el("result-count").textContent, "1 recipe", "and it counts in the singular");

  app.search("zzzz");
  assert.equal(app.el("result-count").textContent, "No recipes match your search.");
});

test("an empty box says nothing rather than announcing a zero", () => {
  // The empty state on screen already says it, and better.
  const app = appWith([]);
  assert.equal(app.el("result-count").textContent, "");
});
