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
const { Session, SessionError, DEAD } = require("../mcp/session.js");
const { openBook, BookError } = require("../mcp/book.js");

const BOOK = "11111111-1111-4111-8111-111111111111";
const CREDENTIAL = {
  url: "https://project.supabase.co",
  key: "sb_publishable_k",
  book: BOOK,
  refreshToken: "the-token",
};

/** A supabase client that signs in and records how it was made. */
function fakeSupabase({ fails = false, throws = null, unreachable = false } = {}) {
  const made = [];
  const refreshed = [];
  const createClient = (url, key, options) => {
    made.push({ url, key, options });
    return {
      auth: {
        refreshSession: async ({ refresh_token }) => {
          refreshed.push(refresh_token);
            if (throws) throw new Error(throws);
          // How the real library fails when the project cannot be
          // reached: it does not throw, it returns this.
          if (unreachable) {
            return {
              data: { session: null, user: null },
              error: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" },
            };
          }
          // And how it fails when the token is genuinely refused.
          if (fails) {
            return {
              data: { session: null, user: null },
              error: { name: "AuthApiError", status: 400, message: "Invalid Refresh Token" },
            };
          }
          return {
            data: {
              session: {
                access_token: `jwt-${refreshed.length}`,
                // What the server hands back and this must never present.
                refresh_token: `rotated-${refreshed.length}`,
                expires_in: 3600,
              },
              user: { id: "agent-1" },
            },
            error: null,
          };
        },
      },
    };
  };
  return { createClient, made, refreshed };
}

/**
 * The refresh-token rules Supabase Auth actually applies, and nothing
 * kinder. A token is good once; after that the server accepts it again
 * only as the parent of the token now current, and answers with the
 * current one rather than a new one. Anything further back is refused
 * with the 400 that reads as "revoked" — reuse detection off or not,
 * which only decides whether the whole session goes with it.
 */
function authServer() {
  const parent = new Map([["the-token", null]]);
  let current = "the-token";
  const used = new Set();
  let n = 0;
  const refreshed = [];
  const refuse = { name: "AuthApiError", status: 400, message: "Invalid Refresh Token: Already Used" };

  function grant(token) {
    refreshed.push(token);
    let issued;
    if (!used.has(token) && token === current) {
      used.add(token);
      issued = `rt-${++n}`;
      parent.set(issued, token);
      current = issued;
    } else if (parent.get(current) === token) {
      issued = current;
    } else {
      return { data: { session: null, user: null }, error: refuse };
    }
    return {
      data: {
        session: { access_token: `jwt-${refreshed.length}`, refresh_token: issued, expires_in: 3600 },
        user: { id: "agent-1" },
      },
      error: null,
    };
  }

  const createClient = (url, key, options) => ({
    auth: { refreshSession: async ({ refresh_token }) => grant(refresh_token) },
    options,
  });
  return { createClient, grant, refreshed };
}

/** A clock the tests move by hand. */
function clock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (minutes) => {
    t += minutes * 60 * 1000;
  };
  return now;
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

test("J17.3 · nothing is persisted and no url is read: this is a process, not a browser", async () => {
  const fake = fakeSupabase();
  await new Session(CREDENTIAL, { createClient: fake.createClient }).open();

  const { url, key, options } = fake.made[0];
  assert.equal(url, CREDENTIAL.url);
  assert.equal(key, CREDENTIAL.key);
  assert.equal(options.auth.persistSession, false);
  assert.equal(options.auth.detectSessionInUrl, false);
  assert.equal(options.auth.autoRefreshToken, false, "the exchange client never refreshes on its own");
});

test("J16.9 · the data client holds no refresh token, only a way to ask for an access token", async () => {
  // A client holding a session is a client that can refresh it, and
  // refreshing it is what put the pasted string out of date. With
  // `accessToken` set the library builds no auth client at all.
  const fake = fakeSupabase();
  const s = new Session(CREDENTIAL, { createClient: fake.createClient });

  await s.open();

  const data = fake.made.find((m) => m.options.accessToken);
  assert.ok(data, "the data client is built with accessToken");
  assert.equal(data.options.auth, undefined, "and with no auth settings to refresh by");
  assert.equal(await data.options.accessToken(), "jwt-1");
});

