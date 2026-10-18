/**
 * J16 · an agent's key — held by the database (migration 010).
 *
 * The key is made by create_agent, stored only as a hash, readable by
 * nobody, and turned back into an agent only by resolve_agent_key, which
 * only the hosted MCP server's role may call. See db-people.test.js for
 * how these run.
 */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { skip, inTransaction, closePool } = require("./helpers/db.js");

const db = (name, fn) => test(name, { skip }, () => inTransaction(fn));
after(closePool);

const sha256 = (text) => crypto.createHash("sha256").update(text).digest();

db("J16.6 · the key is shown once, and only its hash is kept", async (s) => {
  const ann = await s.person("Ann");
  const agent = await s.agentIn(ann.book, "Meal planner");

  assert.match(agent.key, /^rfk_[A-Za-z0-9_-]{43}$/, "rfk_ and 256 bits, url-safe");
  assert.equal(agent.keyPrefix, agent.key.slice(0, 12));

  await s.asAdmin();
  const row = await s.one("select * from agent_keys where agent_id = $1", [agent.id]);
  assert.deepEqual(row.key_hash, sha256(agent.key));
  assert.equal(row.key_prefix, agent.keyPrefix);
  assert.equal(row.last_used_at, null);
  // Nowhere in the row, nor in the agent's account, is the key itself.
  const user = await s.one("select to_jsonb(u) as u from auth.users u where id = $1", [agent.id]);
  for (const text of [JSON.stringify(row), JSON.stringify(user.u)]) {
    assert.ok(!text.includes(agent.key.slice(4)), "the key was stored in plain text");
  }

  // Two agents, two keys.
  const second = await s.agentIn(ann.book, "Shopper");
  assert.notEqual(second.key, agent.key);
});

db("J16.6 · the owner sees each key's prefix, when it was made and when it was last used", async (s) => {
  const ann = await s.person("Ann");
  const ed = await s.person("Ed");
  await s.member(ann.book, ed, "editor");
  const agent = await s.agentIn(ann.book, "Meal planner");

  await s.as(ann);
  const [listed] = (await s.q("select * from list_agents($1)", [ann.book])).rows;
  assert.equal(listed.agent_id, agent.id);
  assert.equal(listed.name, "Meal planner");
  assert.equal(listed.key_prefix, agent.keyPrefix);
  assert.ok(listed.created_at);
  assert.equal(listed.last_used_at, null);
  assert.equal(listed.kind, "key");
  assert.equal(listed.redirect_host, null, "a key sends nobody anywhere");
  assert.equal(Object.keys(listed).length, 7, "and nothing else — certainly not the hash");

  // Used, and the list says so. A second use inside the minute writes nothing.
  await s.asMcp();
  await s.q("select resolve_agent_key($1)", [agent.key]);
  await s.asAdmin();
  const first = (await s.one("select last_used_at from agent_keys where agent_id = $1", [agent.id])).last_used_at;
  assert.ok(first);
  await s.q("update agent_keys set last_used_at = now() - interval '30 seconds' where agent_id = $1", [agent.id]);
  const backdated = (await s.one("select last_used_at from agent_keys where agent_id = $1", [agent.id])).last_used_at;
  await s.asMcp();
  await s.q("select resolve_agent_key($1)", [agent.key]);
  await s.asAdmin();
  assert.deepEqual(
    (await s.one("select last_used_at from agent_keys where agent_id = $1", [agent.id])).last_used_at,
    backdated,
    "written at most once a minute"
  );

  // An editor, an agent and a stranger are not shown the list.
  for (const who of [ed, agent]) {
    await s.as(who);
    assert.match(String((await s.attempt("select * from list_agents($1)", [ann.book])).error), /only the owner/);
  }
});

