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

db("J18.21 · at the quota the oldest records go instead of the insert being refused (013)", async (s) => {
  const ann = await s.person("Ann");
  const bea = await s.person("Bea");
  await s.asAdmin();
  // 2000 records, oldest first, one a minute apart; and one in another book.
  await s.q(
    `insert into plans (id, book_id, data, completed_at)
     select gen_random_uuid(), $1, '{}', now() - make_interval(mins => 5000 - n) from generate_series(1, 2000) n`,
    [ann.book]
  );
  await s.q(ARCHIVE, [randomUUID(), bea.book]);
  const oldest = await s.one("select id from plans where book_id = $1 order by completed_at asc limit 1", [ann.book]);

  await s.as(ann);
  const fresh = randomUUID();
  assert.equal((await s.attempt(ARCHIVE, [fresh, ann.book])).error, null, "the add is not refused");
  await s.asAdmin();
  assert.equal((await s.one("select count(*)::int as n from plans where book_id = $1", [ann.book])).n, 2000);
  assert.equal((await s.q("select 1 from plans where id = $1", [oldest.id])).rowCount, 0, "the oldest made room");
  assert.equal((await s.q("select 1 from plans where id = $1", [fresh])).rowCount, 1, "and the new one is kept");
  assert.equal((await s.one("select count(*)::int as n from plans where book_id = $1", [bea.book])).n, 1,
    "another book's record is not touched");
});

db("J18.21 · an agent's record rolls the oldest off too, and nobody's insert makes room in a book not theirs (014)", async (s) => {
  const ann = await s.person("Ann");
  const olly = await s.person("Olly");
  const agent = await s.agentIn(ann.book);
  await s.asAdmin();
  await s.q(
    `insert into plans (id, book_id, data, completed_at)
     select gen_random_uuid(), $1, '{}', now() - make_interval(mins => 5000 - n) from generate_series(1, 2000) n`,
    [ann.book]
  );
  const oldest = await s.one("select id from plans where book_id = $1 order by completed_at asc limit 1", [ann.book]);

  // Somebody outside the book is refused, and takes nothing with them.
  await s.as(olly);
  const refused = await s.attempt(ARCHIVE, [randomUUID(), ann.book]);
  assert.equal(refused.error && refused.error.code, "42501");
  await s.asAdmin();
  assert.equal((await s.one("select count(*)::int as n from plans where book_id = $1", [ann.book])).n, 2000);
  assert.equal((await s.q("select 1 from plans where id = $1", [oldest.id])).rowCount, 1);

  // An insert that inserts nothing makes no room: a duplicate id met with
  // `on conflict do nothing` would otherwise erase a record a time.
  await s.as(agent);
  const dup = await s.attempt(`${ARCHIVE} on conflict do nothing`, [oldest.id, ann.book]);
  assert.equal(dup.error, null);
  assert.equal(dup.rowCount, 0);
  await s.asAdmin();
  assert.equal((await s.one("select count(*)::int as n from plans where book_id = $1", [ann.book])).n, 2000);
  assert.equal((await s.q("select 1 from plans where id = $1", [oldest.id])).rowCount, 1, "nothing deleted");

  await s.as(agent);
  const mine = randomUUID();
  assert.equal((await s.attempt(ARCHIVE, [mine, ann.book])).error, null);
  await s.asAdmin();
  assert.equal((await s.one("select count(*)::int as n from plans where book_id = $1", [ann.book])).n, 2000, "still at the quota");
  assert.equal((await s.q("select 1 from plans where id = $1", [oldest.id])).rowCount, 0, "the oldest made room");
  assert.equal((await s.q("select 1 from plans where id = $1", [mine])).rowCount, 1, "and the new one is kept");

  // A new record dated before every other is still the one kept.
  await s.as(agent);
  const early = randomUUID();
  await s.q("insert into plans (id, book_id, data, completed_at) values ($1, $2, '{}', now() - interval '10 years')", [early, ann.book]);
  await s.asAdmin();
  assert.equal((await s.q("select 1 from plans where id = $1", [early])).rowCount, 1);
  assert.equal((await s.one("select count(*)::int as n from plans where book_id = $1", [ann.book])).n, 2000);
});
