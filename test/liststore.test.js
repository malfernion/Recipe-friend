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
// What syncNow passes, having just pulled the plan.
const SEED = { seed: true };
const MODULES = ["units.js", "scale.js", "storage.js", "plan.js", "planstore.js", "lists.js", "liststore.js", "sync.js"];

function fakeServer() {
  // Keyed on the book and the id, as 012 keys them.
  const rows = new Map();
  const key = (bookId, id) => `${bookId}/${id}`;
  let clock = 0;
  const calls = [];
  const tick = () => new Date(Date.UTC(2026, 0, 1) + ++clock).toISOString();
  const copy = (r) => JSON.parse(JSON.stringify(r));
  const server = {
    rows,
    calls,
    role: "editor",
    offline: false,
    row: (id, bookId = BOOK) => rows.get(key(bookId, id)),
    api: {
      async fetchLists(bookId) {
        calls.push("fetchLists");
        if (server.offline) throw new Error("offline");
        return [...rows.values()].filter((r) => r.book_id === bookId).map(copy);
      },
      async fetchList(bookId, id) {
        calls.push("fetchList");
        if (server.offline) throw new Error("offline");
        const r = rows.get(key(bookId, id));
        return r ? copy(r) : null;
      },
      async insertList(bookId, list) {
        calls.push("insertList");
        if (server.role !== "editor") throw Object.assign(new Error("rls"), { code: "42501" });
        if (rows.has(key(bookId, list.id))) return;
        rows.set(key(bookId, list.id), {
          id: list.id, book_id: bookId, name: list.name, name_at: list.nameAt, kind: list.kind,
          items: copy(list.items), pruned_to: list.prunedTo || 0, deleted_at: null, created_at: tick(), updated_at: tick(),
        });
      },
      async updateList(bookId, id, fields, seenAt) {
        calls.push("updateList");
        const r = rows.get(key(bookId, id));
        if (server.role === "viewer") return false;
        if (server.role === "agent" && Object.keys(fields).some((k) => k !== "items" && k !== "pruned_to")) {
          throw Object.assign(new Error("an agent may change a list's items, not the list"), { code: "42501" });
        }
        if (!r || (seenAt && r.updated_at !== seenAt)) return false;
        if (!r.deleted_at) Object.assign(r, copy(fields));
        r.updated_at = tick();
        return true;
      },
      async deleteList(bookId, id) {
        calls.push("deleteList");
        if (server.role !== "editor") throw new Error("rls");
        const r = rows.get(key(bookId, id));
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
  const result = await a.sync.syncLists(null, SEED);
  const shopping = a.L.shoppingListId(BOOK);
  assert.deepEqual(result.changed, [shopping]);
  assert.deepEqual(texts(a, shopping), ["1 l stock", "Curry", "milk"]);
  assert.equal(server.row(shopping).name, "Shopping");

  // A second device seeding at the same moment writes the same list.
  const b = device(fakeServer());
  b.store.applyMerge([recipe], []);
  b.plans.setPlan(JSON.parse(JSON.stringify(a.plans.plan)));
  await b.sync.syncLists(null, SEED);
  assert.equal(JSON.stringify(b.lists.get(shopping)), JSON.stringify(a.lists.get(shopping)));

  // Seeded is remembered: deleting every list does not bring it back.
  a.lists.remove(shopping);
  await a.sync.syncLists(null, SEED);
  assert.ok(server.row(shopping).deleted_at);
  await a.sync.syncLists(null, SEED);
  assert.equal(a.lists.lists.length, 0);
  // Nor on a device that has never seen the book: the tombstone is a row.
  const c = device(server);
  await c.sync.syncLists(null, SEED);
  assert.equal(c.lists.lists.length, 0);
});

test("J18.4 · a reader pulls and pushes nothing, and does not seed", async () => {
  const server = fakeServer();
  const ed = device(server);
  const list = ed.lists.create("Freezer", "stock");
  await ed.sync.syncLists(null, SEED);
  server.calls.length = 0;
  server.role = "viewer";
  const vic = device(server, { readOnly: true });
  await vic.sync.syncLists(null, SEED);
  assert.deepEqual(vic.lists.lists.map((l) => l.name).sort(), ["Freezer", "Shopping"]);
  vic.lists.change(list.id, (l) => vic.L.addItem(l, { text: "peas" }));
  await vic.sync.syncLists(null, SEED);
  assert.deepEqual(server.calls, ["fetchLists", "fetchLists"]);
  assert.equal(server.row(list.id).items.length, 0);
});

test("J18.25 · an agent pushes items and nothing else", async () => {
  const server = fakeServer();
  const ed = device(server);
  const list = ed.lists.create("Shopping list", "checklist");
  await ed.sync.syncLists(null, SEED);
  server.role = "agent";
  const bot = device(server, { addOnly: true });
  await bot.sync.syncLists(null, SEED);
  bot.lists.change(list.id, (l) => bot.L.addItem(l, { text: "milk" }));
  bot.lists.rename(list.id, "Mine");
  bot.lists.create("New", "checklist");
  bot.lists.remove(ed.L.shoppingListId(BOOK));
  await bot.sync.syncLists(null, SEED);
  assert.equal(server.row(list.id).name, "Shopping list");
  assert.equal(server.row(list.id).items[0].text, "milk");
  assert.equal(server.row(ed.L.shoppingListId(BOOK)).deleted_at, null);
  assert.equal(server.rows.size, 2);
});

test("J18.22 · an offline edit is kept, and goes up when the network comes back", async () => {
  const server = fakeServer();
  const a = device(server);
  const list = a.lists.create("Shopping list", "checklist");
  await a.sync.syncLists(null, SEED);
  server.offline = true;
  a.lists.change(list.id, (l) => a.L.addItem(l, { text: "milk" }));
  assert.equal(await a.sync.pullLists(list.id), null, "the poll fails quietly");
  assert.deepEqual(texts(a, list.id), ["milk"]);
  server.offline = false;
  const back = await a.sync.pullLists(list.id);
  assert.equal(back.pushed, 1);
  assert.equal(server.row(list.id).items[0].text, "milk");
});

test("J18.23 · a write over a row somebody else has written since is merged again, not lost", async () => {
  const server = fakeServer();
  const a = device(server);
  const b = device(server);
  const list = a.lists.create("Shopping list", "checklist");
  await a.sync.syncLists(null, SEED);
  await b.sync.syncLists(null, SEED);
  const stale = await server.api.fetchLists(BOOK);
  b.lists.change(list.id, (l) => b.L.addItem(l, { text: "milk" }));
  await b.sync.syncLists(null, SEED);
  a.lists.change(list.id, (l) => a.L.addItem(l, { text: "eggs" }));
  const real = server.api.fetchLists;
  a.sync.api = { ...server.api, fetchLists: async () => stale };
  await a.sync.syncLists(null, SEED);
  a.sync.api = server.api;
  assert.deepEqual(server.row(list.id).items.map((i) => i.text).sort(), ["eggs", "milk"]);
  assert.deepEqual(texts(a, list.id), ["eggs", "milk"]);
  assert.equal(real, server.api.fetchLists);
});

test("J18.24 · a pull tells the UI which lists changed, and nothing when nothing did", async () => {
  const server = fakeServer();
  const a = device(server);
  const b = device(server);
  const list = a.lists.create("Freezer", "stock");
  await a.sync.syncLists(null, SEED);
  await b.sync.syncLists(null, SEED);
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
  await a.sync.syncLists(null, SEED);
  await b.sync.syncLists(null, SEED);
  b.lists.change(list.id, (l) => b.L.addItem(l, { text: "peas" })); // offline, unheard
  a.lists.remove(list.id);
  await a.sync.syncLists(null, SEED);
  await b.sync.syncLists(null, SEED);
  assert.equal(b.lists.get(list.id), null);
  assert.ok(server.row(list.id).deleted_at);
  // One made and deleted before it ever went up owes the server nothing.
  const quick = a.lists.create("Temp", "checklist");
  a.lists.remove(quick.id);
  server.calls.length = 0;
  await a.sync.syncLists(null, SEED);
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

// ---------------------------------------------------------------------
// From the review of step 1a
// ---------------------------------------------------------------------

test("build step 1 · a poll never moves the plan: only syncNow, with the plan just pulled", async () => {
  const server = fakeServer();
  const a = device(server);
  const recipe = a.store.add(aRecipe({ name: "Monday's curry", servings: 2 }));
  a.plans.setPlan(a.win.RecipePlan.addMeal(a.plans.plan, recipe, 100));
  await a.sync.pullLists();
  await a.sync.pullLists(a.L.shoppingListId(BOOK));
  assert.equal(a.lists.lists.length, 0);
  assert.ok(!server.calls.includes("insertList"));
  assert.equal(a.lists.seeded, false);
});

test("build step 1 · a row with Shopping's id in another book does not stop this book's", async () => {
  const server = fakeServer();
  const a = device(server);
  const id = a.L.shoppingListId(BOOK);
  // Somebody who knows the book's id squats it in a book of their own.
  await server.api.insertList(OTHER, { id, name: "Squat", nameAt: 0, kind: "checklist", items: [] });
  await a.sync.syncLists(null, SEED);
  await a.sync.syncLists(null, SEED);
  assert.deepEqual(a.lists.lists.map((l) => l.name), ["Shopping"]);
  assert.equal(server.row(id).name, "Shopping");
  assert.equal(server.row(id, OTHER).name, "Squat");
});

/** Run `fn` with the clock at `ms` (sync prunes on Date.now()). */
async function at(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

test("J9.4 · six weeks of shopping, then the tablet syncs: what was deleted stays deleted", async () => {
  const server = fakeServer();
  const a = device(server);
  const b = device(server);
  const list = a.lists.create("Weekly", "checklist", T0);
  const milk = a.L.newId();
  await at(T0, async () => {
    a.lists.change(list.id, (l) => a.L.addItem(l, { text: "old milk", id: milk, now: T0 }));
    await a.sync.syncLists(null, SEED);
    await b.sync.syncLists(null, SEED);
    a.lists.change(list.id, (l) => a.L.deleteItems(l, [milk], T0 + 1));
    await a.sync.syncLists(null, SEED);
  });
  for (let week = 1; week <= 6; week++) {
    const now = T0 + week * 7 * DAY;
    await at(now, async () => {
      for (let i = 0; i < 70; i++) a.lists.change(list.id, (l) => a.L.addItem(l, { text: `w${week} ${i}`, now: now + i }));
      a.lists.change(list.id, (l) => a.L.deleteItems(l, a.L.liveItems(l).map((i) => i.id), now + 100));
      await a.sync.syncLists(null, SEED);
    });
  }
  await at(T0 + 43 * DAY, async () => {
    await b.sync.syncLists(null, SEED);
    await a.sync.syncLists(null, SEED);
  });
  assert.deepEqual(a.L.liveItems(a.lists.get(list.id)), []);
  assert.deepEqual(b.L.liveItems(b.lists.get(list.id)), []);
  assert.ok(server.row(list.id).pruned_to > T0, "the server row carries the prune mark");
  assert.ok(server.row(list.id).items.length <= 5 * 70, "a month of tombstones, not six weeks'");
});

test("J9.4 · a phone back after 40 days brings what it wrote since the mark, and not what was deleted", async () => {
  const server = fakeServer();
  const a = device(server);
  const phone = device(server);
  const list = a.lists.create("Weekly", "checklist", T0);
  const bread = a.L.newId();
  await at(T0, async () => {
    a.lists.change(list.id, (l) => a.L.addItem(l, { text: "bread", id: bread, now: T0 }));
    await a.sync.syncLists(null, SEED);
    await phone.sync.syncLists(null, SEED);
  });
  // The phone goes offline and writes one line on day 1 ...
  await at(T0 + DAY, () => phone.lists.change(list.id, (l) => phone.L.addItem(l, { text: "old offline", now: T0 + DAY })));
  await at(T0 + 2 * DAY, async () => {
    a.lists.change(list.id, (l) => a.L.deleteItems(l, [bread], T0 + 2 * DAY));
    await a.sync.syncLists(null, SEED);
  });
  // ... and one on day 40, then comes back.
  await at(T0 + 40 * DAY, async () => {
    phone.lists.change(list.id, (l) => phone.L.addItem(l, { text: "new offline", now: T0 + 40 * DAY }));
    await a.sync.syncLists(null, SEED); // a prunes the bread tombstone
    await phone.sync.syncLists(null, SEED);
    await a.sync.syncLists(null, SEED);
  });
  const names = (d) => d.L.liveItems(d.lists.get(list.id)).map((i) => i.text).sort();
  assert.deepEqual(names(a), ["new offline"]);
  assert.deepEqual(names(phone), ["new offline"]);
});
