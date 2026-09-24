/**
 * js/planstore.js and the plan half of js/sync.js — where a book's plan is
 * kept, and how two devices come back with the same one (J12, J13, J14).
 *
 * Driven against a fake Supabase that keeps rows the way the real one
 * does, so "the record survives a half-finished Done" and "a viewer's
 * client never pushes" are read off the server's tables rather than off a
 * mock's call log. The tables are the ones migration 007 creates: one live
 * plan per book, and an insert-only archive whose primary key is the
 * plan's own id.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp, aRecipe } = require("./helpers/load.js");

const BOOK = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

// ---------------------------------------------------------------------
// A fake Supabase holding the two tables 007 adds.
// ---------------------------------------------------------------------

function fakeCloud() {
  const db = { recipes: [], live_plans: [], plans: [], book_members: [] };
  const calls = [];
  const failures = new Map(); // "table.op" -> Error

  const matches = (row, filters) =>
    filters.every(([col, op, val]) => {
      const cell = row[col];
      if (op === "eq") return cell === val;
      if (op === "in") return [].concat(val).includes(cell);
      if (op === "is") return val === null ? cell === null || cell === undefined : cell === val;
      return true;
    });

  function run(q) {
    calls.push({ table: q.table, op: q.op, payload: q.payload });
    const failure = failures.get(`${q.table}.${q.op}`);
    if (failure) return { data: null, error: failure };
    const rows = db[q.table];
    const hit = rows.filter((r) => matches(r, q.filters));
    let data = hit;

    if (q.op === "insert") {
      const row = { ...q.payload };
      // The key on `plans` is the book *and* the plan's own id (007), and
      // the client leans on both halves: two devices recording the same
      // plan is a duplicate key, not a plan counted twice (J14.10), while
      // the same id under another book is another book's business and
      // must not collide with this one's.
      const clashes =
        q.table === "plans"
          ? (r) => r.id === row.id && r.book_id === row.book_id
          : (r) => r.id === row.id;
      if (rows.some(clashes)) {
        return {
          data: null,
          error: Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
          }),
        };
      }
      rows.push(row);
      data = [row];
    } else if (q.op === "upsert") {
      for (const item of [].concat(q.payload)) {
        // live_plans is keyed on book_id, recipes on id.
        const key = q.table === "live_plans" ? "book_id" : "id";
        const found = rows.find((r) => r[key] === item[key]);
        if (found) Object.assign(found, item, { updated_at: new Date().toISOString() });
        else rows.push({ ...item, updated_at: new Date().toISOString() });
      }
      data = [].concat(q.payload);
    } else if (q.op === "delete") {
      db[q.table] = rows.filter((r) => !matches(r, q.filters));
      data = hit;
    }

    if (q.maybeSingle) return { data: data[0] || null, error: null };
    return { data, error: null };
  }

  function builder(table) {
    const q = { table, op: "select", filters: [], payload: null };
    const api = {
      select() { return api; },
      insert(p) { q.op = "insert"; q.payload = p; return api; },
      upsert(p) { q.op = "upsert"; q.payload = p; return api; },
      delete() { q.op = "delete"; return api; },
      eq(col, val) { q.filters.push([col, "eq", val]); return api; },
      in(col, vals) { q.filters.push([col, "in", vals]); return api; },
      is(col, val) { q.filters.push([col, "is", val]); return api; },
      maybeSingle() { q.maybeSingle = true; return Promise.resolve(run(q)); },
      then(resolve, reject) { return Promise.resolve(run(q)).then(resolve, reject); },
    };
    return api;
  }

  return {
    db,
    calls,
    client: { from: builder },
    breakWrite: (what, err) => failures.set(what, err || new Error("offline")),
    mend: (what) => failures.delete(what),
    wrote: (table) => calls.filter((c) => c.table === table && c.op !== "select"),
  };
}

/** One phone: its own caches, its own sync, pointed at a shared cloud. */
function device(cloud, { bookId = BOOK, readOnly = false, addOnly = false } = {}) {
  const win = loadApp("units.js", "scale.js", "storage.js", "plan.js", "shoplist.js", "planstore.js", "sync.js");
  const store = new win.RecipeStore();
  const planStore = new win.RecipePlanStore();
  const statuses = [];
  const api = new win.RecipeApi(cloud.client);
  const sync = new win.RecipeSync(store, api, (s) => statuses.push(s), planStore);
  sync.userId = "u1";
  sync.setBook(bookId, { readOnly, addOnly });
  store.useBook(bookId);
  planStore.onChange = () => sync.schedulePush();
  return { win, store, planStore, sync, statuses, plan: win.RecipePlan };
}

/** What `listBooks` reads, so a device can resolve its own book (J7.17). */
function joinBook(cloud, { bookId = BOOK, role = "editor", owner = "someone-else" } = {}) {
  cloud.db.book_members.push({
    book_id: bookId,
    user_id: "u1",
    role,
    books: { name: "Ours", owner },
  });
}

/** A recipe both devices already have, so a meal has something to name. */
function shareRecipe(cloud, name = "Bolognese") {
  const win = loadApp("units.js", "scale.js", "storage.js");
  const recipe = win.RecipeStore.sanitizeRecipe({
    ...aRecipe({ name, servings: 4, ingredients: [{ amount: 4, unit: "", item: "onions" }] }),
  });
  cloud.db.recipes.push({
    id: recipe.id,
    book_id: BOOK,
    data: recipe,
    updated_at: new Date(recipe.updatedAt).toISOString(),
    deleted_at: null,
  });
  return recipe;
}

// ---------------------------------------------------------------------
// Where a plan lives
// ---------------------------------------------------------------------

test("J12.3 · each book keeps its own plan in its own local cache, so switching books switches plans", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const recipe = shareRecipe(cloud);

  d.planStore.setPlan(d.plan.addMeal(d.planStore.plan, recipe, 1000));
  assert.deepEqual(d.planStore.plan.meals.map((m) => m.name), ["Bolognese"]);

  d.planStore.useBook(OTHER);
  assert.deepEqual(d.planStore.plan.meals, [], "the other book is not shopping for this week");

  d.planStore.useBook(BOOK);
  assert.deepEqual(d.planStore.plan.meals.map((m) => m.name), ["Bolognese"],
    "and coming back finds the plan where it was left");
});

test("J12.3 · pointing sync at another book points the plan at it too", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const recipe = shareRecipe(cloud);
  d.planStore.setPlan(d.plan.addMeal(d.planStore.plan, recipe, 1000));

  d.sync.setBook(OTHER);
  assert.deepEqual(d.planStore.plan.meals, [], "one call, and neither cache is left behind");
});

test("J7.13 · a book that is no longer yours is forgotten, and its plan goes with it", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const recipe = shareRecipe(cloud);
  d.planStore.setPlan(d.plan.addMeal(d.planStore.plan, recipe, 1000));
  // The app forgets a gone book through the recipe store; the plan is the
  // book's too (J12.2), so it has to go on the same gesture.
  d.store.onForgetBook = (id) => d.planStore.forgetBook(id);

  d.store.forgetBook(BOOK);
  d.planStore.useBook(OTHER);
  d.planStore.useBook(BOOK);
  assert.deepEqual(d.planStore.plan.meals, [], "nothing of the book is left on the device");
});

// ---------------------------------------------------------------------
// A plan arriving from somebody else
// ---------------------------------------------------------------------

test("a hostile plan from the server is sanitised, not trusted", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const sanitize = d.win.RecipePlanStore.sanitizePlan;

  const plan = sanitize({
    id: "'; drop table plans; --",
    createdAt: "yesterday",
    meals: [
      ...Array(5000).fill({ recipeId: "33333333-3333-4333-8333-333333333333", name: "x".repeat(5000) }),
      { recipeId: "not-a-uuid", name: "nowhere" },
    ],
    settled: Object.fromEntries([
      ["nonsense", { got: { amount: "lots", at: "whenever" } }],
      ["negative", { have: { amount: -100, at: 5 } }],
      ...Array.from({ length: 5000 }, (_, i) => [`k${i}`, { got: { amount: 1, at: 1 } }]),
    ]),
  });

  assert.match(plan.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "an id that could not be a primary key is replaced with one that can");
  const limits = d.win.RecipePlanStore.limits;
  assert.equal(plan.meals.length, limits.MAX_MEALS, "the plan is bounded");
  assert.equal(plan.meals[0].name.length, limits.MAX_NAME_CHARS);
  assert.ok(plan.meals.every((m) => m.recipeId !== "not-a-uuid"),
    "a meal naming no possible recipe is dropped, not carried for ever");
  assert.equal(Object.keys(plan.settled).length, limits.MAX_SETTLED, "and so are the settlements");
  assert.equal(plan.settled.nonsense, undefined, "a settlement with no readable moment cannot merge");
  assert.equal(plan.settled.negative.have.amount, 0, "and nothing settles a negative amount");
  assert.ok(Number.isFinite(plan.createdAt));
});

