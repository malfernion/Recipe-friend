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
    prunedTo: -5,
    items: [
      null,
      { id: "not-a-uuid", text: "drop me" },
      { id: L.newId(), text: "a\ud800b", parentId: "x", order: "!!", tally: [["__proto__", 5, 5]], posAt: 1e20, addedAt: 5000 },
      ...Array.from({ length: 1000 }, (_, i) => ({ id: L.newId(), text: `t${i}`, addedAt: i, gone: i % 2 === 0, goneAt: i + 1 })),
    ],
  });
  assert.equal(list.name.length, L.limits.MAX_NAME_CHARS);
  const odd = list.items.find((i) => i.text === "ab");
  assert.equal(odd.parentId, null);
  assert.equal(odd.order, "V");
  assert.deepEqual(odd.tally, []);
  assert.ok(odd.posAt <= Date.UTC(2200, 0, 1));
  assert.equal(L.liveItems(list).length, L.limits.MAX_HELD_LIVE, "the newest live items");
  assert.equal(list.items.filter((i) => i.gone).length, L.limits.MAX_GONE);
  assert.ok(list.prunedTo > 0, "tombstones over the cap raise the prune mark rather than vanish");
});

/** A list at every cap the client has: what the server must accept. */
function worstList() {
  const at = Date.UTC(2199, 0, 1);
  const item = (i, gone) => ({
    id: L.newId(),
    parentId: L.newId(),
    order: "z".repeat(L.limits.MAX_KEY_CHARS - 1) + "y",
    text: i % 2 ? "🍝".repeat(L.limits.MAX_TEXT_CHARS / 2) : "麵".repeat(L.limits.MAX_TEXT_CHARS),
    addedAt: at,
    posAt: at,
    textAt: at,
    tickAt: at,
    goneAt: at + i,
    gone,
    ticked: true,
    tally: Array.from({ length: L.limits.MAX_DEVICES }, (_, d) => [`dev${String(d).padStart(13, "x")}`, 99999, 99999]),
  });
  return L.sanitizeList({
    id: L.newId(),
    name: "x",
    kind: "stock",
    items: [
      ...Array.from({ length: L.limits.MAX_HELD_LIVE }, (_, i) => item(i, false)),
      ...Array.from({ length: L.limits.MAX_GONE }, (_, i) => item(i, true)),
    ],
  });
}

test("a list at every cap fits inside what the server accepts", () => {
  const list = worstList();
  assert.equal(list.items.length, L.limits.MAX_HELD_LIVE + L.limits.MAX_GONE);
  const bytes = Buffer.byteLength(JSON.stringify(list.items));
  // jsonb is larger than JSON text by its per-element headers; a third
  // more is well past that for objects of this shape.
  assert.ok(bytes * 1.34 <= L.limits.SERVER_MAX_BYTES, `${bytes} bytes of JSON`);
});

// ---------------------------------------------------------------------
// Tombstones are kept 30 days, then pruned behind a mark (J9.4)
// ---------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

test("J9.4 · a phone not opened for six weeks of shopping does not bring deleted items back", () => {
  const t0 = Date.UTC(2026, 0, 1);
  let a = L.createList({ name: "Shopping", kind: "checklist", now: t0 });
  const milk = L.newId();
  a = L.addItem(a, { text: "old milk", id: milk, now: t0 });
  const b = JSON.parse(JSON.stringify(a)); // the tablet, then left in a drawer
  a = L.deleteItems(a, [milk], t0 + 1000);
  for (let week = 1; week <= 6; week++) {
    const now = t0 + week * 7 * DAY;
    for (let i = 0; i < 70; i++) a = L.addItem(a, { text: `w${week} ${i}`, now: now + i });
    a = L.deleteItems(a, L.liveItems(a).map((i) => i.id), now + 100);
    a = L.prune(a, now + 200);
  }
  assert.ok(a.prunedTo >= t0 + 1000, "the old tombstones are gone, behind the mark");
  assert.ok(!a.items.some((i) => i.id === milk), "nothing deleted kept for long");
  for (const merged of [L.mergeLists(a, b), L.mergeLists(b, a)]) {
    assert.deepEqual(L.liveItems(merged).map((i) => i.text), []);
  }
});

