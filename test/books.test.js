/**
 * J7 · Cooking together: books, membership and invites.
 *
 * Driven at the level someone actually works at: open the Books dialog,
 * click Create invite link, follow a #join= link and say no. The two halves
 * under test are js/books.js (the dialog and everything it decides) and the
 * book/member/invite half of js/sync.js, wired here to a fake Supabase that
 * keeps rows and files the way the real one does — so "the person removed
 * keeps nothing" and "the recipes stay with the book" are read off the
 * server's tables rather than off a mock's call log alone.
 *
 * Two things here are security properties rather than conveniences, and are
 * tested as such: following an invite link redeems nothing until it has been
 * accepted (J7.5), and a move that did not reach the server never drops the
 * local copy (J7.11).
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadApp, aRecipe } = require("./helpers/load.js");
const { makeElement } = require("./helpers/dom.js");

const ME = "u-me";
const THEM = "u-them";
const MINE = "11111111-1111-4111-8111-111111111111";
const SHARED = "22222222-2222-4222-8222-222222222222";
const HOURS = 3600000;

// ---------------------------------------------------------------------
// A DOM with the ids index.html gives books.js, and nothing else.
// ---------------------------------------------------------------------

function makeDoc() {
  const byId = new Map();
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, makeElement(id));
    return byId.get(id);
  };
  return {
    el: get,
    body: { classList: makeElement("body").classList },
    querySelector(sel) {
      const m = /^#([\w-]+)$/.exec(sel);
      return m ? get(m[1]) : null;
    },
    querySelectorAll() { return []; },
    getElementById: get,
    createElement: (tag) => makeElement(tag),
    addEventListener() {},
  };
}

/**
 * The event a browser hands a delegated listener: a target whose closest()
 * answers for the data- attributes the rendered control carries.
 */
function control(attrs, extra = {}) {
  const t = {
    dataset: { ...attrs },
    ...extra,
    closest(sel) {
      const m = /^\[data-([\w-]+)\]$/.exec(sel);
      if (!m) return null;
      // A test names the dataset key; a selector names the attribute.
      const camel = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const has = (k) => Object.prototype.hasOwnProperty.call(attrs, k);
      return has(m[1]) || has(camel) ? t : null;
    },
  };
  return t;
}

function swapGlobals(values) {
  const saved = new Map();
  for (const [k, v] of Object.entries(values)) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  return () => {
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
  };
}

// ---------------------------------------------------------------------
// A fake Supabase: real enough rows that state can be asserted on.
// ---------------------------------------------------------------------

function fakeCloud() {
  const db = {
    books: [
      { id: MINE, name: "Dave's recipes", owner: ME },
      { id: SHARED, name: "Household", owner: THEM },
    ],
    profiles: [
      { user_id: ME, display_name: "Dave" },
      { user_id: THEM, display_name: "Sam" },
    ],
    book_members: [],
    invites: [],
    recipes: [],
    // auth.users, only as far as add_agent has to ask about it: whether
    // an id belongs to somebody or to nobody (J16.1).
    anon_users: [],
  };
  const calls = [];
  const failures = new Map(); // "table.op" or "storage.copy" -> Error
  const files = new Map();
  let nextId = 1;

  /*
    PostgREST resolves an embed through a foreign key. book_members has one
    to books, so `books(name, owner)` works — and none to profiles, since
    both point at auth.users instead. Embedding `profiles(...)` from here
    is a request the real server answers with "could not find a
    relationship", so the fake must not answer it either: it used to, and
    that is why an empty member list went unnoticed for as long as it did.
  */
  const embed = (row) => {
    const book = db.books.find((b) => b.id === row.book_id);
    return {
      ...row,
      books: book ? { name: book.name, owner: book.owner } : null,
    };
  };
  const join = (bookId, userId, role) => {
    db.book_members.push(embed({ book_id: bookId, user_id: userId, role }));
  };
  join(MINE, ME, "owner");
  join(SHARED, THEM, "owner");
  join(SHARED, ME, "editor");

  const matches = (row, filters) =>
    filters.every(([col, op, val]) => {
      const cell = row[col];
      if (op === "eq") return cell === val;
      if (op === "gt") return cell > val;
      if (op === "is") return val === null ? cell === null || cell === undefined : cell === val;
      if (op === "in") return [].concat(val).includes(cell);
      return true;
    });

  /*
    The recipes_book_immutable trigger from migration 006. Without it here
    the fake would happily do the thing the database now refuses, and the
    tests would be describing a server that no longer exists.
  */
  function movesBook(table, row, payload) {
    return table === "recipes" && payload.book_id && payload.book_id !== row.book_id;
  }

  const bookIsFixed = () => ({
    data: null,
    error: new Error("a recipe cannot change book: copy it and delete the original"),
  });

  /**
   * The other half of `book_members_role_only` (008 §6c). A `with check`
   * describes the row being written and cannot see the row being
   * replaced, so the policy alone allows agent -> editor; the trigger is
   * what refuses it, in both directions (J16.8).
   */
  function freezesAgent(table, row, payload) {
    if (table !== "book_members" || !payload.role) return false;
    return row.role === "agent" || payload.role === "agent";
  }

  const agentIsNotARole = () => ({
    data: null,
    error: new Error("an agent is not a role you change; remove it and add another"),
  });

  function run(q) {
    calls.push({ table: q.table, op: q.op, filters: q.filters.map((f) => f.join(":")), payload: q.payload });
    // A dropped book that keeps being re-checked, or a replacement that never
    // appears in the book list, would loop for ever. Fail the test instead of
    // hanging the suite.
    if (calls.length > 400) throw new Error("runaway client: the app never stopped asking");
    const failure = failures.get(`${q.table}.${q.op}`);
    if (failure) return { data: null, error: failure };
    const rows = db[q.table] || (db[q.table] = []);
    const hit = rows.filter((r) => matches(r, q.filters));
    let data = hit;

    if (q.op === "insert") {
      const row = { ...q.payload };
      if (q.table === "books") row.id = row.id || `book-${nextId++}`;
      if (q.table === "invites") {
        row.used_count = row.used_count || 0;
        row.created_at = row.created_at || new Date().toISOString();
        // The 48 hours is the column default, set in migration 005.
        row.expires_at = row.expires_at || new Date(Date.now() + 48 * HOURS).toISOString();
      }
      rows.push(q.table === "book_members" ? embed(row) : row);
      data = [row];
    } else if (q.op === "update") {
      for (const row of hit) {
        if (movesBook(q.table, row, q.payload)) return bookIsFixed();
        if (freezesAgent(q.table, row, q.payload)) return agentIsNotARole();
        Object.assign(row, q.payload);
      }
      data = hit.map((r) => ({ ...r }));
    } else if (q.op === "upsert") {
      for (const item of [].concat(q.payload)) {
        const found = rows.find((r) => r.id === item.id);
        if (found && movesBook(q.table, found, item)) return bookIsFixed();
        if (found) Object.assign(found, item);
        else rows.push({ ...item });
      }
      data = [].concat(q.payload);
    } else if (q.op === "delete") {
      db[q.table] = rows.filter((r) => !matches(r, q.filters));
      if (q.table === "books") {
        // The database cascades; a book taken away takes its contents.
        for (const gone of hit) {
          db.book_members = db.book_members.filter((m) => m.book_id !== gone.id);
          db.recipes = db.recipes.filter((r) => r.book_id !== gone.id);
          db.invites = db.invites.filter((i) => i.book_id !== gone.id);
        }
      }
      data = hit;
    }

    if (q.single || q.maybeSingle) return { data: data[0] || null, error: null };
    return { data, error: null };
  }

  function builder(table) {
    const q = { table, op: "select", filters: [], payload: null };
    const api = {
      select(cols) { q.cols = cols; return api; },
      insert(p) { q.op = "insert"; q.payload = p; return api; },
      update(p) { q.op = "update"; q.payload = p; return api; },
      upsert(p) { q.op = "upsert"; q.payload = p; return api; },
      delete() { q.op = "delete"; return api; },
      eq(col, val) { q.filters.push([col, "eq", val]); return api; },
      gt(col, val) { q.filters.push([col, "gt", val]); return api; },
      is(col, val) { q.filters.push([col, "is", val]); return api; },
      in(col, vals) { q.filters.push([col, "in", vals]); return api; },
      order() { return api; },
      single() { q.single = true; return Promise.resolve(run(q)); },
      maybeSingle() { q.maybeSingle = true; return Promise.resolve(run(q)); },
      then(resolve, reject) { return Promise.resolve(run(q)).then(resolve, reject); },
    };
    return api;
  }

  const storageApi = (bucket) => ({
    async copy(from, to) {
      calls.push({ storage: "copy", bucket, from, to });
      const failure = failures.get("storage.copy");
      if (failure) return { data: null, error: failure };
      if (!files.has(from)) return { data: null, error: new Error("object not found") };
      files.set(to, files.get(from));
      return { data: { path: to }, error: null };
    },
    async remove(paths) {
      calls.push({ storage: "remove", bucket, paths });
      const failure = failures.get("storage.remove");
      if (failure) return { data: null, error: failure };
      for (const p of paths) files.delete(p);
      return { data: null, error: null };
    },
    async upload(p, blob) {
      calls.push({ storage: "upload", bucket, path: p });
      files.set(p, blob);
      return { data: { path: p }, error: null };
    },
    async createSignedUrl(p) {
      calls.push({ storage: "sign", bucket, path: p });
      return { data: { signedUrl: `https://files.test/${p}` }, error: null };
    },
  });

  /** The RPCs migrations 005 and 006 define. */
  const rpcs = {
    /**
     * move_recipe: the copy and the tombstone, or neither. Owner of the
     * book it is leaving only — checked here because the real one runs as
     * security definer and so has to check everything itself.
     */
    move_recipe({ recipe_id, target_book, new_id, new_data }) {
      const src = db.recipes.find((r) => r.id === recipe_id && !r.deleted_at);
      if (!src) throw new Error("that recipe is not here to move");
      const from = db.books.find((b) => b.id === src.book_id);
      if (!from || from.owner !== ME) {
        throw new Error("only the owner of a book may move recipes out of it");
      }
      if (src.book_id === target_book) throw new Error("that recipe is already in that book");
      if (!db.book_members.some((m) => m.book_id === target_book && m.user_id === ME)) {
        throw new Error("you are not a member of that book");
      }
      if (db.recipes.some((r) => r.id === new_id)) throw new Error("duplicate key value");
      const now = new Date().toISOString();
      db.recipes.push({
        id: new_id,
        book_id: target_book,
        data: new_data || src.data,
        updated_at: now,
        deleted_at: null,
      });
      src.deleted_at = now;
      src.updated_at = now;
      return new_id;
    },
    preview_invite({ invite_code }) {
      const inv = db.invites.find(
        (i) => i.code === invite_code && new Date(i.expires_at) > new Date()
      );
      if (!inv) throw new Error("invalid or expired invite");
      if (inv.used_count >= inv.max_uses) throw new Error("this invite has already been used");
      const book = db.books.find((b) => b.id === inv.book_id);
      const owner = db.profiles.find((p) => p.user_id === book.owner);
      return [{
        book_name: book.name,
        owner_name: (owner && owner.display_name) || "Someone",
        already_member: db.book_members.some((m) => m.book_id === book.id && m.user_id === ME),
      }];
    },
    redeem_invite({ invite_code }) {
      const inv = db.invites.find(
        (i) => i.code === invite_code && new Date(i.expires_at) > new Date()
      );
      if (!inv) throw new Error("invalid or expired invite");
      const book = db.books.find((b) => b.id === inv.book_id);
      const already = db.book_members.some((m) => m.book_id === book.id && m.user_id === ME);
      if (!already) {
        if (inv.used_count >= inv.max_uses) throw new Error("this invite has already been used");
        join(book.id, ME, "editor");
        inv.used_count += 1;
      }
      return [{ book_id: book.id, book_name: book.name }];
    },
    /**
     * add_agent: the owner of the book, and nobody's account. Both checks
     * are here because the real one is security definer and so has to do
     * its own — and the second is the one migration 008 rests on (J16.1).
     */
    add_agent({ book, agent_id }) {
      const target = db.books.find((b) => b.id === book);
      if (!target || target.owner !== ME) {
        throw new Error("only the owner of a book may add an agent to it");
      }
      if (!db.anon_users.includes(agent_id)) {
        throw new Error("an agent is not a person's account");
      }
      const held = db.book_members.find(
        (m) => m.book_id === book && m.user_id === agent_id
      );
      if (held && held.role !== "agent") {
        throw new Error("that account already belongs to this book");
      }
      if (!held) join(book, agent_id, "agent");
      return null;
    },
    /**
     * discard_orphan_agent: anonymous, and in no book at all. A person
     * fails the first test and an agent in use fails the second, which
     * is the whole of why this is safe to expose.
     */
    discard_orphan_agent({ agent_id }) {
      const anon = db.anon_users.indexOf(agent_id);
      if (anon < 0) return null;
      if (db.book_members.some((m) => m.user_id === agent_id)) return null;
      db.anon_users.splice(anon, 1);
      const profile = db.profiles.findIndex((p) => p.user_id === agent_id);
      if (profile >= 0) db.profiles.splice(profile, 1);
      return null;
    },
  };

  const client = {
    from: builder,
    storage: { from: storageApi },
    async rpc(name, args) {
      calls.push({ rpc: name, args });
      const failure = failures.get(`rpc.${name}`);
      if (failure) return { data: null, error: failure };
      try {
        return { data: rpcs[name](args), error: null };
      } catch (err) {
        return { data: null, error: err };
      }
    },
  };

  /**
   * The second client an agent is minted in (J16.6). The real one signs
   * an anonymous user in; this one records that somebody did, hands back
   * a session shaped like Supabase's, and — the part that matters — puts
   * the new id in `anon_users`, so `add_agent` can tell it from a person.
   */
  let anonCount = 0;
  const captchaTokens = [];
  const makeScratchClient = () => ({
    auth: {
      async signInAnonymously(opts) {
        const failure = failures.get("auth.signInAnonymously");
        if (failure) return { data: null, error: failure };
        anonCount += 1;
        const id = `agent-${anonCount}`;
        db.anon_users.push(id);
        // Recorded because the challenge is worth nothing if the answer
        // never leaves the browser. The client-side guard only stops an
        // honest caller; the token reaching Supabase is what stops the
        // other kind.
        captchaTokens.push(opts && opts.options && opts.options.captchaToken);
        db.profiles.push({
          user_id: id,
          // handle_new_user reads the sign-up metadata, which is what puts
          // an agent in the roster under the name somebody chose.
          display_name: (opts && opts.options && opts.options.data && opts.options.data.name) || "",
        });
        calls.push({ auth: "signInAnonymously" });
        return {
          data: { user: { id }, session: { user: { id }, refresh_token: `refresh-${id}` } },
          error: null,
        };
      },
    },
  });

  return {
    db, client, calls, files,
    join,
    makeScratchClient,
    anonCalls: () => calls.filter((c) => c.auth === "signInAnonymously"),
    captchaTokens,
    fail: (what, err) => failures.set(what, err || new Error("offline")),
    unfail: (what) => failures.delete(what),
    /** Every call to one table, or every storage call of one kind. */
    tableCalls: (table, op) =>
      calls.filter((c) => c.table === table && (!op || c.op === op)),
    storageCalls: (kind) => calls.filter((c) => c.storage === kind),
    rpcCalls: (name) => calls.filter((c) => c.rpc === name),
    invite: (over = {}) => {
      const row = {
        code: over.code || "code-abcdef",
        book_id: over.book_id || MINE,
        created_by: ME,
        max_uses: over.max_uses === undefined ? 1 : over.max_uses,
        used_count: over.used_count || 0,
        created_at: new Date().toISOString(),
        expires_at: over.expires_at || new Date(Date.now() + 48 * HOURS).toISOString(),
      };
      db.invites.push(row);
      return row;
    },
  };
}

