/**
 * js/liststore.js and the lists half of js/sync.js — where a book's lists
 * are kept, and how they meet the server's (J18.22–J18.25).
 *
 * Sync runs against a fake api holding rows the way migration 012 does:
 * a tombstone is final, a write names the updated_at it merged with, and
 * an agent may change items only.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp, aRecipe } = require("./helpers/load.js");

const BOOK = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MODULES = ["units.js", "scale.js", "storage.js", "plan.js", "planstore.js", "lists.js", "liststore.js", "sync.js"];

function fakeServer() {
  const rows = new Map();
  let clock = 0;
  const calls = [];
  const tick = () => new Date(Date.UTC(2026, 0, 1) + ++clock).toISOString();
  const copy = (r) => JSON.parse(JSON.stringify(r));
  const server = {
    rows,
    calls,
    role: "editor",
    offline: false,
    api: {
      async fetchLists(bookId) {
        calls.push("fetchLists");
        if (server.offline) throw new Error("offline");
        return [...rows.values()].filter((r) => r.book_id === bookId).map(copy);
      },
      async fetchList(bookId, id) {
        calls.push("fetchList");
        if (server.offline) throw new Error("offline");
        const r = rows.get(id);
        return r && r.book_id === bookId ? copy(r) : null;
      },
      async insertList(bookId, list) {
        calls.push("insertList");
        if (server.role !== "editor") throw Object.assign(new Error("rls"), { code: "42501" });
        if (rows.has(list.id)) return;
        rows.set(list.id, {
          id: list.id, book_id: bookId, name: list.name, name_at: list.nameAt, kind: list.kind,
          items: copy(list.items), deleted_at: null, created_at: tick(), updated_at: tick(),
        });
      },
      async updateList(bookId, id, fields, seenAt) {
        calls.push("updateList");
        const r = rows.get(id);
        if (server.role === "viewer") return false;
        if (server.role === "agent" && Object.keys(fields).some((k) => k !== "items")) {
          throw Object.assign(new Error("an agent may change a list's items, not the list"), { code: "42501" });
        }
        if (!r || r.book_id !== bookId || (seenAt && r.updated_at !== seenAt)) return false;
        if (!r.deleted_at) Object.assign(r, copy(fields));
        r.updated_at = tick();
        return true;
      },
      async deleteList(bookId, id) {
        calls.push("deleteList");
        if (server.role !== "editor") throw new Error("rls");
        const r = rows.get(id);
        if (r) Object.assign(r, { deleted_at: tick(), items: [], updated_at: tick() });
      },
    },
  };
  return server;
}

/** One device: its own storage, stores and sync, on `server`. */
function device(server, roles = {}) {
  const win = loadApp(...MODULES);
  const store = new win.RecipeStore();
  const plans = new win.RecipePlanStore();
  const lists = new win.RecipeListStore();
  const sync = new win.RecipeSync(store, server.api, () => {}, plans, lists);
  sync.setBook(BOOK, roles);
  store.useBook(BOOK);
  return { win, store, plans, lists, sync, L: win.RecipeLists };
}

const texts = (d, id) => d.L.liveItems(d.lists.get(id)).map((i) => i.text).sort();

// ---------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------

test("J18.1 · each book keeps its own lists, and they survive a reload", () => {
  const win = loadApp(...MODULES);
  const store = new win.RecipeListStore();
  store.useBook(BOOK);
  const list = store.create("Freezer", "stock");
  store.change(list.id, (l) => win.RecipeLists.addItem(l, { text: "peas" }));
  store.useBook(OTHER);
  assert.equal(store.lists.length, 0);
  const again = new win.RecipeListStore();
  again.useBook(BOOK);
  assert.deepEqual(again.lists.map((l) => l.name), ["Freezer"]);
  assert.equal(again.get(list.id).items[0].text, "peas");
  again.forgetBook(BOOK);
  const gone = new win.RecipeListStore();
  gone.useBook(BOOK);
  assert.equal(gone.lists.length, 0);
});

