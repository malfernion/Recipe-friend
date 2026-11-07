/**
 * mcp/tools-write.js — the one tool that changes something.
 *
 * The interesting assertions are about what an agent must *not* do, and
 * about the failures in between: a tool that says it filed a recipe when
 * it did not, or says it failed when it did, is how a household ends up
 * with two of the same dinner and no way to delete either (J16.3).
 *
 * Every tool here is called through the harness's `call`, which pulls
 * first the way the server does (J17.9). Going straight to `tool.run` is
 * testing a path no host takes.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { agentBook, BOOK } = require("./helpers/agent.js");
const write = require("../mcp/tools-write.js");
const read = require("../mcp/tools-read.js");

const by = (name) => [...write, ...read].find((t) => t.name === name);
const FILE = by("add_recipe");

const PIE = {
  name: "Chicken pie",
  servings: 4,
  ingredients: [
    { amount: 500, unit: "g", item: "chicken" },
    { amount: 1, unit: "", item: "onion" },
  ],
  steps: ["Bake it."],
};
const SOUP = {
  name: "Lentil soup",
  servings: 2,
  ingredients: [
    { amount: 200, unit: "g", item: "lentils" },
    { amount: 2, unit: "", item: "onions" },
  ],
  steps: ["Simmer it."],
};
const DAL = {
  name: "Dal",
  ingredients: [{ amount: 200, unit: "g", item: "red lentils" }],
  steps: ["Simmer it."],
};

const aBook = () => agentBook({ recipes: [PIE, SOUP] });

// --- filing a recipe ---------------------------------------------------

test("J16.3 · a filed recipe goes up as a row the server has never seen", async () => {
  const { call, sent } = await aBook();

  const out = await call(FILE, { ...DAL, servings: 2, tags: ["quick"] });

  assert.equal(out.added.name, "Dal");
  assert.match(out.note, /cannot delete/);
  assert.deepEqual(sent.recipes.map((r) => r.data.name), ["Dal"], "and nothing else went with it");
  assert.equal(sent.recipes[0].book_id, BOOK, "as a row for this book, built by sync");
});

test("J16.3 · a recipe the server already holds is never sent again", async () => {
  const { call, book, sent, idOf } = await aBook();
  // Make the local copy of a held recipe newer than the server's, which
  // is what puts it in `toPush`. An agent pushing it would send an
  // upsert against a row that exists — an UPDATE no policy matches —
  // and one refusal fails the batch, taking the new recipe with it.
  book.store.update(idOf("Chicken pie"), { description: "edited locally" });

  await call(FILE, DAL);

  assert.deepEqual(sent.recipes.map((r) => r.data.name), ["Dal"]);
});

test("J16.11 · a recipe below the floor is refused, the same as from anybody", async () => {
  const { call, sent } = await aBook();

  for (const short of [
    { name: "", ingredients: [{ item: "x" }], steps: ["do"] },
    { name: "No steps", ingredients: [{ item: "x" }], steps: [] },
    { name: "No ingredients", ingredients: [], steps: ["do"] },
  ]) {
    const out = await call(FILE, short);
    assert.match(out.error, /needs a name, at least one ingredient and at least one step/);
  }
  assert.deepEqual(sent.recipes, [], "nothing refused was sent anywhere");
});

test("J17.10 · a recipe that reached the book is reported as filed, whatever else failed", async () => {
  const { call, breakPlanHalf, mendNetwork, book, sent } = await aBook();
  await book.refresh();
  // The shape that made this lie: recipes go up first and succeed, and
  // the plan half of the same trip fails afterwards. `syncNow` reports
  // one failure for both, so a tool that rolled back on it would take
  // back a recipe the book already holds — and the retry it invites
  // would file a second copy nobody on this side can delete.
  breakPlanHalf();

  const out = await FILE.run(book, DAL);

  assert.equal(out.landed, "confirmed");
  assert.equal(out.added.name, "Dal");
  assert.ok(!out.error, "it landed; saying otherwise invites a duplicate");
  assert.deepEqual(sent.recipes.map((r) => r.data.name), ["Dal"]);

  // The cache is a cache: the row comes out of it while the book is
  // being asked — so that no sync started by a call arriving in that
  // window can push it — and the next pull brings it back, because by
  // then it is the book's.
  mendNetwork();
  await book.refresh();
  assert.ok(book.recipes.some((r) => r.name === "Dal"), "and nothing was lost taking it out");
});

test("J17.10 · a recipe that never reached the book is taken back out and said to be safe to resend", async () => {
  const { breakRecipePush, book } = await aBook();
  await book.refresh();
  // The push failed but the book is readable, so this can be checked
  // rather than guessed.
  breakRecipePush();

  const out = await FILE.run(book, DAL);

  assert.match(out.error, /was not filed/);
  assert.match(out.error, /safe to send again/);
  assert.ok(!out.added, "nothing to report as added");
  assert.ok(!book.recipes.some((r) => r.name === "Dal"), "the cache dies with the process");
});

test("J17.10 · a recipe nobody can check on is not called filed and not called failed", async () => {
  const { breakNetwork, mendNetwork, book, sent } = await aBook();
  await book.refresh();
  breakNetwork();

  const out = await FILE.run(book, DAL);

  assert.equal(out.landed, "unknown");
  assert.match(out.error, /may or may not have been filed/);
  assert.match(out.error, /Do not send it again without looking/);
  // Kept. Nobody could find out, so throwing the recipe away would lose
  // one that was never filed — and putting it back is safe because it
  // keeps its own id, which a later sync pushes only if the server has
  // never seen it (J16.3).
  assert.ok(book.recipes.some((r) => r.name === "Dal"), "not thrown away on an unanswered question");

  // And it does land, once there is a network to land on.
  mendNetwork();
  await book.refresh();
  assert.deepEqual(sent.recipes.map((r) => r.data.name), ["Dal"], "exactly once");
});

test("J17.9 · a change started while somebody else's sync is in flight still lands, and says so truly", async () => {
  const { book, api, sent } = await aBook();
  await book.refresh();

  // An ordinary read's sync, parked mid-flight at an await every sync
  // makes. If the change shared the book with it, the sync would apply
  // what it read over the top of the change.
  let release;
  const parked = new Promise((resume) => (release = resume));
  const real = api.fetchArchivedPlanIds.bind(api);
  let once = false;
  api.fetchArchivedPlanIds = async () => {
    if (!once) {
      once = true;
      await parked;
    }
    return real();
  };
  const stranger = book.refresh();
  await new Promise((resume) => setTimeout(resume, 5));

  const writing = FILE.run(book, DAL);
  await new Promise((resume) => setTimeout(resume, 5));
  release();

  const out = await writing;
  await stranger.catch(() => {});

  assert.equal(out.added.name, "Dal");
  assert.ok(sent.recipes.some((r) => r.data.name === "Dal"), "and the book got what the tool said it got");
});

test("J17.9 · a question arriving while a change is in flight waits for it", async () => {
  const { book, api } = await aBook();
  await book.refresh();

  // The order is the assertion: a change reads, then pushes. A question
  // that lands between those two has seen the book half-changed.
  const order = [];
  const realRead = api.fetchRecipes.bind(api);
  const realPush = api.pushRecipes.bind(api);
  api.fetchRecipes = async (...args) => {
    order.push("read");
    return realRead(...args);
  };
  api.pushRecipes = async (...args) => {
    order.push("push");
    return realPush(...args);
  };

  const writing = FILE.run(book, DAL);
  const question = book.refresh();
  await Promise.all([writing, question]);

  const firstPush = order.indexOf("push");
  assert.ok(firstPush > 0, order.join(","));
  assert.ok(order.slice(0, firstPush).includes("read"));
  assert.equal(order.lastIndexOf("read") > firstPush, true, "the question waited its turn");
});

test("J16.3 · a field the schema never declared cannot ride in on a filed recipe", async () => {
  const { call, book, sent } = await aBook();
  const before = Date.now();

  // Nothing checks `arguments` against `inputSchema` — the low-level MCP
  // server advertises `additionalProperties: false` and does not enforce
  // it — so a host that forwards extra fields, or a web page whose
  // "recipe" asked for them, gets whatever it sends straight into the
  // sanitiser. `updatedAt` is the dangerous one: reconciliation is
  // last-write-wins on it, so a recipe stamped in the year 5138 outranks
  // every later edit and every tombstone, on every device, for good —
  // J16.3 undone through the one insert the policies do allow.
  const out = await call(FILE, {
    ...DAL,
    updatedAt: Date.UTC(5138, 10, 16),
    createdAt: Date.UTC(5138, 10, 16),
    sharedFrom: "22222222-2222-4222-8222-222222222222",
    favorite: true,
    imagePath: `${BOOK}/33333333-3333-4333-8333-333333333333.jpg`,
  });

  assert.equal(out.added.name, "Dal");
  const row = sent.recipes.find((r) => r.data.name === "Dal");
  assert.ok(row.data.updatedAt >= before, "stamped now, whatever was asked for");
  assert.ok(row.data.updatedAt < before + 60000, new Date(row.data.updatedAt).toISOString());
  assert.ok(row.data.createdAt >= before);
  assert.equal(row.data.sharedFrom, "", "it did not arrive from anywhere");
  assert.equal(row.data.favorite, false, "an agent does not star (J3.6)");
  assert.equal(row.data.imagePath, "", "and gets no stored photo (J16.10)");
  assert.ok(book.recipes.some((r) => r.name === "Dal"));
});

test("J16.10 · a picture arrives as a link or not at all", async () => {
  const { call, book } = await aBook();
  const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  await call(FILE, { ...DAL, name: "Pasted photo", image: tiny });
  await call(FILE, { ...DAL, name: "Linked photo", image: "https://example.com/dal.jpg" });

  const pasted = book.recipes.find((r) => r.name === "Pasted photo");
  const linked = book.recipes.find((r) => r.name === "Linked photo");
  assert.equal(pasted.image, "", "an agent can neither see the pictures in the book nor add one");
  assert.equal(linked.image, "https://example.com/dal.jpg", "a link lives on the recipe (J6.2)");
});

// --- the shape of the whole set ---------------------------------------

test("J17.6 · no tool exists for anything the credential cannot do", () => {
  const names = [...read, ...write].map((t) => t.name);
  assert.deepEqual(
    names.filter((n) => /edit|update|delete|remove|favourite|favorite|star|done|finish|complete/.test(n)),
    []
  );
  // The plan tools went with the plan's shopping list (J18, build step 1).
  assert.deepEqual(names.sort(), [
    "add_recipe", "find_recipes", "get_recipe", "list_recipes", "planning_history",
    "recipes_sharing_ingredients",
  ]);
});

test("J17.10 · the one-way tool says so twice: to the client in a hint, to the model in words", () => {
  assert.equal(FILE.annotations.readOnlyHint, false);
  assert.equal(FILE.annotations.destructiveHint, true);
  assert.match(FILE.description, /cannot be undone/i);
  assert.match(FILE.description, /permanent until a person removes it/);
});
