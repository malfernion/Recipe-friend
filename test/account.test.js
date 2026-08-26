/**
 * J1 · Arriving for the first time, and J8.2 · preferences follow the person.
 *
 * js/account.js is the front door: it decides whether the sign-in gate is
 * up, what the one way in is, and what happens the first time somebody
 * gets through it. It is an IIFE that runs on load and talks to Supabase,
 * so these tests hand it a window, a document and a Supabase stand-in and
 * then drive it the way a person does — arrive, click Sign in, sign out.
 *
 * Two of J1's claims are not the client's to keep: the profile row and the
 * first book are made by a database trigger (supabase/migrations/003), and
 * the database is deliberately outside the net. What is tested here is the
 * client-side fallback that names a book when the account has none, which
 * is the only part of J1.3 this code can be held to.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadApp, loadUI, aRecipe } = require("./helpers/load.js");

const ROOT = path.join(__dirname, "..");
const readSrc = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/**
 * Settle everything the app queued. loadUI replaces the global setTimeout
 * with a stub that never fires, so a macrotask tick is the honest way to
 * let a chain of awaited promises finish.
 */
const flush = () => new Promise((resolve) => setImmediate(resolve));

const CONFIGURED = { supabaseUrl: "https://project.supabase.co", supabaseKey: "sb_publishable_x" };

/** A signed-in session the way Supabase hands one over. */
function aSession(over = {}) {
  return {
    user: {
      id: over.userId || "user-1",
      email: "email" in over ? over.email : "dave@example.com",
      user_metadata: "metadata" in over ? over.metadata : { name: "Dave" },
    },
  };
}

/** The tables account.js and sync.js reach for, empty unless seeded. */
function makeDb(over = {}) {
  return {
    books: over.books || [],
    book_members: over.book_members || [],
    profiles: over.profiles || [],
    recipes: over.recipes || [],
  };
}

/**
 * A Supabase stand-in: `auth` plus enough of the PostgREST query builder
 * for sync.js and books.js. Every call is recorded, including the sign-in
 * routes the app must never take (J1.2).
 */
