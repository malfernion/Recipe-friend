/**
 * The pure helpers behind J18.27 (fitCount) and J18.28 (lastEdited).
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/load.js");

const L = loadApp("units.js", "scale.js", "lists.js").RecipeLists;

test("J18.28 · lastEdited is the newest stamp the list holds, 0 when none", () => {
  assert.equal(L.lastEdited(null), 0);
  assert.equal(L.lastEdited({ items: [] }), 0);
  let list = L.createList({ name: "Shopping", kind: "checklist", now: 1000 });
  assert.equal(L.lastEdited(list), 1000);
  list = L.addItem(list, { text: "milk", id: "a", now: 2000 });
  assert.equal(L.lastEdited(list), 2000);
  const renamed = L.rename(list, "Food", 3000);
  assert.equal(L.lastEdited(renamed), 3000, "the name counts");
  assert.equal(L.lastEdited(L.setTicked(list, "a", true, 5000)), 5000, "a tick counts");
  assert.equal(L.lastEdited(L.deleteItems(list, ["a"], 6000)), 6000, "a deletion counts");
});

test("J18.27 · fitCount keeps the prefix that fits beside the closing button", () => {
  assert.equal(L.fitCount([], 80, 300, 6), 0);
  assert.equal(L.fitCount([60, 60, 60, 60], 80, 300, 6), 3);
  assert.equal(L.fitCount([60, 60], 80, 100, 6), 0, "All lists alone fills it");
  assert.equal(L.fitCount([400, 10], 80, 300, 6), 0, "a narrow one does not jump the queue");
  assert.equal(L.fitCount([60], 80, 146, 6), 1, "exactly fits");
  assert.equal(L.fitCount([60], 80, 145, 6), 0);
});