/**
 * The size of a plan as Postgres would store it, which is what migration
 * 007's `pg_column_size(data) <= 200000` measures — jsonb, not the JSON
 * text that was sent. The model is the one written down in planstore.js:
 * strings cost their UTF-8 bytes, a number costs 24 as a numeric, and
 * every element — container, key or value — costs 8 bytes of jsonb
 * bookkeeping. Every term is rounded up, so this over-counts a real row.
 */
function jsonbBytes(value) {
  if (value === null || typeof value === "boolean") return 8;
  if (typeof value === "number") return 8 + 24;
  if (typeof value === "string") return 8 + Buffer.byteLength(value, "utf8");
  if (Array.isArray(value)) return 8 + value.reduce((n, v) => n + jsonbBytes(v), 0);
  return (
    8 +
    Object.entries(value).reduce((n, [k, v]) => n + 8 + Buffer.byteLength(k, "utf8") + jsonbBytes(v), 0)
  );
}

/**
 * The biggest plan the client's caps will let through. `from` numbers its
 * settled keys, so two of these can be made to have settled entirely
 * different things.
 */
function maximalPlan(win, from = 0) {
  const limits = win.RecipePlanStore.limits;
  const uuid = () => win.RecipeStore.newId();
  // The widest a double gets, and the longest characters can be: a
  // UTF-16 unit is at most three bytes of UTF-8, and jsonb keeps UTF-8.
  const HUGE = Number.MAX_VALUE;
  const digits = "〇一二三四五六七八九";
  const wide = (n) => "中".repeat(n);
  const key = (i) =>
    wide(limits.MAX_KEY_CHARS - 6) +
    String(from + i).padStart(6, "0").split("").map((d) => digits[Number(d)]).join("");
  return win.RecipePlanStore.sanitizePlan({
    id: uuid(),
    createdAt: HUGE,
    updatedAt: HUGE,
    completedAt: HUGE,
    // Twice the caps of everything, so what is measured is what the caps
    // let through rather than what a test happened to build.
    meals: Array.from({ length: limits.MAX_MEALS * 2 }, () => ({
      id: uuid(),
      recipeId: uuid(),
      name: wide(limits.MAX_NAME_CHARS * 2),
      portions: 1234.5678,
      multiplier: 7.6543219,
      addedAt: HUGE,
    })),
    // Lines added by hand at their widest: the longest state there is.
    items: Array.from({ length: limits.MAX_ITEMS * 2 }, () => ({
      id: uuid(),
      text: wide(limits.MAX_ITEM_CHARS * 2),
      addedAt: HUGE,
      state: "removed",
      at: HUGE,
    })),
    settled: Object.fromEntries(
      Array.from({ length: limits.MAX_SETTLED * 2 }, (_, i) => [
        key(i),
        { have: { amount: HUGE, at: HUGE }, got: { amount: HUGE, at: HUGE } },
      ])
    ),
  });
}

test("J12.2 · the biggest plan this client will hold is one the server will take", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const limits = d.win.RecipePlanStore.limits;
  const plan = maximalPlan(d.win);

  assert.equal(plan.meals.length, limits.MAX_MEALS);
  assert.equal(plan.items.length, limits.MAX_ITEMS);
  assert.equal(plan.items[0].text.length, limits.MAX_ITEM_CHARS);
  assert.equal(Object.keys(plan.settled).length, limits.MAX_SETTLED);
  assert.equal(plan.meals[0].name.length, limits.MAX_NAME_CHARS);

  // A plan the client accepts and the server refuses is the worst shape
  // there is: the push fails for ever, sync parks on an error, and the
  // plan looks perfectly fine on the phone that cannot get rid of it.
  assert.ok(
    jsonbBytes(plan) <= limits.SERVER_MAX_BYTES,
    `a maximal plan is ${jsonbBytes(plan)} bytes, and 007 takes ${limits.SERVER_MAX_BYTES}`
  );
  // The same row shape holds an archived plan (007), so the same sum
  // covers what Done records.
  assert.ok(jsonbBytes({ ...plan, completedAt: Date.now() }) <= limits.SERVER_MAX_BYTES);
});

test("J12.11 · merging two full plans does not make one the server would refuse", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const limits = d.win.RecipePlanStore.limits;

  // Two devices, each at the cap, each having settled entirely different
  // items: the merge takes the union, which is twice what either side
  // was allowed to hold.
  const mine = maximalPlan(d.win);
  const theirs = {
    ...maximalPlan(d.win, 500000),
    id: mine.id,
    createdAt: mine.createdAt,
    updatedAt: mine.updatedAt + 1,
  };
  const merged = d.plan.mergePlans(mine, theirs);
  assert.ok(Object.keys(merged.settled).length > limits.MAX_SETTLED, "the union really is bigger");

  d.planStore.applyMerge(merged, []);
  const held = d.planStore.plan;
  assert.equal(Object.keys(held.settled).length, limits.MAX_SETTLED, "what is kept is not");
  assert.ok(jsonbBytes(held) <= limits.SERVER_MAX_BYTES);
});

/**
 * A maximal plan with clocks a date can be made of. The sizes are what
 * these tests are about, and jsonb charges the same 24 bytes for any
 * number, so the stamps can be ordinary ones — which `pushLivePlan` needs
 * them to be, since it dates the row from the plan.
 */
function datable(plan, at) {
  const settled = {};
  for (const [key, entry] of Object.entries(plan.settled)) {
    settled[key] = { have: { amount: entry.have.amount, at }, got: { amount: entry.got.amount, at } };
  }
  return { ...plan, createdAt: at, updatedAt: at, completedAt: null, settled };
}

test("J12.11 · what a merge sends up is no bigger than what this device would hold", async () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const limits = d.win.RecipePlanStore.limits;

  // Two devices at the cap on the same plan, having settled entirely
  // different items. The merge takes the union (J12.11), which is twice
  // what either side was allowed — and the row on the server has the
  // same size check as the one here (007), so a push of the union is a
  // push that fails for ever.
  const mine = datable(maximalPlan(d.win), 1000);
  d.planStore.applyMerge(mine, []);
  cloud.db.live_plans.push({
    book_id: BOOK,
    data: { ...datable(maximalPlan(d.win, 500000), 1000), id: mine.id },
    updated_at: new Date(1000).toISOString(),
  });

  await d.sync.syncNow();

  const sent = cloud.db.live_plans[0].data;
  assert.equal(Object.keys(sent.settled).length, limits.MAX_SETTLED,
    "what goes up is the plan this device holds, not the union it started from");
  assert.equal(sent.meals.length, limits.MAX_MEALS);
  assert.ok(jsonbBytes(sent) <= limits.SERVER_MAX_BYTES,
    `a pushed plan is ${jsonbBytes(sent)} bytes, and 007 takes ${limits.SERVER_MAX_BYTES}`);
});

