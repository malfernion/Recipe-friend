/**
 * mcp/book.js — reaching the one book an agent key resolved to (J16.1,
 * J16.3).
 *
 * The api is stubbed rather than the whole of PostgREST: these are the
 * eight calls `RecipeSync` makes, and what matters here is which of them
 * an agent's sync is allowed to reach for.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp, aRecipe } = require("./helpers/load.js");
const { openBook, BookError } = require("../mcp/book.js");

const BOOK = "11111111-1111-4111-8111-111111111111";

function fakeApi({ role = "agent", rows = [] } = {}) {
  const pushed = { recipes: [], livePlans: [], archived: [] };
  return {
    userId: null,
    pushed,
    rows,
    async listBooks() {
      return role ? [{ id: BOOK, role, name: "Ours", isOwner: false }] : [];
    },
    async fetchRecipes() {
      return this.rows;
    },
    async pushRecipes(list) {
      pushed.recipes.push(...list);
    },
    async fetchLivePlan() {
      return null;
    },
    async pushLivePlan(bookId, plan) {
      pushed.livePlans.push(plan);
    },
    async fetchArchivedPlanIds() {
      return [];
    },
    async fetchArchivedPlans() {
      return [];
    },
    async insertArchivedPlan(bookId, plan) {
      pushed.archived.push(plan);
      return true;
    },
  };
}


const session = () => ({ bookId: BOOK, open: async () => ({ client: {}, userId: "agent-1" }) });

// --- the book ---------------------------------------------------------

test("J17.3 · every sync asks the session first, so the token it carries is re-signed before it runs down", async () => {
  let opens = 0;
  let broken = false;
  const s = {
    bookId: BOOK,
    open: async () => {
      opens++;
      if (broken) throw new Error("no token");
      return { client: {}, userId: "agent-1" };
    },
  };
  const book = await openBook(s, { api: fakeApi() });

  await book.refresh();
  assert.equal(opens, 2, "once to open the book, once before its first sync");

  broken = true;
  await assert.rejects(() => book.refresh(), /no token/);
});

test("J16.1 · the book the key resolved to is the book that is opened", async () => {
  const win = loadApp("units.js", "storage.js");
  const remote = win.RecipeStore.sanitizeRecipe(aRecipe({ name: "Soup" }));
  const api = fakeApi({ rows: [{ id: remote.id, data: remote, updated_at: new Date(1000).toISOString(), deleted_at: null }] });

  const book = await openBook(session(), { api });
  assert.deepEqual(book.recipes, [], "opening is the session and the membership row");

  await book.refresh();

  assert.equal(book.id, BOOK);
  assert.equal(book.name, "Ours");
  assert.equal(api.userId, "agent-1");
  assert.deepEqual(book.recipes.map((r) => r.name), ["Soup"], "a cold start is a full pull");
});

test("J17.2 · one key, one book: the book it resolved to, and nothing else chooses one", async () => {
  // An agent belongs to one book and cannot be added to a second
  // (J16.1), so a roster with anything else in it is a project half way
  // through a migration — the situation the pinned book id is for.
  const api = fakeApi();
  api.listBooks = async () => [
    { id: "99999999-9999-4999-8999-999999999999", role: "agent", name: "Somewhere else", isOwner: true },
    { id: BOOK, role: "agent", name: "Ours", isOwner: false },
  ];

  const book = await openBook(session(), { api });

  assert.equal(book.id, BOOK, "the one the key resolved to, not the one it owns");
  assert.equal(book.name, "Ours");
});

test("J16.7 · an agent that has been removed is told, not shown an empty book", async () => {
  await assert.rejects(() => openBook(session(), { api: fakeApi({ role: null }) }), (err) => {
    assert.ok(err instanceof BookError);
    assert.match(err.message, /not in that book any more/);
    return true;
  });
});

test("a key that is not an agent's is refused rather than used", async () => {
  await assert.rejects(
    () => openBook(session(), { api: fakeApi({ role: "editor" }) }),
    /is a editor's, not an agent's/
  );
});

test("J16.3 · only rows the server has never seen go up", async () => {
  const win = loadApp("units.js", "storage.js");
  const held = win.RecipeStore.sanitizeRecipe(aRecipe({ name: "Held" }));
  const api = fakeApi({ rows: [{ id: held.id, data: held, updated_at: new Date(1000).toISOString(), deleted_at: null }] });

  const book = await openBook(session(), { api });
  await book.refresh();

  // The held row has to be *in* the push for the filter to mean
  // anything, so it is edited locally until it is newer than the
  // server's — which is what a book that was read, then changed, looks
  // like. An upsert carrying it would be an UPDATE no policy matches,
  // and one refusal fails the whole batch, taking the new recipe with
  // it. Without this edit the test passes with the filter deleted.
  book.store.update(held.id, { description: "changed on this device" });
  book.store.add(aRecipe({ name: "Filed" }));
  await book.refresh();

  assert.deepEqual(api.pushed.recipes.map((r) => r.data.name), ["Filed"]);
});

test("J16.4 · an agent never records a plan, even one it finds finished", async () => {
  const win = loadApp("units.js", "storage.js", "plan.js", "planstore.js");
  const api = fakeApi();
  // A Done that landed half way: recorded by somebody's phone, and the
  // empty plan that should have replaced it never arrived. Any device
  // that may write is expected to finish it; an agent may not.
  api.fetchLivePlan = async () => ({
    book_id: BOOK,
    data: { ...win.RecipePlan.emptyPlan(1), completedAt: 5000 },
    updated_at: new Date(5000).toISOString(),
  });

  const book = await openBook(session(), { api });
  await book.refresh();

  assert.deepEqual(api.pushed.archived, [], "the record is not its errand");
  assert.equal(book.plan.completedAt, 5000, "it leaves the plan exactly as it found it");
});

test("J8.1 · an agent has no unit preferences, because it is not a person", async () => {
  const book = await openBook(session(), { api: fakeApi() });

  assert.deepEqual(book.prefs, { mass: "", volume: "" });
});

test("a book that cannot be reached says so rather than answering from nothing", async () => {
  const api = fakeApi();
  const book = await openBook(session(), { api });
  api.fetchRecipes = async () => {
    throw new Error("network");
  };

  await assert.rejects(() => book.refresh(), /Could not reach the book/);
});

test("J17.5 · a book that cannot be opened at all says the same thing as one that cannot be read", async () => {
  // The roster read is the one network call between the exchange and
  // the first sync, and both of those say "try again in a moment". Left
  // bare it handed the driver's own words to the model instead.
  const api = fakeApi();
  api.listBooks = async () => {
    throw new Error("fetch failed");
  };

  await assert.rejects(() => openBook(session(), { api }), (err) => {
    assert.match(err.message, /Could not reach the book/);
    assert.match(err.message, /Ask again in a moment/);
    return true;
  });
});

test("J17.5 · an agent removed while the server is running is told so, not blamed on the network", async () => {
  const api = fakeApi();
  const book = await openBook(session(), { api });
  await book.refresh();

  // Somebody opens the Books dialog and removes it. The membership row
  // goes, so every read stops matching — which from in here looks
  // exactly like a network that is down, and means the opposite thing.
  api.fetchRecipes = async () => {
    throw new Error("permission denied");
  };
  api.listBooks = async () => [];

  await assert.rejects(() => book.refresh(), (err) => {
    assert.match(err.message, /not in that book any more/);
    assert.match(err.message, /Books dialog/);
    assert.ok(!/Ask again in a moment/.test(err.message), "not something waiting will fix");
    return true;
  });
});

test("J17.5 · a roster that cannot be read either is called a network, which is the honest guess", async () => {
  const api = fakeApi();
  const book = await openBook(session(), { api });
  api.fetchRecipes = async () => {
    throw new Error("network");
  };
  api.listBooks = async () => {
    throw new Error("network");
  };

  await assert.rejects(() => book.refresh(), /Could not reach the book/);
});

test("a failed question does not leave the lane broken behind it", async () => {
  // Everything queues on one lane, so a rejection that is allowed to
  // stay on it stops the book for the life of the process — every later
  // question and every later change rejecting because one sync failed
  // once. The write side of this guard is held by two tests; this is the
  // read side.
  const api = fakeApi();
  const book = await openBook(session(), { api });
  let down = true;
  api.fetchRecipes = async () => {
    if (down) throw new Error("network");
    return [];
  };

  await assert.rejects(() => book.refresh(), /Could not reach the book/);

  down = false;
  const after = await book.refresh();
  assert.ok(after, "the lane carried on");
  assert.ok(await book.write(async () => true), "and so did the other half of it");
});

test("two tools called at once queue on one sync rather than one of them being told the network is down", async () => {
  // `syncNow` answers a re-entrant call by returning undefined and doing
  // nothing, which this layer cannot tell from a failure — so without a
  // queue the second of two tool calls in one model turn fails with a
  // network diagnosis and a perfectly healthy network.
  const api = fakeApi();
  const book = await openBook(session(), { api });
  let pulls = 0;
  api.fetchRecipes = async () => {
    pulls++;
    await new Promise((resume) => setTimeout(resume, 5));
    return [];
  };

  const [a, b] = await Promise.all([book.refresh(), book.refresh()]);

  assert.ok(a, "both got an answer");
  assert.equal(a, b, "and it was the same one");
  assert.equal(pulls, 1, "one trip, not two");

  // And the queue opens again afterwards.
  await book.refresh();
  assert.equal(pulls, 2);
});
