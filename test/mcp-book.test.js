/**
 * mcp/session.js and mcp/book.js — holding a credential, and reaching
 * the one book it names (J16.1, J16.3).
 *
 * The api is stubbed rather than the whole of PostgREST: these are the
 * eight calls `RecipeSync` makes, and what matters here is which of them
 * an agent's sync is allowed to reach for.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp, aRecipe } = require("./helpers/load.js");
const { Session, SessionError } = require("../mcp/session.js");
const { openBook, BookError } = require("../mcp/book.js");

const BOOK = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL = {
  url: "https://project.supabase.co",
  key: "sb_publishable_k",
  book: BOOK,
  refreshToken: "the-token",
};

/** A supabase client that signs in and records how it was made. */
function fakeSupabase({ fails = false, throws = null } = {}) {
  const made = [];
  const refreshed = [];
  const createClient = (url, key, options) => {
    made.push({ url, key, options });
    return {
      auth: {
        refreshSession: async ({ refresh_token }) => {
          refreshed.push(refresh_token);
          if (throws) throw new Error(throws);
          if (fails) return { data: null, error: { message: "Invalid Refresh Token" } };
          return { data: { session: { access_token: "jwt" }, user: { id: "agent-1" } }, error: null };
        },
      },
    };
  };
  return { createClient, made, refreshed };
}

/** The eight calls sync makes, and a record of what went up. */
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

const session = () => ({ credential: CREDENTIAL, open: async () => ({ client: {}, userId: "agent-1" }) });

// --- the session ------------------------------------------------------

test("the credential is exchanged once, however many tools ask at once", async () => {
  const fake = fakeSupabase();
  const s = new Session(CREDENTIAL, { createClient: fake.createClient });

  const [a, b] = await Promise.all([s.open(), s.open()]);

  assert.equal(a, b, "one session, shared");
  assert.deepEqual(fake.refreshed, ["the-token"]);
  assert.equal(a.userId, "agent-1");
});

test("nothing is persisted and no url is read: this is a process, not a browser", async () => {
  const fake = fakeSupabase();
  await new Session(CREDENTIAL, { createClient: fake.createClient }).open();

  const { url, key, options } = fake.made[0];
  assert.equal(url, CREDENTIAL.url);
  assert.equal(key, CREDENTIAL.key);
  assert.equal(options.auth.persistSession, false);
  assert.equal(options.auth.detectSessionInUrl, false);
  assert.equal(options.auth.autoRefreshToken, true, "an hour is shorter than a planning conversation");
});

test("J16.9 · a refused exchange sends somebody to the Books dialog", async () => {
  const s = new Session(CREDENTIAL, { createClient: fakeSupabase({ fails: true }).createClient });

  await assert.rejects(() => s.open(), (err) => {
    assert.ok(err instanceof SessionError);
    assert.match(err.message, /no longer works/);
    assert.match(err.message, /Books dialog/);
    return true;
  });
});

test("a network that is down is not a revoked credential", async () => {
  // The two failures look alike from here and mean opposite things: one
  // is "wait a moment", the other is "delete the agent and start again".
  const s = new Session(CREDENTIAL, { createClient: fakeSupabase({ throws: "fetch failed" }).createClient });

  await assert.rejects(() => s.open(), (err) => {
    assert.match(err.message, /Could not reach/);
    assert.ok(!/revoked|no longer works/.test(err.message));
    return true;
  });
});

test("a failed exchange is not remembered, so the next call tries again", async () => {
  let down = true;
  const createClient = () => ({
    auth: {
      refreshSession: async () =>
        down
          ? { data: null, error: { message: "network" } }
          : { data: { session: {}, user: { id: "agent-1" } }, error: null },
    },
  });
  const s = new Session(CREDENTIAL, { createClient });

  await assert.rejects(() => s.open());
  down = false;
  assert.equal((await s.open()).userId, "agent-1");
});

// --- the book ---------------------------------------------------------

test("J16.1 · the book the credential names is the book that is opened", async () => {
  const win = loadApp("units.js", "storage.js");
  const remote = win.RecipeStore.sanitizeRecipe(aRecipe({ name: "Soup" }));
  const api = fakeApi({ rows: [{ id: remote.id, data: remote, updated_at: new Date(1000).toISOString(), deleted_at: null }] });

  const book = await openBook(session(), { api });

  assert.equal(book.id, BOOK);
  assert.equal(book.name, "Ours");
  assert.equal(api.userId, "agent-1");
  assert.deepEqual(book.recipes.map((r) => r.name), ["Soup"], "a cold start is a full pull");
});

test("J16.7 · an agent that has been removed is told, not shown an empty book", async () => {
  await assert.rejects(() => openBook(session(), { api: fakeApi({ role: null }) }), (err) => {
    assert.ok(err instanceof BookError);
    assert.match(err.message, /not in that book any more/);
    return true;
  });
});

test("a credential that is not an agent's is refused rather than used", async () => {
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
  // A recipe the agent files, beside one the server already holds. An
  // upsert carrying the held row would be an UPDATE no policy matches,
  // and one refusal fails the whole batch — taking the new one with it.
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

  assert.deepEqual(api.pushed.archived, [], "the record is not its errand");
  assert.equal(book.plan.completedAt, 5000, "it leaves the plan exactly as it found it");
});

test("J8.1 · an agent has no unit preferences, because it is not a person", async () => {
  const book = await openBook(session(), { api: fakeApi() });

  assert.deepEqual(book.prefs, { mass: "", volume: "" });
});

test("a book that cannot be reached says so rather than answering from nothing", async () => {
  const api = fakeApi();
  api.fetchRecipes = async () => {
    throw new Error("network");
  };

  await assert.rejects(() => openBook(session(), { api }), /Could not reach the book/);
});
