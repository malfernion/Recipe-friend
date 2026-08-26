/**
 * js/share.js — a recipe carried in a URL fragment.
 * The link is the data (J6.3), so what it does and does not carry matters.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { loadApp, aRecipe } = require("./helpers/load.js");

const win = loadApp("units.js", "scale.js", "storage.js", "share.js");
const { encodeRecipeShare, decodeRecipeShare } = win.RecipeShare;
const sanitize = win.RecipeStore.sanitizeRecipe;

const b64url = (buf) =>
  buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

test("J6.1 · a recipe survives the round trip intact", async () => {
  const recipe = sanitize(aRecipe({
    name: "Sunday Roast",
    description: "The good one",
    servings: 6,
    prepMinutes: 30,
    cookMinutes: 120,
    ingredients: [
      { amount: 2, unit: "kg", item: "beef" },
      { amount: null, unit: "", item: "salt, to taste" },
    ],
    steps: ["Season.", "Roast."],
    tags: ["Sunday", "beef"],
  }));

  const back = sanitize(await decodeRecipeShare(await encodeRecipeShare(recipe)));

  assert.equal(back.name, "Sunday Roast");
  assert.equal(back.description, "The good one");
  assert.equal(back.servings, 6);
  assert.equal(back.prepMinutes, 30);
  assert.equal(back.cookMinutes, 120);
  assert.deepEqual(back.steps, ["Season.", "Roast."]);
  assert.deepEqual(back.tags, ["sunday", "beef"]);
  assert.equal(back.ingredients.length, 2);
  assert.equal(back.ingredients[0].unit, "kg");
  assert.equal(back.ingredients[1].amount, null, "the to-taste line survives");
});

test("J5.2 · a recipe keeps its identity, so the same link twice is one recipe", async () => {
  const recipe = sanitize(aRecipe());
  const back = sanitize(await decodeRecipeShare(await encodeRecipeShare(recipe)));
  assert.equal(back.id, recipe.id);
});

test("J6.2 · a stored photo does not travel in a link", async () => {
  const recipe = sanitize(aRecipe({
    imagePath: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg",
  }));
  const back = sanitize(await decodeRecipeShare(await encodeRecipeShare(recipe)));
  assert.equal(back.imagePath, "", "a private photo path is not shareable");
});

test("J6.2 · a device photo is left behind, a public URL travels", async () => {
  const withData = sanitize(aRecipe({ image: "data:image/jpeg;base64," + "A".repeat(2000) }));
  const backData = sanitize(await decodeRecipeShare(await encodeRecipeShare(withData)));
  assert.equal(backData.image, "", "a data URI is far too large for a URL");

  const withUrl = sanitize(aRecipe({ image: "https://example.test/x.jpg" }));
  const backUrl = sanitize(await decodeRecipeShare(await encodeRecipeShare(withUrl)));
  assert.equal(backUrl.image, "https://example.test/x.jpg");
});

test("J6.5 · a shared recipe does not arrive already starred", async () => {
  const recipe = sanitize(aRecipe({ favorite: true }));
  const back = sanitize(await decodeRecipeShare(await encodeRecipeShare(recipe)));
  assert.equal(back.favorite, false);
});

test("a link stays small enough to send", async () => {
  const recipe = sanitize(aRecipe({
    name: "Sunday Roast",
    ingredients: Array.from({ length: 15 }, (_, i) => ({ amount: i + 1, unit: "g", item: `thing ${i}` })),
    steps: Array.from({ length: 10 }, (_, i) => `Step ${i}: do the thing carefully and well.`),
  }));
  const url = `https://malfernion.github.io/Recipe-friend/#add=${await encodeRecipeShare(recipe)}`;
  assert.ok(url.length < 2000, `link was ${url.length} characters`);
});

test("J5.4 · a link that cannot be read returns nothing rather than guessing", async () => {
  for (const junk of ["", "9.zzzz", "1.!!!!", "0.bm90IGpzb24", "1."]) {
    assert.equal(await decodeRecipeShare(junk), null, `expected null for ${JSON.stringify(junk)}`);
  }
  assert.equal(await decodeRecipeShare(null), null);
});

test("a payload from a different format version is refused", async () => {
  const wrong = zlib.deflateRawSync(Buffer.from(JSON.stringify({ v: 2, r: { name: "x" } })));
  assert.equal(await decodeRecipeShare("1." + b64url(wrong)), null);
});

test("J6.4 · the decoder refuses an oversized payload rather than unpacking it", async () => {
  // 50MB of zeroes compresses to ~50KB: a link that fits in the address bar
  // and takes the tab down with it.
  const bomb = zlib.deflateRawSync(Buffer.alloc(50 * 1024 * 1024, 0x41));
  assert.ok(bomb.length < 100 * 1024, "the bomb really is small on the wire");
  assert.equal(await decodeRecipeShare("1." + b64url(bomb)), null);

  assert.equal(await decodeRecipeShare("1." + "A".repeat(70000)), null,
    "an absurdly long fragment is refused before decoding");
});

test("an uncompressed link still decodes, for browsers without CompressionStream", async () => {
  const plain = Buffer.from(JSON.stringify({ v: 1, r: { name: "Soup" } }));
  const back = await decodeRecipeShare("0." + b64url(plain));
  assert.equal(back.name, "Soup");
});
