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
  const db = { recipes: [], live_plans: [], plans: [] };
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
      // `plans.id` is a primary key, and the client leans on that: two
      // devices recording the same plan is a duplicate key, not a plan
      // counted twice (J14.10).
      if (rows.some((r) => r.id === row.id)) {
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
function device(cloud, { bookId = BOOK, readOnly = false } = {}) {
  const win = loadApp("units.js", "scale.js", "storage.js", "plan.js", "shoplist.js", "planstore.js", "sync.js");
  const store = new win.RecipeStore();
  const planStore = new win.RecipePlanStore();
  const statuses = [];
  const api = new win.RecipeApi(cloud.client);
  const sync = new win.RecipeSync(store, api, (s) => statuses.push(s), planStore);
  sync.userId = "u1";
  sync.setBook(bookId, { readOnly });
  store.useBook(bookId);
  planStore.onChange = () => sync.schedulePush();
  return { win, store, planStore, sync, statuses, plan: win.RecipePlan };
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
  assert.equal(plan.meals.length, 200, "the plan is bounded");
  assert.equal(plan.meals[0].name.length, 120);
  assert.ok(plan.meals.every((m) => m.recipeId !== "not-a-uuid"),
    "a meal naming no possible recipe is dropped, not carried for ever");
  assert.equal(Object.keys(plan.settled).length, 500, "and so are the settlements");
  assert.equal(plan.settled.nonsense, undefined, "a settlement with no readable moment cannot merge");
  assert.equal(plan.settled.negative.have.amount, 0, "and nothing settles a negative amount");
  assert.ok(Number.isFinite(plan.createdAt));
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
