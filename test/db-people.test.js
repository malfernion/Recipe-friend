/**
 * J1, J7 · Arriving, and who may be in a book — held by the database.
 *
 * These run against the real schema in a real Postgres (server/), each in
 * a transaction that is rolled back, acting as a user the way PostgREST
 * does: `authenticated`, with that user's claims. They skip when
 * DATABASE_URL is not set. Every one checks the thing that is allowed and
 * the thing that is refused, because a policy that refuses everything
 * passes half of these.
 */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { skip, inTransaction, closePool } = require("./helpers/db.js");

const db = (name, fn) => test(name, { skip }, () => inTransaction(fn));
after(closePool);

db("J1.3 · signing in for the first time creates a profile and one book named after the person", async (s) => {
  const dave = await s.person("Dave");

  const profile = await s.one("select display_name from profiles where user_id = $1", [dave.id]);
  assert.equal(profile.display_name, "Dave");
  const books = await s.q("select id, name from books where owner = $1", [dave.id]);
  assert.deepEqual(books.rows.map((b) => b.name), ["Dave's recipes"]);
  const member = await s.one("select role from book_members where book_id = $1 and user_id = $2", [
    books.rows[0].id,
    dave.id,
  ]);
  assert.equal(member.role, "owner");

  // J1.4 rides along: nothing is seeded.
  const recipes = await s.one("select count(*)::int as n from recipes where book_id = $1", [dave.book]);
  assert.equal(recipes.n, 0);

  // And it is theirs alone: somebody else signing in sees none of it.
  const other = await s.person("Erin");
  await s.as(other);
  const seen = await s.q("select id from books where id = $1", [dave.book]);
  assert.equal(seen.rowCount, 0);
  await s.as(dave);
  const mine = await s.q("select name from books");
  assert.deepEqual(mine.rows.map((b) => b.name), ["Dave's recipes"]);
});

db("J1.3 · a book is named from the Google name, or the full name, or the email address", async (s) => {
  const { randomUUID } = require("node:crypto");
  const make = async (meta, email) => {
    const id = randomUUID();
    await s.q(
      `insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, is_anonymous, created_at, updated_at)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, $3, false, now(), now())`,
      [id, email, JSON.stringify(meta)]
    );
    return (await s.one("select name from books where owner = $1", [id])).name;
  };
  await s.asAdmin();
  assert.equal(await make({ full_name: "Fran Smith" }, "f@example.test"), "Fran Smith's recipes");
  assert.equal(await make({ name: "" }, "gil.jones@example.test"), "gil.jones's recipes");
  assert.equal(await make({}, null), "cook's recipes");
});

db("J1.1 · signed out, the database hands over nothing", async (s) => {
  const ann = await s.person("Ann");
  await s.recipe(ann.book);
  await s.livePlan(ann.book);
  await s.invite(ann.book, ann);

  // The member reads their own book; that is the allowed case.
  await s.as(ann);
  assert.equal((await s.q("select id from recipes")).rowCount, 1);

  await s.asAnon();
  for (const table of ["books", "book_members", "recipes", "profiles", "invites", "live_plans", "plans"]) {
    const { error, rows } = await s.attempt(`select * from ${table}`);
    assert.ok(error || rows.length === 0, `anon read something from ${table}`);
  }
  const insert = await s.attempt("insert into books (name, owner) values ('x', $1)", [ann.id]);
  assert.ok(insert.error, "anon created a book");
  for (const fn of ["redeem_invite('x')", "preview_invite('x')", "add_agent($1, $1)", "move_recipe($1, $1, $1, null)"]) {
    const call = await s.attempt(`select * from ${fn}`, fn.includes("$1") ? [ann.id] : []);
    assert.match(String(call.error && call.error.message), /permission denied/, fn);
  }
});

db("J7.2 · anyone can create more books, and only as themselves", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");

  // What createBook does: the book, then yourself in it as owner.
  await s.as(ann);
  const book = await s.one("insert into books (name, owner) values ('Baking', $1) returning id", [ann.id]);
  await s.q("insert into book_members (book_id, user_id, role) values ($1, $2, 'owner')", [book.id, ann.id]);
  const names = await s.q("select name from books order by name");
  assert.deepEqual(names.rows.map((b) => b.name), ["Ann's recipes", "Baking"]);

  // A book owned by somebody else is refused.
  const forged = await s.attempt("insert into books (name, owner) values ('Yours', $1)", [bob.id]);
  assert.equal(forged.error && forged.error.code, "42501");
});

