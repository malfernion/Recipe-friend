/**
 * js/html.js — the escaper.
 *
 * The app builds markup with template strings, so this one function is
 * what stands between a recipe name and the page. It had no test at all
 * until now: it existed as two private copies, one in app.js and one in
 * books.js, neither reachable from outside. Deleting a line from either
 * broke nothing that anyone would notice until it mattered.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp, loadUI, aRecipe } = require("./helpers/load.js");

const { escapeHTML } = loadApp().RecipeHTML;

test("the five characters that can break out of text or a quoted attribute", () => {
  assert.equal(escapeHTML("&"), "&amp;");
  assert.equal(escapeHTML("<"), "&lt;");
  assert.equal(escapeHTML(">"), "&gt;");
  assert.equal(escapeHTML('"'), "&quot;");
  assert.equal(escapeHTML("'"), "&#39;");
});

test("ampersands are escaped first, so nothing is double-decoded", () => {
  // If < were escaped before &, "&lt;" would come back as "&amp;lt;" and
  // render as literal text — or worse, "&amp;" first then "&" again.
  assert.equal(escapeHTML("&lt;"), "&amp;lt;");
  assert.equal(escapeHTML("a & b < c"), "a &amp; b &lt; c");
});

test("a script tag cannot survive as markup", () => {
  assert.equal(
    escapeHTML('<script>alert(1)</script>'),
    "&lt;script&gt;alert(1)&lt;/script&gt;"
  );
});

test("an attribute breakout cannot survive", () => {
  // The shape that matters here: a recipe's image URL landing in src="…".
  const hostile = 'https://x/"onerror="alert(1)';
  const escaped = escapeHTML(hostile);
  assert.ok(!escaped.includes('"'), "no quote is left to close the attribute");
  assert.equal(escaped, "https://x/&quot;onerror=&quot;alert(1)");
});

test("every occurrence is escaped, not just the first", () => {
  assert.equal(escapeHTML("<<<"), "&lt;&lt;&lt;");
  assert.equal(escapeHTML("a'b'c"), "a&#39;b&#39;c");
});

test("non-strings are coerced rather than trusted or thrown at", () => {
  assert.equal(escapeHTML(null), "null");
  assert.equal(escapeHTML(undefined), "undefined");
  assert.equal(escapeHTML(42), "42");
  assert.equal(escapeHTML({ toString: () => "<b>" }), "&lt;b&gt;");
});

test("ordinary text is left alone", () => {
  assert.equal(escapeHTML("Nana's Sunday Roast"), "Nana&#39;s Sunday Roast");
  assert.equal(escapeHTML("Soupe à l'oignon — 250g"), "Soupe à l&#39;oignon — 250g");
});

test("a hostile recipe reaches the page as text, not as markup", () => {
  const ui = loadUI();
  ui.store.add(aRecipe({
    name: '<img src=x onerror=alert(1)>',
    description: '"><script>alert(2)</script>',
    tags: ["<b>bold</b>"],
  }));
  ui.app.render();

  const html = ui.el("recipe-list").innerHTML;
  assert.ok(html.includes("&lt;img src=x"), "the name is escaped into the card");
  assert.ok(!html.includes("<img src=x"), "and never lands as a tag");
  assert.ok(!html.includes("<script>"), "nor does the description");
  assert.ok(!html.includes("<b>bold</b>"), "nor a tag hidden in a tag name");
});
