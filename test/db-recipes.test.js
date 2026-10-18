/**
 * J7 · Who may change what is in a book, moving and copying, and the two
 * triggers that keep a recipe in its book and a membership row on its
 * person — held by the database.
 *
 * See db-people.test.js for how these run. Refusals arrive two ways and
 * both are checked for what they are: an insert with no matching policy
 * raises, while an update or delete with no matching policy succeeds and
 * changes nothing — so those count rows, and then read the row back as
 * postgres to be sure.
 */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { skip, inTransaction, closePool } = require("./helpers/db.js");

const db = (name, fn) => test(name, { skip }, () => inTransaction(fn));
after(closePool);

async function nameOf(s, id) {
  await s.asAdmin();
  const row = await s.one("select data->>'name' as name, deleted_at from recipes where id = $1", [id]);
  return row && row.name;
}

db("J7.3 · everyone in a book who may write to it can add, edit and delete its recipes", async (s) => {
  const ann = await s.person("Ann");
  const ed = await s.person("Ed");
  await s.member(ann.book, ed, "editor");
  const soup = await s.recipe(ann.book, { name: "Soup" });
  const stew = await s.recipe(ann.book, { name: "Stew" });

  await s.as(ed);
  const added = await s.attempt("insert into recipes (id, book_id, data) values ($1, $2, $3)", [
    randomUUID(),
    ann.book,
    { name: "Bread" },
  ]);
  assert.equal(added.error, null);
  const edited = await s.q("update recipes set data = $2 where id = $1", [soup, { name: "Better soup" }]);
  assert.equal(edited.rowCount, 1);
  const deleted = await s.q("delete from recipes where id = $1", [stew]);
  assert.equal(deleted.rowCount, 1);
  assert.equal(await nameOf(s, soup), "Better soup");

  // Somebody outside the book can do none of it, and sees nothing.
  const outsider = await s.person("Olly");
  await s.as(outsider);
  assert.equal((await s.q("select id from recipes where book_id = $1", [ann.book])).rowCount, 0);
  const pushed = await s.attempt("insert into recipes (id, book_id, data) values ($1, $2, $3)", [
    randomUUID(),
    ann.book,
    { name: "Spam" },
  ]);
  assert.equal(pushed.error && pushed.error.code, "42501");
  assert.equal((await s.q("update recipes set data = '{}' where id = $1", [soup])).rowCount, 0);
  assert.equal((await s.q("delete from recipes where id = $1", [soup])).rowCount, 0);
  assert.equal(await nameOf(s, soup), "Better soup");
});

db("J7.17 · a book can be one you read and do not change", async (s) => {
  const ann = await s.person("Ann");
  const vic = await s.person("Vic");
  await s.member(ann.book, vic, "viewer");
  const soup = await s.recipe(ann.book, { name: "Soup", favourite: false });

  await s.as(vic);
  // Reading is the point.
  const read = await s.q("select data->>'name' as name from recipes where book_id = $1", [ann.book]);
  assert.deepEqual(read.rows, [{ name: "Soup" }]);

  // Every write is refused, favouriting included: a favourite is a write to the recipe.
  const added = await s.attempt("insert into recipes (id, book_id, data) values ($1, $2, '{}')", [
    randomUUID(),
    ann.book,
  ]);
  assert.equal(added.error && added.error.code, "42501");
  const starred = await s.q("update recipes set data = data || '{\"favourite\": true}' where id = $1", [soup]);
  assert.equal(starred.rowCount, 0);
  const deleted = await s.q("delete from recipes where id = $1", [soup]);
  assert.equal(deleted.rowCount, 0);
  const upsert = await s.attempt(
    "insert into recipes (id, book_id, data) values ($1, $2, '{}') on conflict (id) do update set data = excluded.data",
    [soup, ann.book]
  );
  assert.ok(upsert.error, "an upsert is a write too");

  await s.asAdmin();
  const still = await s.one("select data from recipes where id = $1", [soup]);
  assert.deepEqual(still.data, { name: "Soup", favourite: false });
});

