/**
 * J16.15, J17.16, J17.17 · apps that sign in — held by the database
 * (migration 011).
 *
 * An app's OAuth sign-in ends where a key does: an agent in one book,
 * made by connect_app for the owner who allowed it. GoTrue's token for it
 * is rewritten by custom_access_token_hook to name that agent, and only
 * the MCP server's role may turn it back into a book. Removing the agent
 * removes GoTrue's grant and sessions with it. GoTrue's own rows
 * (auth.oauth_clients, oauth_authorizations, oauth_consents, sessions)
 * are written here as GoTrue writes them. See db-people.test.js for how
 * these run.
 */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { skip, inTransaction, closePool, randomUUID } = require("./helpers/db.js");

const db = (name, fn) => test(name, { skip }, () => inTransaction(fn));
after(closePool);

/** An app, registered the way dynamic client registration registers one. */
async function app(s, name = "Claude", redirect = "https://claude.ai/api/mcp/auth_callback") {
  await s.asAdmin();
  const id = randomUUID();
  await s.q(
    `insert into auth.oauth_clients (id, registration_type, redirect_uris, grant_types, client_name,
                                     client_type, token_endpoint_auth_method)
     values ($1, 'dynamic', $2, 'authorization_code,refresh_token', $3, 'public', 'none')`,
    [id, redirect, name]
  );
  return { id, name, redirect };
}

/**
 * A sign-in request GoTrue has sent to the consent screen, already
 * claimed by `who` (the screen's first call does that). Pending unless
 * told otherwise.
 */
async function request(s, client, who, over = {}) {
  await s.asAdmin();
  const authorizationId = randomUUID().replace(/-/g, "");
  await s.q(
    `insert into auth.oauth_authorizations (id, authorization_id, client_id, user_id, redirect_uri, scope,
                                            status, created_at, expires_at)
     values ($1, $2, $3, $4, $5, 'email', $6, now() - interval '1 minute', $7)`,
    [randomUUID(), authorizationId, client.id, who && who.id, client.redirect,
      over.status || "pending", over.expiresAt || new Date(Date.now() + 600000)]
  );
  return authorizationId;
}

/** What the consent screen's Allow does in the database. */
async function connect(s, who, authorizationId, book) {
  await s.as(who);
  return (await s.one("select connect_app($1, $2) as made", [authorizationId, book])).made;
}

/**
 * GoTrue's hook call for a token about to be issued. GoTrue makes it as
 * supabase_auth_admin, which these tests cannot become; that it may, and
 * nobody else may, is checked below, and db-oauth.test.js has GoTrue
 * itself call it.
 */
async function hook(s, userId, extra = {}) {
  await s.asAdmin();
  const event = {
    user_id: userId,
    authentication_method: "oauth_provider/authorization_code",
    claims: {
      sub: userId, aud: "authenticated", role: "authenticated", email: "ann@example.test", phone: "",
      app_metadata: { provider: "google" }, user_metadata: { name: "Ann" },
      aal: "aal1", session_id: randomUUID(), is_anonymous: false, iss: "http://localhost/auth/v1",
      exp: 4102444800, iat: 1792281600, ...extra,
    },
  };
  return (await s.one("select public.custom_access_token_hook($1::jsonb) as out", [JSON.stringify(event)])).out;
}

db("J16.15 · Allow makes the app an agent in the chosen book, named and placed like a key's", async (s) => {
  const ann = await s.person("Ann");
  const claude = await app(s);
  const made = await connect(s, ann, await request(s, claude, ann), ann.book);

  assert.equal(made.name, "Claude", "named after the app, from GoTrue's record of it");
  await s.asAdmin();
  const row = await s.one(
    `select m.book_id, m.role, x.user_id, x.client_id, x.redirect_host, u.email, u.is_anonymous
     from agent_apps x join book_members m on m.user_id = x.agent_id join auth.users u on u.id = x.agent_id
     where x.agent_id = $1`, [made.agent_id]);
  assert.deepEqual(
    { ...row },
    { book_id: ann.book, role: "agent", user_id: ann.id, client_id: claude.id, redirect_host: "claude.ai",
      email: null, is_anonymous: true }
  );
  assert.equal((await s.one("select count(*)::int as n from agent_keys where agent_id = $1", [made.agent_id])).n, 0,
    "it has no key: its way in is the sign-in");

  await s.as(ann);
  const [listed] = (await s.q("select * from list_agents($1)", [ann.book])).rows;
  assert.equal(listed.kind, "app");
  assert.equal(listed.name, "Claude");
  assert.equal(listed.redirect_host, "claude.ai");
  assert.equal(listed.key_prefix, null);
});