test("J9.4 · a phone back after 40 days: what it wrote since the mark arrives; older offline items do not", () => {
  const t0 = Date.UTC(2026, 0, 1);
  let server = L.createList({ name: "Shopping", kind: "checklist", now: t0 });
  server = L.addItem(server, { text: "kept", now: t0 });
  let phone = JSON.parse(JSON.stringify(server));
  // Offline: one item on the first day, one on the fortieth.
  phone = L.addItem(phone, { text: "old offline", now: t0 + 1 * DAY });
  phone = L.addItem(phone, { text: "new offline", now: t0 + 40 * DAY });
  // Meanwhile the book shops and deletes, and prunes what is a month old.
  server = L.addItem(server, { text: "bread", now: t0 + 2 * DAY });
  server = L.deleteItems(server, [L.liveItems(server).find((i) => i.text === "bread").id], t0 + 3 * DAY);
  server = L.prune(server, t0 + 40 * DAY);
  assert.equal(server.prunedTo, t0 + 3 * DAY);
  for (const merged of [L.mergeLists(server, phone), L.mergeLists(phone, server)]) {
    assert.deepEqual(L.liveItems(merged).map((i) => i.text).sort(), ["kept", "new offline"]);
  }
});

test("J18.10 · a tombstone is kept 30 days, so Undo and older copies still meet it", () => {
  const { list, ids } = typed("checklist", "milk");
  const gone = L.deleteItems(list, ids, 10 * DAY);
  assert.equal(L.prune(gone, 39 * DAY), gone, "29 days on: kept");
  const pruned = L.prune(gone, 41 * DAY);
  assert.equal(pruned.items.length, 0);
  assert.equal(pruned.prunedTo, 10 * DAY);
  assert.deepEqual(texts(L.mergeLists(list, pruned)), []);
});

test("J18.22 · merging stays lawful with prune marks and random histories", () => {
  const M = L.mergeLists;
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (let round = 0; round < 150; round++) {
    const base = typed(round % 2 ? "stock" : "checklist", "a", "b", "c").list;
    const replicas = [0, 1, 2].map((r) => {
      let l = JSON.parse(JSON.stringify(base));
      let now = 10 * DAY;
      for (let step = 0; step < 25; step++) {
        now += rand(4) * DAY + rand(1000);
        const live = L.liveItems(l);
        const pick = live.length ? live[rand(live.length)].id : null;
        const op = rand(7);
        if (op === 0 || !pick) l = L.addItem(l, { text: `r${r}s${step}`, afterId: pick, now });
        else if (op === 1) l = L.deleteItems(l, L.subtree(l, pick), now);
        else if (op === 2) l = L.prune(l, now);
        else if (op === 3) l = L.setTicked(l, pick, rand(2) === 0, now);
        else if (op === 4) l = L.bump(l, pick, rand(2) ? 1 : -1, `device${r}xxxx`);
        else if (op === 5) l = L.indent(l, pick, now);
        else l = L.editText(l, pick, `e${r}${step}`, now);
      }
      return l;
    });
    const [a, b, c] = replicas;
    assert.equal(json(M(a, b)), json(M(b, a)), `round ${round}: commutative`);
    assert.equal(json(M(M(a, b), c)), json(M(a, M(b, c))), `round ${round}: associative`);
    assert.equal(json(M(M(a, c), b)), json(M(a, M(c, b))), `round ${round}: associative`);
    assert.equal(json(M(a, a)), json(L.sanitizeList(a)), `round ${round}: idempotent`);
  }
});

// ---------------------------------------------------------------------
// Folding, counters with many devices, long keys
// ---------------------------------------------------------------------