db("J16.12 · nobody can read the keys: not the public, not the owner, not the agent", async (s) => {
  const ann = await s.person("Ann");
  const agent = await s.agentIn(ann.book);

  for (const who of ["anon", ann, agent]) {
    if (who === "anon") await s.asAnon();
    else await s.as(who);
    const read = await s.attempt("select * from agent_keys");
    assert.match(String(read.error), /permission denied/, `${who.name || who} read agent_keys`);
    const accounts = await s.attempt("select * from agent_accounts");
    assert.match(String(accounts.error), /permission denied/);
  }
});

db("J16.12 · only the hosted server's role may resolve a key", async (s) => {
  const ann = await s.person("Ann");
  const agent = await s.agentIn(ann.book);

  for (const who of ["anon", ann, agent]) {
    if (who === "anon") await s.asAnon();
    else await s.as(who);
    const call = await s.attempt("select resolve_agent_key($1)", [agent.key]);
    assert.match(String(call.error), /permission denied/, `${who.name || who} resolved a key`);
  }

  await s.asMcp();
  const { r } = await s.one("select resolve_agent_key($1) as r", [agent.key]);
  assert.deepEqual(r, { agent_id: agent.id, book_id: ann.book });

  // Anything that is not a live key is the same null, whatever was wrong with it.
  for (const wrong of [`rfk_${"A".repeat(43)}`, agent.key.slice(0, -1), "rfa1.whatever", "", null]) {
    assert.equal((await s.one("select resolve_agent_key($1) as r", [wrong])).r, null);
  }

  // And the role can do nothing else.
  for (const sql of ["select * from recipes", "select * from agent_keys", "select * from books"]) {
    assert.match(String((await s.attempt(sql)).error), /permission denied/, sql);
  }
  assert.match(String((await s.attempt("select create_agent($1, 'x')", [ann.book])).error), /permission denied/);
});

db("J16.12 · the role is one PostgREST can switch to and nobody can log in as", async (s) => {
  await s.asAdmin();
  const role = await s.one("select rolcanlogin from pg_roles where rolname = 'recipe_friend_mcp'");
  assert.equal(role.rolcanlogin, false);
  const member = await s.one("select pg_has_role('authenticator', 'recipe_friend_mcp', 'member') as ok");
  assert.equal(member.ok, true);
  for (const r of ["anon", "authenticated"]) {
    const { ok } = await s.one("select pg_has_role($1, 'recipe_friend_mcp', 'member') as ok", [r]);
    assert.equal(ok, false, `${r} can become recipe_friend_mcp`);
  }
});

db("J16.7 · a removed agent's key stops resolving in the same statement", async (s) => {
  const ann = await s.person("Ann");
  const agent = await s.agentIn(ann.book);
  const other = await s.agentIn(ann.book, "Another");

  await s.as(ann);
  await s.q("delete from book_members where book_id = $1 and user_id = $2", [ann.book, agent.id]);

  await s.asMcp();
  assert.equal((await s.one("select resolve_agent_key($1) as r", [agent.key])).r, null);
  assert.ok((await s.one("select resolve_agent_key($1) as r", [other.key])).r, "and only that one");
});

db("J16.1 · an agent's account is one GoTrue can read: its token columns are empty, not null", async (s) => {
  const ann = await s.person("Ann");
  const agent = await s.agentIn(ann.book);

  await s.asAdmin();
  const row = await s.one(
    `select confirmation_token, recovery_token, email_change_token_new, email_change,
            email_change_token_current, phone_change, phone_change_token, reauthentication_token,
            aud, role
     from auth.users where id = $1`,
    [agent.id]
  );
  for (const [col, value] of Object.entries(row)) {
    if (col === "aud" || col === "role") assert.equal(value, "authenticated", col);
    else assert.equal(value, "", `${col} is null, and GoTrue's user list would 500`);
  }
});

db("J16.2 · a book holds at most twenty agents", async (s) => {
  const ann = await s.person("Ann");
  for (let i = 0; i < 20; i++) await s.agentIn(ann.book, `Agent ${i}`);

  await s.as(ann);
  const one = await s.attempt("select create_agent($1, 'One too many')", [ann.book]);
  assert.match(String(one.error), /at most 20 agents/);
});