// ---------------------------------------------------------------------
// The books dialog, wired to a real store, a real sync and that cloud.
// ---------------------------------------------------------------------

function harness(opts = {}) {
  const win = loadApp("units.js", "scale.js", "storage.js", "sync.js");
  const doc = makeDoc();
  const cloud = fakeCloud();
  const store = new win.RecipeStore();

  const toasts = [];
  const confirms = [];
  let answer = true;
  const clipboard = [];
  const renders = { count: 0 };

  const restore = swapGlobals({
    document: doc,
    window: win,
    CSS: { escape: (s) => s },
    location: { origin: "https://test.local", pathname: "/", hash: "" },
    navigator: { clipboard: { writeText: async (text) => { clipboard.push(text); } } },
    alert() {},
    setTimeout: (fn) => { void fn; return 0; },
    clearTimeout() {},
  });
  win.document = doc;
  // ask.js is a <dialog> the person answers; here it is the answer itself,
  // recorded so the tests can still read what they were asked.
  const RecipeAsk = {
    ask: async (message) => {
      confirms.push(message);
      return typeof answer === "function" ? answer(message) : answer;
    },
  };
  win.RecipeAsk = RecipeAsk;
  globalThis.RecipeAsk = RecipeAsk;

  const statuses = [];
  const api = new win.RecipeApi(cloud.client);
  const sync = new win.RecipeSync(store, api, (s) => statuses.push(s));
  sync.userId = ME;
  sync.displayName = opts.displayName === undefined ? "Dave" : opts.displayName;
  const startBook = opts.book === undefined ? MINE : opts.book;
  sync.setBook(startBook);
  store.useBook(startBook);

  const app = {
    store,
    render: () => { renders.count++; },
    toast: (message) => toasts.push(message),
  };

  // What account.js puts on the shared handle: the throwaway client an
  // agent is signed in with, and the coordinates its credential carries.
  win.RecipeCloud = {
    makeScratchClient: cloud.makeScratchClient,
    coords: { url: "https://test.supabase.co", key: "sb_publishable_test" },
  };

  const src = fs.readFileSync(path.join(__dirname, "..", "js", "books.js"), "utf8");
  new Function("window", src)(win);
  const books = new win.RecipeBooks.BooksUI(sync, api, app);
  books.wire();

  return {
    win, doc, cloud, db: cloud.db, store, sync, api, app, books, toasts, confirms,
    clipboard, statuses, renders, restore,
    el: doc.el,
    setConfirm: (value) => { answer = value; },
    lastToast: () => toasts[toasts.length - 1],
    /** A recipe in the local box, as if just typed in. */
    typed: (over) => store.add(aRecipe(over)),
    /** The same recipe, already on the server. */
    onServer: (recipe, bookId) => {
      cloud.db.recipes.push({
        id: recipe.id,
        book_id: bookId || MINE,
        data: JSON.parse(JSON.stringify(recipe)),
        updated_at: new Date(recipe.updatedAt || Date.now()).toISOString(),
        deleted_at: null,
      });
    },
  };
}

/** The names rendered in the books list, in order. */
function bookNames(html) {
  return [...html.matchAll(/data-book="([^"]+)"[^>]*>\s*([^<]*?)\s*</g)].map((m) => m[2]);
}

