/**
 * mcp/server.js and mcp/index.js — the tools meeting the protocol.
 *
 * Two kinds of test. An MCP client on an in-memory transport, which is
 * the whole surface a host sees; and the real program in a real
 * subprocess, because the one thing an in-memory transport cannot check
 * is the rule that matters most on stdio — that nothing but MCP messages
 * ever reaches stdout.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { makeServer } = require("../mcp/server.js");
const { agentBook, BOOK } = require("./helpers/agent.js");

const CREDENTIAL =
  "rfa1." +
  Buffer.from(
    JSON.stringify({
      url: "https://project.supabase.co",
      key: "sb_publishable_k",
      book: BOOK,
      refresh_token: "the-token",
    })
  ).toString("base64url");

const SOUP = {
  name: "Lentil soup",
  servings: 2,
  ingredients: [{ amount: 200, unit: "g", item: "lentils" }],
  steps: ["Simmer it."],
};

/** A client wired to the server through memory, with the book stubbed. */
async function connect({ openBook } = {}) {
  const opened = openBook || (async () => (await agentBook({ recipes: [SOUP] })).book);
  const server = makeServer({ session: {}, version: "1.0.0", openBook: opened });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

test("a host is offered nine tools, each saying what kind of thing it is", async () => {
  const client = await connect();

  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "add_recipe", "add_to_plan", "find_recipes", "get_plan", "get_recipe",
    "list_recipes", "planning_history", "recipes_sharing_ingredients", "remove_from_plan",
  ]);
  for (const tool of tools) {
    assert.ok(tool.description, `${tool.name} says what it is for`);
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.ok(tool.annotations.title, `${tool.name} has something to call it`);
  }
  const filing = tools.find((t) => t.name === "add_recipe");
  assert.equal(filing.annotations.destructiveHint, true, "the one-way tool tells the host so");
  assert.equal(tools.find((t) => t.name === "get_plan").annotations.readOnlyHint, true);
});

test("J17.4 · listing the tools opens no book, so a host may spawn this and think again", async () => {
  let opened = 0;
  const client = await connect({
    openBook: async () => {
      opened++;
      return (await agentBook({ recipes: [SOUP] })).book;
    },
  });

  await client.listTools();
  assert.equal(opened, 0, "no credential exchanged, no book pulled");

  await client.callTool({ name: "list_recipes", arguments: {} });
  await client.callTool({ name: "get_plan", arguments: {} });
  assert.equal(opened, 1, "and once opened, it is shared");
});

test("a tool answers with the thing itself, as json a model can read", async () => {
  const client = await connect();

  const out = await client.callTool({ name: "list_recipes", arguments: {} });

  assert.equal(out.isError, undefined);
  const said = JSON.parse(out.content[0].text);
  assert.deepEqual(said.recipes.map((r) => r.name), ["Lentil soup"]);
});

test("J17.5 · a credential nobody can use is an answer somebody can act on", async () => {
  const client = await connect({
    openBook: async () => {
      throw new Error("That agent is not in that book any more.");
    },
  });

  const out = await client.callTool({ name: "list_recipes", arguments: {} });

  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /not in that book any more/);
});

test("J17.4 · a book that would not open is tried again rather than remembered as dead", async () => {
  let attempts = 0;
  const client = await connect({
    openBook: async () => {
      attempts++;
      if (attempts === 1) throw new Error("Could not reach the book just now.");
      return (await agentBook({ recipes: [SOUP] })).book;
    },
  });

  assert.equal((await client.callTool({ name: "list_recipes", arguments: {} })).isError, true);
  assert.equal((await client.callTool({ name: "list_recipes", arguments: {} })).isError, undefined);
  assert.equal(attempts, 2);
});

test("a tool that goes wrong says which one, rather than closing the connection", async () => {
  const client = await connect({
    openBook: async () => {
      const { book } = await agentBook({ recipes: [SOUP] });
      book.planStore.plannedIndex = () => {
        throw new Error("the archive was nonsense");
      };
      return book;
    },
  });

  const out = await client.callTool({ name: "list_recipes", arguments: {} });

  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /list_recipes could not finish: the archive was nonsense/);
});

// --- the guard on stdout ---------------------------------------------

test("J17.1 · every channel that would reach stdout is pointed at stderr", () => {
  // Tested directly, because the subprocess test below cannot fail on
  // this: nothing on the path it exercises logs, and the modules that do
  // use `console.warn`, which node already sends to stderr. The risk
  // this guards is a browser module reaching for `console.log`, and the
  // only honest way to check it is to reach for one.
  const { guardStdout, TO_STDOUT } = require("../mcp/stdout-guard.js");
  const said = [];
  const fake = { error: (...args) => said.push(["stderr", ...args]) };
  for (const channel of TO_STDOUT) fake[channel] = (...args) => said.push(["STDOUT", ...args]);

  const release = guardStdout(fake);
  for (const channel of TO_STDOUT) fake[channel]("hello from " + channel);

  assert.deepEqual(
    said.filter(([where]) => where === "STDOUT"),
    [],
    "not one of them reached the wire"
  );
  assert.equal(said.length, TO_STDOUT.length, "and none of them was swallowed either");

  release();
  fake.log("after");
  assert.deepEqual(said.at(-1), ["STDOUT", "after"], "the guard is the only thing holding it");
});

test("J17.1 · the program installs that guard before it loads anything written for a browser", () => {
  const src = require("node:fs").readFileSync(path.join(__dirname, "..", "mcp", "index.js"), "utf8");
  const guard = src.indexOf("stdout-guard");
  const firstOtherRequire = src.indexOf('require("./credential.js")');

  assert.ok(guard > -1, "it installs one");
  assert.ok(guard < firstOtherRequire, "and does it first");
});

// --- the real program -------------------------------------------------

/** Run mcp/index.js, say these things to it, and collect both streams. */
function run(requests, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "index.js")], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ out, err, code }));
    for (const request of requests) child.stdin.write(JSON.stringify(request) + "\n");
    // Long enough for the handshake; the process ends when stdin does.
    setTimeout(() => child.stdin.end(), 400);
  });
}

const HELLO = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

test("J17.1 · nothing but MCP messages ever reaches stdout, which on stdio is the wire", async () => {
  const { out, err } = await run(
    [HELLO, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }],
    { RECIPE_FRIEND_CREDENTIAL: CREDENTIAL }
  );

  const lines = out.split("\n").filter(Boolean);
  assert.ok(lines.length >= 2, out);
  for (const line of lines) {
    const message = JSON.parse(line); // throws, loudly, on anything else
    assert.equal(message.jsonrpc, "2.0");
  }
  const listed = lines.map((l) => JSON.parse(l)).find((m) => m.id === 2);
  assert.equal(listed.result.tools.length, 9);

  // The server does say something when it starts. It says it over there.
  assert.match(err, /recipe-friend 1\.0\.0: ready/);
});

test("a credential the host got wrong stops the program, and says which variable", async () => {
  const { out, err, code } = await run([HELLO], { RECIPE_FRIEND_CREDENTIAL: "" });

  assert.equal(code, 1);
  assert.equal(out, "", "not one word of it on the wire");
  assert.match(err, /RECIPE_FRIEND_CREDENTIAL/);
});
