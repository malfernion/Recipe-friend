/**
 * J16 · Letting a program help — held by the database.
 *
 * An agent is a principal with a membership row whose role is 'agent'
 * (migration 008), made by its owner with create_agent (010). Everything
 * it may and may not do is a policy, a function or a trigger. Its key is
 * db-agent-keys.test.js. See db-people.test.js for how these run.
 */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { skip, inTransaction, closePool } = require("./helpers/db.js");

const db = (name, fn) => test(name, { skip }, () => inTransaction(fn));
after(closePool);

const createAgent = (s, book, name = "Helper") => s.attempt("select create_agent($1, $2) as made", [book, name]);

db("J16.1 · an agent has no book of its own and cannot make one", async (s) => {
  const ann = await s.person("Ann");
  const agent = await s.agentIn(ann.book, "Kitchen helper");

  // The new-user trigger gives it a profile, where its name lives, and no book.
  const profile = await s.one("select display_name from profiles where user_id = $1", [agent.id]);
  assert.equal(profile.display_name, "Kitchen helper");
  assert.equal((await s.q("select 1 from books where owner = $1", [agent.id])).rowCount, 0);
  assert.deepEqual((await s.q("select book_id, role from book_members where user_id = $1", [agent.id])).rows, [
    { book_id: ann.book, role: "agent" },
  ]);
  // No email, no phone, no password: nothing anybody could sign in as.
  const row = await s.one("select email, phone, encrypted_password, is_anonymous from auth.users where id = $1", [agent.id]);
  assert.deepEqual(row, { email: null, phone: null, encrypted_password: "", is_anonymous: true });

  // Creating one is refused outright.
  await s.as(agent);
  const made = await s.attempt("insert into books (name, owner) values ('Mine', $1)", [agent.id]);
  assert.equal(made.error && made.error.code, "42501");

  // The same insert from a person goes through.
  await s.as(ann);
  assert.equal((await s.attempt("insert into books (name, owner) values ('More', $1)", [ann.id])).error, null);
});

db("J16.1 · an anonymous account nobody placed gets no book either", async (s) => {
  const loose = await s.anonymous();
  await s.as(loose);
  const made = await s.attempt("insert into books (name, owner) values ('Mine', $1)", [loose.id]);
  assert.equal(made.error && made.error.code, "42501");
});

db("J16.12 · the old way in is closed: add_agent places nobody, for anybody", async (s) => {
  const ann = await s.person("Ann");
  const loose = await s.anonymous();

  await s.as(ann);
  const placed = await s.attempt("select add_agent($1, $2)", [ann.book, loose.id]);
  assert.match(String(placed.error), /permission denied/);
  // Not even as postgres, which the grant does not stop.
  await s.asAdmin();
  const forced = await s.attempt("select add_agent($1, $2)", [ann.book, loose.id]);
  assert.match(String(forced.error), /create_agent now/);
  assert.equal((await s.q("select 1 from book_members where user_id = $1", [loose.id])).rowCount, 0);
});

db("J16.1 · an agent belongs to one book and cannot be added to a second", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");
  await s.member(ann.book, bob, "editor");
  const agent = await s.agentIn(ann.book);

  // Bob read the agent's id off the roster, and owns a book of his own.
  // create_agent takes no id, so the only way to try is a row of his own.
  await s.as(bob);
  const stolen = await s.attempt("insert into book_members (book_id, user_id, role) values ($1, $2, 'agent')", [
    bob.book,
    agent.id,
  ]);
  assert.ok(stolen.error, "an agent was attached to a second book");

  await s.asAdmin();
  assert.equal((await s.q("select 1 from book_members where user_id = $1", [agent.id])).rowCount, 1);
});

db("J16.2 · only an owner may add one, and it is named", async (s) => {
  const ann = await s.person("Ann");
  const ed = await s.person("Ed");
  const vi = await s.person("Vi");
  await s.member(ann.book, ed, "editor");
  await s.member(ann.book, vi, "viewer");
  const agent = await s.agentIn(ann.book);

  for (const who of [ed, vi]) {
    await s.as(who);
    assert.match(String((await createAgent(s, ann.book)).error), /only the owner/);
  }
  await s.as(agent);
  assert.match(String((await createAgent(s, ann.book)).error), /an agent cannot add an agent/);
  await s.asAnon();
  assert.match(String((await createAgent(s, ann.book)).error), /permission denied/);

  await s.as(ann);
  assert.match(String((await createAgent(s, ann.book, "   ")).error), /needs a name/);
  const made = await createAgent(s, ann.book, "  Meal planner  ");
  assert.equal(made.error, null);
  assert.equal(made.rows[0].made.name, "Meal planner");

  await s.asAdmin();
  const names = (await s.q(
    "select p.display_name from book_members m join profiles p using (user_id) where m.book_id = $1 and m.role = 'agent' order by 1",
    [ann.book]
  )).rows.map((r) => r.display_name);
  assert.deepEqual(names, ["Kitchen helper", "Meal planner"]);
});

