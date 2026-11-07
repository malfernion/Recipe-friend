/**
 * js/lists.js — a book's lists, their items, and how two copies meet (J18).
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp, aRecipe } = require("./helpers/load.js");

const win = loadApp("units.js", "scale.js", "lists.js");
const L = win.RecipeLists;

const BOOK = "11111111-1111-4111-8111-111111111111";
const DEV_A = "deviceAAAA01";
const DEV_B = "deviceBBBB02";

/** A list with items typed out top to bottom, returned with their ids. */
function typed(kind, ...texts) {
  let list = L.createList({ name: "Shopping", kind, now: 1000 });
  let last = null;
  const ids = [];
  texts.forEach((text, i) => {
    const id = L.newId();
    list = L.addItem(list, { text, afterId: last, id, now: 2000 + i });
    ids.push(id);
    last = id;
  });
  return { list, ids };
}

const texts = (list, open) =>
  L.rows(list, open).map((r) => (r.type === "item" ? `${"  ".repeat(r.depth)}${r.item.text}` : `${"  ".repeat(r.depth)}[Ticked (${r.count})]`));

// ---------------------------------------------------------------------
// Order keys
// ---------------------------------------------------------------------

test("order keys: always strictly between, and short when typing a list out", () => {
  let key = null;
  const keys = [];
  for (let i = 0; i < 300; i++) keys.push((key = L.keyBetween(key, null)));
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1] < keys[i]);
  assert.ok(keys[keys.length - 1].length <= 10, keys[keys.length - 1]);

  let top = "V";
  for (let i = 0; i < 100; i++) {
    const next = L.keyBetween(null, top);
    assert.ok(next < top && !next.endsWith("0"));
    top = next;
  }
  let lo = "V";
  let hi = "W";
  for (let i = 0; i < 50; i++) {
    const mid = L.keyBetween(lo, hi);
    assert.ok(lo < mid && mid < hi, `${lo} < ${mid} < ${hi}`);
    if (i % 2) lo = mid;
    else hi = mid;
  }
  assert.equal(L.keyBetween(null, null), "V");
  assert.ok(L.keyBetween("X", "X") > "X", "equal neighbours: just after");
});

// ---------------------------------------------------------------------
// Lists and items
// ---------------------------------------------------------------------

test("J18.2 · a list is a checklist or a stock list", () => {
  assert.equal(L.createList({ name: "Freezer", kind: "stock" }).kind, "stock");
  assert.throws(() => L.createList({ name: "X", kind: "todo" }));
  assert.equal(L.sanitizeList({ id: L.newId(), name: "X", kind: "todo", items: [] }), null);
});

test("J18.3 · a list can be renamed; the later name wins a merge", () => {
  const list = L.createList({ name: "Shopping", kind: "checklist", now: 10 });
  const a = L.rename(list, "Groceries", 20);
  const b = L.rename(list, "Big shop", 30);
  assert.equal(L.mergeLists(a, b).name, "Big shop");
  assert.equal(L.mergeLists(b, a).name, "Big shop");
  assert.equal(L.rename(a, "  "), a, "an empty name is no change");
});

test("J18.7 · Enter makes the next item directly below, at the same depth", () => {
  let { list, ids } = typed("checklist", "milk", "eggs", "bread");
  list = L.addItem(list, { text: "butter", afterId: ids[0] });
  assert.deepEqual(texts(list), ["milk", "butter", "eggs", "bread"]);
  list = L.indent(list, ids[1]); // eggs under butter
  const id = L.newId();
  list = L.addItem(list, { text: "free range", afterId: ids[1], id });
  assert.deepEqual(texts(list), ["milk", "butter", "  eggs", "  free range", "bread"]);
  // An empty line is allowed: Enter makes it before anything is typed.
  const blank = L.addItem(list, { afterId: id });
  assert.equal(L.liveItems(blank).length, 6);
});

test("J18.6 · editing: line breaks become spaces, and empty or unchanged writes nothing", () => {
  const { list, ids } = typed("checklist", "milk");
  const edited = L.editText(list, ids[0], "semi-skimmed\nmilk", 5000);
  assert.equal(edited.items[0].text, "semi-skimmed milk");
  assert.equal(L.editText(edited, ids[0], "semi-skimmed milk"), edited);
  assert.equal(L.editText(edited, ids[0], "   "), edited);
});