/** Let every settled promise in flight run to completion. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------
// J7.1–J7.3 · having books at all
// ---------------------------------------------------------------------

test("J7.1 · everyone's first book is named after them", async () => {
  const h = harness();
  h.db.books = [];
  h.db.book_members = [];

  const bookId = await h.sync.resolveBook(ME, null, "Dave Ernsting");

  assert.deepEqual(
    h.db.books.map((b) => [b.name, b.owner]),
    [["Dave Ernsting's recipes", ME]]
  );
  assert.equal(bookId, h.db.books[0].id);
  assert.deepEqual(
    h.db.book_members.map((m) => [m.book_id, m.user_id, m.role]),
    [[bookId, ME, "owner"]],
    "and they are in it"
  );
});

test("J7.1 · someone with no name at all still gets a book", async () => {
  const h = harness();
  assert.equal(h.win.RecipeApi.ownBookName(""), "Recipes");
  assert.equal(h.win.RecipeApi.ownBookName("  Dave  "), "Dave's recipes");
});

test("J7.1 · that first book can be shared as it is, with no personal tier to leave", async () => {
  const h = harness();
  h.db.books = [];
  h.db.book_members = [];
  const bookId = await h.sync.resolveBook(ME, null, "Dave");
  h.sync.setBook(bookId);

  await h.books.refresh();
  assert.equal(h.el("invite-btn").hidden, false, "the very first book can be invited into");

  await h.el("invite-btn").fire("click");
  assert.deepEqual(h.db.invites.map((i) => i.book_id), [bookId]);
});

test("J7.2 · anyone can create more books", async () => {
  const h = harness();
  await h.books.refresh();

  h.el("new-book-name").value = "  Camping  ";
  await h.el("create-book-btn").fire("click");

  assert.ok(h.db.books.some((b) => b.name === "Camping" && b.owner === ME));
  const created = h.db.books.find((b) => b.name === "Camping");
  assert.equal(h.sync.bookId, created.id, "and you are put into the book you just made");
  assert.equal(h.el("new-book-name").value, "", "the box is cleared for the next one");
  assert.equal(h.lastToast(), "Created “Camping”.");
  assert.ok(bookNames(h.el("book-list").innerHTML).includes("Camping"));
});

test("J7.2 · a book with no name is not created", async () => {
  const h = harness();
  await h.books.refresh();
  h.el("new-book-name").value = "   ";
  await h.el("create-book-btn").fire("click");
  assert.equal(h.cloud.tableCalls("books", "insert").length, 0);
});

test("J7.2 · books are switched from the header", async () => {
  const h = harness();
  h.typed({ name: "Only in mine" });
  await h.books.refresh();

  assert.equal(h.el("books-btn").hidden, false);
  assert.equal(h.el("current-book").hidden, false);
  assert.equal(h.el("current-book").textContent, "Dave's recipes");

  await h.el("books-btn").fire("click");
  assert.equal(h.el("books-dialog").open, true, "the dialog opens on the button");
  assert.deepEqual(
    bookNames(h.el("book-list").innerHTML),
    ["Dave&#39;s recipes", "Household"],
    "every book you are in is there to switch to, yours and other people's"
  );
  assert.match(h.el("book-list").innerHTML, /book-role">shared/, "and says which is which");
  assert.match(h.el("book-list").innerHTML, /book-role">yours/);

  await h.el("book-list").fire("click", { target: control({ book: SHARED }) });
  await flush();

  assert.equal(h.sync.bookId, SHARED);
  assert.equal(h.el("current-book").textContent, "Household");
  assert.deepEqual(h.store.recipes, [], "J9.7 · the other book's cache is its own");

  await h.books.switchTo(MINE);
  assert.deepEqual(h.store.recipes.map((r) => r.name), ["Only in mine"], "and comes back intact");
});

test("J7.2 · the book you were last in is remembered, per person", async () => {
  const h = harness();
  const { rememberSelection, rememberedSelection } = h.win.RecipeBooks;

  assert.equal(rememberedSelection(ME), null, "nothing remembered to begin with");
  await h.books.switchTo(SHARED);
  assert.equal(rememberedSelection(ME), SHARED, "switching books is remembered");

  rememberSelection(THEM, MINE);
  assert.equal(rememberedSelection(ME), SHARED, "and one person's choice is not another's");
  assert.equal(rememberedSelection(THEM), MINE);
});

test("J7.2 · remembering is a convenience: storage that refuses does not break switching", async () => {
  const h = harness();
  h.win.localStorage.setItem = () => { throw new Error("quota"); };
  h.win.localStorage.getItem = () => { throw new Error("blocked"); };

  assert.equal(h.win.RecipeBooks.rememberedSelection(ME), null);
  await h.books.switchTo(SHARED);
  assert.equal(h.sync.bookId, SHARED);
});

test("J7.3 · everyone in a book can add, edit and delete its recipes", async () => {
  const h = harness({ book: SHARED });
  await h.books.refresh();

  // Being a member rather than the owner takes nothing away from the recipes.
  const saved = h.store.add(aRecipe({ name: "Their book, my recipe" }));
  assert.ok(saved, "a member can add");
  assert.ok(h.store.update(saved.id, { ...saved, name: "Edited" }), "and edit");
  const push = h.sync.merge([]).toPush;
  assert.deepEqual(push.map((p) => [p.book_id, p.data.name]), [[SHARED, "Edited"]]);

  assert.equal(h.store.remove(saved.id), true, "and delete");
  const after = h.sync.merge([]);
  assert.equal(after.tombstones.length, 1);
  assert.equal(after.toPush[0].book_id, SHARED, "the delete travels to the book's other members");
});

// ---------------------------------------------------------------------
// J7.4 · invites: one person, 48 hours, revocable
// ---------------------------------------------------------------------

test("J7.4 · an invite link is good for one person", async () => {
  const h = harness();
  await h.books.refresh();

  await h.el("invite-btn").fire("click");

  assert.equal(h.db.invites.length, 1);
  assert.equal(h.db.invites[0].max_uses, 1, "one use, not many");
  assert.equal(h.db.invites[0].used_count, 0);
  assert.equal(h.db.invites[0].created_by, ME);
  assert.match(h.db.invites[0].code, /^[A-Za-z0-9_-]{16}$/, "and the code is url-safe");
  assert.match(h.lastToast(), /one person/, "and it says so");
});

test("J7.4 · an invite expires after 48 hours, and only live ones are listed", async () => {
  const h = harness();
  h.cloud.invite({ code: "live-one" });
  h.cloud.invite({ code: "gone-one", expires_at: new Date(Date.now() - HOURS).toISOString() });

  const live = await h.api.listInvites(MINE);

  assert.deepEqual(live.map((i) => i.code), ["live-one"], "an expired link is not offered");
  await h.books.refresh();
  assert.match(h.el("invite-list").innerHTML, /2 days left/);
  assert.doesNotMatch(h.el("invite-list").innerHTML, /gone-one/);
});

test("J7.4 · the invite the app hands out says how long it is good for", async () => {
  const h = harness();
  await h.books.refresh();
  await h.el("invite-btn").fire("click");

  const code = h.db.invites[0].code;
  assert.equal(h.el("invite-out").hidden, false);
  assert.equal(h.el("invite-out").textContent, `https://test.local/#join=${code}`);
  assert.deepEqual(h.clipboard, [`https://test.local/#join=${code}`], "and is on the clipboard");
  assert.match(h.lastToast(), /48 hours/);
});

test("J7.4 · the code in the link survives being a link", async () => {
  const h = harness();
  // Bytes whose base64 is "+/++" repeated — the two characters that would
  // not come back out of a URL fragment the same way they went in.
  h.win.crypto = { getRandomValues: (bytes) => { for (let i = 0; i < bytes.length; i += 3) bytes.set([0xfb, 0xff, 0xbe], i); } };

  const code = await h.api.createInvite(MINE);

  assert.equal(code, "-_---_---_---_--", "url-safe, and no padding to be stripped in transit");
  assert.equal(h.db.invites[0].code, code, "the server is told the same code the link carries");
});

test("J7.4 · a browser with no secure randomness is refused an invite rather than given a guessable one", async () => {
  const h = harness();
  h.win.crypto = { };
  await assert.rejects(() => h.api.createInvite(MINE), /secure invite code/);
  assert.equal(h.db.invites.length, 0);
});

test("J7.4 · the owner can see the live ones", async () => {
  const h = harness();
  h.cloud.invite({ code: "aaaaaa-111111" });
  h.cloud.invite({ code: "bbbbbb-222222", expires_at: new Date(Date.now() + 3 * HOURS).toISOString() });

  await h.books.refresh();
  const html = h.el("invite-list").innerHTML;

  assert.match(html, /111111/, "each live link is shown by its tail");
  assert.match(html, /222222/);
  assert.match(html, /1 of 1 use left · 2 days left/);
  assert.match(html, /3 hours left/);
  assert.equal(h.el("invite-empty").hidden, true);
});

test("J7.4 · an owner with no live links is told so rather than shown an empty space", async () => {
  const h = harness();
  await h.books.refresh();
  assert.equal(h.el("invite-list").innerHTML, "");
  assert.equal(h.el("invite-empty").hidden, false);
});

test("J7.4 · an invite that has been spent says so", async () => {
  const h = harness();
  h.cloud.invite({ code: "spent-333333", used_count: 1 });
  await h.books.refresh();
  assert.match(h.el("invite-list").innerHTML, /used up/);
});

test("J7.4 · the owner can revoke a link that went astray", async () => {
  const h = harness();
  const inv = h.cloud.invite({ code: "astray-444444" });
  await h.books.refresh();
  h.el("invite-out").textContent = `https://test.local/#join=${inv.code}`;
  h.el("invite-out").hidden = false;
  h.setConfirm(true);

  await h.el("invite-list").fire("click", { target: control({ revoke: inv.code }) });

  assert.deepEqual(h.db.invites, [], "the link is gone from the server");
  assert.match(h.confirms[0], /Revoke this invite link/);
  assert.equal(h.lastToast(), "Invite revoked.");
  assert.equal(h.el("invite-out").hidden, true, "and the link on screen goes with it");
  assert.equal(h.el("invite-list").innerHTML, "");
});

test("J7.4 · a revoke that was not confirmed tears up nothing", async () => {
  const h = harness();
  const inv = h.cloud.invite({ code: "kept-555555" });
  await h.books.refresh();
  h.setConfirm(false);

  await h.el("invite-list").fire("click", { target: control({ revoke: inv.code }) });

  assert.equal(h.db.invites.length, 1, "the link still works");
  assert.equal(h.cloud.tableCalls("invites", "delete").length, 0);
});

test("J7.4 · invites belong to the owner: a member is not shown any", async () => {
  const h = harness({ book: SHARED });
  h.cloud.invite({ code: "not-yours-666666", book_id: SHARED });

  await h.books.refresh();

  assert.equal(h.cloud.tableCalls("invites").length, 0, "a member never asks for them");
  assert.equal(h.el("invite-list").innerHTML, "");
  assert.equal(h.el("invite-empty").hidden, true);
  assert.equal(h.el("invite-btn").hidden, true, "and cannot mint one");
});

// ---------------------------------------------------------------------
// J7.5 · an invite is an offer, not a membership
// ---------------------------------------------------------------------

const STRANGERS = "33333333-3333-4333-8333-333333333333";

/** A book of Sam's that I am not in, with a live invite to it. */
function invited(h, code = "invite-me") {
  h.db.books.push({ id: STRANGERS, name: "Sam's kitchen", owner: THEM });
  h.cloud.join(STRANGERS, THEM, "owner");
  return h.cloud.invite({ code, book_id: STRANGERS }).code;
}

test("J7.5 · opening an invite never joins anyone by itself", async () => {
  const h = harness();
  const code = invited(h);
  h.setConfirm(false);

  const joined = await h.books.join(code);

  assert.equal(joined, false);
  assert.equal(h.cloud.rpcCalls("preview_invite").length, 1, "it looks the invite up");
  assert.equal(h.cloud.rpcCalls("redeem_invite").length, 0, "and redeems nothing");
  assert.equal(
    h.db.book_members.some((m) => m.book_id === STRANGERS && m.user_id === ME),
    false,
    "no membership is created"
  );
  assert.equal(h.db.invites[0].used_count, 0, "and the link is not spent");
  assert.equal(h.sync.bookId, MINE, "you are left where you were");
  assert.equal(h.lastToast(), "Invite declined — nothing was joined.");
});