db("J16.3 · an agent may read the book, add recipes, and work on the plan — and no more", async (s) => {
  const ann = await s.person("Ann");
  const soup = await s.recipe(ann.book, { name: "Soup" });
  const agent = await s.agentIn(ann.book);
  await s.as(ann);
  const baking = (await s.one("insert into books (name, owner) values ('Baking', $1) returning id", [ann.id])).id;

  await s.as(agent);
  // Allowed: read, add, plan.
  assert.deepEqual((await s.q("select id from recipes")).rows, [{ id: soup }]);
  const added = await s.attempt("insert into recipes (id, book_id, data) values ($1, $2, '{\"name\":\"Bread\"}')", [
    randomUUID(),
    ann.book,
  ]);
  assert.equal(added.error, null);
  const planned = await s.attempt(
    "insert into live_plans (book_id, data) values ($1, '{\"meals\":[1]}') on conflict (book_id) do update set data = excluded.data",
    [ann.book]
  );
  assert.equal(planned.error, null);
  assert.equal((await s.q("update live_plans set data = '{\"meals\":[1,2]}' where book_id = $1", [ann.book])).rowCount, 1);

  // Refused: edit, favourite or delete a recipe.
  assert.equal((await s.q("update recipes set data = '{\"name\":\"Mine now\"}' where id = $1", [soup])).rowCount, 0);
  assert.equal((await s.q("update recipes set data = data || '{\"favourite\":true}' where id = $1", [soup])).rowCount, 0);
  assert.equal((await s.q("delete from recipes where id = $1", [soup])).rowCount, 0);
  // An upsert of a recipe that is already there is an edit.
  const upsert = await s.attempt(
    "insert into recipes (id, book_id, data) values ($1, $2, '{}') on conflict (id) do update set data = excluded.data",
    [soup, ann.book]
  );
  assert.ok(upsert.error);
  // Refused: move one, invite anybody, change a role, touch the book.
  assert.match(String((await s.attempt("select move_recipe($1, $2, $3, null)", [soup, baking, randomUUID()])).error), /only the owner/);
  const invited = await s.attempt("insert into invites (code, book_id, created_by) values ('x', $1, $2)", [ann.book, agent.id]);
  assert.equal(invited.error && invited.error.code, "42501");
  assert.equal((await s.q("update book_members set role = 'viewer' where book_id = $1", [ann.book])).rowCount, 0);
  assert.equal((await s.q("update books set name = 'Taken' where id = $1", [ann.book])).rowCount, 0);
  assert.equal((await s.q("delete from books where id = $1", [ann.book])).rowCount, 0);

  await s.asAdmin();
  assert.deepEqual((await s.one("select data from recipes where id = $1", [soup])).data, { name: "Soup" });
  assert.equal((await s.one("select name from books where id = $1", [ann.book])).name, "Ann's recipes");
});

db("J16.3 · an agent sees only the book it was placed in", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");
  await s.recipe(bob.book);
  const agent = await s.agentIn(ann.book);

  await s.as(agent);
  assert.deepEqual((await s.q("select id from books")).rows, [{ id: ann.book }]);
  assert.equal((await s.q("select 1 from recipes where book_id = $1", [bob.book])).rowCount, 0);
  const elsewhere = await s.attempt("insert into recipes (id, book_id, data) values ($1, $2, '{}')", [
    randomUUID(),
    bob.book,
  ]);
  assert.equal(elsewhere.error && elsewhere.error.code, "42501");
});

