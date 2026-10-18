/**
 * mcp/server.js — the tools meeting the protocol.
 *
 * An MCP client on an in-memory transport, which is the whole surface a
 * host sees once its key has been accepted. What happens before that —
 * the key, the HTTP — is mcp-http.test.js.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { makeServer } = require("../mcp/server.js");
const { agentBook, BOOK } = require("./helpers/agent.js");

const SOUP = {
  name: "Lentil soup",
  servings: 2,
  ingredients: [{ amount: 200, unit: "g", item: "lentils" }],
  steps: ["Simmer it."],
};

/** A client wired to the server through memory, with the book stubbed. */
async function connect({ openBook, recipes = [SOUP] } = {}) {
  let harness = null;
  const opened =
    openBook ||
    (async () => {
      harness = await agentBook({ recipes });
      return harness.book;
    });
  const server = makeServer({ session: {}, version: "1.0.0", openBook: opened });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  client.harness = () => harness;
  return client;
}

test("a host is offered twelve tools, each saying what kind of thing it is", async () => {
  const client = await connect();

  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "add_recipe", "add_to_list", "add_to_plan", "edit_list", "find_recipes", "get_plan",
    "get_recipe", "list_recipes", "planning_history", "recipes_sharing_ingredients",
    "remove_from_list", "remove_from_plan",
  ]);
  for (const tool of tools) {
    assert.ok(tool.description, `${tool.name} says what it is for`);
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.ok(tool.title, `${tool.name} has something to call it`);
    assert.ok(!tool.annotations.title, `${tool.name} does not send its title twice`);
  }
  const filing = tools.find((t) => t.name === "add_recipe");
  assert.equal(filing.annotations.destructiveHint, true, "the one-way tool tells the host so");
  assert.equal(tools.find((t) => t.name === "get_plan").annotations.readOnlyHint, true);
});

/**
 * What a host is charged for saying hello.
 *
 * Every session pays for the whole tool list before it asks anything, so
 * the number is a budget and this is the guard on it. It is deliberately
 * loose — a real new tool should not have to argue with a test — and it
 * fails on the thing that actually happens: descriptions growing back
 * into essays about why the server is built the way it is.
 */
// Raised from 9,000 when the list tools arrived (J17.14): two tools, and
// the sentence telling a model to read the list before adding to it,
// which is the one piece of reasoning a caller can act on. Raised again
// to 12,000 for edit_list, whose `was` is a rule a caller has to follow.
const LISTING_BUDGET = 12000;

test("J17.13 · the tool list is what a caller needs, inside a budget every session pays", async () => {
  const client = await connect();

  const { tools } = await client.listTools();
  const listing = JSON.stringify(tools);

  assert.ok(
    listing.length <= LISTING_BUDGET,
    `the tool list is ${listing.length} characters, over its ${LISTING_BUDGET} budget`
  );

  for (const tool of tools) {
    // What comes back, so a caller does not have to spend a call finding
    // out. `add_recipe` says it in its own words rather than by the
    // formula, being the one tool whose answer is about what it did.
    assert.match(tool.description, /[Gg]ives back/, tool.name);
    // The reasoning belongs in the code and the journeys, both of which
    // are free to read. These are the phrases that were shipping to
    // every client before this was written down.
    for (const essay of [
      /because unit preferences belong to a person/,
      /the app's own portion stepper/,
      /plurals folded together/,
      /somebody may be editing it from a phone/,
      /the honest answer/,
    ]) {
      assert.ok(!essay.test(tool.description), `${tool.name} is explaining itself: ${essay}`);
    }
  }
});

test("J17.4 · listing the tools opens no book, so saying hello costs no pull", async () => {
  let opened = 0;
  const client = await connect({
    openBook: async () => {
      opened++;
      return (await agentBook({ recipes: [SOUP] })).book;
    },
  });

  await client.listTools();
  assert.equal(opened, 0, "no book pulled");

  await client.callTool({ name: "list_recipes", arguments: {} });
  await client.callTool({ name: "get_plan", arguments: {} });
  assert.equal(opened, 1, "and once opened, it is shared");
});

test("J17.9 · every call reads the book again, so an answer is never an hour old", async () => {
  const client = await connect();
  await client.callTool({ name: "list_recipes", arguments: {} });
  const pullsAfterFirst = client.harness().pulls();

  // Somebody adds a recipe from a phone while the session is open. A
  // server that answered from the snapshot it took at the first call
  // would go on saying the book has one recipe for as long as it ran.
  client.harness().addRemoteRecipe({
    name: "Dal",
    ingredients: [{ amount: 200, unit: "g", item: "red lentils" }],
    steps: ["Simmer it."],
  });

  const out = await client.callTool({ name: "list_recipes", arguments: {} });

  assert.deepEqual(JSON.parse(out.content[0].text).recipes.map((r) => r.name).sort(), ["Dal", "Lentil soup"]);
  assert.equal(client.harness().pulls(), pullsAfterFirst + 1, "one more trip, for one more question");
});

test("a tool answers with the thing itself, as json a model can read", async () => {
  const client = await connect();

  const out = await client.callTool({ name: "list_recipes", arguments: {} });

  assert.equal(out.isError, undefined);
  const said = JSON.parse(out.content[0].text);
  assert.deepEqual(said.recipes.map((r) => r.name), ["Lentil soup"]);
});

test("J17.5 · an agent removed after its key was checked is an answer somebody can act on", async () => {
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