test("J7.5 · the invite names the book and its owner, and what everyone in it can do", async () => {
  const h = harness();
  const code = invited(h);
  h.setConfirm(false);

  await h.books.join(code);

  const asked = h.confirms[0];
  assert.match(asked, /Sam's kitchen/, "which book");
  assert.match(asked, /Sam is sharing this recipe book with you/, "and whose");
  assert.match(asked, /everyone in the book — including you — can add, edit and delete its recipes/);
  assert.match(asked, /switch to this book/i, "and what it changes about saving");
});

test("J7.5 · membership is agreed to, and only then joined", async () => {
  const h = harness();
  const code = invited(h);
  h.setConfirm(true);

  const joined = await h.books.join(code);

  assert.equal(joined, true);
  assert.equal(h.cloud.rpcCalls("redeem_invite").length, 1);
  assert.ok(h.db.book_members.some((m) => m.book_id === STRANGERS && m.user_id === ME));
  assert.equal(h.db.invites[0].used_count, 1, "the one use is spent");
  assert.equal(h.sync.bookId, STRANGERS, "and you are reading it");
  assert.equal(h.lastToast(), "Joined “Sam's kitchen”.");
});

test("J7.5 · an invite that cannot be read joins nothing and says so", async () => {
  const h = harness();
  invited(h);
  h.cloud.fail("rpc.preview_invite", new Error("invalid or expired invite"));

  const joined = await h.books.join("invite-me");

  assert.equal(joined, false);
  assert.deepEqual(h.confirms, [], "nobody is asked to agree to an invite that isn't there");
  assert.equal(h.cloud.rpcCalls("redeem_invite").length, 0);
  assert.equal(h.lastToast(), "That invite link is invalid, used up, or has expired.");
});

test("J7.5 · an invite accepted but refused by the server joins nothing and says so", async () => {
  const h = harness();
  const code = invited(h);
  h.setConfirm(true);
  h.cloud.fail("rpc.redeem_invite", new Error("this invite has already been used"));

  const joined = await h.books.join(code);

  assert.equal(joined, false);
  assert.equal(h.sync.bookId, MINE, "you stay in the book you were in");
  assert.equal(
    h.db.book_members.some((m) => m.book_id === STRANGERS && m.user_id === ME),
    false
  );
  assert.equal(h.lastToast(), "That invite link is invalid, used up, or has expired.");
});

test("J7.5 · a link to a book you are already in offers a switch, and declining redeems nothing", async () => {
  const h = harness();
  const code = h.cloud.invite({ code: "already-in", book_id: SHARED }).code;
  h.setConfirm(false);

  const joined = await h.books.join(code);

  assert.match(h.confirms[0], /already in “Household”/);
  assert.equal(joined, false);
  assert.equal(h.cloud.rpcCalls("redeem_invite").length, 0, "declining spends nothing");
  assert.equal(h.db.invites[0].used_count, 0);
  assert.equal(h.sync.bookId, MINE);
});

test("J7.5 · a link to a book you are already in costs no use when you accept it", async () => {
  const h = harness();
  const code = h.cloud.invite({ code: "already-in", book_id: SHARED }).code;
  h.setConfirm(true);

  const joined = await h.books.join(code);

  assert.equal(joined, true);
  assert.equal(h.sync.bookId, SHARED);
  assert.equal(h.db.invites[0].used_count, 0, "an existing member does not spend the link");
  assert.equal(
    h.db.book_members.filter((m) => m.book_id === SHARED && m.user_id === ME).length,
    1,
    "and is not added twice"
  );
});

// ---------------------------------------------------------------------
// J7.6, J7.7 · leaving, and who may
// ---------------------------------------------------------------------

test("J7.6 · a member can leave a book, and its recipes stay with the book", async () => {
  const h = harness({ book: SHARED });
  const theirs = { ...aRecipe({ name: "Sam's stew" }), id: "44444444-4444-4444-8444-444444444444" };
  h.onServer(theirs, SHARED);
  await h.books.refresh();
  assert.equal(h.el("leave-book-btn").hidden, false, "a member is offered the way out");
  h.setConfirm(true);

  await h.el("leave-book-btn").fire("click");

  assert.match(h.confirms[0], /Leave “Household”\? Its recipes stay with the book\./);
  assert.equal(
    h.db.book_members.some((m) => m.book_id === SHARED && m.user_id === ME),
    false,
    "the membership is given up"
  );
  assert.ok(
    h.db.book_members.some((m) => m.book_id === SHARED && m.user_id === THEM),
    "and nobody else's is touched"
  );
  assert.deepEqual(
    h.db.recipes.map((r) => [r.book_id, r.data.name]),
    [[SHARED, "Sam's stew"]],
    "the recipes stay with the book"
  );
  assert.equal(h.sync.bookId, MINE, "and you are moved to a book you still have");
  assert.equal(h.lastToast(), "Left “Household”.");
});

test("J7.6 · leaving a book leaves nothing of it on the device", async () => {
  const h = harness({ book: SHARED });
  const cacheKey = `recipe-friend:v1:book:${SHARED}`;
  h.typed({ name: "Sam's stew" }); // cached locally, as any synced recipe is
  assert.ok(h.win.localStorage.getItem(cacheKey), "the book's recipes are on this device");
  // The plan is the book's too (J12.2), and the app carries it away on
  // the same gesture the recipes go on.
  const forgotten = [];
  h.store.onForgetBook = (id) => forgotten.push(id);
  await h.books.refresh();
  h.setConfirm(true);

  await h.el("leave-book-btn").fire("click");

  assert.equal(h.win.localStorage.getItem(cacheKey), null,
    "a book you walked out of does not go on sitting in local storage");
  assert.deepEqual(forgotten, [SHARED], "and its plan goes with it");
  assert.deepEqual(h.store.recipes.map((r) => r.name), [],
    "the box on screen is the book you are in now, not the one you left");
});

test("J7.6 · a book you decided to stay in is not left", async () => {
  const h = harness({ book: SHARED });
  await h.books.refresh();
  h.setConfirm(false);

  await h.el("leave-book-btn").fire("click");

  assert.equal(h.cloud.tableCalls("book_members", "delete").length, 0);
  assert.equal(h.sync.bookId, SHARED);
});

test("J7.6 · leaving a book is not mistaken for the book vanishing", async () => {
  const h = harness({ book: SHARED });
  await h.books.refresh();
  h.setConfirm(true);

  await h.el("leave-book-btn").fire("click");

  assert.deepEqual(h.toasts, ["Left “Household”."], "no “isn't available to you” on top of it");
});

test("J7.7 · an owner cannot leave a book", async () => {
  const h = harness();
  await h.books.refresh();

  assert.equal(h.el("leave-book-btn").hidden, true, "the way out is not offered");

  await h.el("leave-book-btn").fire("click");
  assert.deepEqual(h.confirms, [], "and pressing it anyway does nothing");
  assert.equal(h.cloud.tableCalls("book_members", "delete").length, 0);
  assert.ok(h.db.book_members.some((m) => m.book_id === MINE && m.user_id === ME));
});

test("J7.7 · ownership comes from the book's owner, not the membership row's role", async () => {
  const h = harness({ book: SHARED });
  // A membership row claiming ownership of somebody else's book.
  h.db.book_members.find((m) => m.book_id === SHARED && m.user_id === ME).role = "owner";

  await h.books.refresh();

  assert.equal(h.el("invite-btn").hidden, true, "a forged role mints no invites");
  assert.equal(h.el("delete-book-btn").hidden, true, "and deletes nothing");
  assert.equal(h.el("leave-book-btn").hidden, false, "it is still somebody else's book");
  assert.doesNotMatch(h.el("member-list").innerHTML, /data-remove/, "and removes nobody");
  assert.equal(h.cloud.tableCalls("invites").length, 0);
});

test("J7.7 · and a modest-looking membership row does not hide your own book from you", async () => {
  const h = harness();
  h.db.book_members.find((m) => m.book_id === MINE && m.user_id === ME).role = "editor";
  h.cloud.join(MINE, THEM, "editor");

  await h.books.refresh();

  assert.equal(h.el("invite-btn").hidden, false);
  assert.equal(h.el("delete-book-btn").hidden, false);
  assert.equal(h.el("leave-book-btn").hidden, true);
  assert.match(h.el("member-list").innerHTML, /data-remove="u-them"/);
});

// ---------------------------------------------------------------------
// J7.8, J7.9 · deleting a book
// ---------------------------------------------------------------------

/** Put n live recipes (and one already deleted) in a book on the server. */
function seedRecipes(h, bookId, n) {
  for (let i = 0; i < n; i++) {
    h.db.recipes.push({
      id: `recipe-${bookId}-${i}`,
      book_id: bookId,
      data: aRecipe({ name: `Recipe ${i}` }),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    });
  }
}

test("J7.8 · deleting a book states how many recipes and how many other people it takes with it", async () => {
  const h = harness();
  h.cloud.join(MINE, THEM, "editor");
  h.cloud.join(MINE, "u-third", "editor");
  seedRecipes(h, MINE, 3);
  seedRecipes(h, SHARED, 4); // another book's recipes are none of this count's business
  await h.books.refresh();
  h.setConfirm(false);

  await h.el("delete-book-btn").fire("click");

  const asked = h.confirms[0];
  assert.match(asked, /Delete “Dave's recipes” for good\?/);
  assert.match(asked, /Its 3 recipes will be deleted\./);
  assert.match(asked, /2 other members will lose it too\./);
});

test("J7.8 · one recipe and one other person are counted as one", async () => {
  const h = harness();
  h.cloud.join(MINE, THEM, "editor");
  seedRecipes(h, MINE, 1);
  await h.books.refresh();
  h.setConfirm(false);

  await h.el("delete-book-btn").fire("click");

  assert.match(h.confirms[0], /Its 1 recipe will be deleted\./);
  assert.match(h.confirms[0], /1 other member will lose it too\./);
});

test("J7.8 · a book nobody else is in does not claim anyone will lose it", async () => {
  const h = harness();
  seedRecipes(h, MINE, 2);
  await h.books.refresh();
  h.setConfirm(false);

  await h.el("delete-book-btn").fire("click");

  assert.doesNotMatch(h.confirms[0], /lose it too/);
});

test("J7.8 · a recipe count the server will not give is not invented", async () => {
  const h = harness();
  await h.books.refresh();
  h.cloud.fail("recipes.select");
  h.setConfirm(false);

  await h.el("delete-book-btn").fire("click");

  assert.match(h.confirms[0], /Its recipes will be deleted\./, "no number rather than a wrong one");
  assert.doesNotMatch(h.confirms[0], /\d+ recipe/);
});

test("J7.8 · the confirmation points at Export, and says an export carries recipes and not photos", async () => {
  const h = harness();
  seedRecipes(h, MINE, 1);
  await h.books.refresh();
  h.setConfirm(false);

  await h.el("delete-book-btn").fire("click");

  assert.match(h.confirms[0], /export first if you want a copy/i);
  assert.match(h.confirms[0], /An export carries recipes, not photos\./);
});

test("J7.8 · deleting a book destroys its recipes for every member", async () => {
  const h = harness();
  h.cloud.join(MINE, THEM, "editor");
  seedRecipes(h, MINE, 2);
  seedRecipes(h, SHARED, 1);
  h.typed({ name: "Cached locally" });
  const cacheKey = `recipe-friend:v1:book:${MINE}`;
  assert.ok(h.win.localStorage.getItem(cacheKey), "the book has a local cache to begin with");
  await h.books.refresh();
  h.setConfirm(true);

  await h.el("delete-book-btn").fire("click");

  assert.equal(h.db.books.some((b) => b.id === MINE), false);
  assert.deepEqual(h.db.recipes.map((r) => r.book_id), [SHARED], "its recipes go with it");
  assert.equal(h.db.book_members.some((m) => m.book_id === MINE), false, "for everyone in it");
  assert.equal(h.win.localStorage.getItem(cacheKey), null, "and the local copy is dropped");
  assert.equal(h.sync.bookId, SHARED, "you are moved to a book you still have");
  assert.equal(h.lastToast(), "Deleted “Dave's recipes”.");
});

test("J7.8 · a delete that was not confirmed destroys nothing", async () => {
  const h = harness();
  seedRecipes(h, MINE, 2);
  await h.books.refresh();
  h.setConfirm(false);

  await h.el("delete-book-btn").fire("click");

  assert.ok(h.db.books.some((b) => b.id === MINE));
  assert.equal(h.cloud.tableCalls("books", "delete").length, 0);
  assert.equal(h.sync.bookId, MINE);
});

test("J7.8 · the recipe count is of this book's live recipes, not ones already deleted", async () => {
  const h = harness();
  seedRecipes(h, MINE, 2);
  seedRecipes(h, SHARED, 5);
  h.db.recipes.push({
    id: "tombstoned", book_id: MINE, data: aRecipe(),
    updated_at: new Date().toISOString(), deleted_at: new Date().toISOString(),
  });

  assert.equal(await h.api.countRecipes(MINE), 2);
});

test("J7.9 · nobody can delete their last remaining book", async () => {
  const h = harness();
  h.db.book_members = h.db.book_members.filter((m) => m.book_id === MINE);
  await h.books.refresh();

  assert.equal(h.el("delete-book-btn").hidden, true, "the button is not there");

  await h.el("delete-book-btn").fire("click");

  assert.equal(h.lastToast(), "This is your only book — create another one first.");
  assert.deepEqual(h.confirms, [], "and it never gets as far as asking");
  assert.equal(h.cloud.tableCalls("books", "delete").length, 0);
  assert.ok(h.db.books.some((b) => b.id === MINE));
});

test("J7.9 · a book someone else owns does not count as a way to delete your last one", async () => {
  const h = harness({ book: SHARED });
  await h.books.refresh();
  assert.equal(h.el("delete-book-btn").hidden, true, "you cannot delete a book you do not own");

  await h.el("delete-book-btn").fire("click");
  assert.equal(h.cloud.tableCalls("books", "delete").length, 0);
});

// ---------------------------------------------------------------------
// J7.10, J7.11 · moving a recipe between books
// ---------------------------------------------------------------------

/** A recipe in the local box with a photo in the current book's storage. */
function withPhoto(h, name = "Photographed") {
  const added = h.typed({ name });
  const path = `${MINE}/${added.id}.jpg`;
  h.store.update(added.id, { ...added, imagePath: path });
  const recipe = h.store.getById(added.id);
  assert.equal(recipe.imagePath, path, "the local recipe really does carry a photo path");
  h.cloud.files.set(path, "jpeg-bytes");
  return recipe;
}

/** Drive the transfer dialog the way the recipe screen does. */
async function transferThrough(h, recipeId, targetBookId, verb) {
  h.books.openMove(recipeId, verb);
  await h.el("move-list").fire("click", { target: control({ target: targetBookId }) });
}

const moveThrough = (h, recipeId, targetBookId) =>
  transferThrough(h, recipeId, targetBookId, "move");
const copyThrough = (h, recipeId, targetBookId) =>
  transferThrough(h, recipeId, targetBookId, "copy");

test("J7.10 · a recipe can be moved to another book you belong to", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = h.typed({ name: "Travels well" });
  h.onServer(recipe, MINE);

  h.books.openMove(recipe.id);

  assert.equal(h.el("move-dialog").open, true);
  assert.match(h.el("move-list").innerHTML, /data-target="22222222-2222-4222-8222-222222222222"/);
  assert.doesNotMatch(h.el("move-list").innerHTML, /data-target="11111111/, "not the book it is in");
  assert.match(h.el("move-list").innerHTML, /Household/);
});

test("J7.10 · with nowhere to move it to, the app says so rather than opening an empty list", async () => {
  const h = harness();
  h.db.book_members = h.db.book_members.filter((m) => m.book_id === MINE);
  await h.books.refresh();
  const recipe = h.typed({ name: "Nowhere to go" });

  h.books.openMove(recipe.id, "move");
  assert.equal(h.el("move-dialog").open, false);
  assert.equal(h.lastToast(), "Create another book first, then you can move recipes into it.");

  h.books.openMove(recipe.id, "copy");
  assert.equal(h.el("move-dialog").open, false);
  assert.equal(h.lastToast(), "Create another book first, then you can copy recipes into it.");
});

test("J7.10 · a moved recipe arrives under an id the new book can hold", async () => {
  const h = harness();
  const recipe = h.typed({ name: "Same recipe, new book" });
  h.onServer(recipe, MINE);

  const { newId } = await h.sync.moveRecipe(recipe.id, SHARED);

  assert.notEqual(newId, recipe.id,
    "an id belongs to the book its recipe was created in, for life (006)");
  assert.deepEqual(
    h.db.recipes.map((r) => [r.book_id, r.data.name, Boolean(r.deleted_at)]),
    [
      [MINE, "Same recipe, new book", true],
      [SHARED, "Same recipe, new book", false],
    ],
    "a copy in the new book, and a tombstone left behind in the old one"
  );
});

test("J7.10 · its photo moves with it, so the new book's members can see it", async () => {
  const h = harness();
  const recipe = withPhoto(h);
  h.onServer(recipe, MINE);
  const oldPath = `${MINE}/${recipe.id}.jpg`;

  const { newId } = await h.sync.moveRecipe(recipe.id, SHARED);
  const newPath = `${SHARED}/${newId}.jpg`;

  assert.equal(h.cloud.files.get(newPath), "jpeg-bytes", "the file is in the new book");
  assert.equal(h.cloud.files.has(oldPath), false, "and no longer in the old one");
  assert.equal(
    h.db.recipes.find((r) => r.id === newId).data.imagePath,
    newPath,
    "and the recipe points at it without waiting for another push"
  );
});

test("J7.10 · the book it left gets a tombstone, so nobody's cache pushes it back", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = h.typed({ name: "Off it goes" });
  h.onServer(recipe, MINE);

  await moveThrough(h, recipe.id, SHARED);

  assert.equal(h.store.getById(recipe.id), null, "gone from the book it left");
  assert.deepEqual(
    h.store.tombstones.map((t) => t.id),
    [recipe.id],
    "and marked deleted there — the id is finished, because the copy carries its own"
  );
  assert.equal(h.el("move-dialog").open, false);
  assert.equal(h.lastToast(), "Moved to “Household”.");
});

test("J7.10 · moving asks first, and names what goes where", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = h.typed({ name: "Off it goes" });
  h.onServer(recipe, MINE);
  h.setConfirm(false);

  await moveThrough(h, recipe.id, SHARED);

  assert.match(h.confirms[0], /Off it goes/);
  assert.match(h.confirms[0], /Household/);
  assert.match(h.confirms[0], /leaves this book/);
  assert.ok(h.store.getById(recipe.id), "answering no leaves it exactly where it was");
  assert.deepEqual(h.db.recipes.filter((r) => r.book_id === SHARED), []);
});