test("J18.8 · indent puts an item under the one above; outdent brings it back after its parent", () => {
  let { list, ids } = typed("checklist", "Top drawer", "peas", "chips", "Bottom drawer");
  list = L.indent(list, ids[1]);
  list = L.indent(list, ids[2]);
  assert.deepEqual(texts(list), ["Top drawer", "  peas", "  chips", "Bottom drawer"]);
  assert.equal(L.indent(list, ids[1]), list, "nothing above it at its depth");
  list = L.indent(list, ids[2]); // chips under peas
  assert.deepEqual(texts(list), ["Top drawer", "  peas", "    chips", "Bottom drawer"]);
  // What is nested moves with it.
  list = L.outdent(list, ids[1]);
  assert.deepEqual(texts(list), ["Top drawer", "peas", "  chips", "Bottom drawer"]);
  assert.equal(L.outdent(list, ids[1]), list, "already at the top");
});

test("J18.9 · moving by drag, never under itself", () => {
  let { list, ids } = typed("checklist", "a", "b", "c", "d");
  list = L.move(list, ids[3], { beforeId: ids[0] });
  assert.deepEqual(texts(list), ["d", "a", "b", "c"]);
  list = L.move(list, ids[0], { afterId: ids[2] });
  assert.deepEqual(texts(list), ["d", "b", "c", "a"]);
  list = L.move(list, ids[2], { parentId: ids[1] });
  assert.deepEqual(texts(list), ["d", "b", "  c", "a"]);
  assert.equal(L.move(list, ids[1], { parentId: ids[2] }), list, "not under its own child");
  list = L.move(list, ids[3], { atTop: true, parentId: ids[1] });
  assert.deepEqual(texts(list), ["b", "  d", "  c", "a"]);
});

test("J18.10 · deleting takes what is nested, and Undo brings back exactly that", () => {
  let { list, ids } = typed("checklist", "Curry", "onions", "rice");
  list = L.indent(list, ids[1]);
  const gone = L.subtree(list, ids[0]);
  assert.deepEqual(gone.sort(), [ids[0], ids[1]].sort());
  const after = L.deleteItems(list, gone, 9000);
  assert.deepEqual(texts(after), ["rice"]);
  assert.equal(after.items.length, 3, "tombstones are kept");
  assert.deepEqual(texts(L.restoreItems(after, gone, 9001)), ["Curry", "  onions", "rice"]);
});

test("J9.4 · a deleted item stays deleted when an older copy meets it", () => {
  const { list, ids } = typed("checklist", "milk", "eggs");
  const older = L.editText(list, ids[0], "oat milk", 3000);
  const deleted = L.deleteItems(list, [ids[0]], 4000);
  assert.deepEqual(texts(L.mergeLists(older, deleted)), ["eggs"]);
  assert.deepEqual(texts(L.mergeLists(deleted, older)), ["eggs"]);
});

test("an item nested under one deleted elsewhere is not lost", () => {
  const { list, ids } = typed("checklist", "Curry", "rice");
  const nested = L.move(list, ids[1], { parentId: ids[0] }, 5000);
  const deleted = L.deleteItems(list, [ids[0]], 5000);
  assert.deepEqual(texts(L.mergeLists(nested, deleted)), ["rice"]);
});

test("two phones' moves making a loop still draw every item, the same on both", () => {
  const { list, ids } = typed("checklist", "a", "b");
  const one = L.move(list, ids[0], { parentId: ids[1] }, 5000);
  const two = L.move(list, ids[1], { parentId: ids[0] }, 5000);
  const merged = L.mergeLists(one, two);
  assert.equal(L.rows(merged).length, 2);
  assert.deepEqual(texts(merged), texts(L.mergeLists(two, one)));
});

// ---------------------------------------------------------------------
// Checklists
// ---------------------------------------------------------------------

test("J18.11 · ticking ticks what is nested; unticking unticks it and brings it back", () => {
  let { list, ids } = typed("checklist", "Curry", "onions", "rice", "milk");
  list = L.indent(list, ids[1]);
  list = L.indent(list, ids[2]);
  list = L.setTicked(list, ids[0], true, 6000);
  assert.ok(list.items.filter((i) => [ids[0], ids[1], ids[2]].includes(i.id)).every((i) => i.ticked));
  assert.deepEqual(texts(list), ["milk", "[Ticked (1)]"]);
  // Unticking one ingredient brings it back where it was, under its recipe.
  list = L.setTicked(list, ids[2], false, 6001);
  assert.deepEqual(texts(list), ["Curry", "  rice", "  [Ticked (1)]", "milk"]);
});

