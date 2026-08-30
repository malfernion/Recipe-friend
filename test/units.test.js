/**
 * js/units.js — measurement preferences and conversion for display.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/load.js");

const { RecipeUnits } = loadApp("units.js");
const { normalizeLabel, familyOf, convertIngredient, toBase, fromBase } = RecipeUnits;

const METRIC = { mass: "metric", volume: "metric" };
const IMPERIAL = { mass: "imperial", volume: "us" };
const AS_ENTERED = { mass: "", volume: "" };

test("J2.2 · a recognised unit collapses to its short label", () => {
  assert.equal(normalizeLabel("Grams"), "g");
  assert.equal(normalizeLabel("kilogram"), "kg");
  assert.equal(normalizeLabel("Ounces"), "oz");
  assert.equal(normalizeLabel("fluid ounces"), "fl oz");
  assert.equal(normalizeLabel("tbsp."), "tbsp");
});

test("J4.6 · an unrecognised unit is kept exactly as written", () => {
  for (const unit of ["cloves", "pinch", "can", "handful", ""]) {
    assert.equal(normalizeLabel(unit), unit);
    assert.equal(familyOf(unit), "other");
  }
});

test("J4.6 · teaspoons and tablespoons are never converted", () => {
  for (const unit of ["tsp", "tbsp"]) {
    const ing = { amount: 2, unit, item: "vanilla" };
    assert.deepEqual(convertIngredient(ing, METRIC), ing);
    assert.deepEqual(convertIngredient(ing, IMPERIAL), ing);
  }
});

test("J4.6 · an unrecognised unit passes through conversion untouched", () => {
  const ing = { amount: 3, unit: "cloves", item: "garlic" };
  assert.deepEqual(convertIngredient(ing, METRIC), ing);
  assert.deepEqual(convertIngredient(ing, IMPERIAL), ing);
});

test("J8.1 · weights convert between metric and imperial", () => {
  assert.deepEqual(convertIngredient({ amount: 100, unit: "g", item: "x" }, IMPERIAL),
    { amount: 3.5, unit: "oz", item: "x" });
  assert.deepEqual(convertIngredient({ amount: 1, unit: "lb", item: "x" }, METRIC),
    { amount: 454, unit: "g", item: "x" });
});

test("J8.4 · a converted amount picks its unit by size", () => {
  const g = (amount) => convertIngredient({ amount, unit: "g", item: "x" }, METRIC);
  assert.equal(g(999).unit, "g");
  assert.equal(convertIngredient({ amount: 2, unit: "lb", item: "x" }, METRIC).unit, "g",
    "2lb is 907g — still grams");
  assert.equal(convertIngredient({ amount: 3, unit: "lb", item: "x" }, METRIC).unit, "kg");
  // Volume: fluid ounces below 120ml, cups at or above it.
  const ml = (amount) => convertIngredient({ amount, unit: "ml", item: "x" }, IMPERIAL);
  assert.equal(ml(119).unit, "fl oz");
  assert.equal(ml(120).unit, "cup");
  assert.equal(ml(240).amount, 1);
});

test("J13.2 · an amount can be had in its base unit exactly, so several can be summed before anything is rounded", () => {
  // The shopping list adds ingredients up before it formats them once, at
  // the end; a conversion that rounded on the way in would lose the
  // difference between a very little and none all over again.
  assert.equal(toBase(1, "kg"), 1000);
  assert.equal(toBase(8, "oz"), 226.8);
  assert.equal(toBase(1, "kg") + toBase(8, "oz"), 1226.8);
  assert.equal(toBase(0.5, "cup"), 120);
  // Spoons and unrecognised units have no base to be had — they are never
  // converted (J4.6), and saying so is what keeps them off a mass line.
  assert.equal(toBase(3, "tsp"), null);
  assert.equal(toBase(1, "tin"), null);
  assert.equal(toBase(1, "constructor"), null);
});

test("J8.4 · a base amount picks its unit by size, whatever it was written in", () => {
  assert.deepEqual(fromBase("mass", "metric", 999), { amount: 999, unit: "g" });
  assert.deepEqual(fromBase("mass", "metric", 1500), { amount: 1.5, unit: "kg" });
  assert.deepEqual(fromBase("mass", "imperial", 100), { amount: 3.5, unit: "oz" });
  assert.deepEqual(fromBase("mass", "imperial", 500), { amount: 1.1, unit: "lb" }, "ounces below a pound");
  assert.deepEqual(fromBase("volume", "metric", 999), { amount: 999, unit: "ml" });
  assert.deepEqual(fromBase("volume", "us", 119), { amount: 4, unit: "fl oz" });
  assert.deepEqual(fromBase("volume", "us", 120), { amount: 0.5, unit: "cup" });
});

test("J8.1 · units can be left exactly as entered", () => {
  const ing = { amount: 250, unit: "g", item: "flour" };
  assert.deepEqual(convertIngredient(ing, AS_ENTERED), ing);
  assert.deepEqual(convertIngredient(ing, {}), ing);
  assert.deepEqual(convertIngredient(ing, null), ing);
});

test("an amount already in the preferred system is left alone", () => {
  const ing = { amount: 250, unit: "g", item: "flour" };
  assert.deepEqual(convertIngredient(ing, METRIC), ing);
});

test("J2.3 · a to-taste line has nothing to convert", () => {
  const ing = { amount: null, unit: "g", item: "salt" };
  assert.equal(convertIngredient(ing, IMPERIAL).amount, null);
});

test("an amount too small to convert keeps the unit it was written in", () => {
  // 0.4g is 0.014oz, which rounds away entirely — better the true small
  // metric amount than a fabricated "0 oz".
  const ing = { amount: 0.4, unit: "g", item: "saffron" };
  assert.deepEqual(convertIngredient(ing, IMPERIAL), ing);
});

test("J8.3 · converting for display never mutates the recipe", () => {
  const ing = Object.freeze({ amount: 250, unit: "g", item: "flour" });
  const out = convertIngredient(ing, IMPERIAL);
  assert.notEqual(out, ing);
  assert.equal(ing.amount, 250, "the source ingredient is untouched");
  assert.equal(ing.unit, "g");
});

test("a lookup key from Object's prototype is not a unit", () => {
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(familyOf(key), "other", `${key} should not resolve to a unit`);
  }
});

test("J4.4 · amounts are shown in the reader's units, not the ones stored", () => {
  // The recipe is written in grams. Two readers, two answers, one recipe.
  const written = Object.freeze({ amount: 500, unit: "g", item: "flour" });
  assert.equal(convertIngredient(written, IMPERIAL).unit, "lb", "500g is over a pound");
  assert.equal(convertIngredient(written, METRIC).unit, "g");
  assert.equal(written.unit, "g", "and the recipe still says what it always said");
});

test("J4.5 · two people sharing a book neither see the same units nor rewrite each other's", () => {
  const shared = [
    { amount: 500, unit: "g", item: "flour" },
    { amount: 250, unit: "ml", item: "milk" },
  ];
  const snapshot = JSON.stringify(shared);

  const dave = shared.map((i) => convertIngredient(i, IMPERIAL));
  const sam = shared.map((i) => convertIngredient(i, METRIC));

  assert.deepEqual(dave.map((i) => i.unit), ["lb", "cup"]);
  assert.deepEqual(sam.map((i) => i.unit), ["g", "ml"]);
  assert.equal(JSON.stringify(shared), snapshot,
    "reading a recipe is not a write — the book is untouched by either of them");
});
