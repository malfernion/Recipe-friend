/**
 * Assistants that sign in (J16.15, J17.15–J17.17), end to end: the MCP
 * SDK's own OAuth client, through Caddy, against GoTrue's OAuth server,
 * the consent the site's page gives, migration 011's hook and the mcp
 * service.
 *
 * The browser half — the consent screen — is played by the calls
 * js/connect.js makes with the person's session: GoTrue's authorization
 * details, connect_app, then approve. Google is not available here, so
 * the person is an email sign-up, which the dev stack allows.
 *
 * Needs the stack in server/ up and migrated, and skips without
 * DATABASE_URL like the other db-* files. What it makes is committed (the
 * services have to see it) and deleted at the end.
 */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { UnauthorizedError } = require("@modelcontextprotocol/sdk/client/auth.js");
const { skip, getPool, closePool, stackConfig, vendoredSupabase } = require("./helpers/db.js");
const { loadApp, aRecipe } = require("./helpers/load.js");

const oauth = (name, fn) => test(name, { skip, timeout: 60000 }, fn);
const REDIRECT = "http://localhost:33418/callback";

let cfg = null;
let supabase = null;
let admin = null;
const people = [];
const clients = [];

function setup() {
  if (cfg) return;
  cfg = stackConfig();
  supabase = vendoredSupabase();
  admin = client(cfg.serviceKey);
}

function client(key) {
  return supabase.createClient(cfg.url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

after(async () => {
  if (!skip) {
    const pool = getPool();
    for (const id of clients) await pool.query("delete from auth.oauth_clients where id = $1", [id]);
    for (const id of people) await admin.auth.admin.deleteUser(id);
  }
  await closePool();
});

/** A person, signed in, with a book holding one recipe. */
async function person(name = "Ann") {
  setup();
  const email = `${crypto.randomUUID()}@example.test`;
  const password = crypto.randomUUID();
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { name },
  });
  if (error) throw error;
  people.push(data.user.id);
  const c = client(cfg.anonKey);
  const signedIn = await c.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  const api = new (loadApp("api.js").RecipeApi)(c);
  api.userId = data.user.id;
  const book = (await api.listBooks()).find((b) => b.isOwner).id;
  await getPool().query("insert into recipes (id, book_id, data) values ($1, $2, $3)", [
    crypto.randomUUID(), book, aRecipe({ name: "Lentil soup" }),
  ]);
  return { id: data.user.id, client: c, api, book, token: signedIn.data.session.access_token };
}

/**
 * What js/connect.js does on Allow (or Deny), given the address GoTrue
 * sent the browser to. Returns where GoTrue then sends the browser.
 */
async function consent(who, authorizeUrl, { allow = true, connect = true, book } = {}) {
  const res = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(res.status, 302, "GoTrue sends the browser to the consent screen");
  const screen = new URL(res.headers.get("location"));
  assert.equal(screen.pathname, "/", "which is the site's own page");
  const id = screen.searchParams.get("authorization_id");
  assert.ok(id, "with the request's id");

  const details = await who.client.auth.oauth.getAuthorizationDetails(id);
  if (details.error) throw details.error;
  if (details.data.redirect_url) return { redirect: details.data.redirect_url, details: details.data };
  if (allow && connect) await who.api.connectApp(id, book || who.book);
  const answer = allow
    ? await who.client.auth.oauth.approveAuthorization(id, { skipBrowserRedirect: true })
    : await who.client.auth.oauth.denyAuthorization(id, { skipBrowserRedirect: true });
  if (answer.error) throw answer.error;
  return { redirect: answer.data.redirect_url, details: details.data };
}

/**
 * The SDK's OAuthClientProvider, with the browser replaced by `consent`:
 * where it would open a window, it signs in as `who` and answers.
 */
function provider(who, options = {}) {
  const held = { client: null, tokens: null, verifier: null, code: null, details: null };
  return {
    held,
    get redirectUrl() { return REDIRECT; },
    get clientMetadata() {
      return {
        client_name: options.name || "Test assistant",
        redirect_uris: [REDIRECT],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation: () => held.client,
    saveClientInformation: (info) => { held.client = info; clients.push(info.client_id); },
    tokens: () => held.tokens,
    saveTokens: (t) => { held.tokens = t; },
    saveCodeVerifier: (v) => { held.verifier = v; },
    codeVerifier: () => held.verifier,
    async redirectToAuthorization(url) {
      held.authorizeUrl = url;
      const { redirect, details } = await consent(who, url, options);
      held.details = details;
      const back = new URL(redirect);
      held.code = back.searchParams.get("code");
      held.error = back.searchParams.get("error");
    },
  };
}

/** Sign an app in the way Claude Code does, and hand back a connected MCP client. */
async function signIn(who, options) {
  const p = provider(who, options);
  const url = new URL(`${cfg.publicUrl}/mcp`);
  let transport = new StreamableHTTPClientTransport(url, { authProvider: p });
  const first = new Client({ name: "t", version: "1" });
  await assert.rejects(() => first.connect(transport), UnauthorizedError, "a client with no token is sent to sign in");
  if (!p.held.code) return { p, mcp: null };
  await transport.finishAuth(p.held.code);
  transport = new StreamableHTTPClientTransport(url, { authProvider: p });
  const mcp = new Client({ name: "t", version: "1" });
  await mcp.connect(transport);
  return { p, mcp };
}

const claims = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));