test("J7.10 · an old photo that could not be tidied away does not undo the move", async () => {
  const h = harness();
  const recipe = withPhoto(h);
  h.onServer(recipe, MINE);
  h.cloud.fail("storage.remove");

  const { newId } = await h.sync.moveRecipe(recipe.id, SHARED);

  assert.ok(
    h.db.recipes.some((r) => r.id === newId && r.book_id === SHARED && !r.deleted_at),
    "the move stands"
  );
});

test("J7.11 · a move that doesn't reach the server leaves the recipe exactly where it was and says so", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = h.typed({ name: "Typed seconds ago" });
  const before = JSON.parse(JSON.stringify(h.store.getById(recipe.id)));
  // Never pushed: the server has no row to move.
  assert.deepEqual(h.db.recipes, []);

  await moveThrough(h, recipe.id, SHARED);

  assert.deepEqual(h.store.getById(recipe.id), before, "the recipe is exactly where it was");
  assert.deepEqual(h.store.tombstones, [], "and is not deleted on the strength of a move");
  assert.equal(h.lastToast(), "Couldn't move that recipe.");
  assert.deepEqual(h.db.recipes, [], "nothing landed in the other book either");
});

test("J7.11 · a recipe the server has not seen yet is pushed up before it is moved", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = h.typed({ name: "Still in the debounce" });
  h.sync.pending = true; // waiting inside the push debounce

  await moveThrough(h, recipe.id, SHARED);

  assert.deepEqual(
    h.db.recipes.map((r) => [r.book_id, Boolean(r.deleted_at)]),
    [[MINE, true], [SHARED, false]],
    "it went up, then moved"
  );
  assert.equal(h.store.getById(recipe.id), null);
  assert.equal(h.lastToast(), "Moved to “Household”.");
});

test("J7.11 · when that push cannot happen, the recipe stays where it was", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = h.typed({ name: "Offline and unmoved" });
  const before = JSON.parse(JSON.stringify(h.store.getById(recipe.id)));
  h.sync.pending = true;
  h.cloud.fail("recipes.select"); // the sync inside the move fails

  await moveThrough(h, recipe.id, SHARED);

  assert.deepEqual(h.store.getById(recipe.id), before);
  assert.deepEqual(h.store.tombstones, []);
  assert.equal(h.lastToast(), "Couldn't move that recipe.");
});

test("J7.11 · a photo is never copied on the strength of a row the server has not got", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = withPhoto(h, "Photo, no row");

  await moveThrough(h, recipe.id, SHARED);

  assert.equal(h.cloud.storageCalls("copy").length, 0, "no file is touched");
  assert.ok(h.store.getById(recipe.id), "and the only copy of the recipe is still here");
  assert.equal(h.lastToast(), "Couldn't move that recipe.");
});

test("J7.11 · a photo that could not be copied across leaves the recipe where it was", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = withPhoto(h, "Photo won't copy");
  h.onServer(recipe, MINE);
  const oldPath = `${MINE}/${recipe.id}.jpg`;
  h.cloud.fail("storage.copy");

  await moveThrough(h, recipe.id, SHARED);

  assert.equal(h.db.recipes[0].book_id, MINE, "the row did not move");
  assert.equal(h.db.recipes[0].data.imagePath, oldPath, "and still points at its photo");
  assert.equal(h.cloud.files.get(oldPath), "jpeg-bytes", "which is still there");
  assert.equal(h.cloud.storageCalls("remove").length, 0, "nothing was deleted on the way");
  assert.ok(h.store.getById(recipe.id), "and the local copy is kept");
  assert.equal(h.lastToast(), "Couldn't move that recipe.");
});

test("J7.11 · a move the server rejects outright keeps the recipe too", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = h.typed({ name: "Refused" });
  h.onServer(recipe, MINE);
  h.cloud.fail("rpc.move_recipe", new Error("only the owner of a book may move recipes out of it"));

  await moveThrough(h, recipe.id, SHARED);

  assert.ok(h.store.getById(recipe.id));
  assert.deepEqual(h.store.tombstones, [], "and it is not tombstoned on the strength of a refusal");
  assert.equal(h.db.recipes[0].book_id, MINE);
  assert.equal(h.lastToast(), "Couldn't move that recipe.");
});

test("J7.11 · a move the server cannot match is refused rather than assumed", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = h.typed({ name: "Gone from the server" });
  // The row is not in this book any more, so the update matches nothing.
  await assert.rejects(
    () => h.sync.moveRecipe(recipe.id, SHARED),
    /hasn't reached the server yet/
  );
  assert.ok(h.store.getById(recipe.id));
});

test("J7.10 · a push cannot drag a recipe into another book", async () => {
  const h = harness();
  // The same id, held locally here and living on the server over there —
  // which is what a share link saved under the sender's id used to make.
  const recipe = h.typed({ name: "Stays put" });
  h.onServer(recipe, SHARED);

  await h.sync.syncNow();

  assert.deepEqual(
    h.db.recipes.map((r) => r.book_id),
    [SHARED],
    "the row stays in the book it was created in (006), rather than being rewritten"
  );
  assert.equal(h.statuses[h.statuses.length - 1], "error",
    "and the push says so instead of appearing to work");
});

// ---------------------------------------------------------------------
// J7.16 · copying a recipe into a book of your own
//
// Copy is the verb for everyone: it takes nothing from anybody, which is
// what makes it the way out of a book you only read.
// ---------------------------------------------------------------------

test("J7.16 · a copy lands in the other book and leaves this one alone", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = h.typed({ name: "Worth keeping" });
  h.onServer(recipe, MINE);

  await copyThrough(h, recipe.id, SHARED);

  const copy = h.db.recipes.find((r) => r.book_id === SHARED);
  assert.ok(copy, "a row in the other book");
  assert.notEqual(copy.id, recipe.id, "under an id of its own");
  assert.equal(copy.data.name, "Worth keeping");
  assert.ok(h.store.getById(recipe.id), "and the original is untouched");
  assert.deepEqual(h.store.tombstones, [], "nothing was taken from this book");
  assert.equal(h.lastToast(), "Copied to “Household”.");
});

test("J7.16 · copying does not ask, because it takes nothing", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = h.typed({ name: "Harmless" });
  h.onServer(recipe, MINE);

  await copyThrough(h, recipe.id, SHARED);

  assert.deepEqual(h.confirms, [], "there is nothing to warn anybody about");
});

test("J7.16 · a copy carries the recipe, not your relationship to it", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = h.typed({ name: "Starred here" });
  h.store.toggleFavorite(recipe.id);
  h.onServer(h.store.getById(recipe.id), MINE);

  await copyThrough(h, recipe.id, SHARED);

  const copy = h.db.recipes.find((r) => r.book_id === SHARED);
  assert.equal(copy.data.favorite, false, "it arrives unstarred (J6.5)");
  assert.equal(copy.data.sharedFrom, "", "and without a trail back to where it came from");
  assert.equal(h.store.getById(recipe.id).favorite, true, "the original keeps its star");
});

test("J7.16 · the photo comes too, filed under the copy's own id", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = withPhoto(h, "Photographed");
  h.onServer(recipe, MINE);
  const oldPath = `${MINE}/${recipe.id}.jpg`;

  await copyThrough(h, recipe.id, SHARED);

  const copy = h.db.recipes.find((r) => r.book_id === SHARED);
  const newPath = `${SHARED}/${copy.id}.jpg`;
  assert.equal(h.cloud.files.get(newPath), "jpeg-bytes");
  assert.equal(copy.data.imagePath, newPath);
  assert.equal(h.cloud.files.get(oldPath), "jpeg-bytes", "and the original's photo stays put");
  assert.equal(h.cloud.storageCalls("remove").length, 0, "nothing is tidied away after a copy");
});

test("J7.16 · a photo that cannot come across does not cost you the copy", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = withPhoto(h, "Photo won't copy");
  h.onServer(recipe, MINE);
  h.cloud.fail("storage.copy");

  await copyThrough(h, recipe.id, SHARED);

  const copy = h.db.recipes.find((r) => r.book_id === SHARED);
  assert.ok(copy, "the recipe still arrives — a copy risks nothing by going without a picture");
  assert.equal(copy.data.imagePath, "", "and does not point at a file that is not there");
  assert.equal(h.lastToast(), "Copied to “Household”, without its photo.");
});

