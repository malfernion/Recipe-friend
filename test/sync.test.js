/**
 * js/sync.js — reconciling this device's copy with the book (J9).
 *
 * This is where a bug loses a recipe rather than showing a wrong number,
 * so the cases here are mostly about what must survive: an edit made
 * offline, a delete made on another device, a recipe the server has never
 * seen.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp, aRecipe } = require("./helpers/load.js");

const BOOK = "11111111-1111-4111-8111-111111111111";
const iso = (ms) => new Date(ms).toISOString();

/** A sync wired to a real store and a client that records what it is asked. */
function harness() {
  const win = loadApp("units.js", "scale.js", "storage.js", "sync.js");
  const store = new win.RecipeStore();
  const calls = { selected: 0, upserted: [] };
  let rows = [];
  let failWith = null;

  const client = {
    from() {
      return {
        select() {
          return {
            eq: async () => {
              calls.selected++;
              return failWith ? { data: null, error: failWith } : { data: rows, error: null };
            },
          };
        },
        async upsert(payload) {
          calls.upserted.push(...payload);
          return failWith ? { error: failWith } : { error: null };
        },
      };
    },
  };

  const statuses = [];
  const api = new win.RecipeApi(client);
  const sync = new win.RecipeSync(store, api, (s) => statuses.push(s));
  sync.setBook(BOOK);
  sync.userId = "u1";
  store.useBook(BOOK);

  return {
    store, sync, api, calls, statuses,
    setRemote: (r) => { rows = r; },
    breakNetwork: (err) => { failWith = err; },
    /** A server row for a recipe. */
    row: (recipe, at, deletedAt) => ({
      id: recipe.id,
      data: recipe,
      updated_at: iso(at),
      deleted_at: deletedAt ? iso(deletedAt) : null,
    }),
  };
}

test("J9.3 · a newer local edit wins and is pushed up", () => {
  const h = harness();
  const saved = h.store.add(aRecipe({ name: "Soup" }));
  h.store.update(saved.id, { ...saved, name: "Better Soup" });
  const local = h.store.getById(saved.id);

  const { recipes, toPush } = h.sync.merge([h.row(saved, local.updatedAt - 5000)]);

  assert.equal(recipes.length, 1);
  assert.equal(recipes[0].name, "Better Soup");
  assert.equal(toPush.length, 1, "the newer local version goes up");
  assert.equal(toPush[0].data.name, "Better Soup");
});

test("J9.3 · a newer remote edit wins and is not pushed back", () => {
  const h = harness();
  const saved = h.store.add(aRecipe({ name: "Soup" }));
  const theirs = { ...saved, name: "Their Soup" };

  const { recipes, toPush } = h.sync.merge([h.row(theirs, saved.updatedAt + 5000)]);

  assert.equal(recipes[0].name, "Their Soup");
  assert.equal(toPush.length, 0, "nothing to send — they are ahead");
});

test("a recipe the server has never seen is pushed, not dropped", () => {
  const h = harness();
  h.store.add(aRecipe({ name: "Brand New" }));

  const { recipes, toPush } = h.sync.merge([]);

  assert.equal(recipes.length, 1, "an empty server does not empty the device");
  assert.equal(toPush.length, 1);
  assert.equal(toPush[0].book_id, BOOK);
});

test("a recipe only the server has is pulled down", () => {
  const h = harness();
  const theirs = { ...aRecipe({ name: "Theirs" }), id: "22222222-2222-4222-8222-222222222222" };

  const { recipes, toPush } = h.sync.merge([h.row(theirs, Date.now())]);

  assert.deepEqual(recipes.map((r) => r.name), ["Theirs"]);
  assert.equal(toPush.length, 0);
});

test("J9.4 · a local delete travels as a tombstone rather than reappearing", () => {
  const h = harness();
  const saved = h.store.add(aRecipe({ name: "Soup" }));
  h.store.remove(saved.id);

  // The server still holds the live recipe, from before the delete.
  const { recipes, tombstones, toPush } = h.sync.merge([h.row(saved, saved.updatedAt)]);

  assert.equal(recipes.length, 0, "it stays deleted");
  assert.equal(tombstones.length, 1);
  assert.equal(toPush.length, 1);
  assert.ok(toPush[0].deleted_at, "the delete is sent as a tombstone, not a removal");
});

test("J9.4 · a delete from another device removes it here", () => {
  const h = harness();
  const saved = h.store.add(aRecipe({ name: "Soup" }));

  const { recipes, tombstones } = h.sync.merge([
    h.row(saved, saved.updatedAt, saved.updatedAt + 5000),
  ]);

  assert.equal(recipes.length, 0);
  assert.equal(tombstones.length, 1, "and is remembered, so it cannot come back");
});

