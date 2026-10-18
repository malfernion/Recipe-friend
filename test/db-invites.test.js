/**
 * J7.4, J7.5 · Invites: one person, 48 hours, revocable, and never a way
 * in for somebody who is not a person — held by the database.
 *
 * The client mints links for one person and only lists live ones, but
 * nothing client-side stops an expired or spent link being redeemed. These
 * are what does. See db-people.test.js for how they run.
 */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { skip, inTransaction, closePool } = require("./helpers/db.js");

const db = (name, fn) => test(name, { skip }, () => inTransaction(fn));
after(closePool);

const redeem = (s, code) => s.attempt("select * from redeem_invite($1)", [code]);
const preview = (s, code) => s.attempt("select * from preview_invite($1)", [code]);

async function membersOf(s, book) {
  await s.asAdmin();
  return (await s.q("select user_id, role from book_members where book_id = $1", [book])).rows;
}

db("J7.4 · a link is good for one person", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");
  const cat = await s.person("Cat");
  // What createInvite sends: a code, and no use count, so the default applies.
  await s.as(ann);
  await s.q("insert into invites (code, book_id, created_by) values ('one-use', $1, $2)", [ann.book, ann.id]);
  assert.equal((await s.one("select max_uses from invites where code = 'one-use'")).max_uses, 1);

  await s.as(bob);
  const first = await redeem(s, "one-use");
  assert.equal(first.error, null);
  assert.deepEqual(first.rows, [{ book_id: ann.book, book_name: "Ann's recipes" }]);
  // Bob opening his own link again, on another device, spends nothing and fails nothing.
  await s.as(bob);
  assert.equal((await redeem(s, "one-use")).error, null);

  await s.as(cat);
  assert.match(String((await preview(s, "one-use")).error), /already been used/);
  assert.match(String((await redeem(s, "one-use")).error), /already been used/);

  const members = await membersOf(s, ann.book);
  assert.deepEqual(members.map((m) => m.user_id).sort(), [ann.id, bob.id].sort());
  assert.equal((await s.one("select used_count from invites where code = 'one-use'")).used_count, 1);
});

db("J7.4 · a link expires after 48 hours", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");
  await s.as(ann);
  await s.q("insert into invites (code, book_id, created_by) values ('fresh', $1, $2)", [ann.book, ann.id]);
  const life = await s.one("select extract(epoch from expires_at - now())::int as seconds from invites where code = 'fresh'");
  assert.equal(life.seconds, 48 * 3600);

  await s.invite(ann.book, ann, { code: "stale", expires_at: new Date(Date.now() - 3600000) });
  await s.invite(ann.book, ann, { code: "nearly", expires_at: new Date(Date.now() + 60000) });

  await s.as(bob);
  assert.match(String((await preview(s, "stale")).error), /invalid or expired/);
  assert.match(String((await redeem(s, "stale")).error), /invalid or expired/);
  assert.equal((await redeem(s, "nearly")).error, null, "a minute left is still live");
});

db("J7.4 · the owner can see the live ones and revoke any that went astray", async (s) => {
  const ann = await s.person("Ann");
  const ed = await s.person("Ed");
  const bob = await s.person("Bob");
  await s.member(ann.book, ed, "editor");
  const code = await s.invite(ann.book, ann);

  // Only the owner sees invites, or mints them.
  await s.as(ed);
  assert.equal((await s.q("select code from invites")).rowCount, 0);
  const minted = await s.attempt("insert into invites (code, book_id, created_by) values ('eds', $1, $2)", [
    ann.book,
    ed.id,
  ]);
  assert.equal(minted.error && minted.error.code, "42501");
  assert.equal((await s.q("delete from invites where code = $1", [code])).rowCount, 0);

  await s.as(ann);
  assert.deepEqual((await s.q("select code from invites")).rows, [{ code }]);
  assert.equal((await s.q("delete from invites where code = $1", [code])).rowCount, 1);

  await s.as(bob);
  assert.match(String((await redeem(s, code)).error), /invalid or expired/);
});

db("J7.5 · opening an invite never joins anyone; it names the book and its owner and says what it grants", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");
  const code = await s.invite(ann.book, ann, { role: "viewer" });

  await s.as(bob);
  const seen = await preview(s, code);
  assert.equal(seen.error, null);
  assert.deepEqual(seen.rows, [
    { book_name: "Ann's recipes", owner_name: "Ann", already_member: false, role: "viewer" },
  ]);
  // Looking was not joining.
  assert.equal((await membersOf(s, ann.book)).length, 1);
  await s.as(bob);
  assert.equal((await s.q("select id from books where id = $1", [ann.book])).rowCount, 0);

  // Accepting is, at exactly the role the link said.
  await s.as(bob);
  assert.equal((await redeem(s, code)).error, null);
  const bobs = (await membersOf(s, ann.book)).find((m) => m.user_id === bob.id);
  assert.equal(bobs.role, "viewer");
  await s.as(bob);
  assert.match(String((await preview(s, code)).error), /already been used/, "a spent link previews as spent");
});

db("J7.5 · an invite is still something only a person can accept", async (s) => {
  const ann = await s.person("Ann");
  const code = await s.invite(ann.book, ann);
  const nobody = await s.anonymous("Not a person");

  // An anonymous sign-in holding a live link is refused, and the link is not spent.
  await s.as(nobody);
  assert.match(String((await redeem(s, code)).error), /sign in first/);
  await s.asAdmin();
  assert.equal((await s.one("select used_count from invites where code = $1", [code])).used_count, 0);
  assert.equal((await membersOf(s, ann.book)).length, 1);

  // Signed out altogether, neither function can even be called.
  await s.asAnon();
  assert.match(String((await redeem(s, code)).error), /permission denied/);
  await s.asAnon();
  assert.match(String((await preview(s, code)).error), /permission denied/);

  // A person with the same link gets in.
  const bob = await s.person("Bob");
  await s.as(bob);
  assert.equal((await redeem(s, code)).error, null);
  assert.equal((await membersOf(s, ann.book)).length, 2);
});