test("J18.12 · ticked items fold to the bottom of whatever they are in, and open on request", () => {
  let { list, ids } = typed("checklist", "Curry", "onions", "rice", "milk", "eggs");
  list = L.indent(list, ids[1]);
  list = L.indent(list, ids[2]);
  list = L.setTicked(list, ids[1], true);
  list = L.setTicked(list, ids[3], true);
  assert.deepEqual(texts(list), ["Curry", "  rice", "  [Ticked (1)]", "eggs", "[Ticked (1)]"]);
  assert.deepEqual(texts(list, new Set(["", ids[0]])), [
    "Curry",
    "  rice",
    "  [Ticked (1)]",
    "  onions",
    "eggs",
    "[Ticked (1)]",
    "milk",
  ]);
  const unticked = L.setTicked(list, ids[3], false);
  assert.deepEqual(texts(unticked), ["Curry", "  rice", "  [Ticked (1)]", "milk", "eggs"], "back where it was");
});

test("J18.13 · Clear ticked deletes every ticked item and what is under it, with an Undo", () => {
  let { list, ids } = typed("checklist", "Curry", "onions", "milk", "eggs");
  list = L.indent(list, ids[1]);
  list = L.setTicked(list, ids[0], true);
  list = L.setTicked(list, ids[2], true);
  const cleared = L.tickedIds(list);
  assert.equal(cleared.length, 3);
  const after = L.deleteItems(list, cleared);
  assert.deepEqual(texts(after), ["eggs"]);
  assert.deepEqual(texts(L.restoreItems(after, cleared)), ["eggs", "[Ticked (2)]"], "Undo");
});

test("J18.23 · an edit on one phone and a tick on the other both survive", () => {
  const { list, ids } = typed("checklist", "6 eggs");
  const a = L.editText(list, ids[0], "7 eggs", 7000);
  const b = L.setTicked(list, ids[0], true, 7000);
  for (const merged of [L.mergeLists(a, b), L.mergeLists(b, a)]) {
    assert.equal(merged.items[0].text, "7 eggs");
    assert.equal(merged.items[0].ticked, true);
  }
});

// ---------------------------------------------------------------------
// Stock lists
// ---------------------------------------------------------------------

test("J18.14, J18.15 · a counter starts at 1, steps by one, stays at 0 faded", () => {
  let { list, ids } = typed("stock", "Bolognese");
  assert.equal(L.rows(list)[0].counter, 1);
  list = L.bump(list, ids[0], +1, DEV_A);
  assert.equal(L.rows(list)[0].counter, 2);
  list = L.bump(L.bump(list, ids[0], -1, DEV_A), ids[0], -1, DEV_A);
  assert.equal(L.rows(list)[0].counter, 0);
  assert.equal(L.rows(list)[0].faded, true);
  assert.equal(L.bump(list, ids[0], -1, DEV_A), list, "never below 0");
  assert.equal(L.liveItems(list).length, 1, "0 does not take it off");
});

test("J18.16 · an item with something under it is a heading with no counter, until that goes", () => {
  let { list, ids } = typed("stock", "Top drawer", "peas");
  list = L.bump(list, ids[0], +1, DEV_A); // 2 before it became a heading
  list = L.indent(list, ids[1]);
  const heading = L.rows(list)[0];
  assert.equal(heading.counter, null);
  assert.equal(L.bump(list, ids[0], +1, DEV_A), list, "a heading cannot be counted");
  list = L.deleteItems(list, [ids[1]]);
  assert.equal(L.rows(list)[0].counter, 2, "its counter comes back");
});

test("J18.17 · two phones each taking one off Bolognese 4 leave 2, not 3", () => {
  let { list, ids } = typed("stock", "Bolognese");
  for (let i = 0; i < 3; i++) list = L.bump(list, ids[0], +1, DEV_A);
  assert.equal(L.count(list.items[0]), 4);
  const a = L.bump(list, ids[0], -1, DEV_A);
  const b = L.bump(list, ids[0], -1, DEV_B);
  assert.equal(L.count(L.mergeLists(a, b).items[0]), 2);
  assert.equal(L.count(L.mergeLists(b, a).items[0]), 2);
  assert.equal(L.count(L.mergeLists(L.mergeLists(a, b), a).items[0]), 2, "meeting again counts nothing twice");
});

test("J18.15 · both phones taking the last one leave 0, and + from there shows 1", () => {
  const { list, ids } = typed("stock", "Peas");
  const merged = L.mergeLists(L.bump(list, ids[0], -1, DEV_A), L.bump(list, ids[0], -1, DEV_B));
  assert.equal(L.count(merged.items[0]), 0);
  assert.equal(L.count(L.bump(merged, ids[0], +1, DEV_A).items[0]), 1);
});

