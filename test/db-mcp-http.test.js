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
const { skip, getPool, closePool, stackConfig, vendoredSupabase } = require("./helpers/db.js");
const { aRecipe, loadApp } = require("./helpers/load.js");
const { signJwt } = require("../mcp/auth.js");

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
    // Committed, so GoTrue reads it too (db-e2e lists users): its text
    // columns are '' as GoTrue writes them, because a NULL 500s the list.
    `insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, raw_app_meta_data,
                             is_anonymous, created_at, updated_at, encrypted_password,
                             confirmation_token, recovery_token, email_change_token_new, email_change,
                             email_change_token_current, phone_change, phone_change_token,
                             reauthentication_token)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
             $2, '{"name":"Ann"}', '{"provider":"google","providers":["google"]}', false, now(), now(), '',
             '', '', '', '', '', '', '', '')`,
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

http("J17.1 · a good key lists the nine tools and reads its own book", async () => {
  const { key } = await household();
  const client = await connect(key);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 9);

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
    const out = await client.callTool({ name: "planning_history", arguments: {} });
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

/**
 * The owner's phone: the app's own sync, over PostgREST, signed in as the
 * owner. The owner was written straight into auth.users with no password,
 * so the session is a token signed the way GoTrue signs one.
 */
function ownersPhone(owner, book) {
  const cfg = stackConfig();
  const iat = Math.floor(Date.now() / 1000);
  const token = signJwt(
    { sub: owner, role: "authenticated", aud: "authenticated", is_anonymous: false, iat, exp: iat + 600 },
    cfg.jwtSecret
  );
  const c = vendoredSupabase().createClient(cfg.url, cfg.anonKey, {
    accessToken: async () => token,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const win = loadApp("units.js", "scale.js", "storage.js", "plan.js", "planstore.js", "lists.js", "liststore.js", "sync.js");
  const api = new win.RecipeApi(c);
  api.userId = owner;
  const lists = new win.RecipeListStore();
  const sync = new win.RecipeSync(new win.RecipeStore(), api, () => {}, new win.RecipePlanStore(), lists);
  sync.setBook(book);
  return { lists, sync: () => sync.syncLists(null, { seed: true }), L: win.RecipeLists };
}

const said = (out) => JSON.parse(out.content[0].text);

http("J18.23, J18.25 · a phone and the agent work on one list over HTTP, and both keep what they did", async () => {
  const { owner, book, key } = await household();
  const phone = ownersPhone(owner, book);
  await phone.sync();
  const freezer = phone.lists.create("Freezer", "stock");
  const bol = phone.L.newId();
  phone.lists.change(freezer.id, (l) => phone.L.addItem(l, { text: "Bolognese", id: bol }));
  for (let i = 0; i < 3; i++) phone.lists.change(freezer.id, (l) => phone.L.bump(l, bol, +1, phone.lists.deviceId));
  await phone.sync();

  const client = await connect(key);
  try {
    const seen = said(await client.callTool({ name: "get_lists", arguments: { list: "freezer" } }));
    assert.deepEqual(seen.list.items.map((i) => [i.text, i.count]), [["Bolognese", 4]]);

    // The phone takes one off with no signal while the agent says there
    // are three left and adds peas: 4 − 1 − 1 is 2 when they meet (J18.17).
    phone.lists.change(freezer.id, (l) => phone.L.bump(l, bol, -1, phone.lists.deviceId));
    const edited = said(await client.callTool({ name: "edit_list", arguments: { list: "Freezer", changes: [{ itemId: bol, count: 3 }] } }));
    assert.equal(edited.edited[0].count, 3);
    const added = said(await client.callTool({ name: "add_to_list", arguments: { list: "Freezer", items: ["peas"] } }));
    assert.deepEqual(added.added.map((i) => i.text), ["peas"]);
    await phone.sync();

    const mine = phone.lists.get(freezer.id);
    assert.deepEqual(phone.L.liveItems(mine).map((i) => i.text).sort(), ["Bolognese", "peas"]);
    assert.equal(phone.L.count(mine.items.find((i) => i.id === bol)), 2);
    const again = said(await client.callTool({ name: "get_lists", arguments: { list: freezer.id } }));
    assert.equal(again.list.items.find((i) => i.itemId === bol).count, 2, "and the agent reads the same");

    // A recipe on a checklist, at a size (J18.18).
    const shopping = phone.L.shoppingListId(book);
    const { recipes } = said(await client.callTool({ name: "list_recipes", arguments: {} }));
    const put = said(
      await client.callTool({ name: "add_to_list", arguments: { list: "Shopping", recipeId: recipes[0].id, multiplier: 2 } })
    );
    assert.ok(put.added, JSON.stringify(put));
    assert.equal(put.added[0].text, "Lentil soup");
    // Recorded as planned, as a person's add is (J18.21, 014).
    assert.equal(put.planned, true);
    const record = await getPool().query("select data from plans where book_id = $1", [book]);
    assert.deepEqual(record.rows.map((r) => r.data.meals[0].recipeId), [recipes[0].id]);
    const history = said(await client.callTool({ name: "planning_history", arguments: {} }));
    assert.equal(history.recipes.find((r) => r.id === recipes[0].id).timesPlanned, 1);
    await phone.sync();
    assert.equal(phone.L.children(phone.lists.get(shopping))[0].text, "Lentil soup");
  } finally {
    await client.close();
  }
});

http("J18.25 · the agent cannot make, rename or delete a list, and is held to a person's limits", async () => {
  const { owner, book, key } = await household();
  const phone = ownersPhone(owner, book);
  await phone.sync();
  const client = await connect(key);
  try {
    for (const name of ["create_list", "rename_list", "delete_list"]) {
      const out = await client.callTool({ name, arguments: { list: "Shopping" } });
      assert.equal(out.isError, true);
      assert.match(out.content[0].text, /There is no tool called/);
    }
    const missing = said(await client.callTool({ name: "add_to_list", arguments: { list: "Pantry", items: ["rice"] } }));
    assert.match(missing.error, /cannot make, rename or delete a list/);

    const long = said(await client.callTool({ name: "add_to_list", arguments: { list: "Shopping", items: ["x".repeat(500)] } }));
    assert.equal(long.added[0].text.length, 200, "an item is a line, capped as a person's is");
    const many = said(await client.callTool({ name: "add_to_list", arguments: { list: "Shopping", items: Array(51).fill("x") } }));
    assert.match(many.error, /at most 50/);

    // And the rows say the same: one list, as the phone named it.
    const { rows } = await getPool().query("select name, deleted_at from lists where book_id = $1", [book]);
    assert.deepEqual(rows.map((r) => [r.name, r.deleted_at]), [["Shopping", null]]);
  } finally {
    await client.close();
  }
});