test("J14.1 · a plan finished after a merge is recorded at a size the record will take", async () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const limits = d.win.RecipePlanStore.limits;

  // A live plan carrying `completedAt` is a Done that got half way, and
  // finishing the job archives the plan as it stands (J14.1). After a
  // merge "as it stands" is the union, and an archived plan goes into a
  // row with the same check as the live one.
  const mine = datable(maximalPlan(d.win), 1000);
  d.planStore.applyMerge(mine, []);
  cloud.db.live_plans.push({
    book_id: BOOK,
    data: { ...datable(maximalPlan(d.win, 500000), 1000), id: mine.id, updatedAt: 2000, completedAt: 2000 },
    updated_at: new Date(2000).toISOString(),
  });

  await d.sync.syncNow();

  assert.equal(cloud.db.plans.length, 1, "the half-finished Done was finished");
  const recorded = cloud.db.plans[0].data;
  assert.equal(Object.keys(recorded.settled).length, limits.MAX_SETTLED);
  assert.ok(jsonbBytes(recorded) <= limits.SERVER_MAX_BYTES,
    `a recorded plan is ${jsonbBytes(recorded)} bytes, and 007 takes ${limits.SERVER_MAX_BYTES}`);
});

test("J13.9 · a settlement off the server cannot make the list ask for more than it needs", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const sanitize = d.win.RecipePlanStore.sanitizePlan;
  const plan = sanitize({
    settled: JSON.parse(
      '{"onion|unit:":{"have":{"amount":-40,"at":1}},' +
      '"tomato|mass":{"got":{"amount":1e999,"at":1}},' +
      '"flour|mass":{"have":{"amount":"lots","at":1}}}'
    ),
  });
  // What is left to buy is the requirement less what was settled (J13.9),
  // so a negative would ask for more than the recipes did and an infinity
  // would answer NaN for ever.
  assert.equal(d.plan.outstandingFor(plan, "onion|unit:", 6), 6);
  assert.equal(d.plan.outstandingFor(plan, "tomato|mass", 400), 400);
  assert.equal(d.plan.outstandingFor(plan, "flour|mass", 500), 500);
});

test("a hostile plan cannot reach Object.prototype through the settled map", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const sanitize = d.win.RecipePlanStore.sanitizePlan;
  // `settled` is keyed on the item as written, so its keys are whatever
  // somebody typed into a recipe — and it arrives off the server, where
  // another member of the book wrote it.
  const plan = sanitize(JSON.parse(
    '{"meals":[],"settled":{"__proto__":{"have":{"amount":1,"at":1}},' +
    '"constructor":{"got":{"amount":2,"at":2}},"polluted":{"got":{"amount":3,"at":3}}}}'
  ));
  assert.equal({}.have, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(plan.settled), null);
  assert.deepEqual(d.plan.settledFor(plan, "__proto__"), { have: 1, got: 0 },
    "the key is an item somebody wrote, and is kept as one");
  assert.deepEqual(d.plan.settledFor(plan, "constructor"), { have: 0, got: 2 });
});

test("J14.4 · an archived plan is one that was finished, and nothing else is", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const { sanitizeArchived } = d.win.RecipePlanStore;
  assert.equal(sanitizeArchived({ meals: [], completedAt: null }), null,
    "a week that never happened does not claim to have been planned");
  assert.ok(sanitizeArchived({ meals: [], completedAt: 5000 }));
});

// ---------------------------------------------------------------------
// Two devices
// ---------------------------------------------------------------------

test("J12.11 · two people settling lines at once keep both, across a real round trip", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const a = device(cloud);
  const b = device(cloud);

  // One phone builds the plan and sends it up; the other picks it up.
  a.planStore.setPlan(a.plan.addMeal(a.planStore.plan, recipe, 1000));
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.deepEqual(b.planStore.plan.meals.map((m) => m.name), ["Bolognese"]);
  assert.equal(b.planStore.plan.id, a.planStore.plan.id, "one plan, not two");

  // Then they walk into the shop and settle different lines at once,
  // neither having seen the other.
  a.planStore.setPlan(a.plan.settle(a.planStore.plan, "onion|unit:", "got", 4, 5000));
  b.planStore.setPlan(b.plan.settle(b.planStore.plan, "tomato|mass", "have", 400, 5001));
  await a.sync.syncNow();
  await b.sync.syncNow();
  await a.sync.syncNow();

  for (const d of [a, b]) {
    assert.deepEqual(d.plan.settledFor(d.planStore.plan, "onion|unit:"), { have: 0, got: 4 });
    assert.deepEqual(d.plan.settledFor(d.planStore.plan, "tomato|mass"), { have: 400, got: 0 });
  }
});

test("J12.11 · a merge that neither side had is still pushed, not held back for want of a newer stamp", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const a = device(cloud);
  const b = device(cloud);
  a.planStore.setPlan(a.plan.addMeal(a.planStore.plan, recipe, 1000));
  await a.sync.syncNow();
  await b.sync.syncNow();

  // B settles last, so the newest moment in the merged plan is B's — and
  // a push decided on "is mine newer than theirs" would leave A's ✓ on
  // this phone for ever.
  a.planStore.setPlan(a.plan.settle(a.planStore.plan, "onion|unit:", "got", 4, 5000));
  b.planStore.setPlan(b.plan.settle(b.planStore.plan, "tomato|mass", "have", 400, 9000));
  await b.sync.syncNow();
  await a.sync.syncNow();

  const row = cloud.db.live_plans[0].data;
  assert.deepEqual(a.plan.settledFor(row, "onion|unit:"), { have: 0, got: 4 },
    "the older settlement is on the server too");
  assert.deepEqual(a.plan.settledFor(row, "tomato|mass"), { have: 400, got: 0 });
});

test("J12.10 · a read-only member's client never pushes a plan", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const viewer = device(cloud, { readOnly: true });

  // Even asked to, in every way there is to ask.
  viewer.planStore.setPlan(viewer.plan.addMeal(viewer.planStore.plan, recipe, 1000));
  viewer.planStore.setPlan(viewer.plan.settle(viewer.planStore.plan, "onion|unit:", "got", 4, 2000));
  viewer.sync.schedulePush();
  await viewer.sync.syncNow();

  assert.deepEqual(cloud.wrote("live_plans"), [], "nothing of theirs reaches the live plan");
  assert.deepEqual(cloud.wrote("plans"), [], "and nothing reaches the archive");
  assert.equal(viewer.sync.pending, false,
    "and nothing is left waiting, so the status line never parks on Sync paused");
  assert.deepEqual(viewer.statuses, ["syncing", "synced"]);
});

test("J12.10 · a read-only member cannot finish a plan either", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const viewer = device(cloud, { readOnly: true });
  viewer.planStore.setPlan(viewer.plan.addMeal(viewer.planStore.plan, recipe, 1000));

  await assert.rejects(() => viewer.sync.completePlan(3000), /read/);
  assert.deepEqual(cloud.db.plans, [], "nothing is recorded");
});

test("J12.10 · a viewer still gets the plan, because reading is the point", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const editor = device(cloud);
  editor.planStore.setPlan(editor.plan.addMeal(editor.planStore.plan, recipe, 1000));
  await editor.sync.syncNow();

  const viewer = device(cloud, { readOnly: true });
  await viewer.sync.syncNow();
  assert.deepEqual(viewer.planStore.plan.meals.map((m) => m.name), ["Bolognese"]);
});

// ---------------------------------------------------------------------
// Finishing a plan
// ---------------------------------------------------------------------

test("J14.1 · Done records the plan and an empty one takes its place", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addMeal(d.planStore.plan, recipe, 1000));
  const was = d.planStore.plan.id;
  await d.sync.syncNow();

  const result = await d.sync.completePlan(7000);

  assert.equal(result.archived.completedAt, 7000);
  assert.equal(cloud.db.plans.length, 1, "the plan is on the record");
  assert.equal(cloud.db.plans[0].id, was);
  assert.equal(cloud.db.live_plans[0].data.id, result.plan.id, "and an empty one is live");
  assert.deepEqual(cloud.db.live_plans[0].data.meals, []);
  assert.notEqual(result.plan.id, was);
  assert.deepEqual(d.planStore.archive.map((p) => p.id), [was]);
});

test("J14.3 · finishing needs at least one recipe, so an empty plan records nothing", async () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  assert.equal(await d.sync.completePlan(7000), null);
  assert.deepEqual(cloud.db.plans, [], "an empty plan has nothing to record");
});

