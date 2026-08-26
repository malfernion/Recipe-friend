/**
 * js/storage.js — what counts as a recipe, and what survives a round trip.
 * This is the layer where a bug is silent: a recipe quietly losing a field
 * looks like nothing at all until someone goes to cook from it.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp, aRecipe } = require("./helpers/load.js");

function freshStore() {
  const win = loadApp("units.js", "scale.js", "storage.js");
  return { store: new win.RecipeStore(), sanitize: win.RecipeStore.sanitizeRecipe };
}

const { sanitize } = freshStore();

test("J2.1 · a recipe needs a name, an ingredient and a step", () => {
  assert.ok(sanitize(aRecipe()));
  assert.equal(sanitize(aRecipe({ name: "" })), null);
  assert.equal(sanitize(aRecipe({ name: "   " })), null);
  assert.equal(sanitize(aRecipe({ ingredients: [] })), null);
  assert.equal(sanitize(aRecipe({ steps: [] })), null);
  assert.equal(sanitize(aRecipe({ steps: ["  "] })), null);
  assert.equal(sanitize(null), null);
  assert.equal(sanitize("a recipe"), null);
});

test("J2.5 · optional numbers stay empty rather than becoming 0", () => {
  const r = sanitize(aRecipe());
  assert.equal(r.servings, null);
  assert.equal(r.prepMinutes, null);
  assert.equal(r.cookMinutes, null);
  assert.equal(sanitize(aRecipe({ servings: "" })).servings, null);
  assert.equal(sanitize(aRecipe({ servings: 4 })).servings, 4);
});

test("J2.3 · an ingredient with no amount is kept as a to-taste line", () => {
  const r = sanitize(aRecipe({
    ingredients: [{ amount: null, unit: "", item: "salt, to taste" }],
  }));
  assert.equal(r.ingredients.length, 1);
  assert.equal(r.ingredients[0].amount, null);
});

test("J2.4 · a zero or negative amount becomes empty, not zero", () => {
  const r = sanitize(aRecipe({
    ingredients: [
      { amount: 0, unit: "g", item: "sugar" },
      { amount: -5, unit: "g", item: "flour" },
    ],
  }));
  assert.equal(r.ingredients[0].amount, null);
  assert.equal(r.ingredients[1].amount, null);
});

test("J2.6 · tags are lowercased", () => {
  const r = sanitize(aRecipe({ tags: ["Sunday", "BEEF", " roast "] }));
  assert.deepEqual(r.tags, ["sunday", "beef", "roast"]);
});

test("J2.2 · a recognised unit is normalised on the way in", () => {
  const r = sanitize(aRecipe({ ingredients: [{ amount: 2, unit: "Kilograms", item: "beef" }] }));
  assert.equal(r.ingredients[0].unit, "kg");
});

test("an oversized payload is bounded rather than stored whole", () => {
  const r = sanitize(aRecipe({
    steps: Array(5000).fill("x".repeat(50000)),
    tags: Array(5000).fill("t"),
    ingredients: Array(5000).fill({ amount: 1, unit: "g", item: "y" }),
  }));
  assert.equal(r.steps.length, 200);
  assert.equal(r.steps[0].length, 2000);
  assert.equal(r.tags.length, 50);
  assert.equal(r.ingredients.length, 200);
});

test("a photo is a device image or an http(s) URL, and nothing else", () => {
  assert.equal(sanitize(aRecipe({ image: "https://example.test/x.jpg" })).image,
    "https://example.test/x.jpg");
  assert.equal(sanitize(aRecipe({ image: "javascript:alert(1)" })).image, "");
  assert.equal(sanitize(aRecipe({ image: "data:text/html,<script>" })).image, "");
  assert.ok(sanitize(aRecipe({ image: "data:image/jpeg;base64,AAAA" })).image);
});

test("a stored photo path must name a book and a recipe", () => {
  const good = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg";
  assert.equal(sanitize(aRecipe({ imagePath: good })).imagePath, good);
  assert.equal(sanitize(aRecipe({ imagePath: "../other-book/x.jpg" })).imagePath, "");
  assert.equal(sanitize(aRecipe({ imagePath: "anything.jpg" })).imagePath, "");
});

test("a hostile payload cannot reach Object.prototype", () => {
  sanitize(JSON.parse(
    '{"name":"x","steps":["s"],"ingredients":[{"amount":1,"unit":"g","item":"y"}],' +
    '"__proto__":{"polluted":true}}'
  ));
  assert.equal({}.polluted, undefined);
});

test("J10.1 · export carries the whole book, and import brings it back", () => {
  const { store } = freshStore();
  store.add(aRecipe({ name: "Soup" }));
  store.add(aRecipe({ name: "Stew" }));

  const backup = store.exportJSON();
  const { store: other } = freshStore();
  const result = other.importJSON(backup);

  assert.equal(result.imported, 2);
  assert.deepEqual(other.recipes.map((r) => r.name).sort(), ["Soup", "Stew"]);
});

test("J10.2 · re-importing the same file never creates duplicates", () => {
  const { store } = freshStore();
  store.add(aRecipe({ name: "Soup" }));
  const backup = store.exportJSON();

  const first = store.importJSON(backup);
  const second = store.importJSON(backup);

  assert.equal(store.recipes.length, 1);
  assert.equal(first.imported, 0);
  assert.equal(second.imported, 0);
});

test("J10.3 · where both sides hold an id, the more recent edit wins", () => {
  const { store } = freshStore();
  const saved = store.add(aRecipe({ name: "Soup" }));

  // A backup taken later, elsewhere, carrying a newer version.
  const newer = JSON.stringify({
    recipes: [{ ...saved, name: "Better Soup", updatedAt: saved.updatedAt + 1000 }],
  });
  assert.equal(store.importJSON(newer).updated, 1);
  assert.equal(store.recipes[0].name, "Better Soup");
  assert.equal(store.recipes.length, 1, "still one recipe, not two");

  // An older backup must not undo it.
  const older = JSON.stringify({
    recipes: [{ ...saved, name: "Old Soup", updatedAt: saved.updatedAt - 1000 }],
  });
  const result = store.importJSON(older);
  assert.equal(result.updated, 0);
  assert.equal(result.skipped, 1);
  assert.equal(store.recipes[0].name, "Better Soup", "newer work survives an old backup");
});

test("a file that is not an export is refused rather than half-read", () => {
  const { store } = freshStore();
  assert.equal(store.importJSON("not json"), null);
  assert.equal(store.importJSON('{"nope":1}'), null);
  assert.equal(store.importJSON("[]").imported, 0);
});

test("J9.4 · a deleted recipe leaves a tombstone so it cannot come back", () => {
  const { store } = freshStore();
  const saved = store.add(aRecipe({ name: "Soup" }));
  store.remove(saved.id);
  assert.equal(store.recipes.length, 0);
  assert.ok(store.tombstones.some((t) => t.id === saved.id),
    "the delete is recorded, not just forgotten");
});
