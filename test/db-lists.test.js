/**
 * J18 · A book's lists — held by the database (migration 012).
 *
 * Who may read, make, rename, delete and change lists, asked of the
 * database directly. See db-people.test.js for how these run.
 */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { skip, inTransaction, closePool } = require("./helpers/db.js");
const { loadApp } = require("./helpers/load.js");

const db = (name, fn) => test(name, { skip }, () => inTransaction(fn));
after(closePool);

const INSERT = "insert into lists (id, book_id, name, kind, items) values ($1, $2, $3, $4, $5)";
// What insertList sends: insert-if-absent.
const INSERT_IF_ABSENT = `${INSERT} on conflict (id) do nothing`;
const ITEMS = "update lists set items = $2 where id = $1";

async function aList(s, book, over = {}) {
  await s.asAdmin();
  const id = randomUUID();
  await s.q(INSERT, [id, book, over.name || "Shopping", over.kind || "checklist", JSON.stringify(over.items || [])]);
  return id;
}

db("J18.1 · a book's lists: every member reads them, nobody outside sees them", async (s) => {
  const ann = await s.person("Ann");
  const vic = await s.person("Vic");
  const olly = await s.person("Olly");
  await s.member(ann.book, vic, "viewer");
  const agent = await s.agentIn(ann.book);
  await aList(s, ann.book);

  for (const who of [ann, vic, agent]) {
    await s.as(who);
    assert.equal((await s.q("select id from lists")).rowCount, 1, who.name);
  }
  await s.as(olly);
  assert.equal((await s.q("select id from lists where book_id = $1", [ann.book])).rowCount, 0);
  const theirs = await s.attempt(INSERT, [randomUUID(), ann.book, "Mine", "checklist", "[]"]);
  assert.equal(theirs.error && theirs.error.code, "42501");
  await s.asAnon();
  assert.equal((await s.attempt("select id from lists")).rowCount, 0);
});

db("J18.3 · an editor makes, renames, changes and deletes a list", async (s) => {
  const ann = await s.person("Ann");
  const ed = await s.person("Ed");
  await s.member(ann.book, ed, "editor");
  const id = randomUUID();

  await s.as(ed);
  assert.equal((await s.attempt(INSERT_IF_ABSENT, [id, ann.book, "Freezer", "stock", "[]"])).error, null);
  // Insert-if-absent a second time: no error, and nothing overwritten.
  assert.equal((await s.attempt(INSERT_IF_ABSENT, [id, ann.book, "Other", "stock", "[]"])).error, null);
  assert.equal((await s.one("select name from lists where id = $1", [id])).name, "Freezer");
  assert.equal((await s.q("update lists set name = 'Chest freezer', name_at = 5 where id = $1", [id])).rowCount, 1);
  assert.equal((await s.q(ITEMS, [id, JSON.stringify([{ id: randomUUID(), text: "peas" }])])).rowCount, 1);
  assert.equal((await s.q("update lists set deleted_at = now() where id = $1", [id])).rowCount, 1);

  // A tombstone is final: a stale push lands in it and changes nothing.
  assert.equal((await s.q("update lists set deleted_at = null, items = '[{\"x\":1}]', name = 'Back' where id = $1", [id])).rowCount, 1);
  const row = await s.one("select name, items, deleted_at from lists where id = $1", [id]);
  assert.equal(row.name, "Chest freezer");
  assert.deepEqual(row.items, []);
  assert.ok(row.deleted_at);
  // And there is no hard delete for anybody.
  assert.equal((await s.q("delete from lists where id = $1", [id])).rowCount, 0);
});

db("J18.4 · a read-only member changes nothing", async (s) => {
  const ann = await s.person("Ann");
  const vic = await s.person("Vic");
  await s.member(ann.book, vic, "viewer");
  const id = await aList(s, ann.book);

  await s.as(vic);
  const made = await s.attempt(INSERT, [randomUUID(), ann.book, "Mine", "checklist", "[]"]);
  assert.equal(made.error && made.error.code, "42501");
  assert.equal((await s.q(ITEMS, [id, "[1]"])).rowCount, 0);
  assert.equal((await s.q("update lists set name = 'X' where id = $1", [id])).rowCount, 0);
  assert.equal((await s.q("update lists set deleted_at = now() where id = $1", [id])).rowCount, 0);
  await s.asAdmin();
  assert.deepEqual((await s.one("select items from lists where id = $1", [id])).items, []);
});