test("J16.9 · only the pasted token is ever exchanged, however long the process runs", async () => {
  const fake = fakeSupabase();
  const now = clock();
  const s = new Session(CREDENTIAL, { createClient: fake.createClient, now });
  const { client } = await s.open();
  const data = fake.made.find((m) => m.options.accessToken);

  // A day of questions, one every twenty minutes, with the data client
  // asking for a token between them as a sync would.
  for (let i = 0; i < 72; i++) {
    now.advance(20);
    assert.equal((await s.open()).client, client, "one data client for the life of the process");
    await data.options.accessToken();
  }

  assert.ok(fake.refreshed.length > 1, "the access token was renewed as it ran down");
  assert.ok(fake.refreshed.every((t) => t === "the-token"), "and never with a token the server handed back");
});

test("J16.9 · a token with time left on it is not renewed", async () => {
  const fake = fakeSupabase();
  const now = clock();
  const s = new Session(CREDENTIAL, { createClient: fake.createClient, now });

  await s.open();
  now.advance(40);
  await s.open();
  assert.equal(fake.refreshed.length, 1, "forty minutes into an hour's token");

  now.advance(10);
  await s.open();
  assert.equal(fake.refreshed.length, 2, "inside the last quarter of its life");
});

test("J16.9 · requests that find the token run down renew it once between them", async () => {
  const fake = fakeSupabase();
  const now = clock();
  const s = new Session(CREDENTIAL, { createClient: fake.createClient, now });
  await s.open();
  const data = fake.made.find((m) => m.options.accessToken);

  now.advance(55);
  const tokens = await Promise.all([data.options.accessToken(), data.options.accessToken(), s.open()]);

  assert.equal(fake.refreshed.length, 2);
  assert.equal(tokens[0], tokens[1]);
});

test("J16.9 · against the server's real rules, the pasted string outlives a long run and a restart", async () => {
  // What was going wrong. The server lets a spent token back in only as
  // the parent of the current one; the old client refreshed in memory
  // after an hour, the pasted string fell two links behind, and the next
  // start was told the credential had been revoked.
  const server = authServer();
  const now = clock();

  const first = new Session(CREDENTIAL, { createClient: server.createClient, now });
  await first.open();
  for (let i = 0; i < 18; i++) {
    now.advance(20);
    await first.open();
  }

  // A restart, and a second copy started alongside the first.
  const second = new Session(CREDENTIAL, { createClient: server.createClient, now });
  assert.equal((await second.open()).userId, "agent-1");
  now.advance(55);
  await first.open();
  await second.open();

  // And the rule has teeth: a client that presented what it was handed
  // back, as the library's own refresh does, puts the string out of date.
  const handedBack = server.grant("the-token").data.session.refresh_token;
  assert.equal(server.grant(handedBack).error, null, "the library's refresh succeeds");
  assert.equal(server.grant("the-token").error.status, 400, "and the pasted string is dead from then on");
});