test("J14.1 · the record goes up before the live plan is cleared, so a failure after it loses nothing", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addMeal(d.planStore.plan, recipe, 1000));
  const was = d.planStore.plan.id;
  await d.sync.syncNow();

  // The second of the two writes never lands.
  cloud.breakWrite("live_plans.upsert");
  await d.sync.completePlan(7000);

  assert.equal(cloud.db.plans.length, 1, "the plan is recorded even though the reset failed");
  assert.equal(d.planStore.plan.id !== was, true, "and this device has already moved on");
  assert.equal(d.sync.pending, true, "with the rest of it queued for the retry (J9.5)");

  cloud.mend("live_plans.upsert");
  await d.sync.syncNow();
  assert.deepEqual(cloud.db.live_plans[0].data.meals, [], "which finishes the job by itself");
  assert.equal(cloud.db.plans.length, 1, "and records the plan once, not twice");
});

test("J14.10 · the other phone pressing Done on the same plan records it once, not twice", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const a = device(cloud);
  const b = device(cloud);
  a.planStore.setPlan(a.plan.addMeal(a.planStore.plan, recipe, 1000));
  await a.sync.syncNow();
  await b.sync.syncNow();

  await a.sync.completePlan(7000);
  await b.sync.completePlan(7001); // b never saw a finish it

  assert.equal(cloud.db.plans.length, 1,
    "every appearance counts, so a plan recorded twice would be a lie about how often it was planned");
  await b.sync.syncNow();
  assert.equal(b.planStore.archive.length, 1);
});

test("J14.1 · a live plan left carrying its completion is finished by whoever finds it", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const a = device(cloud);
  a.planStore.setPlan(a.plan.addMeal(a.planStore.plan, recipe, 1000));
  await a.sync.syncNow();

  // The state a completion leaves behind when it stops half way: the live
  // row holds a plan that has been finished.
  cloud.db.live_plans[0].data = a.plan.complete(a.planStore.plan, 7000);

  const b = device(cloud);
  await b.sync.syncNow();

  assert.equal(cloud.db.plans.length, 1, "the plan is on the record");
  assert.deepEqual(cloud.db.live_plans[0].data.meals, [], "and the book is not still shopping for it");
  assert.equal(b.planStore.plan.completedAt, null);
});

// ---------------------------------------------------------------------
// Clearing, and what must not come back
// ---------------------------------------------------------------------

test("J14.4 · a cleared plan does not come back from another device's cache", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const a = device(cloud);
  const b = device(cloud);

  a.planStore.setPlan(a.plan.addMeal(a.planStore.plan, recipe, 1000));
  a.planStore.setPlan(a.plan.settle(a.planStore.plan, "onion|unit:", "have", 4, 2000));
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.deepEqual(b.plan.settledFor(b.planStore.plan, "onion|unit:"), { have: 4, got: 0 });

  // Clear: a new, empty plan takes the live row. No tombstone anywhere.
  a.planStore.setPlan(a.plan.emptyPlan(9000));
  await a.sync.syncNow();

  await b.sync.syncNow();
  assert.deepEqual(b.planStore.plan.meals, [], "the week that never happened is gone");
  assert.deepEqual(b.plan.settledFor(b.planStore.plan, "onion|unit:"), { have: 0, got: 0 },
    "and 'we have onions' was about that shop, not this one");

  // And b, having merged, does not push the old plan back at a.
  await a.sync.syncNow();
  assert.deepEqual(a.planStore.plan.meals, []);
  assert.deepEqual(a.plan.settledFor(a.planStore.plan, "onion|unit:"), { have: 0, got: 0 });
});

test("J14.4 · a plan finished on one phone does not come back from the other's cache", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const a = device(cloud);
  const b = device(cloud);
  a.planStore.setPlan(a.plan.addMeal(a.planStore.plan, recipe, 1000));
  await a.sync.syncNow();
  await b.sync.syncNow();

  await a.sync.completePlan(7000);
  // b was in the shop with no signal, and adds another night to a plan
  // that is already archived.
  b.planStore.setPlan(b.plan.addMeal(b.planStore.plan, recipe, 8000));
  await b.sync.syncNow();

  assert.deepEqual(b.planStore.plan.meals, [], "the finished plan is finished");
  assert.equal(cloud.db.plans.length, 1);
  assert.deepEqual(cloud.db.live_plans[0].data.meals, []);
});

// ---------------------------------------------------------------------
// What the archive is for
// ---------------------------------------------------------------------

test("J14.6, J14.10 · archived plans come down and answer when a recipe was last planned, and how often", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const a = device(cloud);

  // Two weeks, the second of them cooking it twice (J12.6).
  a.planStore.setPlan(a.plan.addMeal(a.planStore.plan, recipe, 1000));
  await a.sync.completePlan(5000);
  let plan = a.plan.addMeal(a.planStore.plan, recipe, 6000);
  plan = a.plan.addMeal(plan, recipe, 6001);
  a.planStore.setPlan(plan);
  await a.sync.completePlan(9000);

  const fresh = device(cloud);
  await fresh.sync.syncNow();

  const index = fresh.planStore.plannedIndex();
  assert.equal(index[recipe.id].lastPlannedAt, 9000, "the date is the date the plan was finished");
  assert.equal(index[recipe.id].count, 3,
    "every appearance counts — a recipe planned twice in one plan was planned twice");
  assert.equal(fresh.planStore.archive.length, 2);
});

test("J14.6 · a device that already has an archived plan does not fetch it again", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const a = device(cloud);
  a.planStore.setPlan(a.plan.addMeal(a.planStore.plan, recipe, 1000));
  await a.sync.completePlan(5000);

  const before = cloud.calls.length;
  await a.sync.syncNow();
  const asked = cloud.calls.slice(before).filter((c) => c.table === "plans");
  assert.deepEqual(asked.map((c) => c.op), ["select"],
    "an archived plan never changes, so knowing its id is knowing all of it");
});

test("J10.1 · an export carries recipes, not plans", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const d = device(cloud);
  await d.sync.syncNow();
  d.planStore.setPlan(d.plan.addMeal(d.planStore.plan, recipe, 1000));
  await d.sync.completePlan(5000);

  // Planning history lives in the book's plans and does not survive a
  // restore into a new account, in the same way a photo does not (J10.4).
  const exported = JSON.parse(d.store.exportJSON());
  assert.deepEqual(Object.keys(exported).sort(), ["recipes", "tombstones", "version"]);
  assert.equal(exported.recipes.length, 1);
});

// ---------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------

test("J14.2 · Undo takes the record back and puts the plan back", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addMeal(d.planStore.plan, recipe, 1000));
  const { archived } = await d.sync.completePlan(7000);

  const restored = await d.sync.undoComplete(archived.id, 8000);

  assert.deepEqual(restored.meals.map((m) => m.name), ["Bolognese"]);
  assert.equal(restored.completedAt, null);
  assert.deepEqual(cloud.db.plans, [], "and the week no longer claims to have been planned");
  assert.deepEqual(cloud.db.live_plans[0].data.meals.map((m) => m.name), ["Bolognese"]);
  assert.deepEqual(d.planStore.archive, []);
});

test("J14.2 · Undo is not handed back by a phone that had already pulled the record", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const a = device(cloud);
  const b = device(cloud);
  a.planStore.setPlan(a.plan.addMeal(a.planStore.plan, recipe, 1000));
  await a.sync.syncNow();

  const { archived } = await a.sync.completePlan(7000);
  // The other phone syncs in the seconds between Done and Undo, so it is
  // holding the record when the record is taken back.
  await b.sync.syncNow();
  assert.deepEqual(b.planStore.archive.map((p) => p.id), [archived.id]);

  await a.sync.undoComplete(archived.id, 8000);
  await b.sync.syncNow();

  assert.deepEqual(cloud.db.plans, [],
    "the week no longer claims to have been planned, on either phone's next sync");
  assert.deepEqual(b.planStore.archive, [],
    "and the phone that had it lets it go rather than pushing it back");
  assert.equal(b.planStore.plannedIndex()[recipe.id], undefined,
    "so nobody is told the recipe was planned in a week that was un-finished");

  await a.sync.syncNow();
  assert.deepEqual(cloud.db.plans, [], "and it does not come back on the next trip either");
});

