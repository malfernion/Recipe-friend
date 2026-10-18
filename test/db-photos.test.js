/**
 * J2.8, J7.17, J16.10 · Who may see and change a book's stored photos —
 * held by the policies on storage.objects.
 *
 * Storage runs every request as the caller's role with their claims, the
 * same way PostgREST does, so the policies can be asked directly here; a
 * photo's path starts with its book's id, and that is all they read. The
 * real upload and signed URL are in db-e2e.test.js. See
 * db-people.test.js for how these run.
 */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { skip, inTransaction, closePool } = require("./helpers/db.js");

const db = (name, fn) => test(name, { skip }, () => inTransaction(fn));
after(closePool);

const BUCKET = "recipe-photos";

/** A photo filed under `book`, as Storage would file it. */
async function photo(s, book) {
  await s.asAdmin();
  const name = `${book}/${randomUUID()}.jpg`;
  await s.q("insert into storage.objects (bucket_id, name) values ($1, $2)", [BUCKET, name]);
  return name;
}

const upload = (s, book) =>
  s.attempt("insert into storage.objects (bucket_id, name) values ($1, $2)", [BUCKET, `${book}/${randomUUID()}.jpg`]);
// Storage refuses a bare DELETE on its tables unless the statement says it
// comes from Storage, which is what the Storage API itself does before
// deleting. The policies are still what decide which rows go.
const remove = async (s, name) => {
  await s.q("select set_config('storage.allow_delete_query', 'true', true)");
  return (await s.q("delete from storage.objects where name = $1", [name])).rowCount;
};
const visible = async (s, name) => (await s.q("select 1 from storage.objects where name = $1", [name])).rowCount;

db("J2.8 · a device photo is kept in private storage that only the book's members can read", async (s) => {
  const ann = await s.person("Ann");
  const stranger = await s.person("Sam");
  const name = await photo(s, ann.book);

  await s.as(ann);
  assert.equal(await visible(s, name), 1);
  assert.equal((await upload(s, ann.book)).error, null);

  await s.as(stranger);
  assert.equal(await visible(s, name), 0);
  const planted = await upload(s, ann.book);
  assert.equal(planted.error && planted.error.code, "42501");
  assert.equal(await remove(s, name), 0);

  await s.asAnon();
  const anon = await s.attempt("select 1 from storage.objects where name = $1", [name]);
  assert.ok(anon.error || anon.rowCount === 0, "signed out, a photo was readable");

  const bucket = await (async () => {
    await s.asAdmin();
    return s.one("select public from storage.buckets where id = $1", [BUCKET]);
  })();
  assert.equal(bucket.public, false, "the bucket itself is private");
});

db("J7.17 · a viewer sees a book's photos and cannot add, replace or remove one", async (s) => {
  const ann = await s.person("Ann");
  const ed = await s.person("Ed");
  const vic = await s.person("Vic");
  await s.member(ann.book, ed, "editor");
  await s.member(ann.book, vic, "viewer");
  const name = await photo(s, ann.book);

  await s.as(vic);
  assert.equal(await visible(s, name), 1);
  assert.equal((await upload(s, ann.book)).error && true, true);
  assert.equal((await s.q("update storage.objects set metadata = '{}' where name = $1", [name])).rowCount, 0);
  assert.equal(await remove(s, name), 0);

  await s.as(ed);
  assert.equal((await upload(s, ann.book)).error, null);
  assert.equal((await s.q("update storage.objects set metadata = '{}' where name = $1", [name])).rowCount, 1);
  assert.equal(await remove(s, name), 1);
});

db("J16.10 · an agent gets no stored photos", async (s) => {
  const ann = await s.person("Ann");
  const vic = await s.person("Vic");
  await s.member(ann.book, vic, "viewer");
  const agent = await s.agentIn(ann.book);
  const name = await photo(s, ann.book);

  // Every other member of the book reads it, a viewer included…
  await s.as(vic);
  assert.equal(await visible(s, name), 1);

  // …and the agent can neither see it nor put one there.
  await s.as(agent);
  assert.equal(await visible(s, name), 0);
  assert.equal((await s.q("select 1 from storage.objects where bucket_id = $1", [BUCKET])).rowCount, 0);
  const added = await upload(s, ann.book);
  assert.equal(added.error && added.error.code, "42501");
  assert.equal(await remove(s, name), 0);
});