test("what is read back from storage is coerced, not believed", () => {
  const win = loadApp(...MODULES);
  win.localStorage.setItem(
    `recipe-friend:lists:v1:book:${BOOK}`,
    JSON.stringify({ lists: [null, { id: "x" }, { id: OTHER, name: "Ok", kind: "checklist", items: [{ id: "bad" }] }], known: ["nope", OTHER], seeded: "yes" })
  );
  const store = new win.RecipeListStore();
  store.useBook(BOOK);
  assert.deepEqual(store.lists.map((l) => [l.name, l.items.length]), [["Ok", 0]]);
  assert.equal(store.isKnown(OTHER), true);
  assert.equal(store.seeded, false);
  win.localStorage.setItem(`recipe-friend:lists:v1:book:${OTHER}`, "{not json");
  store.useBook(OTHER);
  assert.equal(store.lists.length, 0);
});

test("an edit notifies sync; an operation that changed nothing writes nothing", () => {
  const win = loadApp(...MODULES);
  const store = new win.RecipeListStore();
  store.useBook(BOOK);
  let pushes = 0;
  store.onChange = () => pushes++;
  const list = store.create("Shopping", "checklist");
  assert.equal(pushes, 1);
  assert.equal(store.change(list.id, (l) => l), store.get(list.id));
  assert.equal(pushes, 1);
  store.rename(list.id, "Groceries");
  assert.equal(pushes, 2);
  assert.equal(store.change("missing", (l) => l), null);
});

test("J18.17 · the device id is stable across reloads and shared by every book", () => {
  const win = loadApp(...MODULES);
  const a = new win.RecipeListStore();
  const id = a.deviceId;
  assert.match(id, /^[A-Za-z0-9]{16}$/);
  const b = new win.RecipeListStore();
  b.useBook(OTHER);
  assert.equal(b.deviceId, id);
  assert.notEqual(new (loadApp(...MODULES).RecipeListStore)().deviceId, id, "another device, another id");
});

// ---------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------

test("build step 1 · the plan becomes Shopping once, by the first editor, after the plan is pulled", async () => {
  const server = fakeServer();
  const a = device(server);
  const recipe = a.store.add(aRecipe({ name: "Curry", servings: 2 }));
  a.plans.setPlan(a.win.RecipePlan.addItem(a.win.RecipePlan.addMeal(a.plans.plan, recipe, 100), "milk", 200));
  const result = await a.sync.syncLists();
  const shopping = a.L.shoppingListId(BOOK);
  assert.deepEqual(result.changed, [shopping]);
  assert.deepEqual(texts(a, shopping), ["1 l stock", "Curry", "milk"]);
  assert.equal(server.rows.get(shopping).name, "Shopping");

  // A second device seeding at the same moment writes the same list.
  const b = device(fakeServer());
  b.store.applyMerge([recipe], []);
  b.plans.setPlan(JSON.parse(JSON.stringify(a.plans.plan)));
  await b.sync.syncLists();
  assert.equal(JSON.stringify(b.lists.get(shopping)), JSON.stringify(a.lists.get(shopping)));

  // Seeded is remembered: deleting every list does not bring it back.
  a.lists.remove(shopping);
  await a.sync.syncLists();
  assert.ok(server.rows.get(shopping).deleted_at);
  await a.sync.syncLists();
  assert.equal(a.lists.lists.length, 0);
  // Nor on a device that has never seen the book: the tombstone is a row.
  const c = device(server);
  await c.sync.syncLists();
  assert.equal(c.lists.lists.length, 0);
});

test("J18.4 · a reader pulls and pushes nothing, and does not seed", async () => {
  const server = fakeServer();
  const ed = device(server);
  const list = ed.lists.create("Freezer", "stock");
  await ed.sync.syncLists();
  server.calls.length = 0;
  server.role = "viewer";
  const vic = device(server, { readOnly: true });
  await vic.sync.syncLists();
  assert.deepEqual(vic.lists.lists.map((l) => l.name).sort(), ["Freezer", "Shopping"]);
  vic.lists.change(list.id, (l) => vic.L.addItem(l, { text: "peas" }));
  await vic.sync.syncLists();
  assert.deepEqual(server.calls, ["fetchLists", "fetchLists"]);
  assert.equal(server.rows.get(list.id).items.length, 0);
});

test("J18.25 · an agent pushes items and nothing else", async () => {
  const server = fakeServer();
  const ed = device(server);
  const list = ed.lists.create("Shopping list", "checklist");
  await ed.sync.syncLists();
  server.role = "agent";
  const bot = device(server, { addOnly: true });
  await bot.sync.syncLists();
  bot.lists.change(list.id, (l) => bot.L.addItem(l, { text: "milk" }));
  bot.lists.rename(list.id, "Mine");
  bot.lists.create("New", "checklist");
  bot.lists.remove(ed.L.shoppingListId(BOOK));
  await bot.sync.syncLists();
  assert.equal(server.rows.get(list.id).name, "Shopping list");
  assert.equal(server.rows.get(list.id).items[0].text, "milk");
  assert.equal(server.rows.get(ed.L.shoppingListId(BOOK)).deleted_at, null);
  assert.equal(server.rows.size, 2);
});