db("J16.4 · an agent does not finish a plan, and does not undo one", async (s) => {
  const ann = await s.person("Ann");
  const agent = await s.agentIn(ann.book);
  const week = randomUUID();
  await s.asAdmin();
  await s.q("insert into plans (id, book_id, data, completed_at) values ($1, $2, '{}', now())", [week, ann.book]);

  await s.as(agent);
  assert.equal((await s.q("select id from plans")).rowCount, 1, "it reads the record");
  const done = await s.attempt("insert into plans (id, book_id, data, completed_at) values ($1, $2, '{}', now())", [
    randomUUID(),
    ann.book,
  ]);
  assert.equal(done.error && done.error.code, "42501");
  assert.equal((await s.q("delete from plans where id = $1", [week])).rowCount, 0);

  // A person in the book does both.
  await s.as(ann);
  assert.equal(
    (await s.attempt("insert into plans (id, book_id, data, completed_at) values ($1, $2, '{}', now())", [randomUUID(), ann.book])).error,
    null
  );
  assert.equal((await s.q("delete from plans where id = $1", [week])).rowCount, 1);
});

db("J16.5 · an agent may clear the plan", async (s) => {
  const ann = await s.person("Ann");
  const agent = await s.agentIn(ann.book);
  await s.livePlan(ann.book, { id: "week-1", meals: ["soup", "stew"] });

  await s.as(agent);
  // Clear is an empty plan with a new id written over the row.
  const cleared = await s.q("update live_plans set data = $2 where book_id = $1", [ann.book, { id: "week-2", meals: [] }]);
  assert.equal(cleared.rowCount, 1);
  // Deleting the row is not clearing it, and is refused.
  assert.equal((await s.q("delete from live_plans where book_id = $1", [ann.book])).rowCount, 0);

  await s.asAdmin();
  assert.deepEqual((await s.one("select data from live_plans where book_id = $1", [ann.book])).data, {
    id: "week-2",
    meals: [],
  });
});

db("J16.7 · removing an agent is immediate and entire", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");
  await s.recipe(ann.book);
  const agent = await s.agentIn(ann.book);
  const left = async () => {
    await s.asAdmin();
    return (await s.one(
      `select (select count(*) from auth.users where id = $1)::int as account,
              (select count(*) from agent_keys where agent_id = $1)::int as key,
              (select count(*) from agent_accounts where user_id = $1)::int as record`,
      [agent.id]
    ));
  };
  assert.deepEqual(await left(), { account: 1, key: 1, record: 1 });

  // While it is in a book, nobody can discard its account — not even its owner.
  await s.as(ann);
  await s.q("select discard_orphan_agent($1)", [agent.id]);
  assert.equal((await left()).account, 1);

  // The × is one delete, and the key and the account go with the row.
  await s.as(ann);
  assert.equal((await s.q("delete from book_members where book_id = $1 and user_id = $2", [ann.book, agent.id])).rowCount, 1);
  assert.deepEqual(await left(), { account: 0, key: 0, record: 0 });
  await s.asMcp();
  assert.equal((await s.one("select resolve_agent_key($1) as r", [agent.key])).r, null, "its key resolves to nobody");

  // A token minted a moment before still names it, and reaches nothing.
  await s.as(agent);
  assert.equal((await s.q("select 1 from recipes")).rowCount, 0, "removed, it reads nothing");
  const write = await s.attempt("insert into recipes (id, book_id, data) values ($1, $2, '{}')", [randomUUID(), ann.book]);
  assert.ok(write.error);

  // A person in no book is never discarded, whoever asks.
  await s.as(bob);
  await s.q("delete from book_members where user_id = $1", [bob.id]);
  await s.as(ann);
  await s.q("select discard_orphan_agent($1)", [bob.id]);
  await s.asAdmin();
  assert.equal((await s.one("select count(*)::int as n from auth.users where id = $1", [bob.id])).n, 1);
});

db("J16.7 · deleting the book takes its agents and their keys with it", async (s) => {
  const ann = await s.person("Ann");
  await s.as(ann);
  const baking = (await s.one("insert into books (name, owner) values ('Baking', $1) returning id", [ann.id])).id;
  await s.q("insert into book_members (book_id, user_id, role) values ($1, $2, 'owner')", [baking, ann.id]);
  const agent = await s.agentIn(baking);
  const other = await s.agentIn(ann.book);

  await s.as(ann);
  assert.equal((await s.q("delete from books where id = $1", [baking])).rowCount, 1);

  await s.asAdmin();
  assert.equal((await s.one("select count(*)::int as n from auth.users where id = $1", [agent.id])).n, 0);
  assert.equal((await s.one("select count(*)::int as n from agent_keys where agent_id = $1", [agent.id])).n, 0);
  assert.equal((await s.one("select count(*)::int as n from agent_keys where agent_id = $1", [other.id])).n, 1,
    "an agent of another book is untouched");
});