function mcpPost(token) {
  return fetch(`${cfg.url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

function refresh(p) {
  return fetch(`${cfg.url}/auth/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: p.held.tokens.refresh_token,
      client_id: p.held.client.client_id,
    }),
  });
}

// ---------------------------------------------------------------------

oauth("J17.15 · a client with no token is told where to sign in, and finds GoTrue wherever it looks", async () => {
  setup();
  const res = await mcpPost(null);
  assert.equal(res.status, 401);
  const challenge = res.headers.get("www-authenticate");
  const meta = /resource_metadata="([^"]+)"/.exec(challenge);
  assert.ok(meta, `the challenge names the metadata: ${challenge}`);
  assert.equal(meta[1], `${cfg.publicUrl}/.well-known/oauth-protected-resource/mcp`);

  for (const p of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    const prm = await (await fetch(`${cfg.url}${p}`)).json();
    assert.equal(prm.resource, `${cfg.publicUrl}/mcp`, p);
    assert.deepEqual(prm.authorization_servers, [`${cfg.publicUrl}/auth/v1`], p);
  }

  for (const p of [
    "/.well-known/oauth-authorization-server/auth/v1",
    "/.well-known/openid-configuration/auth/v1",
    "/auth/v1/.well-known/oauth-authorization-server",
    "/auth/v1/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server",
  ]) {
    const res = await fetch(`${cfg.url}${p}`);
    assert.equal(res.status, 200, p);
    const as = await res.json();
    assert.equal(as.issuer, `${cfg.publicUrl}/auth/v1`, p);
    assert.equal(as.registration_endpoint, `${cfg.publicUrl}/auth/v1/oauth/clients/register`, `${p}: apps register themselves`);
    assert.ok(as.code_challenge_methods_supported.includes("S256"), p);
  }
});

oauth("J17.15 · an MCP client signs in through the owner's consent and reads the book it was given", async () => {
  const ann = await person();
  const { p, mcp } = await signIn(ann, { name: "Claude" });

  assert.equal(p.held.details.client.name, "Claude", "the consent screen is told which app is asking");
  assert.equal(p.held.details.redirect_uri, REDIRECT, "and where it will send the person back to");
  const auth = new URL(p.held.authorizeUrl);
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256", "PKCE, as OAuth 2.1 requires");

  const tools = await mcp.listTools();
  assert.equal(tools.tools.length, 12);
  const listed = await mcp.callTool({ name: "list_recipes", arguments: {} });
  assert.match(listed.content[0].text, /Lentil soup/, "the book the owner chose");
  await mcp.close();

  const { rows } = await getPool().query(
    "select x.client_id, x.redirect_host, x.last_used_at, m.book_id from agent_apps x join book_members m on m.user_id = x.agent_id where x.user_id = $1",
    [ann.id]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].book_id, ann.book);
  assert.equal(rows[0].redirect_host, "localhost:33418");
  assert.ok(rows[0].last_used_at, "and its use is recorded, as a key's is");

  const listedAgents = await ann.api.listAgents(ann.book);
  assert.deepEqual(
    listedAgents.map((a) => [a.name, a.kind, a.redirectHost]),
    [["Claude", "app", "localhost:33418"]],
    "the owner sees it under Agents as a connected app"
  );
});

