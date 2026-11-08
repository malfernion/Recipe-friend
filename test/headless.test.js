/**
 * The modules carry no DOM, and something outside this app depends on it.
 *
 * An agent (J16) runs somewhere that has no browser, and the point of
 * letting it load these files rather than reimplement them is that the
 * shopping list it computes is the list the phone computes — the same
 * promotion to kilograms, the same tolerance of plurals, the same
 * refusal to guess how big a tin is. A second implementation would drift
 * on exactly those, and nobody would notice until the list was wrong in
 * a supermarket.
 *
 * Breaking that costs nothing visible here: reach for `document` in
 * plan.js and the site still works. So it is held by a test rather than
 * by anybody remembering, and the Boundaries section says the same.
 *
 * The scan reads the source including its comments, deliberately: it
 * keeps the check to something with no parser in it, and none of these
 * files mentions a browser API in prose today. A comment that trips it
 * is a comment worth rewording.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadApp } = require("./helpers/load.js");

const SRC = path.join(__dirname, "..", "js");

/** Nothing a browser provides and Node does not. */
const PURE = ["plan.js", "lists.js", "listdrop.js", "search.js", "scale.js", "units.js", "html.js"];
/** The same, except that the working copy is a key-value store.
 *  `api.js` is here because `load.js` brings it in with `sync.js`, so it
 *  is part of what the MCP server runs whether it asks for it or not. */
const CACHED = ["storage.js", "planstore.js", "liststore.js", "sync.js", "api.js"];

const BROWSER = [
  "document", "navigator", "location", "alert", "confirm", "sessionStorage",
  "XMLHttpRequest", "HTMLElement", "CustomEvent", "requestAnimationFrame",
  "matchMedia", "getComputedStyle",
];

function reaches(file, names) {
  const src = fs.readFileSync(path.join(SRC, file), "utf8");
  return names.filter((name) => new RegExp(`\\b${name}\\b`).test(src));
}

test("the planning modules name nothing a browser provides", () => {
  for (const file of PURE) {
    assert.deepEqual(reaches(file, [...BROWSER, "localStorage"]), [], `js/${file}`);
  }
});

test("the modules that cache reach no further than localStorage", () => {
  for (const file of CACHED) {
    assert.deepEqual(reaches(file, BROWSER), [], `js/${file}`);
  }
});

test("J17.7 · the whole set runs a list end to end in bare Node", () => {
  // No stub DOM here, unlike the app tests: a fake window with an
  // in-memory localStorage is the whole environment, which is what a
  // program outside this app has.
  const win = loadApp(...CACHED, ...PURE);
  const Lists = win.RecipeLists;
  const chilli = win.RecipeStore.sanitizeRecipe({
    name: "Chilli",
    servings: 4,
    ingredients: [
      { amount: 500, unit: "g", item: "beef mince" },
      { amount: 1, unit: "tin", item: "kidney beans" },
    ],
    steps: ["Cook it."],
  });
  let a = Lists.createList({ name: "Shopping", kind: "checklist", now: 1000 });
  a = Lists.addTree(a, Lists.recipeItems(chilli, 8, { mass: "metric", volume: "metric" }), { now: 1001 });
  let b = Lists.addItem(a, { text: "milk", now: 1002 });
  a = Lists.setTicked(a, Lists.children(a)[0].id, true, 1003);
  const met = Lists.mergeLists(a, b);
  assert.deepEqual(Lists.rows(met, new Set([""])).map((r) => r.type === "item" ? r.item.text : "Ticked"), [
    "milk", "Ticked", "Chilli", "1000 g beef mince", "2 tin kidney beans",
  ]);
  assert.equal(win.RecipeSearch.stemWord("Tomatoes"), win.RecipeSearch.stemWord("tomato"));
});