test("J14.1 · a Done pressed with no signal is still owed to the book when the signal returns", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addMeal(d.planStore.plan, recipe, 1000));

  cloud.breakWrite("plans.insert");
  cloud.breakWrite("live_plans.upsert");
  await d.sync.completePlan(7000);
  assert.deepEqual(cloud.db.plans, [], "nothing reached the book");

  cloud.mend("plans.insert");
  cloud.mend("live_plans.upsert");
  await d.sync.syncNow();
  assert.deepEqual(cloud.db.plans.map((r) => r.id), [d.planStore.archive[0].id],
    "and the record goes up as soon as there is somewhere to put it");
});

test("J12.10 · a viewer does not finish somebody else's half-finished Done", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const editor = device(cloud);
  editor.planStore.setPlan(editor.plan.addMeal(editor.planStore.plan, recipe, 1000));
  await editor.sync.syncNow();
  // The state a completion leaves behind when it stops half way.
  cloud.db.live_plans[0].data = editor.plan.complete(editor.planStore.plan, 7000);

  const viewer = device(cloud, { readOnly: true });
  await viewer.sync.syncNow();

  assert.deepEqual(cloud.db.plans, [], "a viewer records nothing");
  assert.deepEqual(cloud.db.live_plans[0].data.meals.map((m) => m.name), ["Bolognese"],
    "and leaves the live plan for somebody who may write it");
  assert.deepEqual(viewer.planStore.plan.meals.map((m) => m.name), ["Bolognese"],
    "so their list is the one the household is shopping from, not an empty one");
  assert.deepEqual(viewer.statuses, ["syncing", "synced"], "and nothing is refused");
});

test("J7.17 · a book you may only read is known to be one before the first sync, not after it", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  joinBook(cloud, { role: "viewer" });
  const d = device(cloud);
  // A device demoted to viewer since it last ran still holds a plan of
  // its own. The books UI settles the role on a refresh that comes after
  // this, so it is `resolveBook` that has to know.
  d.planStore.setPlan(d.plan.addMeal(d.planStore.plan, recipe, 1000));

  await d.sync.resolveBook("u1", BOOK, "Dave");
  assert.equal(d.sync.readOnly, true);

  await d.sync.syncNow();
  assert.deepEqual(cloud.wrote("live_plans"), [],
    "nothing of theirs is pushed, so the status line never parks on Sync paused");
  assert.equal(d.statuses.includes("error"), false);
  assert.equal(d.statuses[d.statuses.length - 1], "synced");
});

test("J7.17 · a book you may write is not mistaken for one you may only read", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  joinBook(cloud, { role: "editor" });
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addMeal(d.planStore.plan, recipe, 1000));

  await d.sync.resolveBook("u1", BOOK, "Dave");
  assert.equal(d.sync.readOnly, false);
  await d.sync.syncNow();
  assert.deepEqual(cloud.db.live_plans[0].data.meals.map((m) => m.name), ["Bolognese"]);
});

test("J14.2 · an Undo that does not reach the server changes nothing here either", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addMeal(d.planStore.plan, recipe, 1000));
  const { archived } = await d.sync.completePlan(7000);

  cloud.breakWrite("plans.delete");
  await assert.rejects(() => d.sync.undoComplete(archived.id, 8000));

  assert.equal(cloud.db.plans.length, 1);
  assert.deepEqual(d.planStore.archive.map((p) => p.id), [archived.id],
    "the record is not dropped here on the strength of a delete that did not happen");
  assert.deepEqual(d.planStore.plan.meals, [], "and the plan is not half-restored");
});

// ---------------------------------------------------------------------
// The ids
// ---------------------------------------------------------------------

test("a plan and its meals carry real uuids, because an archived plan's id is a primary key", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const recipe = shareRecipe(cloud);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  // No crypto.randomUUID: the browser that used to get "plan-1750000000".
  d.win.crypto = {};
  const plan = d.plan.addMeal(d.plan.emptyPlan(1000), recipe, 2000);
  assert.match(plan.id, uuid);
  assert.match(plan.meals[0].id, uuid);
});

// ---------------------------------------------------------------------
// J16.4 · an agent works on the plan and never on the record
// ---------------------------------------------------------------------

test("J16.4 · an agent leaves a finished plan alone rather than parking its sync", async () => {
  const cloud = fakeCloud();
  joinBook(cloud, { role: "agent" });
  const recipe = shareRecipe(cloud);
  const agent = device(cloud, { addOnly: true });

  // Somebody pressed Done on their phone, so the row the agent pulls is
  // a plan carrying completedAt. A person's device archives it and puts
  // an empty one in its place. An agent may write the live plan and not
  // the archive, so doing half of that would clear its own plan and then
  // be refused the record — a week that never happened, and a sync
  // parked for ever on a book that is perfectly well.
  let finished = agent.plan.addMeal(agent.plan.emptyPlan(Date.now() - 2000), recipe, Date.now() - 2000);
  finished = { ...finished, completedAt: Date.now() - 1000 };
  cloud.db.live_plans.push({
    book_id: BOOK,
    data: finished,
    updated_at: new Date().toISOString(),
  });

  await agent.sync.syncNow();

  assert.equal(agent.planStore.archive.length, 0, "it records nothing");
  assert.equal(cloud.db.plans.length, 0, "and nothing reaches the archive");
  assert.equal(agent.statuses[agent.statuses.length - 1], "synced",
    "and the sync finishes rather than parking");
  assert.ok(agent.planStore.plan.completedAt, "the finished plan is left as it was found");
});

test("J16.4 · an agent refuses to finish or undo a plan", async () => {
  const cloud = fakeCloud();
  joinBook(cloud, { role: "agent" });
  const recipe = shareRecipe(cloud);
  const agent = device(cloud, { addOnly: true });
  agent.planStore.setPlan(
    agent.plan.addMeal(agent.plan.emptyPlan(Date.now()), recipe, Date.now())
  );

  await assert.rejects(() => agent.sync.completePlan(), /does not finish a plan/);

  // And Undo, given something to undo — it pulls a record off the
  // archive, which is the write an agent has no policy for.
  const done = { ...agent.plan.emptyPlan(Date.now() - 5000), completedAt: Date.now() - 4000 };
  agent.planStore.archivePlan(done);
  await assert.rejects(() => agent.sync.undoComplete(done.id), /does not finish a plan/);

  assert.equal(cloud.db.plans.length, 0);
});

test("J16.3 · an agent still settles a line and pushes the live plan", async () => {
  const cloud = fakeCloud();
  joinBook(cloud, { role: "agent" });
  const recipe = shareRecipe(cloud);
  const agent = device(cloud, { addOnly: true });

  // The whole point of the role: it plans. Only the record is barred.
  agent.planStore.setPlan(
    agent.plan.addMeal(agent.plan.emptyPlan(Date.now()), recipe, Date.now())
  );
  await agent.sync.syncNow();

  assert.equal(cloud.db.live_plans.length, 1, "the plan it built goes up");
  assert.equal(cloud.db.live_plans[0].data.meals.length, 1);
});

// ---------------------------------------------------------------------
// Meals that are not recipes, and lines added by hand (J12.13, J12.13, J14.13)
// ---------------------------------------------------------------------

test("J12.13 · two phones adding to the list offline both keep it, across a real round trip", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const a = device(cloud);
  const b = device(cloud);
  a.planStore.setPlan(a.plan.addMeal(a.planStore.plan, recipe, 1000));
  await a.sync.syncNow();
  await b.sync.syncNow();

  a.planStore.setPlan(a.plan.addItem(a.planStore.plan, "milk", 5000));
  b.planStore.setPlan(b.plan.addItem(b.planStore.plan, "kitchen roll", 5001));
  await a.sync.syncNow();
  await b.sync.syncNow();
  await a.sync.syncNow();

  for (const d of [a, b]) {
    assert.deepEqual(d.plan.liveItems(d.planStore.plan).map((i) => i.text).sort(), ["kitchen roll", "milk"]);
  }
  assert.deepEqual(cloud.db.live_plans[0].data.items.map((i) => i.text).sort(), ["kitchen roll", "milk"]);
});