db("J16.8 · an agent's role cannot be changed, to it or from it", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");
  await s.member(ann.book, bob, "editor");
  const agent = await s.agentIn(ann.book);

  await s.as(ann);
  const widened = await s.attempt("update book_members set role = 'editor' where book_id = $1 and user_id = $2", [
    ann.book,
    agent.id,
  ]);
  assert.match(String(widened.error), /not a role you change/);
  const narrowed = await s.attempt("update book_members set role = 'viewer' where book_id = $1 and user_id = $2", [
    ann.book,
    agent.id,
  ]);
  assert.match(String(narrowed.error), /not a role you change/);
  const demoted = await s.attempt("update book_members set role = 'agent' where book_id = $1 and user_id = $2", [
    ann.book,
    bob.id,
  ]);
  assert.ok(demoted.error, "a person was turned into an agent");

  // A person's role still changes along the ladder.
  const person = await s.attempt("update book_members set role = 'viewer' where book_id = $1 and user_id = $2", [
    ann.book,
    bob.id,
  ]);
  assert.equal(person.error, null);
  assert.equal(person.rowCount, 1);
  await s.asAdmin();
  assert.equal((await s.one("select role from book_members where user_id = $1", [agent.id])).role, "agent");
});

// An agent whose account stops being anonymous is still an agent (009).
//
// GoTrue lets an anonymous user become a permanent one — by adding an
// email address where email sign-in is on, or linking an identity where
// manual linking is on — and the agent's own credential is enough to do
// it. 008 decided who was an agent by asking about anonymity, so a
// converted agent could make itself a book, redeem an invite link, and
// outlive its own removal. 009 asks whether the account was ever placed
// as an agent instead. `convert` does to the row what GoTrue does, and
// the token that follows says is_anonymous: false.

async function placedAgent(s, owner, name) {
  return s.agentIn(owner.book, name);
}

async function convert(s, agent) {
  await s.asAdmin();
  await s.q("update auth.users set is_anonymous = false, email = $2 where id = $1", [
    agent.id,
    `${agent.id}@example.test`,
  ]);
  return { ...agent, anonymous: false };
}

db("J16.1 · an agent has no book of its own and cannot make one, even once its account stops being anonymous", async (s) => {
  const ann = await s.person("Ann");
  const agent = await convert(s, await placedAgent(s, ann));

  await s.as(agent);
  const made = await s.attempt("insert into books (name, owner) values ('Mine', $1)", [agent.id]);
  assert.equal(made.error && made.error.code, "42501");
  // In the book it was placed in, it is exactly as narrow as before.
  assert.equal((await s.q("select id from books")).rowCount, 1);
  assert.equal((await s.q("update books set name = 'Taken' where id = $1", [ann.book])).rowCount, 0);

  // A person's token says the same thing, and they still get their book.
  await s.as(ann);
  assert.equal((await s.attempt("insert into books (name, owner) values ('More', $1)", [ann.id])).error, null);
});

db("J7.5 · an invite is still something only a person can accept, an agent that stopped being anonymous included", async (s) => {
  const ann = await s.person("Ann");
  const bob = await s.person("Bob");
  const code = await s.invite(bob.book, bob);
  const agent = await convert(s, await placedAgent(s, ann));

  await s.as(agent);
  const joined = await s.attempt("select * from redeem_invite($1)", [code]);
  assert.match(String(joined.error), /sign in first/);
  await s.asAdmin();
  assert.equal((await s.one("select used_count from invites where code = $1", [code])).used_count, 0);

  // Ann, a person, redeems the same link.
  await s.as(ann);
  assert.equal((await s.attempt("select * from redeem_invite($1)", [code])).error, null);
});

db("J16.7 · removing an agent is immediate and entire, even once its account stops being anonymous", async (s) => {
  const ann = await s.person("Ann");
  const agent = await convert(s, await placedAgent(s, ann));

  await s.as(ann);
  await s.q("delete from book_members where book_id = $1 and user_id = $2", [ann.book, agent.id]);
  await s.asAdmin();
  assert.equal((await s.one("select count(*)::int as n from auth.users where id = $1", [agent.id])).n, 0,
    "the converted agent's account outlived its removal");
});
