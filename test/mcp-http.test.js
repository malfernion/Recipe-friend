/**
 * mcp/http.js and mcp/auth.js — the hosted server's door (J17.1, J17.3).
 *
 * The real handler on a real port, with the database's half stubbed: a
 * resolver that knows one key. db-mcp-http.test.js does the same against
 * the whole stack, where the key, the tokens and the policies are real.
 */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { createHandler, configFromEnv } = require("../mcp/http.js");
const {
  KeyResolver,
  ResolveError,
  agentToken,
  readJwt,
  bearer,
  AGENT_TOKEN_SECONDS,
  MAX_CACHE_SECONDS,
} = require("../mcp/auth.js");

const SECRET = "test-only-secret";
const GOOD = `rfk_${"a".repeat(43)}`;
const AGENT = "22222222-2222-4222-8222-222222222222";
const BOOK = "11111111-1111-4111-8111-111111111111";

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

/** The handler on a port, with a resolver that knows GOOD and nothing else. */
async function start({ resolve } = {}) {
  const asked = [];
  const logged = [];
  const resolver = {
    async resolve(key) {
      asked.push(key);
      if (resolve) return resolve(key);
      return key === GOOD ? { agentId: AGENT, bookId: BOOK } : null;
    },
  };
  const handle = createHandler({
    supabaseUrl: "http://nowhere.invalid",
    jwtSecret: SECRET,
    resolver,
    log: (line) => logged.push(line),
  });
  const server = http.createServer((req, res) => handle(req, res).catch((err) => {
    res.statusCode = 500;
    res.end(String(err));
  }));
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, asked, logged };
}

const HELLO = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

function post(url, { key, body = HELLO } = {}) {
  return fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

// --- the door ---------------------------------------------------------

test("J17.1 · no key is a 401 that says how to authenticate, and asks the database nothing", async () => {
  const { url, asked } = await start();

  const res = await post(url);

  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate"), /^Bearer realm="recipe-friend"/);
  assert.match((await res.json()).error.message, /Bearer rfk_/);
  assert.deepEqual(asked, []);
});

test("J17.1 · a key that is not live is a 401 marked invalid_token, not a tool answer", async () => {
  const { url, logged } = await start();
  const wrong = `rfk_${"b".repeat(43)}`;

  const res = await post(url, { key: wrong });

  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate"), /error="invalid_token"/);
  assert.match((await res.json()).error.message, /not valid/);
  assert.ok(logged.every((line) => !line.includes(wrong)), "and the key is not in the log");
});

test("J17.1 · GET and DELETE are 405: a stateless server has no stream and no session", async () => {
  const { url, asked } = await start();

  for (const method of ["GET", "DELETE"]) {
    const res = await fetch(`${url}/mcp`, { method, headers: { Authorization: `Bearer ${GOOD}` } });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get("allow"), "POST");
  }
  assert.deepEqual(asked, []);
});

test("the health check answers without a key or the database", async () => {
  const { url, asked } = await start();

  const res = await fetch(`${url}/health`);

  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.deepEqual(asked, []);
  assert.equal((await fetch(`${url}/elsewhere`)).status, 404);
});

test("a database that cannot be asked is a 503, not a wrong key", async () => {
  const { url } = await start({
    resolve: () => {
      throw new ResolveError("the database answered 502");
    },
  });

  const res = await post(url, { key: GOOD });

  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "5");
});