oauth("J17.16 · the app's token names its agent, never the person, and only /mcp accepts it", async () => {
  const ann = await person();
  const { p, mcp } = await signIn(ann);
  await mcp.close();
  const token = p.held.tokens.access_token;
  const c = claims(token);
  const agent = (await getPool().query("select agent_id from agent_apps where user_id = $1", [ann.id])).rows[0].agent_id;

  assert.equal(c.sub, agent, "sub is the agent");
  assert.notEqual(c.sub, ann.id);
  assert.equal(c.role, "recipe_friend_app");
  assert.equal(c.aud, "recipe-friend-mcp");
  assert.equal(c.email, "", "none of the person's details");
  assert.deepEqual(c.user_metadata, {});
  assert.equal(c.client_id, p.held.client.client_id);

  const rest = await fetch(`${cfg.url}/rest/v1/books?select=id`, {
    headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey },
  });
  assert.ok(rest.status === 401 || rest.status === 403, `PostgREST refuses it (${rest.status})`);
  const storage = await fetch(`${cfg.url}/storage/v1/bucket`, {
    headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey },
  });
  assert.ok(storage.status >= 400, `Storage refuses it (${storage.status})`);
  const me = await (await fetch(`${cfg.url}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey },
  })).json();
  assert.notEqual(me.id, ann.id, "even GoTrue sees the agent, not the person");

  const refreshed = await refresh(p);
  assert.equal(refreshed.status, 200, "it refreshes");
  const next = await refreshed.json();
  assert.notEqual(next.refresh_token, p.held.tokens.refresh_token, "with rotation");
  assert.equal(claims(next.access_token).sub, agent, "and the new token is the agent's too");
  assert.equal((await mcpPost(next.access_token)).status, 200);
});

oauth("J17.16 · a person's own session is refused at /mcp, and so is a token nobody signed", async () => {
  const ann = await person();
  const own = await mcpPost(ann.token);
  assert.equal(own.status, 401, "a signed-in person's token is not an app's");
  assert.match(own.headers.get("www-authenticate"), /error="invalid_token"/);

  const forged = ann.token.split(".").slice(0, 2).join(".") + ".AAAA";
  assert.equal((await mcpPost(forged)).status, 401);
});

oauth("J16.15 · an app nobody connected to a book gets no token, even with GoTrue's approval", async () => {
  const ann = await person();
  const p = provider(ann, { connect: false });
  const transport = new StreamableHTTPClientTransport(new URL(`${cfg.publicUrl}/mcp`), { authProvider: p });
  await assert.rejects(() => new Client({ name: "t", version: "1" }).connect(transport), UnauthorizedError);
  assert.ok(p.held.code, "approved behind the consent screen's back");
  await assert.rejects(() => transport.finishAuth(p.held.code), "the hook refuses to issue it a token");
});

oauth("J16.15 · Deny sends the app away with access_denied and makes nothing", async () => {
  const ann = await person();
  const { p, mcp } = await signIn(ann, { allow: false });
  assert.equal(mcp, null);
  assert.equal(p.held.error, "access_denied");
  const { rows } = await getPool().query("select 1 from agent_apps where user_id = $1", [ann.id]);
  assert.equal(rows.length, 0);
});

oauth("J16.15 · only the owner of a book may connect an app to it", async () => {
  const ann = await person("Ann");
  const sam = await person("Sam");
  const p = provider(sam, { book: ann.book });
  const transport = new StreamableHTTPClientTransport(new URL(`${cfg.publicUrl}/mcp`), { authProvider: p });
  await assert.rejects(
    () => new Client({ name: "t", version: "1" }).connect(transport),
    { message: /only the owner of a book may connect an app to it/ }
  );
});

oauth("J17.17 · removing the app's agent ends its refresh token at once and its access token within the cache", async () => {
  const ann = await person();
  const { p, mcp } = await signIn(ann);
  await mcp.close();
  const token = p.held.tokens.access_token;
  const agent = claims(token).sub;

  await ann.api.removeAgent(ann.book, agent);

  const pool = getPool();
  const left = await pool.query(
    "select (select count(*) from auth.oauth_consents where user_id = $1 and client_id = $2)::int as consents, (select count(*) from auth.sessions where user_id = $1 and oauth_client_id = $2)::int as sessions",
    [ann.id, p.held.client.client_id]
  );
  assert.deepEqual(left.rows[0], { consents: 0, sessions: 0 }, "GoTrue's grant and sessions go with it");

  const refused = await refresh(p);
  assert.equal(refused.status, 400, "its refresh token is dead");

  const wait = (Number(cfg.mcpCacheSeconds) || 30) * 1000 + 1000;
  await new Promise((r) => setTimeout(r, wait));
  const res = await mcpPost(token);
  assert.equal(res.status, 401, "and its last access token stops once the cache lets go");
  assert.match(res.headers.get("www-authenticate"), /error="invalid_token"/);
});

oauth("J17.15 · a client that asks for openid still gets a token: the scope is the server's", async () => {
  const ann = await person();
  setup();
  const reg = await (await fetch(`${cfg.url}/auth/v1/oauth/clients/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Greedy", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  })).json();
  clients.push(reg.client_id);
  const verifier = crypto.randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    client_id: reg.client_id, redirect_uri: REDIRECT, response_type: "code", scope: "openid profile email",
    code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
  });
  const { redirect } = await consent(ann, `${cfg.url}/auth/v1/oauth/authorize?${q}`);
  const code = new URL(redirect).searchParams.get("code");
  const res = await fetch(`${cfg.url}/auth/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier }),
  });
  assert.equal(res.status, 200, "no ID token is attempted, so nothing fails");
  assert.equal(claims((await res.json()).access_token).scope, "email");
});