db("J16.15 · only an owner, for a book they own, and for their own pending request", async (s) => {
  const ann = await s.person("Ann");
  const ed = await s.person("Ed");
  const vi = await s.person("Vi");
  await s.member(ann.book, ed, "editor");
  await s.member(ann.book, vi, "viewer");
  const claude = await app(s);

  for (const who of [ed, vi]) {
    const id = await request(s, claude, who);
    await s.as(who);
    const { error } = await s.attempt("select connect_app($1, $2)", [id, ann.book]);
    assert.match(String(error), /only the owner/, "an editor or reader cannot hand the book over");
  }

  // Ann's book, but Ed's request: nobody connects an app on another's say-so.
  const edsRequest = await request(s, claude, ed);
  await s.as(ann);
  assert.match(String((await s.attempt("select connect_app($1, $2)", [edsRequest, ann.book])).error), /not yours/);

  for (const over of [{ status: "approved" }, { expiresAt: new Date(Date.now() - 1000) }]) {
    const stale = await request(s, claude, ann, over);
    await s.as(ann);
    assert.match(String((await s.attempt("select connect_app($1, $2)", [stale, ann.book])).error), /expired/);
  }

  const agent = await s.agentIn(ann.book, "Meal planner");
  const its = await request(s, claude, agent);
  await s.as(agent);
  assert.match(String((await s.attempt("select connect_app($1, $2)", [its, ann.book])).error), /agent cannot/);

  await s.asAnon();
  assert.ok((await s.attempt("select connect_app($1, $2)", [edsRequest, ann.book])).error, "anon may not call it");
});

db("J16.15 · connecting the same app again reuses its agent, or moves it to the book chosen", async (s) => {
  const ann = await s.person("Ann");
  const claude = await app(s);
  const first = await connect(s, ann, await request(s, claude, ann), ann.book);
  const again = await connect(s, ann, await request(s, claude, ann), ann.book);
  assert.equal(again.agent_id, first.agent_id);
  assert.equal(again.reused, true);

  await s.as(ann);
  const second = (await s.one("insert into books (name, owner) values ('Second', $1) returning id", [ann.id])).id;
  await s.q("insert into book_members (book_id, user_id, role) values ($1, $2, 'owner')", [second, ann.id]);
  const moved = await connect(s, ann, await request(s, claude, ann), second);
  await s.asAdmin();
  assert.equal((await s.one("select count(*)::int as n from agent_apps where user_id = $1", [ann.id])).n, 1,
    "still one agent for the app");
  assert.equal((await s.one("select book_id from book_members where user_id = $1", [moved.agent_id])).book_id, second);
  assert.equal((await s.one("select count(*)::int as n from book_members where user_id = $1", [first.agent_id])).n, 0,
    "and out of the first book");
});

db("J17.16 · the hook leaves a person's own token exactly as it was", async (s) => {
  const ann = await s.person("Ann");
  const out = await hook(s, ann.id);
  assert.equal(out.claims.sub, ann.id);
  assert.equal(out.claims.role, "authenticated");
  assert.equal(out.claims.email, "ann@example.test");
  assert.equal(out.claims.aud, "authenticated");
});

db("J17.16 · an app's token is rewritten to its agent, or refused if it has none", async (s) => {
  const ann = await s.person("Ann");
  const claude = await app(s);

  const refused = await hook(s, ann.id, { client_id: claude.id });
  assert.equal(refused.error.http_code, 403, "approved behind the consent screen's back: no token");
  assert.equal(refused.claims, undefined);

  const made = await connect(s, ann, await request(s, claude, ann), ann.book);
  const out = await hook(s, ann.id, { client_id: claude.id, scope: "email" });
  assert.equal(out.claims.sub, made.agent_id, "the agent, never the person");
  assert.equal(out.claims.role, "recipe_friend_app");
  assert.equal(out.claims.aud, "recipe-friend-mcp");
  assert.equal(out.claims.is_anonymous, true);
  assert.equal(out.claims.email, "");
  assert.deepEqual(out.claims.user_metadata, {});
  assert.deepEqual(out.claims.app_metadata, {});
  assert.equal(out.claims.client_id, claude.id, "what refreshing and revoking go by is kept");
  for (const k of ["session_id", "aal", "exp", "iat", "iss", "phone"]) assert.ok(k in out.claims, k);

  // Another person's sign-in with the same app is not Ann's agent.
  const bo = await s.person("Bo");
  assert.ok((await hook(s, bo.id, { client_id: claude.id })).error);
});