test("J12.13 · a line taken off on one phone stays off when the other syncs its older copy", async () => {
  const cloud = fakeCloud();
  const a = device(cloud);
  const b = device(cloud);
  a.planStore.setPlan(a.plan.addItem(a.planStore.plan, "milk", 1000));
  await a.sync.syncNow();
  await b.sync.syncNow();
  const id = b.planStore.plan.items[0].id;

  a.planStore.setPlan(a.plan.setItemState(a.planStore.plan, id, "removed", 5000));
  await a.sync.syncNow();
  await b.sync.syncNow();

  assert.deepEqual(b.plan.liveItems(b.planStore.plan), []);
  assert.deepEqual(b.plan.liveItems(cloud.db.live_plans[0].data), []);
});

test("J12.13 · a tick on a line added by hand is pushed, with no meal changing", async () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addItem(d.planStore.plan, "milk", 1000));
  await d.sync.syncNow();
  const id = d.planStore.plan.items[0].id;

  d.planStore.setPlan(d.plan.setItemState(d.planStore.plan, id, "got", 2000));
  await d.sync.syncNow();
  assert.equal(cloud.db.live_plans[0].data.items[0].state, "got",
    "the plan the server holds differs only in the line, and that is enough to push it");
});

test("J12.13 · a plan that is only a line added by hand begins when the line goes in", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  assert.equal(d.planStore.plan.createdAt, 0, "the placeholder has not begun");
  d.planStore.setPlan(d.plan.addItem(d.planStore.plan, "milk", 4000));
  assert.equal(d.planStore.plan.createdAt, 4000, "it is this book's plan now, and dates from the milk");
});

test("J12.13 · lines off the server are sanitised, not trusted", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const limits = d.win.RecipePlanStore.limits;
  const uuid = () => d.win.RecipeStore.newId();
  const kept = uuid();
  const plan = d.win.RecipePlanStore.sanitizePlan({
    meals: [],
    items: [
      { id: "not-a-uuid", text: "dropped" },
      { id: uuid(), text: "   " },
      { id: kept, text: "x".repeat(500), state: "eaten", mealId: "nope", at: "whenever", addedAt: 7 },
      { id: kept, text: "older copy", at: 1, addedAt: 7 },
    ],
  });
  assert.equal(plan.items.length, 1, "no id to merge on, or no words, is no line");
  const [item] = plan.items;
  assert.equal(item.text.length, limits.MAX_ITEM_CHARS);
  assert.equal(item.state, "", "a state that is not one is still to buy");
  assert.equal("mealId" in item, false, "a line belongs to the list, not to a meal");
  assert.equal(item.at, 7, "with no readable stamp it dates from when it was added");
});

test("J12.13 · half a character that arrives on its own is taken out, not pushed", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const plan = d.win.RecipePlanStore.sanitizePlan({
    meals: [{ recipeId: d.win.RecipeStore.newId(), name: "pizza \ud83d" }],
    items: [{ id: d.win.RecipeStore.newId(), text: "milk \udc00 \ud83d\ude00" }],
  });
  assert.equal(plan.items[0].text, "milk \ud83d\ude00", "the lone half goes; the whole emoji stays");
  assert.equal(plan.meals[0].name, "pizza");
});

test("J12.13 · past what a plan holds, the newest lines on the list are the ones kept", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const limits = d.win.RecipePlanStore.limits;
  const uuid = () => d.win.RecipeStore.newId();
  const lines = Array.from({ length: limits.MAX_ITEMS + 30 }, (_, i) => ({
    id: uuid(), text: `line ${i}`, addedAt: 1000 + i, at: 1000 + i,
  }));
  const plan = d.win.RecipePlanStore.sanitizePlan({ meals: [], items: lines });
  const texts = plan.items.map((i) => i.text);
  assert.equal(texts.length, limits.MAX_ITEMS);
  assert.ok(texts.includes(`line ${limits.MAX_ITEMS + 29}`), "the line just added is kept");
  assert.ok(!texts.includes("line 0"), "the oldest is what goes");
});

test("J12.13 · two phones' lists meeting near the limit lose nothing and bring nothing back", async () => {
  const cloud = fakeCloud();
  const a = device(cloud);
  const b = device(cloud);
  const limits = a.win.RecipePlanStore.limits;
  // Sixty shared lines, synced to both phones.
  let plan = a.planStore.plan;
  for (let i = 0; i < 60; i++) plan = a.plan.addItem(plan, `shared ${i}`, 1000 + i);
  a.planStore.setPlan(plan);
  await a.sync.syncNow();
  await b.sync.syncNow();

  // Offline, A takes two off — the newest two, so age cannot be what
  // keeps them off — and adds forty, which is more than the list would
  // hold if the removed ones counted; B adds thirty of its own. Together
  // that is everything the plan holds (MAX_ITEMS), and none of it may go.
  const x = a.planStore.plan.items[59];
  const y = a.planStore.plan.items[58];
  plan = a.plan.setItemState(a.planStore.plan, x.id, "removed", 5000);
  plan = a.plan.setItemState(plan, y.id, "removed", 5001);
  for (let i = 0; i < 40; i++) plan = a.plan.addItem(plan, `a ${i}`, 6000 + i);
  a.planStore.setPlan(plan);
  let theirs = b.planStore.plan;
  for (let i = 0; i < 30; i++) theirs = b.plan.addItem(theirs, `b ${i}`, 7000 + i);
  b.planStore.setPlan(theirs);
  assert.equal(60 + 40 + 30, limits.MAX_ITEMS, "the two lists together are exactly what the plan holds");

  await a.sync.syncNow();
  await b.sync.syncNow();
  await a.sync.syncNow();

  for (const d of [a, b]) {
    const texts = d.plan.liveItems(d.planStore.plan).map((i) => i.text);
    assert.ok(!texts.includes(x.text) && !texts.includes(y.text), "what A took off stays off");
    for (let i = 0; i < 58; i++) assert.ok(texts.includes(`shared ${i}`), `"shared ${i}" is kept`);
    for (let i = 0; i < 40; i++) assert.ok(texts.includes(`a ${i}`), `A's "a ${i}" is kept`);
    for (let i = 0; i < 30; i++) assert.ok(texts.includes(`b ${i}`), `B's "b ${i}" is kept`);
  }
});

test("J12.13 · a line is never cut half way through a character", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const limits = d.win.RecipePlanStore.limits;
  const plan = d.win.RecipePlanStore.sanitizePlan({
    meals: [{ recipeId: d.win.RecipeStore.newId(), name: "b".repeat(limits.MAX_NAME_CHARS - 1) + "🍕" }],
    items: [{ id: d.win.RecipeStore.newId(), text: "a".repeat(limits.MAX_ITEM_CHARS - 1) + "😀" }],
  });
  assert.equal(plan.items[0].text, "a".repeat(limits.MAX_ITEM_CHARS - 1));
  assert.equal(plan.meals[0].name, "b".repeat(limits.MAX_NAME_CHARS - 1));
});

test("J12.13 · junk at the front of a list off the server does not push real lines out", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const real = { id: d.win.RecipeStore.newId(), text: "milk", addedAt: 1, at: 1 };
  const plan = d.win.RecipePlanStore.sanitizePlan({
    meals: [],
    items: [...Array.from({ length: 5000 }, () => ({ id: "junk", text: "x" })), real],
  });
  assert.deepEqual(plan.items.map((i) => i.text), ["milk"]);
});

test("J12.13 · over the cap, what is still on the list is kept before what was taken off it", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const limits = d.win.RecipePlanStore.limits;
  const uuid = () => d.win.RecipeStore.newId();
  const removed = Array.from({ length: limits.MAX_ITEMS }, (_, i) => ({
    id: uuid(), text: `gone ${i}`, state: "removed", addedAt: i, at: 10000 + i,
  }));
  const live = Array.from({ length: 10 }, (_, i) => ({
    id: uuid(), text: `wanted ${i}`, addedAt: 500 + i, at: 500 + i,
  }));
  const plan = d.win.RecipePlanStore.sanitizePlan({ meals: [], items: [...removed, ...live] });
  assert.equal(plan.items.length, limits.MAX_ITEMS);
  assert.equal(d.plan.liveItems(plan).length, 10, "nothing anybody means to buy is lost");
  assert.ok(!plan.items.some((i) => i.text === "gone 0"), "the oldest removal goes first");
});