test("J17.1 · with a good key, an MCP client connects and is offered the twelve tools", async () => {
  const { url, asked, logged } = await start();
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${GOOD}` } },
    })
  );

  const { tools } = await client.listTools();
  await client.close();

  assert.equal(tools.length, 12);
  assert.ok(asked.length >= 2 && asked.every((k) => k === GOOD), "every request is checked on its own");
  assert.ok(logged.some((line) => line.includes(`agent=${AGENT.slice(0, 8)}`)), "the log names the agent");
  assert.ok(logged.every((line) => !line.includes(GOOD)), "and never the key");
});

// --- the secret's narrow use -----------------------------------------

test("J17.1 · the token minted for an agent is that agent's, as authenticated, for five minutes", () => {
  const now = Date.UTC(2026, 9, 18);
  const token = agentToken({ agentId: AGENT, bookId: BOOK }, SECRET, now);
  const [head, body, sig] = token.split(".");

  const expected = crypto.createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  assert.equal(sig, expected, "HS256 with the stack's secret");
  const claims = readJwt(token);
  assert.equal(claims.sub, AGENT);
  assert.equal(claims.role, "authenticated");
  assert.equal(claims.aud, "authenticated");
  assert.equal(claims.is_anonymous, true);
  assert.equal(claims.exp - claims.iat, AGENT_TOKEN_SECONDS);
  assert.equal(AGENT_TOKEN_SECONDS, 300);

  assert.throws(() => agentToken({ agentId: "anybody" }, SECRET), /not a resolved agent/);
  assert.throws(() => agentToken(null, SECRET));
});

test("J16.12 · keys are resolved as recipe_friend_mcp, with a token that lasts a minute", async () => {
  const sent = [];
  const resolver = new KeyResolver({
    restUrl: "http://rest.test/rest/v1/",
    jwtSecret: SECRET,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ agent_id: AGENT, book_id: BOOK }), { status: 200 });
    },
  });

  assert.deepEqual(await resolver.resolve(GOOD), { agentId: AGENT, bookId: BOOK });

  assert.equal(sent[0].url, "http://rest.test/rest/v1/rpc/resolve_agent_key");
  assert.deepEqual(JSON.parse(sent[0].init.body), { key: GOOD });
  const claims = readJwt(bearer(sent[0].init.headers.Authorization));
  assert.equal(claims.role, "recipe_friend_mcp");
  assert.equal(claims.exp - claims.iat, 60);
  assert.equal(claims.sub, undefined, "it is nobody");
});

test("J17.3 · a resolved key is believed for the cache's life and no longer, and the cache is at most a minute", async () => {
  let now = 1_000_000;
  let live = true;
  let trips = 0;
  const resolver = new KeyResolver({
    restUrl: "http://rest.test/rest/v1",
    jwtSecret: SECRET,
    cacheSeconds: 3600,
    now: () => now,
    fetch: async () => {
      trips++;
      return new Response(live ? JSON.stringify({ agent_id: AGENT, book_id: BOOK }) : "null", { status: 200 });
    },
  });
  assert.equal(resolver.cacheMs, MAX_CACHE_SECONDS * 1000, "an hour asked for, a minute given");

  assert.ok(await resolver.resolve(GOOD));
  live = false; // the owner removes the agent
  now += 59_000;
  assert.ok(await resolver.resolve(GOOD), "still believed inside the bound");
  assert.equal(trips, 1);
  now += 2_000;
  assert.equal(await resolver.resolve(GOOD), null, "and refused once past it");
  assert.equal(trips, 2);
});

test("J17.3 · only live keys are remembered, and junk never reaches the database", async () => {
  let trips = 0;
  const resolver = new KeyResolver({
    restUrl: "http://rest.test/rest/v1",
    jwtSecret: SECRET,
    fetch: async () => {
      trips++;
      return new Response("null", { status: 200 });
    },
  });

  assert.equal(await resolver.resolve(GOOD), null);
  assert.equal(await resolver.resolve(GOOD), null);
  assert.equal(trips, 2, "a wrong key is asked about every time");
  for (const junk of ["", "rfa1.abc", "rfk_short", `rfk_${"a".repeat(42)}!`, null]) {
    assert.equal(await resolver.resolve(junk), null);
  }
  assert.equal(trips, 2);
});

test("a resolver that cannot reach the database says so, rather than calling the key wrong", async () => {
  const down = new KeyResolver({
    restUrl: "http://rest.test/rest/v1",
    jwtSecret: SECRET,
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  await assert.rejects(() => down.resolve(GOOD), ResolveError);
  const failing = new KeyResolver({
    restUrl: "http://rest.test/rest/v1",
    jwtSecret: SECRET,
    fetch: async () => new Response("", { status: 500 }),
  });
  await assert.rejects(() => failing.resolve(GOOD), /answered 500/);
});

test("the service will not start without the stack's url and secret", () => {
  assert.throws(() => configFromEnv({}), /SUPABASE_URL and JWT_SECRET/);
  const config = configFromEnv({ SUPABASE_URL: "http://caddy/", JWT_SECRET: "s" });
  assert.equal(config.supabaseUrl, "http://caddy");
  assert.equal(config.port, 3100);
  assert.equal(config.cacheSeconds, 30);
});