test("J9.3 · an edit made after someone else's delete wins", () => {
  const h = harness();
  const saved = h.store.add(aRecipe({ name: "Soup" }));
  h.store.update(saved.id, { ...saved, name: "Rescued" });
  const local = h.store.getById(saved.id);

  const { recipes } = h.sync.merge([h.row(saved, local.updatedAt - 9000, local.updatedAt - 5000)]);

  assert.deepEqual(recipes.map((r) => r.name), ["Rescued"]);
});

test("a hostile row from the server is sanitised, not trusted", () => {
  const h = harness();
  const id = "33333333-3333-4333-8333-333333333333";
  const { recipes } = h.sync.merge([{
    id,
    data: { name: "Bad", ingredients: [{ amount: 1, unit: "g", item: "x" }], steps: ["s"],
            image: "javascript:alert(1)", tags: Array(5000).fill("t") },
    updated_at: iso(Date.now()),
    deleted_at: null,
  }]);

  assert.equal(recipes[0].image, "", "a javascript: image never reaches the page");
  assert.equal(recipes[0].tags.length, 50, "and the row is bounded");
});

test("a server row that is not a usable recipe is discarded rather than rendered", () => {
  const h = harness();
  const { recipes } = h.sync.merge([{
    id: "44444444-4444-4444-8444-444444444444",
    data: { name: "", ingredients: [], steps: [] },
    updated_at: iso(Date.now()),
    deleted_at: null,
  }]);
  assert.equal(recipes.length, 0);
});

test("recipes come back newest first", () => {
  const h = harness();
  const now = Date.now();
  const mk = (name, n) => ({ ...aRecipe({ name }), id: `5555555${n}-5555-4555-8555-555555555555` });
  const a = mk("Oldest", 1), b = mk("Newest", 2), c = mk("Middle", 3);

  const { recipes } = h.sync.merge([
    h.row(a, now - 10000), h.row(b, now), h.row(c, now - 5000),
  ]);

  assert.deepEqual(recipes.map((r) => r.name), ["Newest", "Middle", "Oldest"]);
});

test("J9.6 · a full sync applies the merge and reports what happened", async () => {
  const h = harness();
  h.store.add(aRecipe({ name: "Mine" }));
  h.setRemote([]);

  const result = await h.sync.syncNow();

  assert.equal(result.pushed, 1);
  assert.equal(h.calls.upserted.length, 1);
  assert.deepEqual(h.statuses, ["syncing", "synced"]);
});

test("J9.5, J9.6 · a failed sync says so and stays pending for a retry", async () => {
  const h = harness();
  h.store.add(aRecipe({ name: "Mine" }));
  h.breakNetwork(new Error("offline"));

  const result = await h.sync.syncNow();

  assert.equal(result, null);
  assert.equal(h.sync.pending, true, "it will try again rather than giving up");
  assert.deepEqual(h.statuses, ["syncing", "error"]);
  assert.equal(h.store.recipes.length, 1, "and the local copy is untouched");
});

test("a sync already running is not started twice", async () => {
  const h = harness();
  h.sync.running = true;
  assert.equal(await h.sync.syncNow(), undefined);
  assert.equal(h.calls.selected, 0);
});

test("J9.7 · each book caches separately, so switching never mixes them", () => {
  const h = harness();
  h.store.add(aRecipe({ name: "In first book" }));

  const OTHER = "66666666-6666-4666-8666-666666666666";
  h.store.useBook(OTHER);
  assert.deepEqual(h.store.recipes, [], "the other book starts empty");
  h.store.add(aRecipe({ name: "In second book" }));

  h.store.useBook(BOOK);
  assert.deepEqual(h.store.recipes.map((r) => r.name), ["In first book"]);
});

test("J9.1 · the browser's copy is the working copy, so the app works with no network at all", () => {
  const h = harness();
  h.store.add(aRecipe({ name: "Written offline" }));
  // No sync has ever run and no client has ever answered.
  assert.equal(h.calls.selected, 0);
  assert.deepEqual(h.store.recipes.map((r) => r.name), ["Written offline"]);
  assert.equal(h.store.getById(h.store.recipes[0].id).name, "Written offline");
});

test("J9.2 · rapid edits are coalesced into one round trip, not one each", async () => {
  const h = harness();
  h.setRemote([]);
  for (let i = 0; i < 5; i++) h.sync.schedulePush();

  assert.equal(h.sync.pending, true, "there is work waiting");
  assert.equal(h.calls.selected, 0, "and none of it has gone out yet");

  // One timer, however many edits: firing it once drains them all.
  await h.sync.syncNow();
  assert.equal(h.calls.selected, 1, "five edits, one round trip");
});