test("a counter is refused on a checklist, and from a device with no id", () => {
  const { list, ids } = typed("checklist", "milk");
  assert.equal(L.bump(list, ids[0], +1, DEV_A), list);
  const stock = typed("stock", "peas");
  assert.equal(L.bump(stock.list, stock.ids[0], +1, ""), stock.list);
});

// ---------------------------------------------------------------------
// Merge laws
// ---------------------------------------------------------------------

/** Three copies of one list that each went their own way. */
function threeWays() {
  let { list, ids } = typed("stock", "Peas", "Chips", "Fish", "Ice");
  list = L.bump(list, ids[0], +1, DEV_A);
  const a = [
    (l) => L.editText(l, ids[0], "Frozen peas", 9000),
    (l) => L.bump(l, ids[1], -1, DEV_A),
    (l) => L.indent(l, ids[2], 9001),
    (l) => L.rename(l, "Freezer", 9002),
  ].reduce((l, f) => f(l), list);
  const b = [
    (l) => L.editText(l, ids[0], "Petits pois", 9000),
    (l) => L.bump(l, ids[1], -1, DEV_B),
    (l) => L.deleteItems(l, [ids[3]], 9100),
    (l) => L.addItem(l, { text: "Fish fingers", afterId: ids[2], now: 9200 }),
  ].reduce((l, f) => f(l), list);
  const c = [
    (l) => L.move(l, ids[3], { atTop: true }, 9500),
    (l) => L.bump(l, ids[0], +1, "deviceCCCC03"),
    (l) => L.addItem(l, { text: "Fish fingers", afterId: ids[2], now: 9200 }),
    (l) => L.rename(l, "Chest freezer", 9002),
  ].reduce((l, f) => f(l), list);
  return [a, b, c];
}

const json = (l) => JSON.stringify(l);

test("J18.22 · merging is commutative, associative and idempotent", () => {
  const [a, b, c] = threeWays();
  const M = L.mergeLists;
  assert.equal(json(M(a, b)), json(M(b, a)));
  assert.equal(json(M(M(a, b), c)), json(M(a, M(b, c))));
  assert.equal(json(M(M(a, c), b)), json(M(M(b, c), a)));
  assert.equal(json(M(a, a)), json(L.sanitizeList(a)));
  const all = M(M(a, b), c);
  assert.equal(json(M(all, b)), json(all));
  // And it is what the facts say.
  assert.equal(all.name, "Freezer");
  assert.equal(L.liveItems(all).length, 5, "two adds of the same words are two items (J18.20)");
  assert.equal(L.count(all.items.find((i) => i.text === "Chips")), 0);
});

test("a list read back is the same list: sanitising is idempotent and canonical", () => {
  const [a] = threeWays();
  const once = L.sanitizeList(JSON.parse(json(a)));
  assert.equal(json(L.sanitizeList(once)), json(once));
  const shuffled = { ...a, items: [...a.items].reverse() };
  assert.equal(json(L.sanitizeList(shuffled)), json(once));
});

test("hostile input is coerced, not believed", () => {
  const id = L.newId();
  const list = L.sanitizeList({
    id,
    name: "x".repeat(500),
    kind: "checklist",
    items: [
      null,
      { id: "not-a-uuid", text: "drop me" },
      { id: L.newId(), text: "a\ud800b", parentId: "x", order: "!!", tally: [["__proto__", 5, 5]], posAt: 1e20 },
      ...Array.from({ length: 600 }, (_, i) => ({ id: L.newId(), text: `t${i}`, gone: i % 2 === 0, goneAt: i })),
    ],
  });
  assert.equal(list.name.length, L.limits.MAX_NAME_CHARS);
  assert.equal(list.items.length, L.limits.MAX_ITEMS);
  const odd = list.items.find((i) => i.text === "ab");
  assert.equal(odd.parentId, null);
  assert.equal(odd.order, "V");
  assert.deepEqual(odd.tally, []);
  assert.ok(odd.posAt <= Date.UTC(2200, 0, 1));
  assert.equal(L.liveItems(list).length, 301, "every live item is kept before any tombstone");
});

