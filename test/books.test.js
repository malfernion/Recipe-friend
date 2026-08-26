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
function control(attrs) {
  const t = {
    dataset: { ...attrs },
    closest(sel) {
      const m = /^\[data-([\w-]+)\]$/.exec(sel);
      return m && Object.prototype.hasOwnProperty.call(attrs, m[1]) ? t : null;
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
  };
  const calls = [];
  const failures = new Map(); // "table.op" or "storage.copy" -> Error
  const files = new Map();
  let nextId = 1;

  const embed = (row) => {
    const book = db.books.find((b) => b.id === row.book_id);
    const profile = db.profiles.find((p) => p.user_id === row.user_id);
    return {
      ...row,
      books: book ? { name: book.name, owner: book.owner } : null,
      profiles: profile ? { display_name: profile.display_name } : null,
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
      return true;
    });

  function run(q) {
    calls.push({ table: q.table, op: q.op, filters: q.filters.map((f) => f.join(":")), payload: q.payload });
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
      for (const row of hit) Object.assign(row, q.payload);
      data = hit.map((r) => ({ ...r }));
    } else if (q.op === "upsert") {
      for (const item of [].concat(q.payload)) {
        const found = rows.find((r) => r.id === item.id);
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

  /** preview_invite and redeem_invite, as migration 005 defines them. */
  const rpcs = {
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

  return {
    db, client, calls, files,
    join,
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
    confirm: (message) => {
      confirms.push(message);
      return typeof answer === "function" ? answer(message) : answer;
    },
    alert() {},
    setTimeout: (fn) => { void fn; return 0; },
    clearTimeout() {},
  });
  win.document = doc;

  const statuses = [];
  const sync = new win.RecipeSync(store, cloud.client, (s) => statuses.push(s));
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

  const src = fs.readFileSync(path.join(__dirname, "..", "js", "books.js"), "utf8");
  new Function("window", src)(win);
  const books = new win.RecipeBooks.BooksUI(sync, app);
  books.wire();

  return {
    win, doc, cloud, db: cloud.db, store, sync, app, books, toasts, confirms,
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
  assert.equal(h.win.RecipeSync.ownBookName(""), "Recipes");
  assert.equal(h.win.RecipeSync.ownBookName("  Dave  "), "Dave's recipes");
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

  const live = await h.sync.listInvites(MINE);

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

test("J7.4 · a browser with no secure randomness is refused an invite rather than given a guessable one", async () => {
  const h = harness();
  h.win.crypto = { };
  await assert.rejects(() => h.sync.createInvite(MINE), /secure invite code/);
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

test("J7.8 · the recipe count is of live recipes, not ones already deleted", async () => {
  const h = harness();
  seedRecipes(h, MINE, 2);
  h.db.recipes.push({
    id: "tombstoned", book_id: MINE, data: aRecipe(),
    updated_at: new Date().toISOString(), deleted_at: new Date().toISOString(),
  });

  assert.equal(await h.sync.countRecipes(MINE), 2);
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

/** Drive the move dialog the way the recipe screen does. */
async function moveThrough(h, recipeId, targetBookId) {
  h.books.openMove(recipeId);
  await h.el("move-list").fire("click", { target: control({ target: targetBookId }) });
}

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

  h.books.openMove(recipe.id);

  assert.equal(h.el("move-dialog").open, false);
  assert.equal(h.lastToast(), "Create another book first, then you can move recipes into it.");
});

test("J7.10 · a moved recipe keeps its identity", async () => {
  const h = harness();
  const recipe = h.typed({ name: "Same recipe, new book" });
  h.onServer(recipe, MINE);

  await h.sync.moveRecipe(recipe.id, SHARED);

  assert.deepEqual(
    h.db.recipes.map((r) => [r.id, r.book_id, r.data.name]),
    [[recipe.id, SHARED, "Same recipe, new book"]],
    "the same row, in the other book — not a copy with a new id"
  );
});

test("J7.10 · its photo moves with it, so the new book's members can see it", async () => {
  const h = harness();
  const recipe = withPhoto(h);
  h.onServer(recipe, MINE);
  const oldPath = `${MINE}/${recipe.id}.jpg`;
  const newPath = `${SHARED}/${recipe.id}.jpg`;

  const returned = await h.sync.moveRecipe(recipe.id, SHARED);

  assert.equal(returned, newPath);
  assert.equal(h.cloud.files.get(newPath), "jpeg-bytes", "the file is in the new book");
  assert.equal(h.cloud.files.has(oldPath), false, "and no longer in the old one");
  assert.equal(
    h.db.recipes[0].data.imagePath,
    newPath,
    "and the recipe points at it without waiting for another push"
  );
});

test("J7.10 · a moved recipe is forgotten locally without a tombstone that would delete it in its new home", async () => {
  const h = harness();
  await h.books.refresh();
  const recipe = h.typed({ name: "Off it goes" });
  h.onServer(recipe, MINE);

  await moveThrough(h, recipe.id, SHARED);

  assert.equal(h.store.getById(recipe.id), null, "gone from the book it left");
  assert.deepEqual(h.store.tombstones, [], "and not marked deleted");
  assert.equal(h.el("move-dialog").open, false);
  assert.equal(h.lastToast(), "Moved to “Household”.");
});

test("J7.10 · an old photo that could not be tidied away does not undo the move", async () => {
  const h = harness();
  const recipe = withPhoto(h);
  h.onServer(recipe, MINE);
  h.cloud.fail("storage.remove");

  const returned = await h.sync.moveRecipe(recipe.id, SHARED);

  assert.equal(returned, `${SHARED}/${recipe.id}.jpg`);
  assert.equal(h.db.recipes[0].book_id, SHARED, "the move stands");
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
    h.db.recipes.map((r) => [r.id, r.book_id]),
    [[recipe.id, SHARED]],
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
  h.cloud.fail("recipes.update", new Error("row level security"));

  await moveThrough(h, recipe.id, SHARED);

  assert.ok(h.store.getById(recipe.id));
  assert.equal(h.db.recipes[0].book_id, MINE);
  assert.equal(h.lastToast(), "Couldn't move that recipe.");
});

test("J7.11 · a recipe already moved by someone else is not dropped twice", async () => {
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

test("J7.12 · a member cannot remove anyone, including the owner", async () => {
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

test("J7.13 · a book that stops being available moves you to another of your books", async () => {
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

test("J7.13 · it happens without being asked: the check runs on an ordinary refresh", async () => {
  const h = harness();
  await h.books.refresh();
  loseBook(h, MINE);

  // No dialog opened, no button pressed — this is the call account.js makes
  // when a sync starts failing.
  await h.books.refresh();

  assert.equal(h.sync.bookId, SHARED);
  assert.match(h.lastToast(), /isn't available to you any more/);
});

test("J7.13 · a book list that could not be fetched is never mistaken for a book that has gone", async () => {
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

test("J7.14 · the message says only that the book is no longer available to you", async () => {
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

test("J7.14 · and says no more than that when there is nowhere to move you to", async () => {
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

test("J7.15 · if the book that went was your only one, a replacement named after you is created", async () => {
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

test("J7.15 · the replacement is named the way the app names any book it makes for you", async () => {
  const h = harness({ displayName: "" });
  h.db.book_members = h.db.book_members.filter((m) => m.book_id === MINE);
  await h.books.refresh();

  loseBook(h, MINE);
  await h.books.refresh();

  const made = h.db.books.find((b) => b.owner === ME && b.id !== MINE);
  assert.equal(made.name, h.win.RecipeSync.ownBookName(""), "no name to use, so: Recipes");
  assert.equal(made.name, "Recipes");
});

test("J7.13 · with no replacement possible, nothing is left pointing at the book that has gone", async () => {
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
  win.RecipeBooks = win.RecipeBooks; // the real one, already loaded by harness()

  const src = fs.readFileSync(path.join(__dirname, "..", "js", "account.js"), "utf8");
  new Function("window", src)(win);

  return { ...h, session, auth: () => onAuth, doc };
}

test("J7.13 · a sync that starts failing is one of the moments it is checked", async () => {
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