test("J18.22 · an offline edit is kept, and goes up when the network comes back", async () => {
  const server = fakeServer();
  const a = device(server);
  const list = a.lists.create("Shopping list", "checklist");
  await a.sync.syncLists();
  server.offline = true;
  a.lists.change(list.id, (l) => a.L.addItem(l, { text: "milk" }));
  assert.equal(await a.sync.pullLists(list.id), null, "the poll fails quietly");
  assert.deepEqual(texts(a, list.id), ["milk"]);
  server.offline = false;
  const back = await a.sync.pullLists(list.id);
  assert.equal(back.pushed, 1);
  assert.equal(server.rows.get(list.id).items[0].text, "milk");
});

test("J18.23 · a write over a row somebody else has written since is merged again, not lost", async () => {
  const server = fakeServer();
  const a = device(server);
  const b = device(server);
  const list = a.lists.create("Shopping list", "checklist");
  await a.sync.syncLists();
  await b.sync.syncLists();
  const stale = await server.api.fetchLists(BOOK);
  b.lists.change(list.id, (l) => b.L.addItem(l, { text: "milk" }));
  await b.sync.syncLists();
  a.lists.change(list.id, (l) => a.L.addItem(l, { text: "eggs" }));
  const real = server.api.fetchLists;
  a.sync.api = { ...server.api, fetchLists: async () => stale };
  await a.sync.syncLists();
  a.sync.api = server.api;
  assert.deepEqual(server.rows.get(list.id).items.map((i) => i.text).sort(), ["eggs", "milk"]);
  assert.deepEqual(texts(a, list.id), ["eggs", "milk"]);
  assert.equal(real, server.api.fetchLists);
});

test("J18.24 · a pull tells the UI which lists changed, and nothing when nothing did", async () => {
  const server = fakeServer();
  const a = device(server);
  const b = device(server);
  const list = a.lists.create("Freezer", "stock");
  await a.sync.syncLists();
  await b.sync.syncLists();
  const heard = [];
  b.lists.onRemote = (ids) => heard.push(ids);
  await b.sync.pullLists(list.id);
  assert.deepEqual(heard, []);
  a.lists.change(list.id, (l) => a.L.addItem(l, { text: "peas" }));
  await a.sync.pullLists(list.id);
  await b.sync.pullLists(list.id);
  assert.deepEqual(heard, [[list.id]]);
  assert.deepEqual(texts(b, list.id), ["peas"]);
});

test("J18.3 · a list deleted on one phone goes from the other, and stays gone", async () => {
  const server = fakeServer();
  const a = device(server);
  const b = device(server);
  const list = a.lists.create("Freezer", "stock");
  await a.sync.syncLists();
  await b.sync.syncLists();
  b.lists.change(list.id, (l) => b.L.addItem(l, { text: "peas" })); // offline, unheard
  a.lists.remove(list.id);
  await a.sync.syncLists();
  await b.sync.syncLists();
  assert.equal(b.lists.get(list.id), null);
  assert.ok(server.rows.get(list.id).deleted_at);
  // One made and deleted before it ever went up owes the server nothing.
  const quick = a.lists.create("Temp", "checklist");
  a.lists.remove(quick.id);
  server.calls.length = 0;
  await a.sync.syncLists();
  assert.ok(!server.calls.includes("deleteList") && !server.calls.includes("insertList"));
});

test("syncNow carries the lists, and switching books switches them", async () => {
  const server = fakeServer();
  const a = device(server);
  server.api.fetchRecipes = async () => [];
  server.api.pushRecipes = async () => {};
  server.api.fetchLivePlan = async () => null;
  server.api.pushLivePlan = async () => {};
  server.api.fetchArchivedPlanIds = async () => [];
  server.api.fetchArchivedPlans = async () => [];
  const result = await a.sync.syncNow();
  assert.equal(result.lists.pulled, 0);
  assert.equal(a.lists.lists.length, 1, "seeded");
  a.sync.setBook(OTHER);
  assert.equal(a.lists.lists.length, 0);
});