db("J7.17 · an owner changes what each member may do, from the member list", async (s) => {
  const ann = await s.person("Ann");
  const ed = await s.person("Ed");
  const vic = await s.person("Vic");
  await s.member(ann.book, ed, "editor");
  await s.member(ann.book, vic, "viewer");
  const roleOf = async (user) => {
    await s.asAdmin();
    return (await s.one("select role from book_members where book_id = $1 and user_id = $2", [ann.book, user.id])).role;
  };

  await s.as(ann);
  assert.equal((await s.q("update book_members set role = 'viewer' where user_id = $1", [ed.id])).rowCount, 1);
  await s.as(ann);
  assert.equal((await s.q("update book_members set role = 'editor' where user_id = $1", [vic.id])).rowCount, 1);
  assert.equal(await roleOf(ed), "viewer");
  assert.equal(await roleOf(vic), "editor");

  // Ownership is not a rung on the ladder.
  await s.as(ann);
  const crowned = await s.attempt("update book_members set role = 'owner' where book_id = $1 and user_id = $2", [
    ann.book,
    vic.id,
  ]);
  assert.equal(crowned.error && crowned.error.code, "42501");
  // The owner's own row is not theirs to demote.
  const self = await s.q("update book_members set role = 'viewer' where book_id = $1 and user_id = $2", [
    ann.book,
    ann.id,
  ]);
  assert.equal(self.rowCount, 0);

  // A member who is not the owner changes nobody's role, their own included.
  await s.as(vic);
  assert.equal((await s.q("update book_members set role = 'editor' where user_id = $1", [ed.id])).rowCount, 0);
  await s.as(ed);
  assert.equal((await s.q("update book_members set role = 'editor' where user_id = $1", [ed.id])).rowCount, 0);
  assert.equal(await roleOf(ed), "viewer");
  assert.equal(await roleOf(ann), "owner");
});

db("J7.17 · an invite cannot hand out ownership, and says which role it grants", async (s) => {
  const ann = await s.person("Ann");
  await s.as(ann);
  const viewer = await s.attempt(
    "insert into invites (code, book_id, created_by, role) values ($1, $2, $3, 'viewer') returning role",
    [randomUUID(), ann.book, ann.id]
  );
  assert.equal(viewer.error, null);
  assert.equal(viewer.rows[0].role, "viewer");
  const owner = await s.attempt("insert into invites (code, book_id, created_by, role) values ($1, $2, $3, 'owner')", [
    randomUUID(),
    ann.book,
    ann.id,
  ]);
  assert.equal(owner.error && owner.error.code, "23514");
});

db("J7.17 · a membership row is one person in one book; only the role they hold may change", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");
  const cat = await s.person("Cat");
  await s.member(ann.book, bob, "editor");

  await s.as(ann);
  // Rewriting who the row is about would put Cat in a book she never joined.
  const swapped = await s.attempt("update book_members set user_id = $3 where book_id = $1 and user_id = $2", [
    ann.book,
    bob.id,
    cat.id,
  ]);
  assert.match(String(swapped.error && swapped.error.message), /one person in one book/);
  // And moving the row to another book Ann owns is the same thing by another door.
  const other = await s.one("insert into books (name, owner) values ('Other', $1) returning id", [ann.id]);
  const moved = await s.attempt("update book_members set book_id = $3 where book_id = $1 and user_id = $2", [
    ann.book,
    bob.id,
    other.id,
  ]);
  assert.match(String(moved.error && moved.error.message), /one person in one book/);

  // The role, on the same row, still changes.
  const role = await s.attempt("update book_members set role = 'viewer' where book_id = $1 and user_id = $2", [
    ann.book,
    bob.id,
  ]);
  assert.equal(role.error, null);
  assert.equal(role.rowCount, 1);
});