db("J18.25 · an agent changes items, and cannot make, rename or delete a list", async (s) => {
  const ann = await s.person("Ann");
  const agent = await s.agentIn(ann.book);
  const id = await aList(s, ann.book);

  await s.as(agent);
  assert.equal((await s.q(ITEMS, [id, JSON.stringify([{ id: randomUUID(), text: "milk" }])])).rowCount, 1);
  const made = await s.attempt(INSERT_IF_ABSENT, [randomUUID(), ann.book, "Agent's", "checklist", "[]"]);
  assert.equal(made.error && made.error.code, "42501");
  for (const sql of [
    "update lists set name = 'Renamed' where id = $1",
    "update lists set name_at = 99 where id = $1",
    "update lists set deleted_at = now() where id = $1",
  ]) {
    const r = await s.attempt(sql, [id]);
    assert.equal(r.error && r.error.code, "42501", sql);
  }
  assert.equal((await s.q("delete from lists where id = $1", [id])).rowCount, 0);
  await s.asAdmin();
  const row = await s.one("select name, items, deleted_at from lists where id = $1", [id]);
  assert.equal(row.name, "Shopping");
  assert.equal(row.items[0].text, "milk");
  assert.equal(row.deleted_at, null);
});

db("J18.2 · a list's kind never changes, and it never changes book", async (s) => {
  const ann = await s.person("Ann");
  const bea = await s.person("Bea");
  await s.member(bea.book, ann, "editor");
  const id = await aList(s, ann.book);

  await s.as(ann);
  const kind = await s.attempt("update lists set kind = 'stock' where id = $1", [id]);
  assert.equal(kind.error && kind.error.code, "23514");
  const moved = await s.attempt("update lists set book_id = $2 where id = $1", [id, bea.book]);
  assert.equal(moved.error && moved.error.code, "23514");
  const bad = await s.attempt(INSERT, [randomUUID(), ann.book, "X", "todo", "[]"]);
  assert.equal(bad.error && bad.error.code, "23514");
});

db("the server keeps updated_at, which moves on every write (compare-and-set)", async (s) => {
  const ann = await s.person("Ann");
  const id = await aList(s, ann.book);
  await s.as(ann);
  const { seen } = await s.one("select updated_at::text as seen from lists where id = $1", [id]);
  assert.equal((await s.q(`${ITEMS} and updated_at = $3`, [id, "[]", seen])).rowCount, 1);
  // The same stamp a second time no longer matches: somebody wrote.
  assert.equal((await s.q(`${ITEMS} and updated_at = $3`, [id, "[]", seen])).rowCount, 0);
  await s.q("update lists set updated_at = '2001-01-01' where id = $1", [id]);
  assert.ok((await s.one("select updated_at > '2020-01-01' as now_ish from lists where id = $1", [id])).now_ish);
});

db("a list at every client cap is accepted, and anything far larger is not", async (s) => {
  const win = loadApp("units.js", "scale.js", "lists.js");
  const L = win.RecipeLists;
  const at = Date.UTC(2199, 0, 1);
  const items = Array.from({ length: L.limits.MAX_ITEMS }, (_, i) => ({
    id: randomUUID(),
    parentId: randomUUID(),
    order: "z".repeat(L.limits.MAX_KEY_CHARS - 1) + "y",
    text: (i % 2 ? "🍝" : "麵麵").repeat(L.limits.MAX_TEXT_CHARS / 2),
    addedAt: at,
    posAt: at,
    textAt: at,
    tickAt: at,
    goneAt: at,
    ticked: true,
    tally: Array.from({ length: L.limits.MAX_DEVICES }, (_, d) => [`device${String(d).padStart(17, "x")}`, 99999, 99999]),
  }));
  const list = L.sanitizeList({ id: randomUUID(), name: "x", kind: "stock", items });
  const ann = await s.person("Ann");
  await s.as(ann);
  assert.equal((await s.attempt(INSERT, [list.id, ann.book, "Full", "stock", JSON.stringify(list.items)])).error, null);
  const huge = JSON.stringify([{ text: "x".repeat(1100000) }]);
  const refused = await s.attempt(INSERT, [randomUUID(), ann.book, "Huge", "stock", huge]);
  assert.equal(refused.error && refused.error.code, "23514");
});
