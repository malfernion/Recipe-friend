/**
 * J18.28 · the "Edited …" wording and the counter's own stamp.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/load.js");

const win = loadApp("units.js", "scale.js", "lists.js", "plan.js");
const L = win.RecipeLists;
const P = win.RecipePlan;
const DEV = "deviceAAAA01";
const MIN = 60000;
const HOUR = 60 * MIN;

test("J18.28 · editedWhen is precise within a day and the day wording after", () => {
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime();
  assert.equal(P.editedWhen(0, now), "");
  assert.equal(P.editedWhen(now - 30000, now), "just now");
  assert.equal(P.editedWhen(now - MIN, now), "1 minute ago");
  assert.equal(P.editedWhen(now - 5 * MIN, now), "5 minutes ago");
  assert.equal(P.editedWhen(now - HOUR, now), "1 hour ago");
  assert.equal(P.editedWhen(now - 2 * HOUR, now), "2 hours ago");
  assert.equal(P.editedWhen(now - 23 * HOUR, now), "23 hours ago");
  assert.equal(P.editedWhen(now - 3 * 24 * HOUR, now), "3 days ago");
  assert.equal(P.plannedLabel(now - 5 * MIN, now), "Last planned today", "Last planned is unchanged");
});

function stock() {
  let list = L.createList({ name: "Freezer", kind: "stock", now: 1000 });
  list = L.addItem(list, { text: "soup", id: "a1111111-1111-4111-8111-111111111111", now: 2000 });
  return list;
}

test("J18.28 · a counter tap and a set both stamp the item, and move lastEdited", () => {
  const id = "a1111111-1111-4111-8111-111111111111";
  const bumped = L.bump(stock(), id, 1, DEV, 9000);
  assert.equal(bumped.items[0].countAt, 9000);
  assert.equal(L.lastEdited(bumped), 9000);
  const set = L.setCount(stock(), id, 5, DEV, 9500);
  assert.equal(L.lastEdited(set), 9500);
  // A clock behind still moves it past the last count.
  assert.equal(L.bump(bumped, id, 1, DEV, 100).items[0].countAt, 9001);
});

test("J18.28 · countAt merges by max, and an item stored without it still loads", () => {
  const id = "a1111111-1111-4111-8111-111111111111";
  const base = stock();
  const a = L.bump(base, id, 1, "deviceAAAA01", 5000);
  const b = L.bump(base, id, 1, "deviceBBBB02", 8000);
  const ab = L.mergeLists(a, b);
  assert.equal(ab.items[0].countAt, 8000);
  assert.deepEqual(L.mergeLists(b, a), ab, "commutative");
  assert.deepEqual(L.mergeLists(ab, a), ab, "absorbs an older copy");
  assert.deepEqual(L.mergeLists(ab, ab), ab, "idempotent");

  const old = JSON.parse(JSON.stringify(stock()));
  delete old.items[0].countAt;
  const loaded = L.sanitizeList(old);
  assert.equal(loaded.items[0].countAt, 0);
  assert.equal(L.sanitizeList({ ...old, items: [{ ...old.items[0], countAt: "x" }] }).items[0].countAt, 0);
});
