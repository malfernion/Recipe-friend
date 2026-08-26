/**
 * js/units.js — measurement preferences and conversion for display.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/load.js");

const { RecipeUnits } = loadApp("units.js");
const { normalizeLabel, familyOf, convertIngredient } = RecipeUnits;

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