test("a list at every cap fits inside what the server accepts", () => {
  const emoji = "🍝".repeat(L.limits.MAX_TEXT_CHARS / 2);
  const cjk = "麵".repeat(L.limits.MAX_TEXT_CHARS);
  const items = Array.from({ length: L.limits.MAX_ITEMS }, (_, i) => ({
    id: L.newId(),
    parentId: L.newId(),
    order: "z".repeat(L.limits.MAX_KEY_CHARS - 1) + "y",
    text: i % 2 ? emoji : cjk,
    addedAt: Date.UTC(2199, 0, 1),
    posAt: Date.UTC(2199, 0, 1),
    textAt: Date.UTC(2199, 0, 1),
    tickAt: Date.UTC(2199, 0, 1),
    goneAt: Date.UTC(2199, 0, 1),
    ticked: true,
    tally: Array.from({ length: L.limits.MAX_DEVICES }, (_, d) => [`device${String(d).padStart(17, "x")}`, 99999, 99999]),
  }));
  const list = L.sanitizeList({ id: L.newId(), name: "x", kind: "stock", items });
  const bytes = Buffer.byteLength(JSON.stringify(list.items));
  // jsonb is larger than JSON text by its per-element headers; a third
  // more is well past that for objects of this shape.
  assert.ok(bytes * 1.34 <= L.limits.SERVER_MAX_BYTES, `${bytes} bytes of JSON`);
});

// ---------------------------------------------------------------------
// A recipe as items, and the plan as a list
// ---------------------------------------------------------------------

test("J18.18 · a recipe is one item with its ingredients under it, scaled and in the reader's units", () => {
  const recipe = aRecipe({
    name: "Pancakes",
    servings: 4,
    ingredients: [
      { amount: 200, unit: "g", item: "flour" },
      { amount: 2, unit: "", item: "eggs" },
      { amount: null, unit: "", item: "salt" },
    ],
  });
  const tree = L.recipeItems(recipe, 8, { mass: "imperial" });
  assert.equal(tree.text, "Pancakes");
  assert.deepEqual(
    tree.children.map((c) => c.text),
    ["14⅛ oz flour", "4 eggs", "salt"]
  );
  // No servings: portions is the multiplier.
  const noServings = L.recipeItems({ ...recipe, servings: null }, 1.5, {});
  assert.equal(noServings.children[0].text, "300 g flour");

  let list = L.createList({ name: "Shopping", kind: "checklist" });
  list = L.addItem(list, { text: "milk" });
  list = L.addTree(list, tree, { atTop: true });
  assert.deepEqual(texts(list), ["Pancakes", "  14⅛ oz flour", "  4 eggs", "  salt", "milk"]);
  // J18.20: again is a second item.
  list = L.addTree(list, tree, { atTop: true });
  assert.equal(L.children(list).length, 3);
});

test("build step 1 · the plan becomes the Shopping checklist, the same on every device", () => {
  const recipe = { ...aRecipe({ name: "Curry", servings: 2 }), id: L.newId() };
  const plan = {
    id: L.newId(),
    createdAt: 100,
    meals: [
      { id: L.newId(), recipeId: recipe.id, name: "Curry", portions: 4, multiplier: null, addedAt: 200 },
      { id: L.newId(), recipeId: L.newId(), name: "Gone recipe", portions: 2, addedAt: 210 },
    ],
    items: [
      { id: L.newId(), text: "milk", textAt: 300, addedAt: 300, state: "", at: 300 },
      { id: L.newId(), text: "eggs", textAt: 301, addedAt: 301, state: "got", at: 400 },
      { id: L.newId(), text: "jam", textAt: 302, addedAt: 302, state: "removed", at: 401 },
    ],
  };
  const one = L.fromPlan(plan, [recipe], BOOK, {});
  const two = L.fromPlan(JSON.parse(JSON.stringify(plan)), [recipe], BOOK.toUpperCase(), {});
  assert.equal(json(one), json(two), "deterministic: ids and stamps come from the plan");
  assert.equal(one.id, L.shoppingListId(BOOK));
  assert.notEqual(one.id, L.shoppingListId("22222222-2222-4222-8222-222222222222"));
  assert.equal(one.name, "Shopping");
  assert.equal(one.kind, "checklist");
  assert.deepEqual(texts(one), ["Curry", "  2 l stock", "Gone recipe", "milk", "[Ticked (1)]"]);
  assert.equal(one.items.find((i) => i.id === plan.meals[0].id).text, "Curry");
  // Merging two devices' moves is a no-op.
  assert.equal(json(L.mergeLists(one, two)), json(one));
  // An empty plan is an empty Shopping list.
  assert.equal(L.fromPlan(null, [], BOOK, {}).items.length, 0);
});

test("derived ids are uuids, stable, and differ by input", () => {
  const a = L.derivedId("x", 1);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(a, L.derivedId("x", 1));
  assert.notEqual(a, L.derivedId("x", 2));
});