test("J16.9 · a credential that stops working mid-run is reported as that, at the next question", async () => {
  let refused = false;
  const now = clock();
  const createClient = () => ({
    auth: {
      refreshSession: async () =>
        refused
          ? { data: { session: null, user: null }, error: { name: "AuthApiError", status: 400, message: "no" } }
          : { data: { session: { access_token: "jwt", expires_in: 3600 }, user: { id: "agent-1" } }, error: null },
    },
  });
  const s = new Session(CREDENTIAL, { createClient, now });
  await s.open();

  refused = true;
  now.advance(55);
  await assert.rejects(() => s.open(), (err) => err.message === DEAD);
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

test("J17.5 · a network that is down is not a revoked credential", async () => {
  // The two look alike from here and mean opposite things: one is "wait
  // a moment", the other is "delete the agent and start again" — and
  // removing an agent is entire and one-way (J16.7), so the wrong answer
  // is the irreversible one.
  //
  // The library does not throw when the network fails; it returns an
  // error carrying status 0. A stub that throws instead tests a failure
  // that cannot happen, which is how this went six reviews unnoticed.
  const s = new Session(CREDENTIAL, { createClient: fakeSupabase({ unreachable: true }).createClient });

  await assert.rejects(() => s.open(), (err) => {
    assert.match(err.message, /Could not reach/);
    assert.match(err.message, /not the credential/);
    assert.ok(!/Books dialog|remove the agent/i.test(err.message), "nobody is sent to delete anything");
    return true;
  });
});

test("J17.5 · only a status the auth server refused the token with means start again", async () => {
  // The two answers are not equally costly. Waiting is free and wrong
  // once; removing an agent is entire and one-way (J16.7). So the
  // irreversible sentence is reserved for a refusal, and everything else
  // — a rate limiter, a bad gateway, a captive portal that answers with
  // no status at all — is the world, which is worth waiting for.
  const answer = async (error) => {
    const createClient = () => ({
      auth: { refreshSession: async () => ({ data: { session: null, user: null }, error }) },
    });
    try {
      await new Session(CREDENTIAL, { createClient }).open();
      return "opened";
    } catch (err) {
      return err.message === DEAD ? "start again" : "wait";
    }
  };

  assert.equal(await answer({ name: "AuthApiError", status: 400, message: "Invalid Refresh Token" }), "start again");
  assert.equal(await answer({ name: "AuthApiError", status: 401, message: "no" }), "start again");
  assert.equal(await answer({ name: "AuthApiError", status: 403, message: "no" }), "start again");

  assert.equal(await answer({ name: "AuthApiError", status: 429, message: "over_request_rate_limit" }), "wait");
  assert.equal(await answer({ name: "AuthApiError", status: 503, message: "unavailable" }), "wait");
  assert.equal(await answer({ name: "AuthRetryableFetchError", status: 0, message: "fetch failed" }), "wait");
  assert.equal(await answer({ name: "AuthUnknownError", message: "Unexpected token <" }), "wait");
});

test("a failed exchange is not remembered, so the next call tries again", async () => {
  let down = true;
  const createClient = () => ({
    auth: {
      refreshSession: async () =>
        down
          ? { data: null, error: { message: "network" } }
          : { data: { session: { access_token: "jwt" }, user: { id: "agent-1" } }, error: null },
    },
  });
  const s = new Session(CREDENTIAL, { createClient });

  await assert.rejects(() => s.open());
  down = false;
  assert.equal((await s.open()).userId, "agent-1");
});

// --- the book ---------------------------------------------------------

test("J16.9 · every sync renews the token first, and a dead credential says so rather than 'cannot reach'", async () => {
  let opens = 0;
  let dead = false;
  const s = {
    credential: CREDENTIAL,
    open: async () => {
      opens++;
      if (dead) throw new SessionError(DEAD);
      return { client: {}, userId: "agent-1" };
    },
  };
  const book = await openBook(s, { api: fakeApi() });

  await book.refresh();
  assert.equal(opens, 2, "once to open the book, once before its first sync");

  dead = true;
  await assert.rejects(() => book.refresh(), (err) => err.message === DEAD);
});

test("J16.1 · the book the credential names is the book that is opened", async () => {
  const win = loadApp("units.js", "storage.js");
  const remote = win.RecipeStore.sanitizeRecipe(aRecipe({ name: "Soup" }));
  const api = fakeApi({ rows: [{ id: remote.id, data: remote, updated_at: new Date(1000).toISOString(), deleted_at: null }] });

  const book = await openBook(session(), { api });
  assert.deepEqual(book.recipes, [], "opening is the credential and the membership row");

  await book.refresh();

  assert.equal(book.id, BOOK);
  assert.equal(book.name, "Ours");
  assert.equal(api.userId, "agent-1");
  assert.deepEqual(book.recipes.map((r) => r.name), ["Soup"], "a cold start is a full pull");
});

test("J17.2 · the credential names the book, and nothing else chooses one", async () => {
  // An agent belongs to one book and cannot be added to a second
  // (J16.1), so a roster with anything else in it is a project half way
  // through a migration — the situation the pinned book id is for.
  const api = fakeApi();
  api.listBooks = async () => [
    { id: "99999999-9999-4999-8999-999999999999", role: "agent", name: "Somewhere else", isOwner: true },
    { id: BOOK, role: "agent", name: "Ours", isOwner: false },
  ];

  const book = await openBook(session(), { api });

  assert.equal(book.id, BOOK, "the one the credential named, not the one it owns");
  assert.equal(book.name, "Ours");
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