test("J14.13 · Done records the meals and not what was added by hand", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const d = device(cloud);
  let plan = d.plan.addMeal(d.planStore.plan, recipe, 1000);
  plan = d.plan.addItem(plan, "milk", 1002);
  d.planStore.setPlan(plan);

  const result = await d.sync.completePlan(7000);

  const recorded = cloud.db.plans[0].data;
  assert.deepEqual(recorded.meals.map((m) => m.name), ["Bolognese"], "the week's meals are the record");
  assert.equal("items" in recorded, false, "the list is not kept");
  assert.equal("items" in d.planStore.archive[0], false, "not on this phone either");
  assert.deepEqual(d.planStore.plan.items, [], "and nothing carries into the next plan");
  assert.ok(cloud.db.live_plans.every((row) => (row.data.items || []).length === 0));
  assert.deepEqual(result.items.map((i) => i.text), ["milk"], "Undo is handed it, and nothing else is");
});

test("J14.2 · Undo puts back what was on the list by hand as well as the meals", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const d = device(cloud);
  let plan = d.plan.addMeal(d.planStore.plan, recipe, 1000);
  plan = d.plan.addItem(plan, "milk", 1001);
  d.planStore.setPlan(plan);
  const { archived, items } = await d.sync.completePlan(7000);

  const restored = await d.sync.undoComplete(archived.id, 8000, items);

  assert.deepEqual(d.plan.liveItems(restored).map((i) => i.text), ["milk"]);
  assert.deepEqual(d.plan.liveItems(cloud.db.live_plans[0].data).map((i) => i.text), ["milk"]);
});

test("J14.3 · a plan that is only lines added by hand is finished, and records nothing", async () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addItem(d.planStore.plan, "milk", 1000));
  await d.sync.syncNow();
  const was = d.planStore.plan;

  const done = await d.sync.completePlan(7000);

  assert.equal(done.archived, null, "nothing claims a week was planned");
  assert.deepEqual(cloud.db.plans, []);
  assert.deepEqual(d.planStore.archive, []);
  assert.equal(done.previous.id, was.id, "the plan that was is handed back for Undo");
  assert.notEqual(d.planStore.plan.id, was.id, "and a later generation takes its place");
  assert.deepEqual(d.planStore.plan.items, []);
  assert.deepEqual(cloud.db.live_plans[0].data.items, [], "on the server too, so the other phone's list goes");
});

test("J14.3 · an empty plan has nothing to finish", async () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  assert.equal(await d.sync.completePlan(7000), null);
  const id = d.win.RecipeStore.newId();
  d.planStore.setPlan({ ...d.planStore.plan, items: [{ id, text: "milk", state: "removed", at: 1, addedAt: 1 }] });
  assert.equal(await d.sync.completePlan(7000), null, "a line taken off is not something on the list");
});

test("J14.2 · the Undo of a Done that recorded nothing needs no network", async () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addItem(d.planStore.plan, "milk", 1000));
  const done = await d.sync.completePlan(7000);
  const calls = cloud.calls.length;

  const back = d.sync.restoreUnrecorded(done.previous, 8000);

  assert.equal(cloud.calls.length, calls, "nothing was asked of the server to do it");
  assert.deepEqual(d.plan.liveItems(back).map((i) => i.text), ["milk"]);
  assert.ok(back.createdAt > done.plan.createdAt, "a later generation than the empty one it replaces");
  await d.sync.syncNow();
  assert.deepEqual(d.plan.liveItems(cloud.db.live_plans[0].data).map((i) => i.text), ["milk"],
    "and it goes up with the next sync like any edit");
});

test("J16.4 · an agent cannot finish or bring back a list either", async () => {
  const cloud = fakeCloud();
  const d = device(cloud, { addOnly: true });
  d.planStore.setPlan(d.plan.addItem(d.planStore.plan, "milk", 1000));
  await assert.rejects(d.sync.completePlan(7000), /agent/);
  assert.throws(() => d.sync.restoreUnrecorded(d.planStore.plan, 8000), /agent/);
});


test("J12.13 · a plan saved with a meal that was only a name keeps its lines as ordinary ones", () => {
  // The previous release let a meal be just a name, with lines of its own.
  // Those plans are still in the book: the meal goes, and nothing to buy
  // goes with it.
  const cloud = fakeCloud();
  const d = device(cloud);
  const pizza = d.win.RecipeStore.newId();
  const plan = d.win.RecipePlanStore.sanitizePlan({
    meals: [{ id: pizza, recipeId: null, name: "Frozen pizza", portions: null, multiplier: null, addedAt: 1 }],
    items: [{ id: d.win.RecipeStore.newId(), text: "2 frozen pizzas", mealId: pizza, addedAt: 2, state: "", at: 2 }],
  });
  assert.deepEqual(plan.meals, [], "a meal is a recipe");
  assert.deepEqual(plan.items.map((i) => [i.text, "mealId" in i]), [["2 frozen pizzas", false]]);
});

// ---------------------------------------------------------------------
// A tap during a sync, and what Undo keeps
// ---------------------------------------------------------------------

/**
 * Hold a sync open part-way, where it has read the plan but not applied
 * it. `at` is the call to hold on: fetchArchivedPlanIds comes before the
 * sync reads this device's archive, fetchArchivedPlans after it.
 */
function stall(d, at = "fetchArchivedPlanIds") {
  const real = d.sync.api[at].bind(d.sync.api);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  d.sync.api[at] = async (...args) => {
    reached();
    await gate;
    d.sync.api[at] = real;
    return real(...args);
  };
  return { arrived, release };
}

test("J14.3 · a Done pressed while a sync is running stays done", async () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addItem(d.planStore.plan, "milk", 1000));
  await d.sync.syncNow();
  const was = d.planStore.plan.id;

  const hold = stall(d);
  const running = d.sync.syncNow();
  await hold.arrived;
  const done = await d.sync.completePlan(Date.now());
  hold.release();
  await running;
  await d.sync.syncNow();

  assert.equal(done.archived, null);
  assert.notEqual(d.planStore.plan.id, was, "the sync that was running did not put the old plan back");
  assert.deepEqual(d.plan.liveItems(d.planStore.plan), []);
  assert.deepEqual(d.plan.liveItems(cloud.db.live_plans[0].data), [], "and neither did the server");
});

test("J14.1 · a recipe Done pressed while a sync is running is recorded, not dropped", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addMeal(d.planStore.plan, recipe, 1000));
  await d.sync.syncNow();

  // Held after the sync has read this phone's archive, so the record Done
  // makes is one that list has never heard of.
  const hold = stall(d, "fetchArchivedPlans");
  const running = d.sync.syncNow();
  await hold.arrived;
  const done = await d.sync.completePlan(Date.now());
  hold.release();
  await running;
  await d.sync.syncNow();

  assert.deepEqual(d.planStore.archive.map((p) => p.id), [done.archived.id], "still on this phone's record");
  assert.deepEqual(cloud.db.plans.map((p) => p.id), [done.archived.id], "and on the book's");
  assert.deepEqual(d.planStore.plan.meals, [], "and the live plan is the empty one");
});

test("J12.13 · a line added while a sync is running is kept", async () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addItem(d.planStore.plan, "milk", 1000));
  await d.sync.syncNow();

  const hold = stall(d);
  const running = d.sync.syncNow();
  await hold.arrived;
  d.planStore.setPlan(d.plan.addItem(d.planStore.plan, "eggs", Date.now()));
  hold.release();
  await running;
  await d.sync.syncNow();

  assert.deepEqual(d.plan.liveItems(d.planStore.plan).map((i) => i.text), ["milk", "eggs"]);
  assert.deepEqual(d.plan.liveItems(cloud.db.live_plans[0].data).map((i) => i.text), ["milk", "eggs"]);
});