db("J7.10 · a recipe belongs to the book it was created in", async (s) => {
  const ann = await s.person("Ann");
  const second = await s.person("Bea");
  await s.member(second.book, ann, "editor");
  const soup = await s.recipe(ann.book, { name: "Soup" });

  await s.as(ann);
  // Ann may write to both books, and still cannot drag a row between them.
  const dragged = await s.attempt("update recipes set book_id = $2 where id = $1", [soup, second.book]);
  assert.equal(dragged.error && dragged.error.code, "23514");
  assert.match(dragged.error.message, /cannot change book/);
  // Nor by the door an ordinary push uses: an upsert naming the other book.
  const pushed = await s.attempt(
    `insert into recipes (id, book_id, data) values ($1, $2, '{"name":"Soup"}')
     on conflict (id) do update set book_id = excluded.book_id, data = excluded.data`,
    [soup, second.book]
  );
  assert.equal(pushed.error && pushed.error.code, "23514");

  // Editing it where it is is fine.
  const edited = await s.q("update recipes set data = '{\"name\":\"Soup 2\"}' where id = $1", [soup]);
  assert.equal(edited.rowCount, 1);
  await s.asAdmin();
  assert.equal((await s.one("select book_id from recipes where id = $1", [soup])).book_id, ann.book);
});

db("J7.10 · moving a recipe to another book is the owner's, as a copy under a new id and a tombstone", async (s) => {
  const ann = await s.person("Ann");
  const ed = await s.person("Ed");
  await s.member(ann.book, ed, "editor");
  // A second book Ann owns, and one she only reads.
  await s.as(ann);
  const baking = (await s.one("insert into books (name, owner) values ('Baking', $1) returning id", [ann.id])).id;
  await s.q("insert into book_members (book_id, user_id, role) values ($1, $2, 'owner')", [baking, ann.id]);
  const theirs = await s.person("Tom");
  await s.member(theirs.book, ann, "viewer");
  const soup = await s.recipe(ann.book, { name: "Soup" });
  const move = (id, target, newId = randomUUID()) =>
    s.attempt("select move_recipe($1, $2, $3, null) as id", [id, target, newId]);

  // An editor of the book it is leaving may not.
  await s.as(ed);
  const byEditor = await move(soup, baking);
  assert.match(String(byEditor.error && byEditor.error.message), /only the owner/);

  await s.as(ann);
  // Not into a book she cannot write to, and not into the book it is in.
  assert.match(String((await move(soup, theirs.book)).error), /cannot add recipes to that book/);
  assert.match(String((await move(soup, ann.book)).error), /already in that book/);

  // The owner, into a book she can write to: a copy and a tombstone.
  const newId = randomUUID();
  const moved = await move(soup, baking, newId);
  assert.equal(moved.error, null);
  assert.equal(moved.rows[0].id, newId);
  await s.asAdmin();
  const copy = await s.one("select book_id, data->>'name' as name, deleted_at from recipes where id = $1", [newId]);
  assert.deepEqual(copy, { book_id: baking, name: "Soup", deleted_at: null });
  const original = await s.one("select book_id, deleted_at from recipes where id = $1", [soup]);
  assert.equal(original.book_id, ann.book);
  assert.ok(original.deleted_at, "the original is tombstoned");

  // And a tombstone is not something to move again.
  await s.as(ann);
  assert.match(String((await move(soup, baking)).error), /not here to move/);
});

db("J7.16 · anyone in a book can copy one of its recipes into a book they can write to", async (s) => {
  const ann = await s.person("Ann");
  const vic = await s.person("Vic");
  await s.member(ann.book, vic, "viewer");
  const soup = await s.recipe(ann.book, { name: "Soup" });

  await s.as(vic);
  const { data } = await s.one("select data from recipes where id = $1", [soup]);
  // Into her own book: allowed — it takes nothing from anybody.
  const copied = await s.attempt("insert into recipes (id, book_id, data) values ($1, $2, $3)", [
    randomUUID(),
    vic.book,
    data,
  ]);
  assert.equal(copied.error, null);
  // Back into the book she only reads: refused.
  const back = await s.attempt("insert into recipes (id, book_id, data) values ($1, $2, $3)", [
    randomUUID(),
    ann.book,
    data,
  ]);
  assert.equal(back.error && back.error.code, "42501");
});