function fakeSupabase(opts = {}) {
  const db = opts.db || makeDb();
  const fail = opts.fail || {};
  const log = {
    oauth: [],
    signOuts: 0,
    forbidden: [],
    booksCreated: [],
    memberships: [],
    profileUpdates: [],
    upserts: [],
    queries: [],
  };
  let session = opts.session || null;
  let onAuth = null;
  let nextBook = 0;

  const filterVal = (q, col) => {
    const hit = q.filters.find((f) => f[0] === col);
    return hit ? hit[1] : undefined;
  };
  const bookOf = (id) => {
    const b = db.books.find((x) => x.id === id);
    return b ? { name: b.name, owner: b.owner } : null;
  };
  const profileOf = (userId) => {
    const p = db.profiles.find((x) => x.user_id === userId);
    return p ? { display_name: p.display_name } : null;
  };

  async function run(q) {
    log.queries.push({ table: q.table, op: q.op, filters: q.filters });
    const err = fail[`${q.table}:${q.op}`] || fail[q.table];
    if (err) return { data: null, error: err };

    switch (`${q.table}:${q.op}`) {
      case "book_members:select": {
        const bookId = filterVal(q, "book_id");
        if (bookId !== undefined) {
          return {
            data: db.book_members
              .filter((m) => m.book_id === bookId)
              .map((m) => ({ user_id: m.user_id, role: m.role, profiles: profileOf(m.user_id) })),
            error: null,
          };
        }
        const userId = filterVal(q, "user_id");
        return {
          data: db.book_members
            .filter((m) => m.user_id === userId)
            .map((m) => ({ book_id: m.book_id, role: m.role, books: bookOf(m.book_id) })),
          error: null,
        };
      }
      case "book_members:insert": {
        db.book_members.push({ ...q.payload });
        log.memberships.push({ ...q.payload });
        return { data: null, error: null };
      }
      case "books:insert": {
        nextBook += 1;
        const book = {
          id: `book-${nextBook}`,
          name: q.payload.name,
          owner: q.payload.owner,
        };
        db.books.push(book);
        log.booksCreated.push(book);
        return { data: [{ id: book.id, name: book.name }], error: null };
      }
      case "profiles:select": {
        const row = db.profiles.find((p) => p.user_id === filterVal(q, "user_id"));
        if (!row) return { data: [], error: null };
        return { data: [{ unit_prefs: "unit_prefs" in row ? row.unit_prefs : null }], error: null };
      }
      case "profiles:update": {
        log.profileUpdates.push(q.payload);
        const row = db.profiles.find((p) => p.user_id === filterVal(q, "user_id"));
        if (row) Object.assign(row, q.payload);
        return { data: null, error: null };
      }
      case "recipes:select": {
        const bookId = filterVal(q, "book_id");
        return { data: db.recipes.filter((r) => r.book_id === bookId), error: null };
      }
      case "recipes:upsert": {
        for (const row of q.payload) {
          log.upserts.push(row);
          const at = db.recipes.findIndex((r) => r.id === row.id);
          if (at >= 0) db.recipes[at] = row;
          else db.recipes.push(row);
        }
        return { data: null, error: null };
      }
      default:
        return { data: [], error: null };
    }
  }

  function builder(table) {
    const q = { table, op: "select", payload: null, filters: [], single: false };
    const api = {
      select() { return api; },
      insert(payload) { q.op = "insert"; q.payload = payload; return api; },
      update(payload) { q.op = "update"; q.payload = payload; return api; },
      upsert(payload) { q.op = "upsert"; q.payload = payload; return api; },
      delete() { q.op = "delete"; return api; },
      eq(col, val) { q.filters.push([col, val]); return api; },
      gt() { return api; },
      is() { return api; },
      order() { return api; },
      single() { q.single = true; return api; },
      maybeSingle() { q.single = true; return api; },
      then(onOk, onErr) {
        return run(q)
          .then((res) => (q.single && Array.isArray(res.data)
            ? { ...res, data: res.data[0] || null }
            : res))
          .then(onOk, onErr);
      },
    };
    return api;
  }

  const forbid = (name) => async () => {
    log.forbidden.push(name);
    return { data: null, error: null };
  };

  const client = {
    auth: {
      async getSession() {
        return { data: { session } };
      },
      onAuthStateChange(cb) {
        onAuth = cb;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signInWithOAuth(options) {
        log.oauth.push(options);
        return { error: opts.oauthError || null };
      },
      async signOut() {
        log.signOuts += 1;
        if (opts.signOutError) return { error: opts.signOutError };
        session = null;
        if (onAuth) onAuth("SIGNED_OUT", null);
        return { error: null };
      },
      // Routes into the app that J1.2 says do not exist. Present so that a
      // test can prove nothing reaches for them.
      signInWithPassword: forbid("signInWithPassword"),
      signUp: forbid("signUp"),
      signInWithOtp: forbid("signInWithOtp"),
      resetPasswordForEmail: forbid("resetPasswordForEmail"),
    },
    from: builder,
    async rpc() {
      return { data: null, error: null };
    },
    storage: {
      from() {
        return {
          async upload() { return { error: null }; },
          async copy() { return { error: null }; },
          async remove() { return { error: null }; },
          async createSignedUrl() { return { data: { signedUrl: "" }, error: null }; },
        };
      },
    },
  };

  return {
    db,
    log,
    client,
    supabase: { createClient: () => client },
    /** Drive an auth state change the way Supabase would. */
    async emit(next) {
      session = next;
      if (onAuth) onAuth(next ? "SIGNED_IN" : "SIGNED_OUT", next);
      await flush();
    },
  };
}

/** Load a browser IIFE into an already-built window. */
function loadInto(win, name) {
  new Function("window", readSrc(path.join("js", name)))(win);
}

/**
 * Someone arrives at the site. Builds the page the way index.html does —
 * gated, with the app modules loaded — then runs account.js on it.
 */
function arrive(opts = {}) {
  const ui = loadUI();
  const win = ui.win;

  // index.html ships <body class="gated">: the gate is up before any
  // script decides anything, so nothing is visible while JS is deciding.
  win.document.body.classList.add("gated");
  // ...and these four arrive hidden, so that a signed-out visitor is never
  // shown an account, a book or a sync status that is not theirs yet.
  for (const id of ["account-name", "current-book", "sync-status", "books-btn"]) {
    win.document.getElementById(id).hidden = true;
  }

  if (opts.localPrefs) ui.store.setPrefs(opts.localPrefs);
  for (const r of opts.localRecipes || []) ui.store.add(r);

  const prefsSet = [];
  const setPrefs = ui.store.setPrefs.bind(ui.store);
  ui.store.setPrefs = (p) => {
    prefsSet.push(p);
    return setPrefs(p);
  };

  loadInto(win, "sync.js");
  loadInto(win, "books.js");

  win.RECIPE_FRIEND_CONFIG = "config" in opts ? opts.config : CONFIGURED;
  const sb = fakeSupabase(opts);
  win.supabase = "supabase" in opts ? opts.supabase : sb.supabase;

  const warnings = [];
  const alerts = [];
  new Function(
    "window", "document", "location", "history", "sessionStorage", "console", "alert",
    readSrc(path.join("js", "account.js")),
  )(
    win,
    win.document,
    win.location,
    win.history,
    win.sessionStorage,
    { warn: (...a) => warnings.push(a.map(String).join(" ")), log() {}, error() {} },
    (message) => alerts.push(message),
  );

  return {
    ...ui,
    sb,
    warnings,
    alerts,
    prefsSet,
    gated: () => win.document.body.classList.contains("gated"),
    cloud: () => win.RecipeCloud,
  };
}

/** A sync wired straight to the fake, for the profile round trip. */
function syncOnly(opts = {}) {
  const win = loadApp("units.js", "scale.js", "storage.js", "sync.js");
  const sb = fakeSupabase(opts);
  const sync = new win.RecipeSync(new win.RecipeStore(), sb.client, () => {});
  sync.userId = "user-1";
  return { sync, sb, win };
}

// ---------------------------------------------------------------------
// J1.1 · signed out, there is a sign-in screen and nothing else
// ---------------------------------------------------------------------

test("J1.1 · signed out, the app is gated and no sync is running", async () => {
  const a = arrive({ session: null });
  await flush();

  assert.equal(a.gated(), true, "the sign-in screen is what is left");
  assert.equal(a.cloud().session, null);
  assert.equal(a.cloud().sync, null, "nothing syncs for someone who is not signed in");
  assert.ok(!a.store.onChange, "and local edits are not queued for a server");
  assert.equal(a.el("account-name").hidden, true);
  assert.equal(a.el("account-btn").textContent, "Sign in");
  assert.equal(a.el("sync-status").hidden, true);
  assert.equal(a.sb.log.queries.length, 0, "nothing is asked of the server");
});

test("J1.1 · the gate hides the recipes, the controls and the navigation", () => {
  const html = readSrc("index.html");
  const css = readSrc(path.join("css", "styles.css"));

  assert.match(html, /<body class="gated">/, "the page arrives gated, before any script runs");

  // The class has to actually take the app off the screen, or "gated" is
  // just a word. These are the three regions index.html is built from.
  const hiding = /body\.gated\s+\.appbar,\s*body\.gated\s+\.container,\s*body\.gated\s+\.app-footer\s*\{[^}]*display:\s*none/;
  assert.match(css, hiding, "the appbar, the recipe list and the footer are all hidden");
  assert.match(css, /\.signin-view\s*\{\s*display:\s*none/, "and the sign-in screen is hidden by default");
  assert.match(css, /body\.gated\s+\.signin-view\s*\{\s*display:\s*flex/, "shown only while gated");
});

test("J1.5 · the sign-in screen links to the privacy policy and terms", () => {
  const html = readSrc("index.html");
  const card = /<div class="signin-card">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(card, "there is a sign-in card to read");

  // Both have to be on the gate itself: signed out, the footer that
  // carries the same pair is hidden with the rest of the app (J1.1).
  assert.match(card[1], /<a href="privacy\.html">Privacy Policy<\/a>/);
  assert.match(card[1], /<a href="terms\.html">Terms of Service<\/a>/);
  assert.ok(fs.existsSync(path.join(ROOT, "privacy.html")), "and the policy is really there");
  assert.ok(fs.existsSync(path.join(ROOT, "terms.html")), "as are the terms");
});

// ---------------------------------------------------------------------
// J1.2 · Google is the only way in
// ---------------------------------------------------------------------

test("J1.2 · the only way in is Sign in with Google", async () => {
  const a = arrive({ session: null });
  await flush();

  await a.el("account-btn").fire("click");
  await flush();

  assert.equal(a.sb.log.oauth.length, 1);
  assert.equal(a.sb.log.oauth[0].provider, "google");
  assert.equal(
    a.sb.log.oauth[0].options.redirectTo,
    "https://test.local/",
    "and it comes back to this app, not somewhere a link could be pointed",
  );
  assert.deepEqual(a.sb.log.forbidden, [], "no password, magic link or sign-up route is used");
  assert.equal(a.sb.log.signOuts, 0);
});

test("J1.2 · the sign-in screen's button is the same one way in", async () => {
  const a = arrive({ session: null });
  await flush();

  a.el("signin-cta").fire("click");
  await flush();

  assert.equal(a.sb.log.oauth.length, 1, "the big button on the gate signs in too");
  assert.equal(a.sb.log.oauth[0].provider, "google");
});

test("J1.2 · there is no email or password option anywhere in the app", () => {
  const html = readSrc("index.html");
  assert.equal(/type="password"/.test(html), false, "no password field");
  assert.equal(/<input[^>]+type="email"/.test(html), false, "no email field");

  const dir = path.join(ROOT, "js");
  const sources = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
  for (const route of ["signInWithPassword", "signUp(", "signInWithOtp", "resetPasswordForEmail"]) {
    assert.equal(sources.includes(route), false, `no ${route} route into the app`);
  }
  const providers = [...sources.matchAll(/provider:\s*"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(providers, ["google"], "google is the only provider named in the source");
});

test("J1.2 · a sign-in that cannot start says so rather than failing silently", async () => {
  const a = arrive({ session: null, oauthError: new Error("auth is misconfigured") });
  await flush();

  await a.el("account-btn").fire("click");
  await flush();

  assert.equal(a.alerts.length, 1, "the one way in never fails quietly");
  assert.match(a.alerts[0], /Sign-in didn't start/);
  assert.equal(a.gated(), true, "and nobody is let through on a failed sign-in");
});

// ---------------------------------------------------------------------
// J1.3 · a first sign-in gets one book, named after the person
// ---------------------------------------------------------------------

test("J1.3 · an account with no books gets one, named after the person", async () => {
  const a = arrive({ session: aSession({ metadata: { name: "Dave" } }) });
  await flush();

  assert.equal(a.sb.log.booksCreated.length, 1, "exactly one book, not two");
  assert.equal(a.sb.log.booksCreated[0].name, "Dave's recipes");
  assert.equal(a.sb.log.booksCreated[0].owner, "user-1");
  assert.deepEqual(a.sb.log.memberships, [
    { book_id: "book-1", user_id: "user-1", role: "owner" },
  ], "and they are its owner");
  assert.equal(a.cloud().sync.bookId, "book-1", "which is the book this session syncs with");
});

test("J1.3 · the book is named after the person, however the account names them", async () => {
  const named = async (metadata, email) => {
    const a = arrive({ session: aSession({ metadata, email }) });
    await flush();
    return a.sb.log.booksCreated.map((b) => b.name);
  };

  assert.deepEqual(await named({ name: "Dave" }, "dave@example.com"), ["Dave's recipes"]);
  assert.deepEqual(
    await named({ full_name: "Dave Ernsting" }, "dave@example.com"),
    ["Dave Ernsting's recipes"],
    "a Google account that only carries full_name still gets a name on its book",
  );
  assert.deepEqual(await named({}, "dave@example.com"), ["dave@example.com's recipes"]);
});

test("J1.3 · a book named for nobody falls back rather than reading oddly", () => {
  const win = loadApp("units.js", "scale.js", "storage.js", "sync.js");
  const name = win.RecipeSync.ownBookName;

  assert.equal(name("Dave"), "Dave's recipes");
  assert.equal(name("  Dave  "), "Dave's recipes");
  assert.equal(name(""), "Recipes", "no name is better than \"'s recipes\"");
  assert.equal(name(null), "Recipes");
  assert.equal(name("D".repeat(200)), `${"D".repeat(60)}'s recipes`, "and it stays within the column");
});

test("J1.3 · an account that already has a book is not given a second one", async () => {
  const db = makeDb({
    books: [{ id: "existing", name: "Dave's recipes", owner: "user-1" }],
    book_members: [{ book_id: "existing", user_id: "user-1", role: "owner" }],
  });
  const a = arrive({ db, session: aSession() });
  await flush();

  assert.deepEqual(a.sb.log.booksCreated, [], "the trigger's book is used, not duplicated");
  assert.equal(a.cloud().sync.bookId, "existing");
});

// ---------------------------------------------------------------------
// J1.4 · a new account has no recipes at all
// ---------------------------------------------------------------------

test("J1.4 · a new account has no recipes at all — nothing is seeded", async () => {
  const a = arrive({ session: aSession() });
  await flush();

  assert.deepEqual(a.store.recipes, [], "the box is empty");
  assert.deepEqual(a.sb.db.recipes, [], "and stays empty on the server");
  assert.deepEqual(a.sb.log.upserts, [], "nothing was invented locally and pushed up");
  assert.equal(a.el("recipe-list").innerHTML, "", "the list renders nothing");
  assert.equal(a.el("empty-state").hidden, false, "the empty state is what a new account sees");
});

test("J1.4 · what a returning account already has is not disturbed by arriving", async () => {
  const db = makeDb({
    books: [{ id: "b1", name: "Dave's recipes", owner: "user-1" }],
    book_members: [{ book_id: "b1", user_id: "user-1", role: "owner" }],
    recipes: [{
      id: "77777777-7777-4777-8777-777777777777",
      book_id: "b1",
      data: aRecipe({ name: "Sunday Roast" }),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    }],
  });
  const a = arrive({ db, session: aSession() });
  await flush();

  assert.deepEqual(a.store.recipes.map((r) => r.name), ["Sunday Roast"]);
  assert.equal(a.el("empty-state").hidden, true);
});

// ---------------------------------------------------------------------
// J1.6 · signed-out local use is not supported, except in development
// ---------------------------------------------------------------------

test("J1.6 · with a project configured, signed-out local use is not offered", async () => {
  const a = arrive({ session: null });
  await flush();

  assert.equal(a.gated(), true, "there is no way to use the box without an account");
  assert.equal(a.el("account-btn").hidden, false, "the way in is still offered");
  assert.ok(a.cloud(), "and the client is live, waiting for a session");
});

test("J1.6 · with no project configured the gate is lifted — the development case", () => {
  for (const config of [null, undefined, {}, { supabaseUrl: "https://x.co" }, { supabaseKey: "k" }]) {
    const a = arrive({ config, session: null });
    assert.equal(a.gated(), false, `an unconfigured build must not strand anyone: ${JSON.stringify(config)}`);
    assert.equal(a.el("account-btn").hidden, true, "and it does not offer a sign-in that cannot work");
    assert.equal(a.cloud(), undefined, "no client, no session, no sync");
  }
});

test("J1.6 · a missing vendor script lifts the gate too rather than locking the app", () => {
  const a = arrive({ supabase: undefined, session: null });

  assert.equal(a.gated(), false);
  assert.equal(a.el("account-btn").hidden, true);
  assert.equal(a.cloud(), undefined);
});

test("J1.6 · the shipped config is a real project, so the fallback is not what users get", () => {
  const win = { window: null };
  win.window = win;
  new Function("window", readSrc(path.join("js", "config.js")))(win);
  const cfg = win.RECIPE_FRIEND_CONFIG;

  assert.match(cfg.supabaseUrl, /^https:\/\/[a-z0-9]+\.supabase\.co$/);
  assert.ok(cfg.supabaseKey);
  assert.equal(/service_role|^eyJ/.test(cfg.supabaseKey), false, "J11.5 · never the service_role key");
});

// ---------------------------------------------------------------------
// J8.2 · preferences belong to the person, not the device
// ---------------------------------------------------------------------

const withProfile = (unit_prefs) =>
  makeDb({
    books: [{ id: "b1", name: "Dave's recipes", owner: "user-1" }],
    book_members: [{ book_id: "b1", user_id: "user-1", role: "owner" }],
    profiles: [{ user_id: "user-1", display_name: "Dave", unit_prefs }],
  });

test("J8.2 · what the profile already holds wins over this device", async () => {
  const db = withProfile({ mass: "imperial", volume: "us" });
  const a = arrive({ db, session: aSession(), localPrefs: { mass: "metric", volume: "metric" } });
  await flush();

  assert.deepEqual(a.store.prefs, { mass: "imperial", volume: "us" }, "signing in elsewhere applies the same units");
  assert.deepEqual(a.sb.log.profileUpdates, [], "and this device does not overwrite the person's choice");
});

test("J8.2 · a device with no preference of its own adopts the person's", async () => {
  const db = withProfile({ mass: "imperial", volume: "us" });
  const a = arrive({ db, session: aSession() });
  await flush();

  assert.deepEqual(a.store.prefs, { mass: "imperial", volume: "us" });
  assert.deepEqual(a.sb.log.profileUpdates, []);
});

test("J8.2 · with nothing on the profile, this device seeds it", async () => {
  const db = withProfile(null);
  const a = arrive({ db, session: aSession(), localPrefs: { mass: "imperial", volume: "us" } });
  await flush();

  assert.deepEqual(a.sb.log.profileUpdates, [{ unit_prefs: { mass: "imperial", volume: "us" } }]);
  assert.deepEqual(a.store.prefs, { mass: "imperial", volume: "us" }, "and the device keeps what it had");
  assert.deepEqual(a.prefsSet, [], "nothing was written back over it");
});

test("J8.2 · preferences set on one device are found on the next", async () => {
  const db = withProfile(null);

  const first = arrive({ db, session: aSession(), localPrefs: { mass: "imperial", volume: "us" } });
  await flush();

  // Somewhere else entirely: a fresh browser, the same account.
  const second = arrive({ db, session: aSession() });
  await flush();

  assert.deepEqual(
    second.store.prefs,
    { mass: "imperial", volume: "us" },
    "J8.2 · signing in elsewhere applies the same units",
  );
  assert.deepEqual(second.sb.log.profileUpdates, [], "and the second device has nothing to add");
  assert.deepEqual(first.store.prefs, { mass: "imperial", volume: "us" });
});

test("J8.2 · a preference the person has only half set still follows them", async () => {
  const db = withProfile({ volume: "us" });
  const a = arrive({ db, session: aSession(), localPrefs: { mass: "metric", volume: "metric" } });
  await flush();

  assert.deepEqual(
    a.store.prefs,
    { mass: "", volume: "us" },
    "the profile is the person's record, and it is taken whole",
  );
  assert.deepEqual(a.sb.log.profileUpdates, [], "this device does not top it up behind their back");
});

test("J8.2 · preferences that already agree are not written back and forth", async () => {
  const db = withProfile({ mass: "metric", volume: "metric" });
  const a = arrive({ db, session: aSession(), localPrefs: { mass: "metric", volume: "metric" } });
  await flush();

  assert.deepEqual(a.prefsSet, [], "no local write");
  assert.deepEqual(a.sb.log.profileUpdates, [], "no remote write");
});

test("J8.2 · neither side holding a preference leaves both alone", async () => {
  const db = withProfile(null);
  const a = arrive({ db, session: aSession() });
  await flush();

  assert.deepEqual(a.prefsSet, []);
  assert.deepEqual(a.sb.log.profileUpdates, []);
  assert.deepEqual(a.store.prefs, { mass: "", volume: "" });
});

test("J8.3 · adopting the person's units does not touch a single recipe", async () => {
  const db = withProfile({ mass: "imperial", volume: "us" });
  const a = arrive({
    db,
    session: aSession(),
    localPrefs: { mass: "metric", volume: "metric" },
    localRecipes: [aRecipe({ name: "Soup", ingredients: [{ amount: 400, unit: "g", item: "tomatoes" }] })],
  });
  await flush();

  assert.deepEqual(a.store.prefs, { mass: "imperial", volume: "us" });
  assert.deepEqual(
    a.store.recipes[0].ingredients,
    [{ amount: 400, unit: "g", item: "tomatoes" }],
    "recipes are stored as entered and converted on display",
  );
});

// ---------------------------------------------------------------------
// J8.2 · the profile round trip, and a profile that is not what it should be
// ---------------------------------------------------------------------

test("J8.2 · a preference pushed to the profile is the preference pulled back", async () => {
  const { sync } = syncOnly({ db: withProfile(null) });

  assert.equal(await sync.pullPrefs(), null, "nothing there to begin with");
  await sync.pushPrefs({ mass: "imperial", volume: "us" });

  assert.deepEqual(await sync.pullPrefs(), { mass: "imperial", volume: "us" });
});

test("J8.2 · a half-set preference travels as a half-set preference", async () => {
  const { sync } = syncOnly({ db: withProfile(null) });
  await sync.pushPrefs({ mass: "metric" });

  assert.deepEqual(await sync.pullPrefs(), { mass: "metric", volume: "" }, "volume stays unset, not undefined");
});

test("J8.2 · a profile row that is empty or missing is read as no preference", async () => {
  const missing = syncOnly({ db: makeDb() });
  assert.equal(await missing.sync.pullPrefs(), null, "no row at all");

  const empty = syncOnly({ db: withProfile(null) });
  assert.equal(await empty.sync.pullPrefs(), null, "a row with nothing in it");

  const blank = syncOnly({ db: withProfile({}) });
  assert.deepEqual(await blank.sync.pullPrefs(), {}, "an empty object is passed through, not invented");
});

test("J8.2 · a malformed profile row does not crash the app or corrupt the units", async () => {
  for (const unit_prefs of [{ mass: "furlongs", volume: 7 }, "nonsense", 42, []]) {
    const a = arrive({ db: withProfile(unit_prefs), session: aSession() });
    await flush();

    assert.deepEqual(
      a.store.prefs,
      { mass: "", volume: "" },
      `garbage on the profile leaves the units unset: ${JSON.stringify(unit_prefs)}`,
    );
    assert.equal(a.cloud().sync.bookId, "b1", "and the app carries on");
  }
});

test("J8.2 · a profile that cannot be read never stops the recipes arriving", async () => {
  const db = withProfile({ mass: "imperial", volume: "us" });
  db.recipes.push({
    id: "88888888-8888-4888-8888-888888888888",
    book_id: "b1",
    data: aRecipe({ name: "Sunday Roast" }),
    updated_at: new Date().toISOString(),
    deleted_at: null,
  });
  const a = arrive({ db, session: aSession(), fail: { "profiles:select": new Error("no profile") } });
  await flush();

  assert.deepEqual(a.store.recipes.map((r) => r.name), ["Sunday Roast"], "the recipes still come down");
  assert.equal(a.el("sync-status").textContent, "Synced");
  assert.ok(
    a.warnings.some((w) => /could not sync preferences/.test(w)),
    "and the failure is reported rather than swallowed",
  );
});

// ---------------------------------------------------------------------
// Session transitions
// ---------------------------------------------------------------------

test("J1.1 · signing out stops sync and puts the gate back", async () => {
  const a = arrive({ session: aSession() });
  await flush();

  const sync = a.cloud().sync;
  assert.ok(sync.bookId, "signed in, sync is running");
  assert.equal(a.gated(), false);
  assert.equal(a.el("account-name").textContent, "Dave");
  assert.equal(a.el("account-btn").textContent, "Sign out");
  assert.equal(a.el("books-btn").hidden, false, "and the book controls are on screen");

  await a.el("account-btn").fire("click");
  await flush();

  assert.equal(a.sb.log.signOuts, 1, "the same button signs out");
  assert.deepEqual(a.sb.log.oauth, [], "and does not try to sign in again");
  assert.equal(a.gated(), true, "the gate is back");
  assert.equal(a.cloud().session, null);
  assert.equal(a.cloud().sync, null, "sync is let go of");
  assert.equal(sync.bookId, null, "and stopped, so nothing is left pushing to the old book");
  assert.equal(a.store.onChange, null, "local edits no longer queue for a server");
  assert.equal(a.el("account-name").hidden, true, "the account controls are hidden");
  assert.equal(a.el("account-name").textContent, "");
  assert.equal(a.el("account-btn").textContent, "Sign in");
  assert.equal(a.el("books-btn").hidden, true);
  assert.equal(a.el("current-book").hidden, true);
  assert.equal(a.el("sync-status").hidden, true);
});

test("J1.1 · a session arriving later lifts the gate and starts sync", async () => {
  const a = arrive({ session: null });
  await flush();
  assert.equal(a.gated(), true);

  await a.sb.emit(aSession());

  assert.equal(a.gated(), false, "signed in, the app is what you see");
  assert.equal(a.el("account-name").hidden, false);
  assert.equal(a.el("account-name").textContent, "Dave");
  assert.ok(a.cloud().sync, "and sync starts on the way in");
  assert.equal(a.store.onChange !== null && typeof a.store.onChange, "function");
});
