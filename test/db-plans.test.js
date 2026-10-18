/**
 * J12, J14 · The plan a book is shopping for, and the plans it finished —
 * held by the database.
 *
 * These are the checks migration 007 asked a reviewer to make by hand in
 * the dashboard. See db-people.test.js for how they run.
 */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { skip, inTransaction, closePool } = require("./helpers/db.js");

const db = (name, fn) => test(name, { skip }, () => inTransaction(fn));
after(closePool);

// What pushLivePlan sends: one upsert on the book.
const UPSERT_LIVE = `insert into live_plans (book_id, data) values ($1, $2)
  on conflict (book_id) do update set data = excluded.data`;
const ARCHIVE = "insert into plans (id, book_id, data, completed_at) values ($1, $2, '{}', now())";

db("J12.10 · a read-only member cannot plan", async (s) => {
  const ann = await s.person("Ann");
  const vic = await s.person("Vic");
  await s.member(ann.book, vic, "viewer");
  const week = randomUUID();
  await s.livePlan(ann.book, { id: week, meals: ["soup"] });
  await s.q(ARCHIVE, [randomUUID(), ann.book]);

  await s.as(vic);
  // A viewer gets the recipes, and sees the plan: reading is allowed.
  assert.equal((await s.q("select book_id from live_plans")).rowCount, 1);
  assert.equal((await s.q("select id from plans")).rowCount, 1);
  // And no planner.
  const upsert = await s.attempt(UPSERT_LIVE, [ann.book, { id: week, meals: [] }]);
  assert.equal(upsert.error && upsert.error.code, "42501");
  // Nor the first save of a plan, in a book that has none yet.
  const tom = await s.person("Tom");
  await s.member(tom.book, vic, "viewer");
  await s.as(vic);
  const first = await s.attempt(UPSERT_LIVE, [tom.book, { meals: ["soup"] }]);
  assert.equal(first.error && first.error.code, "42501");
  assert.equal((await s.q("update live_plans set data = '{}' where book_id = $1", [ann.book])).rowCount, 0);
  const done = await s.attempt(ARCHIVE, [randomUUID(), ann.book]);
  assert.equal(done.error && done.error.code, "42501");
  assert.equal((await s.q("delete from plans where book_id = $1", [ann.book])).rowCount, 0);

  await s.asAdmin();
  assert.deepEqual((await s.one("select data from live_plans where book_id = $1", [ann.book])).data, {
    id: week,
    meals: ["soup"],
  });
});

db("J12.2 · a plan belongs to the book: its editors plan it, and nobody else sees it", async (s) => {
  const ann = await s.person("Ann");
  const ed = await s.person("Ed");
  const outsider = await s.person("Olly");
  await s.member(ann.book, ed, "editor");

  // The first save of a book's plan and every save after it: INSERT and UPDATE both allowed.
  await s.as(ed);
  assert.equal((await s.attempt(UPSERT_LIVE, [ann.book, { meals: ["a"] }])).error, null);
  assert.equal((await s.attempt(UPSERT_LIVE, [ann.book, { meals: ["a", "b"] }])).error, null);
  const plan = await s.one("select data, updated_at from live_plans where book_id = $1", [ann.book]);
  assert.deepEqual(plan.data, { meals: ["a", "b"] });

  // The server keeps updated_at; a client's own value is not taken.
  await s.q("update live_plans set updated_at = '2001-01-01' where book_id = $1", [ann.book]);
  const touched = await s.one("select updated_at > '2020-01-01' as now_ish from live_plans where book_id = $1", [
    ann.book,
  ]);
  assert.equal(touched.now_ish, true);

  // One live plan per book: a second row for the same book is a conflict, not a second plan.
  await s.as(ed);
  const second = await s.attempt("insert into live_plans (book_id, data) values ($1, '{}')", [ann.book]);
  assert.equal(second.error && second.error.code, "23505");

  await s.as(outsider);
  assert.equal((await s.q("select 1 from live_plans where book_id = $1", [ann.book])).rowCount, 0);
  const theirs = await s.attempt(UPSERT_LIVE, [ann.book, {}]);
  assert.equal(theirs.error && theirs.error.code, "42501");
});

db("J12.2 · a plan belongs to its book for life", async (s) => {
  const ann = await s.person("Ann");
  const bea = await s.person("Bea");
  await s.member(bea.book, ann, "editor");
  await s.livePlan(ann.book);

  await s.as(ann);
  const dragged = await s.attempt("update live_plans set book_id = $2 where book_id = $1", [ann.book, bea.book]);
  assert.equal(dragged.error && dragged.error.code, "23514");
  assert.match(dragged.error.message, /belongs to its book/);
  const edited = await s.q("update live_plans set data = '{\"meals\":[]}' where book_id = $1", [ann.book]);
  assert.equal(edited.rowCount, 1);
});

db("J14.10 · pressing Done twice records the week once", async (s) => {
  const ann = await s.person("Ann");
  const bea = await s.person("Bea");
  await s.member(bea.book, ann, "editor");
  const week = randomUUID();

  await s.as(ann);
  assert.equal((await s.attempt(ARCHIVE, [week, ann.book])).error, null);
  const again = await s.attempt(ARCHIVE, [week, ann.book]);
  assert.equal(again.error && again.error.code, "23505", "the retry is a duplicate key, not a second record");

  // The same plan id under another book is somebody else's week, and goes in.
  assert.equal((await s.attempt(ARCHIVE, [week, bea.book])).error, null);

  // And a record cannot be edited after the fact.
  assert.equal((await s.q("update plans set data = '{\"x\":1}' where id = $1", [week])).rowCount, 0);
});

db("J14.2 · Undo takes the record back, and only for somebody who could make it", async (s) => {
  const ann = await s.person("Ann");
  const vic = await s.person("Vic");
  await s.member(ann.book, vic, "viewer");
  const week = randomUUID();
  await s.asAdmin();
  await s.q(ARCHIVE, [week, ann.book]);

  await s.as(vic);
  assert.equal((await s.q("delete from plans where book_id = $1 and id = $2", [ann.book, week])).rowCount, 0);
  await s.as(ann);
  assert.equal((await s.q("delete from plans where book_id = $1 and id = $2", [ann.book, week])).rowCount, 1);
});