db("J7.5 · membership is something you agree to, not something you can be given", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");

  await s.as(ann);
  // Putting somebody else into your book, at any role, is refused.
  for (const role of ["editor", "viewer", "owner"]) {
    const forced = await s.attempt("insert into book_members (book_id, user_id, role) values ($1, $2, $3)", [
      ann.book,
      bob.id,
      role,
    ]);
    assert.equal(forced.error && forced.error.code, "42501", `owner put a person in as ${role}`);
  }
  // So is putting yourself into somebody else's.
  const intruding = await s.attempt("insert into book_members (book_id, user_id, role) values ($1, $2, 'owner')", [
    bob.book,
    ann.id,
  ]);
  assert.equal(intruding.error && intruding.error.code, "42501");

  // Joining a book you own as its owner — the second half of creating one — is allowed.
  const book = await s.one("insert into books (name, owner) values ('Second', $1) returning id", [ann.id]);
  const joined = await s.attempt("insert into book_members (book_id, user_id, role) values ($1, $2, 'owner')", [
    book.id,
    ann.id,
  ]);
  assert.equal(joined.error, null);

  await s.asAdmin();
  const bobs = await s.one("select count(*)::int as n from book_members where user_id = $1", [bob.id]);
  assert.equal(bobs.n, 1, "Bob is in his own book and nothing else");
});

db("J7.6 · a member can leave a book; its recipes stay with the book", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");
  const cat = await s.person("Cat");
  await s.member(ann.book, bob, "editor");
  await s.member(ann.book, cat, "editor");
  await s.recipe(ann.book);

  await s.as(bob);
  // Bob cannot take Cat out — that is the owner's (J7.12).
  const other = await s.q("delete from book_members where book_id = $1 and user_id = $2", [ann.book, cat.id]);
  assert.equal(other.rowCount, 0);
  const left = await s.q("delete from book_members where book_id = $1 and user_id = $2", [ann.book, bob.id]);
  assert.equal(left.rowCount, 1);
  assert.equal((await s.q("select id from recipes where book_id = $1", [ann.book])).rowCount, 0, "Bob still reads it");

  await s.asAdmin();
  assert.equal((await s.q("select id from recipes where book_id = $1", [ann.book])).rowCount, 1);
});

db("J7.12 · an owner can remove someone from a book, who keeps nothing from it", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");
  await s.member(ann.book, bob, "editor");
  await s.recipe(ann.book);

  await s.as(bob);
  assert.equal((await s.q("select id from recipes")).rowCount, 1);
  // An editor removing the owner is refused.
  const coup = await s.q("delete from book_members where book_id = $1 and user_id = $2", [ann.book, ann.id]);
  assert.equal(coup.rowCount, 0);

  await s.as(ann);
  const removed = await s.q("delete from book_members where book_id = $1 and user_id = $2", [ann.book, bob.id]);
  assert.equal(removed.rowCount, 1);

  await s.as(bob);
  assert.equal((await s.q("select id from recipes where book_id = $1", [ann.book])).rowCount, 0);
  assert.equal((await s.q("select id from books where id = $1", [ann.book])).rowCount, 0);
});

db("J7.8 · an owner can delete a book, which destroys its recipes for every member", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");
  await s.member(ann.book, bob, "editor");
  await s.recipe(ann.book);

  await s.as(bob);
  const notYours = await s.q("delete from books where id = $1", [ann.book]);
  assert.equal(notYours.rowCount, 0, "an editor deleted the book");

  await s.as(ann);
  const gone = await s.q("delete from books where id = $1", [ann.book]);
  assert.equal(gone.rowCount, 1);

  await s.asAdmin();
  assert.equal((await s.q("select id from recipes where book_id = $1", [ann.book])).rowCount, 0);
  assert.equal((await s.q("select 1 from book_members where book_id = $1", [ann.book])).rowCount, 0);
});

db("J7.18 · the Sharing list says who is in this book, by name", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");
  const stranger = await s.person("Sam");
  await s.member(ann.book, bob, "viewer");

  await s.as(bob);
  const roster = await s.q("select user_id, role from book_members where book_id = $1 order by role", [ann.book]);
  assert.deepEqual(roster.rows.map((r) => r.role), ["owner", "viewer"]);
  const names = await s.q("select display_name from profiles order by display_name");
  assert.deepEqual(names.rows.map((p) => p.display_name), ["Ann", "Bob"], "co-members' names and nobody else's");

  // Somebody sharing no book with Bob is not in that list, and cannot read the roster.
  await s.as(stranger);
  assert.equal((await s.q("select 1 from book_members where book_id = $1", [ann.book])).rowCount, 0);
  assert.equal((await s.q("select 1 from profiles where user_id = $1", [ann.id])).rowCount, 0);
});