test("J18.12 · an item added under a recipe ticked on another phone is not hidden, nor cleared", () => {
  let { list, ids } = typed("checklist", "Curry", "onions");
  list = L.indent(list, ids[1]);
  const ticked = L.setTicked(list, ids[0], true, 5000);
  // Phone b adds before it hears of the tick, so nothing is unticked there.
  const added = L.addItem(list, { text: "coriander", parentId: ids[0], now: 5000 });
  const merged = L.mergeLists(ticked, added);
  assert.equal(merged.items.find((i) => i.id === ids[0]).ticked, true);
  assert.deepEqual(texts(merged), ["Curry", "  coriander", "  [Ticked (1)]"]);
  const cleared = L.deleteItems(merged, L.tickedIds(merged));
  assert.deepEqual(texts(cleared, new Set([ids[0]])), ["Curry", "  coriander"], "only onions goes");
});

test("J18.7 · Enter inside an open Ticked group unticks what the new line is under", () => {
  let { list, ids } = typed("checklist", "Curry", "onions");
  list = L.indent(list, ids[1]);
  list = L.setTicked(list, ids[0], true);
  list = L.addItem(list, { text: "rice", afterId: ids[1] });
  assert.deepEqual(texts(list), ["Curry", "  rice", "  [Ticked (1)]"]);
  assert.equal(list.items.find((i) => i.id === ids[0]).ticked, false);
});

test("J18.17 · a counter tapped from many devices keeps every tap, in any order of meeting", () => {
  let seed = 3;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  for (const devices of [12, 24, 40]) {
    const { list, ids } = typed("stock", "Peas");
    let start = list;
    for (let i = 0; i < 150; i++) start = L.bump(start, ids[0], 1, "deviceSTART1");
    const replicas = [0, 1, 2].map((ri) => {
      let l = start;
      for (let d = ri; d < devices; d += 3) {
        const dev = `device${String(d).padStart(6, "0")}`;
        const taps = 1 + rand(3);
        for (let k = 0; k < taps; k++) l = L.bump(l, ids[0], rand(3) === 0 ? 1 : -1, dev);
      }
      return l;
    });
    const [a, b, c] = replicas;
    const orders = [
      L.mergeLists(L.mergeLists(a, b), c),
      L.mergeLists(L.mergeLists(a, c), b),
      L.mergeLists(L.mergeLists(b, c), a),
    ];
    const counts = orders.map((m) => L.count(m.items[0]));
    assert.equal(new Set(counts).size, 1, `${devices} devices: ${counts}`);
    // Every replica's taps, added up by hand: the merge lost none.
    const tapsOf = (r) => r.items[0].tally.filter(([d]) => d !== "deviceSTART1").reduce((t, [, p, m]) => t + p - m, 0);
    assert.equal(counts[0], 151 + tapsOf(a) + tapsOf(b) + tapsOf(c), `${devices} devices: no tap lost`);
    assert.equal(orders[0].items[0].tally.length, devices + 1);
  }
});

test("order keys stay short: a gap filled thousands of times is renumbered, in order", () => {
  let { list, ids } = typed("checklist", "first", "last");
  let first = ids[0];
  for (let i = 0; i < 3000; i++) {
    const id = L.newId();
    list = L.addItem(list, { text: `n${i}`, afterId: first, id, now: 10000 + i });
    list = L.deleteItems(list, [first], 10000 + i);
    first = id;
  }
  assert.deepEqual(texts(list), ["n2999", "last"]);
  assert.ok(list.items.every((i) => i.order.length <= L.limits.RESPACE_AT + 1));
  const many = typed("checklist", "a", "z");
  for (let i = 0; i < 250; i++) many.list = L.addItem(many.list, { text: `m${i}`, afterId: many.ids[0], now: 20000 + i });
  const drawn = texts(many.list);
  assert.equal(drawn[0], "a");
  assert.equal(drawn[1], "m249", "each lands directly below a");
  assert.equal(drawn[drawn.length - 1], "z");
  assert.ok(many.list.items.every((i) => i.order.length <= L.limits.RESPACE_AT + 1));
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