test("J7.16 · a recipe the server has not seen yet can still be copied", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = h.typed({ name: "Typed seconds ago" });
  assert.deepEqual(h.db.recipes, [], "nothing pushed yet");

  await copyThrough(h, recipe.id, SHARED);

  assert.equal(
    h.db.recipes.filter((r) => r.book_id === SHARED).length,
    1,
    "a copy is built from what is in front of you, not from a row that may not be up yet"
  );
  assert.ok(h.store.getById(recipe.id));
});

test("J7.16 · a copy the server refuses leaves both books as they were", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = h.typed({ name: "Refused" });
  h.onServer(recipe, MINE);
  h.cloud.fail("recipes.insert", new Error("row level security"));

  await copyThrough(h, recipe.id, SHARED);

  assert.deepEqual(h.db.recipes.filter((r) => r.book_id === SHARED), []);
  assert.ok(h.store.getById(recipe.id));
  assert.deepEqual(h.store.tombstones, []);
  assert.equal(h.lastToast(), "Couldn't copy that recipe.");
});

// ---------------------------------------------------------------------
// J7.18 · seeing who is in a book
// ---------------------------------------------------------------------

test("J7.18 · the roster names everyone in the book, including you", async () => {
  const h = harness();
  h.cloud.join(MINE, THEM, "editor");
  await h.books.refresh();

  assert.deepEqual(
    h.books.members.map((m) => [m.name, m.role, m.isMe]),
    [["Dave", "owner", true], ["Sam", "editor", false]]
  );
  const html = h.el("member-list").innerHTML;
  assert.match(html, /Dave/, "you are in the list too");
  assert.match(html, /Sam/, "and so is everyone else — by name, not as 'Someone'");
});

test("J7.18 · a roster that cannot be read says so, rather than showing an empty book", async () => {
  const h = harness();
  h.cloud.join(MINE, THEM, "editor");
  // Only the roster: listBooks reads the same table, and refresh lets that
  // one reject on purpose so a network blip never looks like a deleted book.
  h.api.listMembers = async () => {
    throw new Error("could not find a relationship between book_members and profiles");
  };

  await h.books.refresh();

  assert.match(h.el("member-list").innerHTML, /Couldn’t load who is in this book/);
  assert.doesNotMatch(h.el("member-list").innerHTML, /Sam/);
});

test("J7.18 · names are a courtesy: an unreadable profile still leaves a roster", async () => {
  const h = harness();
  h.cloud.join(MINE, THEM, "editor");
  h.cloud.fail("profiles.select", new Error("row level security"));

  await h.books.refresh();

  assert.deepEqual(h.books.members.map((m) => m.role), ["owner", "editor"],
    "who is here matters more than what they are called");
  assert.match(h.el("member-list").innerHTML, /Someone/);
});

// ---------------------------------------------------------------------
// J7.17 · a book you can read and not change
// ---------------------------------------------------------------------

/** The current book, held as a viewer rather than an editor. */
async function asViewer(h) {
  h.db.books.find((b) => b.id === MINE).owner = THEM;
  for (const m of h.db.book_members) {
    if (m.book_id !== MINE) continue;
    // The fake embeds a snapshot of the book on the membership row, the
    // way PostgREST returns it, so the snapshot has to move too.
    if (m.books) m.books.owner = THEM;
    if (m.user_id === ME) m.role = "viewer";
  }
  await h.books.refresh();
}

test("J7.17 · a viewer's local edits are never pushed", async () => {
  const h = harness();
  await asViewer(h);
  assert.equal(h.sync.readOnly, true, "the book is read-only");

  // Something local, as an offline edit or a stale cache would leave it.
  h.typed({ name: "Not mine to save" });
  await h.sync.syncNow();

  assert.deepEqual(h.db.recipes, [], "nothing went up");
  assert.equal(
    h.statuses[h.statuses.length - 1],
    "synced",
    "and sync says it is done, rather than parking on an error it can never clear"
  );
});

test("J7.17 · a viewer's edit does not even schedule a push", async () => {
  const h = harness();
  await asViewer(h);
  h.sync.schedulePush();
  assert.equal(h.sync.pending, false, "there is nothing to send and nothing to retry");
});

test("J7.17 · a viewer still pulls what the book holds", async () => {
  const h = harness();
  const theirs = aRecipe({ name: "Theirs to share" });
  h.onServer(theirs, MINE);
  await asViewer(h);

  await h.sync.syncNow();

  assert.deepEqual(h.store.recipes.map((r) => r.name), ["Theirs to share"],
    "reading is the whole point of being here");
});

test("J7.17 · a viewer can copy a recipe out, into a book of their own", async () => {
  const h = harness();
  // An explicit id: aRecipe leaves that to the store, and a copy is
  // addressed by it.
  const theirs = aRecipe({ name: "Worth taking", id: "33333333-3333-4333-8333-333333333333" });
  h.onServer(theirs, MINE);
  await asViewer(h);
  await h.sync.syncNow();

  await copyThrough(h, theirs.id, SHARED);

  assert.equal(
    h.db.recipes.filter((r) => r.book_id === SHARED).length,
    1,
    "copy takes nothing from anybody, which is what makes it everyone's"
  );
});

test("J7.17 · a book only offers itself as somewhere to copy to if you can write there", async () => {
  const h = harness();
  await h.books.refresh();
  assert.deepEqual(h.books.writableBooks().map((b) => b.id).sort(), [MINE, SHARED].sort());

  // Household read-only: it stops being somewhere a recipe can go.
  h.db.book_members = h.db.book_members.map((m) =>
    m.book_id === SHARED && m.user_id === ME ? { ...m, role: "viewer" } : m
  );
  await h.books.refresh();

  assert.deepEqual(h.books.writableBooks().map((b) => b.id), [MINE]);
  const recipe = h.typed({ name: "Nowhere to go" });
  h.books.openMove(recipe.id, "copy");
  assert.equal(h.el("move-dialog").open, false);
  assert.equal(h.lastToast(), "Create another book first, then you can copy recipes into it.");
});

test("J7.17 · an owner can change what somebody may do, and is told which", async () => {
  const h = harness();
  h.cloud.join(MINE, THEM, "editor");
  await h.books.refresh();

  await h.el("member-list").fire("change", {
    target: control({ roleFor: THEM }, { value: "viewer" }),
  });

  const them = h.db.book_members.find((m) => m.book_id === MINE && m.user_id === THEM);
  assert.equal(them.role, "viewer");
  assert.match(h.lastToast(), /read this book, not change it/);
});

// ---------------------------------------------------------------------
// J7.12 · taking someone out of a book
// ---------------------------------------------------------------------

test("J7.12 · an owner can remove someone from a book", async () => {
  const h = harness();
  h.cloud.join(MINE, THEM, "editor");
  seedRecipes(h, MINE, 2);
  await h.books.refresh();
  assert.match(h.el("member-list").innerHTML, /data-remove="u-them"/);
  assert.doesNotMatch(h.el("member-list").innerHTML, /data-remove="u-me"/, "not yourself");
  h.setConfirm(true);

  await h.el("member-list").fire("click", { target: control({ remove: THEM }) });

  assert.match(h.confirms[0], /Remove this person from the book\?/);
  assert.equal(
    h.db.book_members.some((m) => m.book_id === MINE && m.user_id === THEM),
    false
  );
  assert.doesNotMatch(h.el("member-list").innerHTML, /Sam/, "and the list is up to date");
});

test("J7.12 · the person removed keeps nothing from the book, and its recipes stay with it", async () => {
  const h = harness();
  h.cloud.join(MINE, THEM, "editor");
  seedRecipes(h, MINE, 2);
  await h.books.refresh();
  h.setConfirm(true);

  await h.el("member-list").fire("click", { target: control({ remove: THEM }) });

  assert.deepEqual(
    h.db.recipes.map((r) => r.book_id),
    [MINE, MINE],
    "the recipes stay with the book"
  );
  assert.ok(
    h.db.book_members.some((m) => m.book_id === MINE && m.user_id === ME),
    "and everyone else stays in it"
  );
  assert.ok(
    h.db.book_members.some((m) => m.book_id === SHARED && m.user_id === THEM),
    "removal is from one book, not from your life"
  );
});

test("J7.12 · a removal that was not confirmed removes nobody", async () => {
  const h = harness();
  h.cloud.join(MINE, THEM, "editor");
  await h.books.refresh();
  h.setConfirm(false);

  await h.el("member-list").fire("click", { target: control({ remove: THEM }) });

  assert.ok(h.db.book_members.some((m) => m.book_id === MINE && m.user_id === THEM));
  assert.equal(h.cloud.tableCalls("book_members", "delete").length, 0);
});

test("J7.12 · removing someone is the owner's to do: a member is offered no such control", async () => {
  const h = harness({ book: SHARED });
  await h.books.refresh();
  assert.match(h.el("member-list").innerHTML, /Sam/, "the members are still listed");
  assert.doesNotMatch(h.el("member-list").innerHTML, /data-remove/);
});

// ---------------------------------------------------------------------
// J7.13, J7.14, J7.15 · a book that is not yours any more
// ---------------------------------------------------------------------

/** The membership row goes: the owner deleted the book, or removed you. */
function loseBook(h, bookId) {
  h.db.book_members = h.db.book_members.filter(
    (m) => !(m.book_id === bookId && m.user_id === ME)
  );
}

test("J7.13 · a book that stops being available moves you to another of your books", { timeout: 5000 }, async () => {
  const h = harness();
  h.typed({ name: "Cached from the book that went" });
  const cacheKey = `recipe-friend:v1:book:${MINE}`;
  await h.books.refresh();
  assert.ok(h.win.localStorage.getItem(cacheKey));

  loseBook(h, MINE);
  await h.books.refresh();

  assert.equal(h.sync.bookId, SHARED, "you are put into a book you still have");
  assert.equal(h.el("current-book").textContent, "Household");
  assert.equal(h.win.localStorage.getItem(cacheKey), null, "and the gone book's cache is forgotten");
  assert.deepEqual(h.store.recipes, [], "its recipes are not left on screen");
});

