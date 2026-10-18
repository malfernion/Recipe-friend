/**
 * The hosted MCP server, end to end: an MCP client over HTTP, through
 * Caddy's /mcp route, to mcp/http.js, which resolves the key in Postgres
 * and reads the book through PostgREST as the agent (J17.1).
 *
 * Needs the stack in server/ up and migrated, the `mcp` service included,
 * and skips without DATABASE_URL like the other db-* files. The owner, the
 * book and the agent are written straight into Postgres and committed —
 * the server has to see them — and removed at the end.
 */
"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { skip, getPool, closePool, stackConfig } = require("./helpers/db.js");
const { aRecipe } = require("./helpers/load.js");

const http = (name, fn) => test(name, { skip }, fn);

const people = [];
after(async () => {
  if (!skip) {
    for (const id of people) await getPool().query("delete from auth.users where id = $1", [id]);
  }
  await closePool();
});

/** An owner with a book holding one recipe, and an agent made for it. */
async function household() {
  const pool = getPool();
  const owner = randomUUID();
  people.push(owner);
  await pool.query(
    `insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data,
                             is_anonymous, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
             $2, '{"name":"Ann"}', '{"provider":"google","providers":["google"]}', false, now(), now())`,
    [owner, `${owner}@example.test`]
  );
  const { rows } = await pool.query("select id from books where owner = $1", [owner]);
  const book = rows[0].id;
  await pool.query("insert into recipes (id, book_id, data) values ($1, $2, $3)", [
    randomUUID(),
    book,
    aRecipe({ name: "Lentil soup" }),
  ]);

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: owner, role: "authenticated", is_anonymous: false }),
    ]);
    await client.query("set local role authenticated");
    const made = (await client.query("select create_agent($1, 'Kitchen helper') as made", [book])).rows[0].made;
    await client.query("commit");
    return { owner, book, agent: made.agent_id, key: made.key };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

function mcpUrl() {
  return new URL(`${stackConfig().url}/mcp`);
}

const HELLO = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

function post(key) {
  return fetch(mcpUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(HELLO),
  });
}

async function connect(key) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(mcpUrl(), { requestInit: { headers: { Authorization: `Bearer ${key}` } } })
  );
  return client;
}

http("J17.1 · without a key, /mcp is a 401 that says how to authenticate", async () => {
  const res = await post(null);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate"), /^Bearer/);
});

http("J17.1 · a key nobody issued is a 401, marked invalid_token", async () => {
  const res = await post(`rfk_${"A".repeat(43)}`);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate"), /invalid_token/);
});

http("J17.1 · a good key lists the twelve tools and reads its own book", async () => {
  const { key } = await household();
  const client = await connect(key);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 12);

    const out = await client.callTool({ name: "list_recipes", arguments: {} });
    assert.equal(out.isError, undefined, out.content[0].text);
    assert.deepEqual(JSON.parse(out.content[0].text).recipes.map((r) => r.name), ["Lentil soup"]);
  } finally {
    await client.close();
  }
});

http("J16.9 · a key is the same key on every request: nothing in it runs down", async () => {
  const { key } = await household();
  for (let i = 0; i < 3; i++) {
    const client = await connect(key);
    const out = await client.callTool({ name: "get_plan", arguments: {} });
    assert.equal(out.isError, undefined, out.content[0].text);
    await client.close();
  }
});

http("J16.7 · a removed agent's key is refused within the server's cache bound", async () => {
  const { book, agent, key } = await household();
  const warm = await connect(key);
  await warm.listTools(); // resolved, and so cached
  await warm.close();

  await getPool().query("delete from book_members where book_id = $1 and user_id = $2", [book, agent]);

  const bound = Number(stackConfig().mcpCacheSeconds || 30);
  const started = Date.now();
  let status = 0;
  while (Date.now() - started < (bound + 5) * 1000) {
    status = (await post(key)).status;
    if (status === 401) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(status, 401, `still accepted ${bound + 5}s after removal`);
  assert.ok(Date.now() - started <= (bound + 2) * 1000, "refused within the bound");
});