test("J14.2 · Undo after a list-only Done keeps what was added since, here or on the other phone", async () => {
  const cloud = fakeCloud();
  const a = device(cloud);
  const b = device(cloud);
  a.planStore.setPlan(a.plan.addItem(a.planStore.plan, "milk", 1000));
  await a.sync.syncNow();
  await b.sync.syncNow();

  const done = await a.sync.completePlan(Date.now());
  await b.sync.syncNow();
  b.planStore.setPlan(b.plan.addItem(b.planStore.plan, "eggs", Date.now()));
  await b.sync.syncNow();
  await a.sync.syncNow();

  a.sync.restoreUnrecorded(done.previous, Date.now());
  await a.sync.syncNow();
  await b.sync.syncNow();

  for (const d of [a, b]) {
    assert.deepEqual(d.plan.liveItems(d.planStore.plan).map((i) => i.text).sort(), ["eggs", "milk"]);
  }
});

test("J14.2 · the plan Undo brings back is a new plan, so no old copy of it can outrank it", async () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addItem(d.planStore.plan, "milk", 1000));
  const done = await d.sync.completePlan(7000);
  const back = d.sync.restoreUnrecorded(done.previous, 8000);
  assert.notEqual(back.id, done.previous.id,
    "a copy of the old plan elsewhere would merge into it by id and take its older birthday");
  assert.notEqual(back.id, done.plan.id);
});

test("J12.10 · a viewer cannot bring a finished list back", () => {
  const cloud = fakeCloud();
  const d = device(cloud, { readOnly: true });
  const previous = d.plan.addItem(d.plan.emptyPlan(1), "milk", 1000);
  assert.throws(() => d.sync.restoreUnrecorded(previous, 8000), /read/);
  assert.deepEqual(d.planStore.plan.items, []);
});

test("J14.2 · Undo of a recorded Done keeps a line added since, too", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addMeal(d.planStore.plan, recipe, 1000));
  const { archived, items } = await d.sync.completePlan(7000);
  d.planStore.setPlan(d.plan.addItem(d.planStore.plan, "eggs", 7500));

  const restored = await d.sync.undoComplete(archived.id, 8000, items);

  assert.deepEqual(restored.meals.map((m) => m.name), ["Bolognese"]);
  assert.deepEqual(d.plan.liveItems(d.planStore.plan).map((i) => i.text), ["eggs"]);
});

test("J12.13 · a new phone's first line, added while its first sync runs, does not replace the book's plan", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const a = device(cloud);
  a.planStore.setPlan(a.plan.addMeal(a.planStore.plan, recipe, 1000));
  await a.sync.syncNow();

  // B has never seen this book's plan: it holds the placeholder.
  const b = device(cloud);
  const hold = stall(b);
  const first = b.sync.syncNow();
  await hold.arrived;
  b.planStore.setPlan(b.plan.addItem(b.planStore.plan, "milk", Date.now()));
  hold.release();
  await first;
  await b.sync.syncNow();
  await a.sync.syncNow();

  for (const d of [a, b]) {
    assert.deepEqual(d.planStore.plan.meals.map((m) => m.name), ["Bolognese"], "the household's week is still there");
    assert.deepEqual(d.plan.liveItems(d.planStore.plan).map((i) => i.text), ["milk"], "and so is the milk");
  }
  assert.deepEqual(cloud.db.live_plans[0].data.meals.map((m) => m.name), ["Bolognese"]);
});

test("J14.2 · Undo keeps the later word on a line, not the older one", async () => {
  const cloud = fakeCloud();
  const recipe = shareRecipe(cloud);
  const d = device(cloud);
  let plan = d.plan.addMeal(d.planStore.plan, recipe, 1000);
  plan = d.plan.settle(plan, "onion|unit:", "have", 1, 1500);
  d.planStore.setPlan(plan);
  const { archived, items } = await d.sync.completePlan(2000);
  d.planStore.setPlan(d.plan.settle(d.planStore.plan, "onion|unit:", "have", 4, 6500));

  await d.sync.undoComplete(archived.id, 8000, items);

  assert.deepEqual(d.plan.settledFor(d.planStore.plan, "onion|unit:"), { have: 4, got: 0 });
});

test("J14.4 · a tick on the old week, made while a sync brings in the new one, stays with the old week", async () => {
  const cloud = fakeCloud();
  const a = device(cloud);
  const b = device(cloud);
  a.planStore.setPlan(a.plan.addItem(a.planStore.plan, "milk", 1000));
  await a.sync.syncNow();
  await b.sync.syncNow();

  // B clears the plan; A, mid-sync, ticks the milk on the week that is over.
  b.planStore.setPlan(b.plan.emptyPlan(b.plan.generationAfter(b.planStore.plan, Date.now())));
  await b.sync.syncNow();
  const hold = stall(a);
  const running = a.sync.syncNow();
  await hold.arrived;
  const milk = a.planStore.plan.items[0].id;
  a.planStore.setPlan(a.plan.setItemState(a.planStore.plan, milk, "got", Date.now()));
  hold.release();
  await running;
  await a.sync.syncNow();

  assert.equal(a.planStore.plan.id, b.planStore.plan.id, "the cleared plan is the one the book is on");
  assert.deepEqual(a.plan.liveItems(a.planStore.plan), [], "and the old week's milk did not follow it in");
});

test("J13.16 · a line saved before lines could be edited dates its words from when it was added", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const id = d.win.RecipeStore.newId();
  const plan = d.win.RecipePlanStore.sanitizePlan({
    meals: [],
    items: [{ id, text: "milk", addedAt: 1234, state: "got", at: 5000 }],
  });
  assert.equal(plan.items[0].textAt, 1234);
});

test("J13.16 · two copies of one line in a list off the server merge field by field", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const id = d.win.RecipeStore.newId();
  const plan = d.win.RecipePlanStore.sanitizePlan({
    meals: [],
    items: [
      { id, text: "7 eggs", textAt: 3000, addedAt: 1, state: "", at: 1 },
      { id, text: "6 eggs", textAt: 1, addedAt: 1, state: "got", at: 4000 },
    ],
  });
  assert.deepEqual(plan.items.map((i) => [i.text, i.state]), [["7 eggs", "got"]]);
});

test("J13.16 · an edit on one phone and a tick on the other survive a real round trip", async () => {
  const cloud = fakeCloud();
  const a = device(cloud);
  const b = device(cloud);
  a.planStore.setPlan(a.plan.addItem(a.planStore.plan, "6 eggs", 1000));
  await a.sync.syncNow();
  await b.sync.syncNow();
  const id = a.planStore.plan.items[0].id;

  a.planStore.setPlan(a.plan.editItem(a.planStore.plan, id, "7 eggs", Date.now()));
  b.planStore.setPlan(b.plan.setItemState(b.planStore.plan, id, "got", Date.now() + 5));
  await a.sync.syncNow();
  await b.sync.syncNow();
  await a.sync.syncNow();

  for (const d of [a, b]) {
    assert.deepEqual(d.planStore.plan.items.map((i) => [i.text, i.state]), [["7 eggs", "got"]]);
  }
});

test("J13.16 · a line stamped far in the future off the server can still be changed", () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  const id = d.win.RecipeStore.newId();
  const plan = d.win.RecipePlanStore.sanitizePlan({
    meals: [],
    items: [{ id, text: "zzz", textAt: 1e20, addedAt: 1, state: "got", at: 1e20 }],
  });
  assert.ok(plan.items[0].textAt < Date.now() + 2 * 24 * 60 * 60 * 1000, "no stamp is believed past a day ahead");
  const edited = d.plan.editItem(plan, id, "milk", Date.now());
  assert.equal(d.plan.mergePlans(plan, edited).items[0].text, "milk");
  const unticked = d.plan.setItemState(plan, id, "", Date.now());
  assert.equal(d.plan.mergePlans(plan, unticked).items[0].state, "");
});

test("J13.16 · a change only to when the words were changed is still pushed", async () => {
  const cloud = fakeCloud();
  const d = device(cloud);
  d.planStore.setPlan(d.plan.addItem(d.planStore.plan, "milk", 1000));
  await d.sync.syncNow();
  const id = d.planStore.plan.items[0].id;
  // Edited away and back on this phone: the same words, a later stamp.
  let plan = d.plan.editItem(d.planStore.plan, id, "oat milk", 2000);
  plan = d.plan.editItem(plan, id, "milk", 3000);
  d.planStore.setPlan(plan);
  await d.sync.syncNow();
  assert.equal(cloud.db.live_plans[0].data.items[0].textAt, 3000);
});