test("J7.13 · it happens without being asked: the check runs on an ordinary refresh", { timeout: 5000 }, async () => {
  const h = harness();
  await h.books.refresh();
  loseBook(h, MINE);

  // No dialog opened, no button pressed — this is the call account.js makes
  // when a sync starts failing.
  await h.books.refresh();

  assert.equal(h.sync.bookId, SHARED);
  assert.match(h.lastToast(), /isn't available to you any more/);
});

test("J7.13 · a book list that could not be fetched is never mistaken for a book that has gone", { timeout: 5000 }, async () => {
  const h = harness();
  h.typed({ name: "Still mine" });
  const cacheKey = `recipe-friend:v1:book:${MINE}`;
  await h.books.refresh();
  h.cloud.fail("book_members.select", new Error("network down"));

  await assert.rejects(() => h.books.refresh(), /network down/);

  assert.equal(h.sync.bookId, MINE, "a blip does not move you out of your book");
  assert.ok(h.win.localStorage.getItem(cacheKey), "nor throw away its recipes");
  assert.deepEqual(h.toasts, [], "and says nothing about availability");
});

test("J7.14 · the message says only that the book is no longer available to you", { timeout: 5000 }, async () => {
  const h = harness();
  await h.books.refresh();
  loseBook(h, MINE);

  await h.books.refresh();

  const said = h.lastToast();
  assert.equal(said, "“Dave's recipes” isn't available to you any more — you're in “Household” now.");
  // Deletion and removal are indistinguishable from here, so neither is named.
  assert.doesNotMatch(said, /delet/i);
  assert.doesNotMatch(said, /remov/i);
  assert.doesNotMatch(said, /owner|kicked|blocked|revoked|no longer a member/i);
});

test("J7.14 · and says no more than that when there is nowhere to move you to", { timeout: 5000 }, async () => {
  const h = harness();
  h.db.book_members = h.db.book_members.filter((m) => m.book_id === MINE);
  await h.books.refresh();
  loseBook(h, MINE);
  h.cloud.fail("books.insert"); // offline: no replacement can be made

  await h.books.refresh();

  const said = h.lastToast();
  assert.equal(said, "“Dave's recipes” isn't available to you any more.");
  assert.doesNotMatch(said, /delet|remov|owner|kicked/i);
});

test("J7.15 · if the book that went was your only one, a replacement named after you is created", { timeout: 5000 }, async () => {
  const h = harness();
  h.db.book_members = h.db.book_members.filter((m) => m.book_id === MINE);
  h.typed({ name: "Cached from the book that went" });
  const cacheKey = `recipe-friend:v1:book:${MINE}`;
  await h.books.refresh();

  loseBook(h, MINE);
  await h.books.refresh();

  const made = h.db.books.find((b) => b.owner === ME && b.id !== MINE);
  assert.ok(made, "a book was made to put new recipes in");
  assert.equal(made.name, "Dave's recipes", "named after you, exactly as your first book was (J1.3)");
  assert.equal(h.sync.bookId, made.id, "and you are in it");
  assert.ok(
    h.db.book_members.some((m) => m.book_id === made.id && m.user_id === ME && m.role === "owner"),
    "as its owner"
  );
  assert.equal(h.win.localStorage.getItem(cacheKey), null, "the gone book's cache is forgotten");
  assert.equal(h.lastToast(), "“Dave's recipes” isn't available to you any more — you're in “Dave's recipes” now.");
});

test("J7.15 · the replacement is named the way the app names any book it makes for you", { timeout: 5000 }, async () => {
  const h = harness({ displayName: "" });
  h.db.book_members = h.db.book_members.filter((m) => m.book_id === MINE);
  await h.books.refresh();

  loseBook(h, MINE);
  await h.books.refresh();

  const made = h.db.books.find((b) => b.owner === ME && b.id !== MINE);
  assert.equal(made.name, h.win.RecipeApi.ownBookName(""), "no name to use, so: Recipes");
  assert.equal(made.name, "Recipes");
});

test("J7.13 · with no replacement possible, nothing is left pointing at the book that has gone", { timeout: 5000 }, async () => {
  const h = harness();
  h.db.book_members = h.db.book_members.filter((m) => m.book_id === MINE);
  h.typed({ name: "Cached from the book that went" });
  const cacheKey = `recipe-friend:v1:book:${MINE}`;
  await h.books.refresh();
  loseBook(h, MINE);
  h.cloud.fail("books.insert");

  await h.books.refresh();

  assert.equal(h.sync.bookId, null, "sync stops asking for a book that isn't there");
  assert.equal(h.win.localStorage.getItem(cacheKey), null, "and its cache is dropped");
  assert.equal(h.el("current-book").hidden, true, "the header stops naming it");
});

/**
 * J7.13 says the check happens on its own, and names a failing sync as one
 * of the moments. That wiring lives in js/account.js, so this loads it the
 * way a browser does — with a session, a fake Supabase and the real BooksUI
 * behind it — and then lets a sync fail.
 */
function signedInApp() {
  const h = harness();
  const doc = h.doc;
  const win = h.win;

  win.RECIPE_FRIEND_CONFIG = { supabaseUrl: "https://test.supabase.co", supabaseKey: "key" };
  const session = {
    user: { id: ME, email: "dave@test.local", user_metadata: { name: "Dave" } },
  };
  let onAuth = null;
  win.supabase = {
    createClient: () => ({
      ...h.cloud.client,
      auth: {
        getSession: async () => ({ data: { session } }),
        onAuthStateChange: (fn) => { onAuth = fn; },
        signOut: async () => ({ error: null }),
        signInWithOAuth: async () => ({ error: null }),
      },
    }),
  };
  win.RecipeApp = { store: h.store, render: h.app.render, toast: h.app.toast };
  win.addEventListener = () => {};
  // window.RecipeBooks and window.RecipeSync are the real ones, loaded by harness().

  const src = fs.readFileSync(path.join(__dirname, "..", "js", "account.js"), "utf8");
  new Function("window", src)(win);

  return { ...h, session, signIn: () => onAuth && onAuth("SIGNED_IN", session) };
}

test("J7.13 · a sync that starts failing is one of the moments it is checked", { timeout: 5000 }, async () => {
  const h = signedInApp();
  await flush();
  const sync = h.win.RecipeCloud.sync;
  assert.ok(sync, "signing in starts a sync");
  assert.equal(sync.bookId, MINE, "in the book we were last using");
  const cacheKey = `recipe-friend:v1:book:${MINE}`;
  h.store.add(aRecipe({ name: "Cached from the book that went" }));

  // The owner deletes the book (or removes us) while we are working. The
  // first we know of it is a sync that will not go through.
  loseBook(h, MINE);
  h.cloud.fail("recipes.select", new Error("permission denied"));
  await sync.syncNow();
  h.cloud.unfail("recipes.select");
  await flush();

  assert.equal(sync.bookId, SHARED, "nobody had to go looking: the app moved us");
  assert.equal(h.win.localStorage.getItem(cacheKey), null, "and forgot the gone book");
  assert.match(h.lastToast(), /isn't available to you any more/);
  assert.doesNotMatch(h.lastToast(), /delet|remov/i);
});

// ---------------------------------------------------------------------
// J16 · letting a program help
// ---------------------------------------------------------------------

/**
 * Open the Books dialog the way somebody does — the challenge is drawn
 * when it opens, not on any refresh, because a widget rendered into a
 * closed dialog is rendered into `display: none`.
 */
async function openBooks(h) {
  await h.el("books-btn").fire("click", {});
  await flush();
}

/** Add an agent the way the dialog does, and let the click settle. */
async function addAgent(h, name) {
  h.el("new-agent-name").value = name;
  h.el("create-agent-btn").fire("click", {});
  await flush();
  await flush();
}

test("J16.2 · only an owner is offered an agent", async () => {
  const h = harness();
  await h.books.refresh();
  assert.equal(h.el("agents-section").hidden, false, "your own book: yours to hand out");

  await h.books.switchTo(SHARED);
  await flush();

  assert.equal(h.el("agents-section").hidden, true,
    "a book you were invited into is not yours to give a credential to");
});

test("J16.2 · an agent is named when it is added, and refuses to be nameless", async () => {
  const h = harness();
  await h.books.refresh();

  await addAgent(h, "   ");

  assert.equal(h.cloud.anonCalls().length, 0, "nothing is minted for a name nobody typed");
  assert.match(h.lastToast(), /name/i);

  // The button is not the only caller: the api refuses it too, so a
  // nameless agent cannot arrive by another route and land in the roster
  // as a blank line nobody can identify later (J16.2).
  await assert.rejects(
    () => h.api.createAgent(MINE, "  ", h.cloud.makeScratchClient, h.win.RecipeCloud.coords, ""),
    /needs a name/
  );
  assert.equal(h.cloud.anonCalls().length, 0);

  await addAgent(h, "Meal planner");

  assert.equal(h.cloud.anonCalls().length, 1);
  const row = h.cloud.db.book_members.find((m) => m.role === "agent");
  assert.ok(row, "it is placed in the book as a member");
  assert.equal(row.book_id, MINE);
});

/**
 * The guards that hold J16 up live in migration 008 and are enforced by
 * Postgres, which CI has not got. A test that asks the fake server
 * whether it refuses something is a test of the fake, and would pass with
 * 008 deleted from the repo — so these read the migration itself and
 * assert the clauses are present.
 *
 * That is a weak check and it is meant to be: it catches the clause being
 * dropped, not the clause being wrong. What proves it works is item (f),
 * (g) and (h) of the checklist at the top of 008, run by hand.
 */
const migration008 = () =>
  fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations", "008_agent_members.sql"), "utf8");

test("J16.1 · add_agent refuses a person's account, and one already in a book", () => {
  const sql = migration008();
  const fn = /create or replace function public\.add_agent[\s\S]*?\n\$\$;/.exec(sql)[0];

  assert.match(fn, /is_book_owner\(book\)/, "the caller owns the book it is placing into");
  assert.match(fn, /is_anonymous is true/, "and the thing being placed is nobody");
  // Without this, any member of a book can read an agent's id out of the
  // roster and attach it to a book of their own.
  assert.match(
    fn,
    /if exists \(select 1 from book_members where user_id = agent_id\) then/,
    "and is not already somebody else's agent"
  );
});

test("J16.8 · the role trigger freezes 'agent' in both directions", () => {
  const sql = migration008();
  const fn = /create or replace function public\.book_members_role_only[\s\S]*?\n\$\$;/.exec(sql)[0];

  // The policy alone cannot do this: a `with check` sees the new row and
  // never the old one, so it happily allows agent -> editor.
  assert.match(fn, /old\.role = 'agent' or new\.role = 'agent'/,
    "the old row is what the policy could not see");
  assert.match(sql, /create trigger book_members_role_only/, "and the trigger is re-created");
});

test("J7.5 · an anonymous session cannot redeem an invite", () => {
  const sql = migration008();
  const fn = /create or replace function public\.redeem_invite[\s\S]*?\n\$\$;/.exec(sql)[0];

  // Anonymous sign-ins are on for J16, so without this an invite link
  // stops being good for one person and becomes good for anyone holding
  // it, with no Google account at all.
  assert.match(fn, /is_anonymous is true/);
  assert.match(fn, /raise exception 'sign in first'/);
});

test("J16.6 · the credential is shown once, and is not shown again", async () => {
  const h = harness();
  await h.books.refresh();

  await addAgent(h, "Meal planner");

  const out = h.el("agent-out");
  assert.equal(out.hidden, false);
  assert.match(out.innerHTML, /rfa1\./, "the credential itself");
  assert.match(out.innerHTML, /not shown again/i, "and what that means, beside it");
  assert.equal(h.clipboard.length, 0,
    "a password in all but name is read before it is copied, not copied before it is read");

  // Closing and reopening on the same book is the thing somebody
  // actually does, and is where "not shown again" was false.
  await openBooks(h);

  assert.equal(h.el("agent-out").hidden, true, "gone, and not recoverable from the dialog");
  assert.equal(h.el("agent-out").textContent, "");
});

test("J16.6 · the credential is escaped where it is rendered", async () => {
  const h = harness();
  await h.books.refresh();
  // The credential is base64url and cannot contain these — but it is
  // written with innerHTML, and the escaping is the reason that is safe
  // rather than lucky. Take the escaper away and this is an injection.
  h.api.createAgent = async () => ({
    userId: "agent-1",
    name: "Meal planner",
    credential: '"><img src=x onerror=alert(1)>',
  });

  await addAgent(h, "Meal planner");

  const html = h.el("agent-out").innerHTML;
  assert.doesNotMatch(html, /<img/, "no tag reaches the markup");
  assert.match(html, /&lt;img/, "it is shown as text instead");
});

test("J16.6 · the credential carries the book it is for", async () => {
  const h = harness();
  await h.books.refresh();
  await addAgent(h, "Meal planner");

  const packed = /rfa1\.([A-Za-z0-9_-]+)/.exec(h.el("agent-out").innerHTML)[1];
  const parts = JSON.parse(Buffer.from(packed, "base64url").toString("utf8"));

  assert.equal(parts.book, MINE,
    "pinned, so an agent never has to guess which book it was given");
  assert.equal(parts.url, "https://test.supabase.co");
  assert.equal(parts.key, "sb_publishable_test");
  assert.match(parts.refresh_token, /^refresh-/, "and the thing that says who is asking");
});

test("J16.7 · an agent is in the member list, by name and marked as one", async () => {
  const h = harness();
  await h.books.refresh();
  await addAgent(h, "Meal planner");

  const html = h.el("member-list").innerHTML;
  assert.match(html, /Meal planner/, "under the name somebody gave it");
  assert.match(html, /class="agent-badge">agent</, "and said to be a program, not a person");
  assert.match(html, /Dave/, "beside the people");
});

test("J16.8 · an agent's role is not a control, and cannot be changed", async () => {
  const h = harness();
  h.cloud.join(MINE, THEM, "editor");
  await h.books.refresh();
  await addAgent(h, "Meal planner");

  const rows = h.el("member-list").innerHTML.split("<li");
  const agentRow = rows.find((r) => r.includes("Meal planner"));
  const personRow = rows.find((r) => r.includes("Sam"));

  assert.doesNotMatch(agentRow, /member-role-pick/,
    "no select: offered one it would have read 'Can add and edit' and widened on the next change");
  assert.match(personRow, /member-role-pick/, "a person still has one");

  // The screen not offering it is a courtesy. Try it the way anything
  // else would — through the handler the select drives — and it must
  // still not happen.
  const agent = h.cloud.db.book_members.find((m) => m.role === "agent");
  await h.el("member-list").fire("change", {
    target: control({ roleFor: agent.user_id }, { value: "editor" }),
  });
  await flush();

  assert.equal(
    h.cloud.db.book_members.find((m) => m.user_id === agent.user_id).role,
    "agent",
    "still an agent — a widened credential is the thing J16.8 exists to prevent"
  );
});

test("J16.7 · the × that removes a person removes an agent, and says which", async () => {
  const h = harness();
  await h.books.refresh();
  await addAgent(h, "Meal planner");
  const agent = h.cloud.db.book_members.find((m) => m.role === "agent");

  await h.el("member-list").fire("click", { target: control({ remove: agent.user_id }) });
  await flush();

  assert.match(h.confirms[h.confirms.length - 1], /Meal planner/,
    "the question names it rather than calling a program 'this person'");
  assert.match(h.confirms[h.confirms.length - 1], /credential stops working/);
  assert.equal(
    h.cloud.db.book_members.some((m) => m.user_id === agent.user_id), false,
    "and the membership row is what goes"
  );
});

test("J16.3 · sync pushes for an agent; the books UI still draws read-only", async () => {
  const h = harness();

  // The two helpers disagree about this one role on purpose. sync.js is in
  // the agent's module set and has to push; books.js is not, and a browser
  // opened with a credential should show the screen whose controls the
  // database would allow, not the ones it would refuse.
  //
  // canWrite is private to sync.js, so it is asked the way the app asks
  // it: resolveBook is what settles readOnly, one whole sync before the
  // books UI gets round to the question (J7.17).
  h.api.listBooks = async () => [{ id: SHARED, name: "Household", role: "agent", isOwner: false }];
  await h.sync.resolveBook("agent-1", SHARED, "Meal planner");

  assert.equal(h.sync.readOnly, false, "an agent pushes: adding a recipe is the point");
  assert.equal(h.books.canEdit({ role: "agent" }), false, "and the books UI still says no");
  assert.equal(h.books.canEdit({ role: "editor" }), true);
  assert.equal(h.books.canEdit({ role: "viewer" }), false);
});

test("J16.3 · an agent pushes a recipe it added, and never one already there", async () => {
  const h = harness({ book: SHARED });
  h.cloud.join(SHARED, ME, "agent");
  h.api.listBooks = async () => [{ id: SHARED, name: "Household", role: "agent", isOwner: false }];
  await h.sync.resolveBook(ME, SHARED, "Meal planner");
  h.store.useBook(SHARED);

  // One the household wrote, already on the server and older there than
  // in this cache — so the merge wants to push it as an update, which is
  // exactly the write an agent has no policy for. And one the agent has
  // just added, which the server has never seen.
  const theirs = h.typed({ name: "Bolognese" });
  h.cloud.db.recipes.push({
    id: theirs.id,
    book_id: SHARED,
    data: JSON.parse(JSON.stringify(theirs)),
    updated_at: new Date(theirs.updatedAt - 60000).toISOString(),
    deleted_at: null,
  });
  const mine = h.typed({ name: "Agent curry" });

  await h.sync.syncNow();

  const pushes = h.cloud.tableCalls("recipes", "upsert");
  const sent = pushes.flatMap((c) => [].concat(c.payload)).map((r) => r.id);
  assert.deepEqual(sent, [mine.id], "only the one the server had never seen");
  assert.equal(sent.includes(theirs.id), false,
    "an upsert of a row that exists is an update, and one refusal fails the whole batch");
});

test("J16.3 · a viewer still cannot push, now that another role can", async () => {
  const h = harness();
  h.api.listBooks = async () => [{ id: SHARED, name: "Household", role: "viewer", isOwner: false }];

  await h.sync.resolveBook(ME, SHARED, "Dave");

  assert.equal(h.sync.readOnly, true, "J7.17 is unchanged by J16 existing");
});

test("J16.11 · what an agent pushes is sanitised on the way back down", async () => {
  const h = harness();
  const agentBook = MINE;

  // A recipe an agent wrote, sitting on the server as it would after its
  // push — including the things a program gets wrong or a hostile one
  // tries. What the household's phone renders is what comes out of
  // `sanitizeRecipe`, not what was sent (J5.7, J2.1).
  h.cloud.db.recipes.push({
    id: "33333333-3333-4333-8333-333333333333",
    book_id: agentBook,
    data: {
      name: "Agent curry",
      ingredients: [{ amount: 2, unit: "Grams", item: "onion" }],
      steps: ["Cook."],
      tags: ["Quick", "quick"],
      image: "javascript:alert(1)",
    },
    updated_at: new Date().toISOString(),
    deleted_at: null,
  });
  // And one that breaks the floor every recipe is held to.
  h.cloud.db.recipes.push({
    id: "44444444-4444-4444-8444-444444444444",
    book_id: agentBook,
    data: { name: "No steps", ingredients: [{ item: "onion" }], steps: [] },
    updated_at: new Date().toISOString(),
    deleted_at: null,
  });

  await h.sync.syncNow();

  const got = h.store.getById("33333333-3333-4333-8333-333333333333");
  assert.ok(got, "the good one arrives");
  assert.equal(got.ingredients[0].unit, "g", "units normalised, whoever wrote them");
  assert.deepEqual(got.tags, ["quick"], "a tag written twice is one tag");
  assert.equal(got.image, "", "and an image that is not an image does not survive");
  assert.equal(
    h.store.getById("44444444-4444-4444-8444-444444444444"), null,
    "and a recipe with no steps is not one, whoever sent it"
  );
});

/**
 * Turnstile, as far as books.js is concerned: a thing on `window` that
 * draws, answers and resets. Absent, everything below must still work —
 * which is the state before a site key exists and the state when
 * Cloudflare does not load.
 */
function fakeTurnstile(win, answer = "tick") {
  const calls = { rendered: 0, resets: 0 };
  let response = answer;
  win.turnstile = {
    render() { calls.rendered += 1; return "widget-1"; },
    getResponse() { return response; },
    reset() { calls.resets += 1; response = ""; },
  };
  // Only on the fake window, which is the `global` books.js closes over.
  // Putting it on globalThis too would leave it there for the next test.
  return { calls, unanswered: () => { response = ""; } };
}

test("J16.2 · with no challenge configured, adding an agent still works", async () => {
  const h = harness();
  h.win.RECIPE_FRIEND_CONFIG = { turnstileSiteKey: "" };
  await h.books.refresh();

  await addAgent(h, "Meal planner");

  assert.equal(h.cloud.anonCalls().length, 1, "nothing is gated on a challenge nobody drew");
  assert.equal(h.books.challengeId, undefined, "and none was drawn");
});

test("J16.2 · the challenge is drawn once, and answered before an agent is made", async () => {
  const h = harness();
  h.win.RECIPE_FRIEND_CONFIG = { turnstileSiteKey: "site-key" };
  const turnstile = fakeTurnstile(h.win);

  await openBooks(h);
  assert.equal(turnstile.calls.rendered, 1);
  assert.equal(h.el("agent-turnstile").hidden, false);

  // Closing and reopening must not stack a second widget on the first.
  await h.books.refresh();
  await openBooks(h);
  assert.equal(turnstile.calls.rendered, 1, "drawn once and kept");

  await addAgent(h, "Meal planner");

  assert.equal(h.cloud.anonCalls().length, 1);
  assert.deepEqual(h.cloud.captchaTokens, ["tick"],
    "and the answer reaches the server, which is the only place it counts");
  assert.equal(turnstile.calls.resets, 1, "and is spent");
});

test("J16.2 · an unanswered challenge stops the account being made at all", async () => {
  const h = harness();
  h.win.RECIPE_FRIEND_CONFIG = { turnstileSiteKey: "site-key" };
  const turnstile = fakeTurnstile(h.win);
  await openBooks(h);
  turnstile.unanswered();

  await addAgent(h, "Meal planner");

  assert.equal(h.cloud.anonCalls().length, 0, "nothing is created on the strength of no answer");
  assert.match(h.lastToast(), /tick the box/i, "and the box under the thumb says why");
});

test("J16.2 · a refused sign-in says what the server said", async () => {
  const h = harness();
  await h.books.refresh();
  // The two failures somebody setting this up will actually hit:
  // anonymous sign-ins still switched off, and a challenge the server
  // wanted and did not get. "Couldn't add that agent" tells them nothing.
  h.cloud.fail("auth.signInAnonymously", new Error("Anonymous sign-ins are disabled"));

  await addAgent(h, "Meal planner");

  assert.match(h.lastToast(), /Anonymous sign-ins are disabled/);
  assert.equal(h.cloud.db.book_members.filter((m) => m.role === "agent").length, 0);
});

test("J16.1 · an agent that cannot be placed does not stay behind as an account", async () => {
  const h = harness();
  await h.books.refresh();
  // The book is somebody else's: signing in succeeds, placing refuses.
  h.sync.setBook(SHARED);

  await addAgent(h, "Meal planner");

  assert.equal(h.cloud.anonCalls().length, 1, "the account was made before we knew");
  assert.equal(
    h.cloud.rpcCalls("discard_orphan_agent").length, 1,
    "and is cleared up in the moment rather than left lying about"
  );
  assert.deepEqual(h.cloud.db.anon_users, [], "the account really is gone, not just asked about");
  assert.match(h.lastToast(), /Couldn't add that agent/);
});

test("J16.1 · clearing up only ever reaches an account in no book", () => {
  const fn = /create or replace function public\.discard_orphan_agent[\s\S]*?\n\$\$;/.exec(
    migration008()
  )[0];

  // This is a definer DELETE on auth.users granted to every signed-in
  // caller. Its two predicates are the whole of why that is safe: a
  // person fails the first, an agent in use fails the second.
  assert.match(fn, /is_anonymous is true/);
  assert.match(fn, /not exists \(select 1 from book_members where user_id = agent_id\)/);
});

test("J16.7 · removing an agent takes its account with it", async () => {
  const h = harness();
  await h.books.refresh();
  await addAgent(h, "Meal planner");
  const agent = h.cloud.db.book_members.find((m) => m.role === "agent");

  await h.el("member-list").fire("click", { target: control({ remove: agent.user_id }) });
  await flush();

  assert.equal(
    h.cloud.db.book_members.some((m) => m.user_id === agent.user_id), false,
    "out of the book"
  );
  assert.deepEqual(h.cloud.db.anon_users, [],
    "and the account is gone too — the dialog promises the credential stops working");
});