db("J17.16 · the role an app's token names can be switched to by nothing, and the hook by GoTrue alone", async (s) => {
  await s.asAdmin();
  const role = await s.one("select rolcanlogin from pg_roles where rolname = 'recipe_friend_app'");
  assert.equal(role.rolcanlogin, false);
  for (const r of ["authenticator", "anon", "authenticated", "service_role", "supabase_storage_admin"]) {
    const { ok } = await s.one("select pg_has_role($1, 'recipe_friend_app', 'member') as ok", [r]);
    assert.equal(ok, false, `${r} can become recipe_friend_app, so PostgREST or Storage would take the token`);
  }
  for (const r of ["anon", "authenticated", "service_role"]) {
    const { ok } = await s.one(
      "select has_function_privilege($1, 'public.custom_access_token_hook(jsonb)', 'execute') as ok", [r]);
    assert.equal(ok, false, `${r} may call the hook`);
  }
  const { ok } = await s.one(
    "select has_function_privilege('supabase_auth_admin', 'public.custom_access_token_hook(jsonb)', 'execute') as ok");
  assert.equal(ok, true);
});

db("J17.16 · an app's agent is resolved only for the MCP server, and only while it is bound", async (s) => {
  const ann = await s.person("Ann");
  const claude = await app(s);
  const made = await connect(s, ann, await request(s, claude, ann), ann.book);

  for (const as of [() => s.as(ann), () => s.asAnon()]) {
    await as();
    assert.ok((await s.attempt("select resolve_agent_app($1, $2)", [made.agent_id, claude.id])).error,
      "nobody but recipe_friend_mcp may ask");
  }
  await s.asMcp();
  assert.deepEqual((await s.one("select resolve_agent_app($1, $2) as r", [made.agent_id, claude.id])).r,
    { agent_id: made.agent_id, book_id: ann.book });
  // The person's id, a key's agent, or another app: nothing.
  const key = await (async () => { await s.asAdmin(); return s.agentIn(ann.book, "Keyed"); })();
  await s.asMcp();
  for (const [a, c] of [[ann.id, claude.id], [key.id, claude.id], [made.agent_id, randomUUID()]]) {
    assert.equal((await s.one("select resolve_agent_app($1, $2) as r", [a, c])).r, null);
  }
  await s.asAdmin();
  assert.ok((await s.one("select last_used_at from agent_apps where agent_id = $1", [made.agent_id])).last_used_at,
    "its use is recorded");
});

db("J17.17 · removing the app's agent removes GoTrue's grant and sessions for it, and nobody else's", async (s) => {
  const ann = await s.person("Ann");
  const claude = await app(s);
  const other = await app(s, "ChatGPT", "https://chatgpt.com/connector_platform_oauth_redirect");
  const made = await connect(s, ann, await request(s, claude, ann), ann.book);
  await connect(s, ann, await request(s, other, ann), ann.book);

  await s.asAdmin();
  for (const c of [claude, other]) {
    await s.q("insert into auth.oauth_consents (id, user_id, client_id, scopes) values ($1, $2, $3, 'email')",
      [randomUUID(), ann.id, c.id]);
    await s.q("insert into auth.sessions (id, user_id, oauth_client_id, created_at) values ($1, $2, $3, now())",
      [randomUUID(), ann.id, c.id]);
  }
  // Ann's own browser session, which is no app's.
  await s.q("insert into auth.sessions (id, user_id, created_at) values ($1, $2, now())", [randomUUID(), ann.id]);

  await s.as(ann);
  await s.q("delete from book_members where user_id = $1", [made.agent_id]);

  await s.asAdmin();
  const count = async (sql, args) => (await s.one(sql, args)).n;
  assert.equal(await count("select count(*)::int as n from auth.oauth_consents where client_id = $1", [claude.id]), 0);
  assert.equal(await count("select count(*)::int as n from auth.sessions where oauth_client_id = $1", [claude.id]), 0,
    "its refresh tokens go with its sessions");
  assert.equal(await count("select count(*)::int as n from auth.users where id = $1", [made.agent_id]), 0);
  assert.equal(await count("select count(*)::int as n from agent_apps where agent_id = $1", [made.agent_id]), 0);
  assert.equal(await count("select count(*)::int as n from auth.oauth_consents where client_id = $1", [other.id]), 1,
    "the other app is untouched");
  assert.equal(await count("select count(*)::int as n from auth.sessions where user_id = $1 and oauth_client_id is null",
    [ann.id]), 1, "and so is Ann's own sign-in");
});

db("J16.12 · create_agent still makes a key, through the shared principal", async (s) => {
  const ann = await s.person("Ann");
  const agent = await s.agentIn(ann.book, "Meal planner");
  assert.match(agent.key, /^rfk_/);
  await s.asAdmin();
  const { ok } = await s.one(
    "select has_function_privilege('authenticated', 'public.new_agent_principal(uuid, text)', 'execute') as ok");
  assert.equal(ok, false, "making a bare principal is nobody's to call");
});
