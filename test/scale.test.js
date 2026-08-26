/**
 * js/scale.js — reading and writing kitchen quantities.
 * Criteria from docs/journeys.md; each test name quotes one.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/load.js");

const { RecipeScale } = loadApp("units.js", "scale.js");
const { quantityToNumber, formatQuantity, ingredientText } = RecipeScale;

test("J2.4 · amounts accept decimals and common fractions", () => {
  assert.equal(quantityToNumber("250"), 250);
  assert.equal(quantityToNumber("1.5"), 1.5);
  assert.equal(quantityToNumber("1/2"), 0.5);
  assert.equal(quantityToNumber("1 1/2"), 1.5);
  assert.equal(quantityToNumber("½"), 0.5);
  assert.equal(quantityToNumber("1½"), 1.5);
  assert.equal(quantityToNumber(" 2 "), 2);
});

test("J2.4 · zero is not a quantity and is treated as empty", () => {
  assert.equal(quantityToNumber("0"), null);
  assert.equal(quantityToNumber("0.0"), null);
  assert.equal(quantityToNumber(""), null);
  assert.equal(quantityToNumber("   "), null);
});

test("J2.4 · text that is not a quantity is rejected rather than guessed at", () => {
  for (const junk of ["a pinch", "some", "-5", "1/0", "NaN", "1e999"]) {
    assert.equal(quantityToNumber(junk), null, `expected null for ${junk}`);
  }
});

test("J4.7 · an amount within 0.03 of a kitchen fraction renders as that fraction", () => {
  assert.equal(formatQuantity(0.5), "½");
  assert.equal(formatQuantity(1.5), "1½");
  assert.equal(formatQuantity(0.333), "⅓");
  assert.equal(formatQuantity(2.67), "2⅔"); // not "2.7" — the near ⅔ wins
  assert.equal(formatQuantity(0.75), "¾");
  assert.equal(formatQuantity(0.125), "⅛");
});

test("J4.7 · an amount with no fraction close by renders as one decimal", () => {
  assert.equal(formatQuantity(2.7), "2.7");
  assert.equal(formatQuantity(0.2), "0.2");
  assert.equal(formatQuantity(1.45), "1.5");
});

test("J4.7 · a whole number renders whole, and near-whole rounds to it", () => {
  assert.equal(formatQuantity(3), "3");
  assert.equal(formatQuantity(3.01), "3");
  assert.equal(formatQuantity(2.99), "3");
});

test("J4.8 · an amount below 0.05 renders as 0 — a recorded limitation", () => {
  assert.equal(formatQuantity(0.049), "0");
  assert.equal(formatQuantity(0.01), "0");
  assert.equal(formatQuantity(0.5 / 12), "0"); // ½ tsp, twelve servings down to one
  // 0.05 is the first amount that shows anything at all.
  assert.equal(formatQuantity(0.05), "0.1");
});

test("J4.2 · halving 1½ tbsp gives ¾ tbsp", () => {
  const ing = { amount: 1.5, unit: "tbsp", item: "mustard" };
  assert.equal(ingredientText(ing, 0.5), "¾ tbsp mustard");
  assert.equal(ingredientText(ing, 1), "1½ tbsp mustard");
  assert.equal(ingredientText(ing, 2), "3 tbsp mustard");
});

test("J2.3 · an empty amount means to taste, and is not scaled", () => {
  const ing = { amount: null, unit: "", item: "salt and pepper, to taste" };
  assert.equal(ingredientText(ing, 1), "salt and pepper, to taste");
  assert.equal(ingredientText(ing, 4), "salt and pepper, to taste");
});

test("J4.6 · an unrecognised unit still scales", () => {
  const ing = { amount: 2, unit: "cloves", item: "garlic" };
  assert.equal(ingredientText(ing, 2), "4 cloves garlic");
});

test("an ingredient with no unit reads as amount and item", () => {
  assert.equal(ingredientText({ amount: 3, unit: "", item: "eggs" }, 1), "3 eggs");
});
