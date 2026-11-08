/**
 * mcp/tools-lists.js — an agent working on the book's lists (J18.25).
 *
 * Called through the harness's `call`, which pulls first as the server
 * does (J17.9). The server's lists are rows in the stub, written back
 * compare-and-set, so a "phone" can write between the agent's read and
 * its push and both are expected to survive (J18.23).
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { agentBook } = require("./helpers/agent.js");
const { openBook, agentDevice } = require("../mcp/book.js");
const tools = require("../mcp/tools-lists.js");

const by = (name) => tools.find((t) => t.name === name);
const GET = by("get_lists");
const ADD = by("add_to_list");
const EDIT = by("edit_list");

const SHOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FREEZER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MILK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EGGS = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BOL = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DRAWER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const PEAS = "12121212-1212-4212-8212-121212121212";

const PIE = {
  name: "Chicken pie",
  servings: 4,
  ingredients: [
    { amount: 500, unit: "g", item: "chicken" },
    { amount: 1, unit: "", item: "onion" },
  ],
  steps: ["Bake it."],
};
const DAL = { name: "Dal", ingredients: [{ amount: 200, unit: "g", item: "red lentils" }], steps: ["Simmer it."] };

/** Shopping: milk, eggs. Freezer: Bolognese (4), and a Top drawer holding peas. */
function lists() {
  const item = (id, text, order, more = {}) => ({ id, text, order, addedAt: 1000, posAt: 1000, textAt: 1000, ...more });
  return [
    { id: SHOP, name: "Shopping", kind: "checklist", createdAt: 1, items: [item(MILK, "milk", "V"), item(EGGS, "6 eggs", "W")] },
    {
      id: FREEZER,
      name: "Freezer",
      kind: "stock",
      createdAt: 2,
      items: [
        item(BOL, "Bolognese", "V", { tally: [["phoneAAAA001", 3, 0]] }),
        item(DRAWER, "Top drawer", "W"),
        item(PEAS, "peas", "V", { parentId: DRAWER }),
      ],
    },
  ];
}

const aBook = (over = {}) => agentBook({ recipes: [PIE, DAL], lists: lists(), ...over });
const texts = (list) => list.items.map((i) => "  ".repeat(i.depth) + i.text);
const full = async (call, name) => (await call(GET, { list: name })).list;
const see = async (call, name) => texts(await full(call, name));

// --- reading -----------------------------------------------------------

test("J18.25 · the agent sees every list in its book, and one in full as the phone draws it", async () => {
  const { call } = await aBook();

  const all = await call(GET);
  assert.deepEqual(all.lists, [
    { id: SHOP, name: "Shopping", kind: "checklist", items: 2, ticked: 0 },
    { id: FREEZER, name: "Freezer", kind: "stock", items: 3 },
  ]);
  assert.equal(all.list, undefined, "names first, a list in full only when asked");

  const freezer = (await call(GET, { list: "freezer" })).list;
  assert.deepEqual(freezer.items, [
    { itemId: BOL, text: "Bolognese", depth: 0, count: 4 },
    // J18.16: a heading has no counter.
    { itemId: DRAWER, text: "Top drawer", depth: 0 },
    { itemId: PEAS, text: "peas", depth: 1, parentId: DRAWER, count: 1 },
  ]);
  assert.equal((await call(GET, { list: SHOP })).list.name, "Shopping", "by id as well as by name");
});

test("J18.25 · a list that is not there says who makes lists, rather than inviting a try", async () => {
  const { call } = await aBook();
  const out = await call(ADD, { list: "Pantry", items: ["rice"] });
  assert.match(out.error, /no list called "Pantry"/);
  assert.match(out.error, /"Shopping", "Freezer"/);
  assert.match(out.error, /cannot make, rename or delete a list/);

  const empty = await agentBook({ lists: [] });
  assert.match((await empty.call(GET, { list: "Shopping" })).error, /no lists/);
});

// --- adding ------------------------------------------------------------

test("J18.5 · lines go on at the end in the order sent, and only items go up", async () => {
  const { call, sent, serverList } = await aBook();

  const out = await call(ADD, { list: "Shopping", items: ["bread", "  2 l   oat\nmilk "] });

  assert.deepEqual(out.added.map((i) => i.text), ["bread", "2 l oat milk"], "a line, as a person's is (J18.6)");
  assert.deepEqual((await see(call, "Shopping")), ["milk", "6 eggs", "bread", "2 l oat milk"]);
  assert.deepEqual(serverList(SHOP).items.filter((i) => !i.gone).length, 4, "what is reported is what the book holds");
  for (const u of sent.listUpdates) assert.deepEqual(Object.keys(u.fields).sort(), ["items", "pruned_to"], "never the name");
  assert.deepEqual(sent.listRefusals, []);
});

test("J18.8 · lines can be placed: under an item, directly below one, or at the top", async () => {
  const { call } = await aBook();

  let out = await call(ADD, { list: "Shopping", items: ["semi-skimmed", "whole"], parentId: MILK });
  assert.deepEqual((await see(call, "Shopping")), ["milk", "  semi-skimmed", "  whole", "6 eggs"]);
  out = await call(ADD, { list: "Shopping", items: ["butter"], afterId: MILK });
  assert.deepEqual((await see(call, "Shopping")), ["milk", "  semi-skimmed", "  whole", "butter", "6 eggs"]);
  out = await call(ADD, { list: "Shopping", items: ["tea"], atTop: true });
  assert.equal((await see(call, "Shopping"))[0], "tea");

  const wrong = await call(ADD, { list: "Shopping", items: ["x"], afterId: "not-an-item" });
  assert.match(wrong.error, /No item "not-an-item" is on Shopping/);
});

test("J17.11 · what arrives is checked: nothing, both, too many", async () => {
  const { call } = await aBook();
  assert.match((await call(ADD, { list: "Shopping" })).error, /either `items`/);
  assert.match((await call(ADD, { list: "Shopping", items: ["x"], recipeId: "y" })).error, /not both/);
  assert.match((await call(ADD, { list: "Shopping", items: [42, " "] })).error, /Nothing to add/);
  assert.match((await call(ADD, { list: "Shopping", items: Array(51).fill("x") })).error, /at most 50/);
  assert.match((await call(ADD, { items: ["x"] })).error, /Say which list/);
});

test("J18.25 · the agent is held to what a person is: a full list takes no more", async () => {
  const full = lists();
  full[0].items = Array.from({ length: 300 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    text: `thing ${i}`,
    order: "V" + String(i).padStart(3, "0").replace(/0/g, "1"),
  }));
  const { call, sent } = await agentBook({ lists: full });
  const out = await call(ADD, { list: "Shopping", items: ["one more"] });
  assert.deepEqual(out.added, []);
  assert.deepEqual(out.notAdded, ["one more"]);
  assert.match(out.note, /full — it holds 300 items/);
  assert.equal(sent.listUpdates.length, 0);
});

test("J18.18 · a recipe goes on a checklist at the top, its ingredients under it at the size asked", async () => {
  const { call, sent, idOf } = await aBook();

  const out = await call(ADD, { list: "shopping", recipeId: idOf("Chicken pie"), servings: 2 });

  assert.deepEqual((await see(call, "Shopping")).slice(0, 3), ["Chicken pie", "  250 g chicken", "  ½ onion"]);
  assert.deepEqual(out.recipe, { id: idOf("Chicken pie"), name: "Chicken pie", servings: 2 });
  assert.equal(out.added.length, 3);
  assert.equal(out.added[0].depth, 0);
  // Recorded as planned, as a person's "+ List" records it (J18.21, J16.4).
  assert.equal(out.planned, true);
  assert.equal(sent.archived.length, 1);
  assert.deepEqual(sent.archived[0].meals.map((m) => [m.recipeId, m.portions]), [[idOf("Chicken pie"), 2]]);
  // A write answers with what it did and the list's size, not the list.
  assert.equal(out.list.items, 5);
  assert.match(out.summary, /^Added 3 items \(Chicken pie\)\. Shopping now holds 5 items, 0 ticked\.$/);

  const twice = await call(ADD, { list: "Shopping", recipeId: idOf("Chicken pie"), multiplier: 2 });
  assert.deepEqual(twice.recipe.servings, 8, "a multiplier works on a recipe that says what it serves");
  assert.equal((await see(call, "Shopping"))[1], "  1000 g chicken");
  assert.equal((await see(call, "Shopping")).filter((t) => t === "Chicken pie").length, 2, "each add its own item (J18.20)");
});

test("J18.18 · a recipe's size is asked the two ways a recipe can be sized, and only on a checklist", async () => {
  const { call, idOf } = await aBook();

  assert.match((await call(ADD, { list: "Shopping", recipeId: idOf("Dal"), servings: 4 })).error, /does not say what it serves/);
  const dal = await call(ADD, { list: "Shopping", recipeId: idOf("Dal"), multiplier: 1.5 });
  assert.equal((await see(call, "Shopping"))[1], "  300 g red lentils");
  assert.deepEqual(dal.recipe.multiplier, 1.5);
  assert.match((await call(ADD, { list: "Freezer", recipeId: idOf("Dal") })).error, /stock list; a recipe goes onto a checklist/);
  assert.match((await call(ADD, { list: "Shopping", recipeId: "nope" })).error, /No recipe with id "nope"/);
  assert.match((await call(ADD, { list: "Shopping", recipeId: idOf("Dal"), multiplier: "lots" })).error, /multiplier must be/);
});

// --- editing -----------------------------------------------------------

test("J17.14 · an edit says what it read, and a person's change since is not written over", async () => {
  const { call, phone } = await aBook();

  let out = await call(EDIT, { list: "Shopping", changes: [{ itemId: EGGS, text: "7 eggs", was: "6 eggs" }] });
  assert.deepEqual(out.edited, [{ itemId: EGGS, text: "7 eggs", depth: 0, ticked: false }]);

  phone(SHOP, (l, L) => L.editText(l, MILK, "oat milk", Date.now() + 5));
  out = await call(EDIT, {
    list: "Shopping",
    changes: [
      { itemId: MILK, text: "whole milk", was: "milk" },
      { itemId: EGGS, text: "8 eggs" },
      { itemId: EGGS, text: "  ", was: "7 eggs" },
      { itemId: "gone-id", text: "x", was: "y" },
    ],
  });
  assert.deepEqual(out.changedSince, [{ itemId: MILK, now: "oat milk" }]);
  assert.deepEqual(out.notEdited.map((n) => n.reason), [
    "Send `was`, the text you read, so a person's change is not written over.",
    "No text to change it to. To take an item off, use delete.",
  ]);
  assert.deepEqual(out.missing, ["gone-id"]);
  assert.deepEqual((await see(call, "Shopping")), ["oat milk", "7 eggs"], "nothing written");
});

test("J18.11 · ticking an item ticks what is under it; a stock list has no ticks", async () => {
  const { call, idOf } = await aBook();
  const pie = (await call(ADD, { list: "Shopping", recipeId: idOf("Chicken pie") })).added[0].itemId;

  const out = await call(EDIT, { list: "Shopping", changes: [{ itemId: pie, ticked: true }] });
  assert.equal(out.edited[0].ticked, true);
  assert.ok((await full(call, "Shopping")).items.filter((i) => i.parentId === pie).every((i) => i.ticked), "its ingredients too");

  const stock = await call(EDIT, { list: "Freezer", changes: [{ itemId: BOL, ticked: true }] });
  assert.match(stock.notEdited[0].reason, /stock list: it has counts, not ticks/);
});

test("J18.17 · a count is set as the agent's own taps from what the counter shows", async () => {
  const { call, book, serverList } = await aBook();

  let out = await call(EDIT, { list: "Freezer", changes: [{ itemId: BOL, count: 2 }, { itemId: PEAS, by: 3 }] });
  assert.deepEqual(out.edited.map((i) => [i.text, i.count]), [["Bolognese", 2], ["peas", 4]]);
  const bol = serverList(FREEZER).items.find((i) => i.id === BOL);
  const device = book.listStore.deviceId;
  assert.deepEqual(bol.tally, [[device, 0, 2], ["phoneAAAA001", 3, 0]].sort((a, b) => (a[0] < b[0] ? -1 : 1)), "the phone's taps stand");

  out = await call(EDIT, {
    list: "Freezer",
    changes: [
      { itemId: BOL, by: -5 },
      { itemId: DRAWER, count: 3 },
      { itemId: PEAS, count: 2, by: 1 },
      { itemId: PEAS, count: 1.5 },
      { itemId: PEAS, count: 100000 },
    ],
  });
  assert.equal(out.edited.find((i) => i.itemId === BOL).count, 0, "never below 0 (J18.15)");
  assert.deepEqual(out.notEdited.map((n) => n.reason), [
    "It has items under it, so it is a heading and has no count.",
    "Send `count` or `by`, not both.",
    "A count is a whole number.",
    "A count is from 0 to 9999.",
  ]);
  const check = await call(EDIT, { list: "Shopping", changes: [{ itemId: MILK, count: 2 }] });
  assert.match(check.notEdited[0].reason, /checklist: it has ticks, not counts/);
});

test("J18.17 · the agent's counter device is one per agent, the same on every request", async () => {
  assert.equal(agentDevice("0b5c9a3e-1f2d-4c5b-8a9e-112233445566"), "agent0b5c9a3e1f");
  assert.match(agentDevice("0b5c9a3e-1f2d-4c5b-8a9e-112233445566"), /^[A-Za-z0-9]{8,16}$/);

  const first = await aBook();
  await first.call(EDIT, { list: "Freezer", changes: [{ itemId: BOL, by: 1 }] });
  // A second request is a second process's book, opened afresh.
  const again = await openBook(first.book.session, { api: first.api });
  await again.refresh();
  assert.equal(again.listStore.deviceId, first.book.listStore.deviceId);
  await EDIT.run(again, { list: "Freezer", changes: [{ itemId: BOL, by: 1 }] });
  const tally = first.serverList(FREEZER).items.find((i) => i.id === BOL).tally;
  assert.equal(tally.length, 2, "one slot for the phone, one for the agent");
  assert.equal(first.L.count({ tally }), 6);
});

test("J18.8, J18.9 · items move, nest and come back out, taking what is under them", async () => {
  const { call } = await aBook();
  await call(ADD, { list: "Shopping", items: ["oat"], parentId: MILK });

  let out = await call(EDIT, { list: "Shopping", changes: [{ itemId: MILK, move: { afterId: EGGS } }] });
  assert.deepEqual((await see(call, "Shopping")), ["6 eggs", "milk", "  oat"]);
  out = await call(EDIT, { list: "Shopping", changes: [{ itemId: MILK, nest: "in" }] });
  assert.deepEqual((await see(call, "Shopping")), ["6 eggs", "  milk", "    oat"]);
  out = await call(EDIT, { list: "Shopping", changes: [{ itemId: MILK, nest: "out" }, { itemId: MILK, move: { parentId: null, atTop: true } }] });
  assert.deepEqual((await see(call, "Shopping")), ["milk", "  oat", "6 eggs"]);

  const oat = (await full(call, "Shopping")).items[1].itemId;
  const bad = await call(EDIT, {
    list: "Shopping",
    changes: [
      { itemId: MILK, move: { parentId: oat } },
      { itemId: MILK, nest: "out" },
      { itemId: MILK, nest: "in" },
      { itemId: MILK, move: { afterId: "nowhere" } },
    ],
  });
  assert.deepEqual(bad.notEdited.map((n) => n.reason), [
    "An item cannot go under itself or under what is nested in it.",
    "It is already at the top level.",
    "There is nothing above it at its depth to go under.",
    "move names an item that is not on the list.",
  ]);
});

test("J18.10 · deleting an item takes what is nested under it, and says what went", async () => {
  const { call, serverList } = await aBook();

  const out = await call(EDIT, { list: "Freezer", changes: [{ itemId: DRAWER, delete: true }, { itemId: PEAS, text: "x", was: "peas" }] });
  assert.deepEqual(out.deleted, [{ itemId: DRAWER, text: "Top drawer", nested: 1 }]);
  assert.deepEqual(out.missing, [PEAS], "gone with it");
  assert.deepEqual((await see(call, "Freezer")), ["Bolognese"]);
  assert.ok(serverList(FREEZER).items.find((i) => i.id === DRAWER).gone, "a tombstone, so it cannot come back (J9.4)");

  const mixed = await call(EDIT, { list: "Freezer", changes: [{ itemId: BOL, delete: true, count: 2 }] });
  assert.match(mixed.notEdited[0].reason, /A delete goes alone/);
});

// --- converging with a phone (J18.23) ------------------------------------

test("J18.23 · a phone writing between the agent's read and its push: both keep what they did", async () => {
  const harness = await aBook();
  const { call, api, phone } = harness;
  const update = api.updateList.bind(api);
  let once = true;
  api.updateList = async (...args) => {
    if (once) {
      once = false;
      // The phone ticks milk and takes one Bolognese a moment before the
      // agent's write arrives, so the agent's compare-and-set misses.
      phone(SHOP, (l, L) => L.setTicked(l, MILK, true, Date.now() + 1));
    }
    return update(...args);
  };

  const out = await call(EDIT, { list: "Shopping", changes: [{ itemId: EGGS, text: "12 eggs", was: "6 eggs" }] });

  assert.deepEqual(out.edited.map((i) => i.text), ["12 eggs"]);
  const milk = (await full(call, "Shopping")).items.find((i) => i.itemId === MILK);
  assert.equal(milk.ticked, true, "the phone's tick survived the agent's edit");
  assert.equal(harness.serverList(SHOP).items.find((i) => i.id === EGGS).text, "12 eggs");
});

test("J18.17 · a phone taking one as the agent sets the count: both count", async () => {
  const harness = await aBook();
  const { call, api, phone } = harness;
  const update = api.updateList.bind(api);
  let once = true;
  api.updateList = async (...args) => {
    if (once) {
      once = false;
      phone(FREEZER, (l, L) => L.bump(l, BOL, -1, "phoneBBBB002"));
    }
    return update(...args);
  };

  const out = await call(EDIT, { list: "Freezer", changes: [{ itemId: BOL, count: 2 }] });

  // From 4: the agent's −2 and the phone's −1.
  assert.equal(out.edited[0].count, 1, "what is reported is what the book holds");
  assert.equal(harness.L.count(harness.serverList(FREEZER).items.find((i) => i.id === BOL)), 1);
});

test("J17.9 · a write that could not get in is reported as not saved, and does not go up later", async () => {
  const harness = await aBook();
  const { call, api, phone, sent } = harness;
  const update = api.updateList.bind(api);
  // Somebody writes before every one of the agent's attempts.
  api.updateList = async (...args) => {
    phone(SHOP, (l, L) => L.setTicked(l, MILK, !l.items.find((i) => i.id === MILK).ticked, Date.now() + 1));
    return update(...args);
  };
  const out = await call(ADD, { list: "Shopping", items: ["bread"] });
  assert.match(out.error, /did not get in. Nothing was saved/);

  api.updateList = update;
  await call(GET);
  assert.equal(sent.listUpdates.length, 0);
  assert.ok(!harness.serverList(SHOP).items.some((i) => i.text === "bread"), "not pushed by the next call's sync");
});

test("J17.5 · a push that fails is a sentence, and the change is not left to go up later", async () => {
  const harness = await aBook();
  harness.breakListPush("network");
  await assert.rejects(() => harness.call(ADD, { list: "Shopping", items: ["bread"] }), /Could not reach the book/);
  harness.mendNetwork();
  await harness.call(GET);
  assert.equal(harness.sent.listUpdates.length, 0);
  assert.equal(harness.book.listStore.get(SHOP).items.some((i) => i.text === "bread"), false);
});

test("J18.25 · an agent's sync never makes, renames or deletes a list, even one made since", async () => {
  const harness = await aBook();
  harness.addRemoteList({ id: "34343434-3434-4343-8343-343434343434", name: "Cupboard", kind: "stock", createdAt: 3, items: [] });
  harness.phone(SHOP, (l, L) => L.rename(l, "Groceries", Date.now()));

  const out = await harness.call(ADD, { list: "groceries", items: ["rice"] });

  assert.equal(out.list.name, "Groceries");
  assert.deepEqual((await harness.call(GET)).lists.map((l) => l.name), ["Groceries", "Freezer", "Cupboard"]);
  assert.deepEqual(harness.sent.listRefusals, [], "nothing the database would refuse was tried");
});

// --- what the review of #62 found ----------------------------------------

test("J17.9 · a phone writing between the agent's push and its read-back is not the agent failing", async () => {
  const harness = await aBook();
  const { call, api, phone } = harness;
  const update = api.updateList.bind(api);
  const fetchList = api.fetchList.bind(api);
  let wrote = false;
  api.updateList = async (...args) => (wrote = await update(...args));
  api.fetchList = async (...args) => {
    if (wrote) {
      wrote = false;
      phone(SHOP, (l, L) => L.setTicked(l, MILK, true, Date.now() + 1));
    }
    return fetchList(...args);
  };

  const out = await call(ADD, { list: "Shopping", items: ["bread"] });

  assert.equal(out.error, undefined, JSON.stringify(out));
  assert.deepEqual(out.added.map((i) => i.text), ["bread"]);
  assert.equal(harness.serverList(SHOP).items.filter((i) => i.text === "bread").length, 1, "once, with no retry asked for");
});

test("J17.9 · a sync whose plan half fails after the list went up reports the list as it landed", async () => {
  const harness = await aBook();
  const { call, idOf } = harness;
  await harness.book.refresh();
  harness.breakPlanHalf("network");

  const out = await ADD.run(harness.book, { list: "Shopping", items: ["bread"] });
  assert.deepEqual(out.added.map((i) => i.text), ["bread"], "it is there, so it is said to be");

  // The same for a recipe, whose record could not go with it.
  const pie = await ADD.run(harness.book, { list: "Shopping", recipeId: idOf("Chicken pie") });
  assert.equal(pie.added[0].text, "Chicken pie");
  assert.equal(pie.planned, false);
  assert.match(pie.plannedNote, /could not be recorded as planned/);

  harness.mendNetwork();
  const shop = await see(call, "Shopping");
  assert.equal(shop.filter((t) => t === "bread").length, 1, "and nobody was invited to add it twice");
  assert.deepEqual(harness.sent.archived, [], "a record not made is not made later behind the answer's back");
});

test("J18.11 · the call's own cascades are not blamed on another device", async () => {
  const { call } = await aBook();
  const semi = (await call(ADD, { list: "Shopping", items: ["semi-skimmed"], parentId: MILK })).added[0].itemId;

  // "Tick the milk, except the semi-skimmed": unticking a child unticks
  // its parent (J18.12), which is this call's doing.
  let out = await call(EDIT, { list: "Shopping", changes: [{ itemId: MILK, ticked: true }, { itemId: semi, ticked: false }] });
  assert.equal(out.notEdited, undefined, JSON.stringify(out.notEdited));
  assert.deepEqual(out.edited.map((i) => [i.text, i.ticked]), [["milk", false], ["semi-skimmed", false]]);

  out = await call(EDIT, {
    list: "Shopping",
    changes: [{ itemId: semi, text: "skimmed", was: "semi-skimmed" }, { itemId: MILK, delete: true }],
  });
  assert.equal(out.notEdited, undefined, JSON.stringify(out.notEdited));
  assert.deepEqual(out.deleted, [{ itemId: MILK, text: "milk", nested: 1 }]);
  assert.deepEqual(out.edited, []);
});

test("J17.13 · a write answers with what it touched and the list's size, not the whole list", async () => {
  const { call } = await aBook();
  const out = await call(EDIT, { list: "Shopping", changes: [{ itemId: MILK, ticked: true }] });
  assert.deepEqual(out.edited, [{ itemId: MILK, text: "milk", depth: 0, ticked: true }]);
  assert.deepEqual(out.list, { id: SHOP, name: "Shopping", kind: "checklist", items: 2, ticked: 1 });
  assert.equal(out.summary, "Changed 1 item. Shopping now holds 2 items, 1 ticked.");
});

test("J18.21 · the agent's recipe add shows in planning_history like a person's", async () => {
  const harness = await aBook();
  await harness.call(ADD, { list: "Shopping", recipeId: harness.idOf("Dal") });
  const history = await harness.call(require("../mcp/tools-read.js").find((t) => t.name === "planning_history"));
  const dal = history.recipes.find((r) => r.name === "Dal");
  assert.equal(dal.timesPlanned, 1);
  assert.ok(dal.lastPlanned);
});

test("moves that cannot be made, or that disagree with themselves, are refused in words", async () => {
  const { call } = await aBook();
  const oat = (await call(ADD, { list: "Shopping", items: ["oat"], parentId: MILK })).added[0].itemId;

  const out = await call(EDIT, {
    list: "Shopping",
    changes: [
      { itemId: MILK, move: { afterId: oat } },
      { itemId: EGGS, move: { parentId: MILK, afterId: EGGS } },
      { itemId: EGGS, move: { parentId: null, afterId: oat } },
    ],
  });
  assert.deepEqual(out.notEdited.map((n) => n.reason), [
    "An item cannot go under itself or under what is nested in it.",
    "An item cannot go under itself or under what is nested in it.",
    "afterId is not under parentId. Send one or the other.",
  ]);
  assert.deepEqual(out.edited, []);
  const add = await call(ADD, { list: "Shopping", items: ["x"], parentId: EGGS, afterId: oat });
  assert.match(add.error, /afterId is not under parentId/);
});

test("a change that changes nothing says so, alone or among others", async () => {
  const { call } = await aBook();
  let out = await call(EDIT, { list: "Shopping", changes: [{ itemId: MILK, ticked: false }] });
  assert.deepEqual(out.notEdited, [{ itemId: MILK, reason: "Already so." }]);
  out = await call(EDIT, {
    list: "Shopping",
    changes: [{ itemId: MILK, text: "milk", was: "milk" }, { itemId: EGGS, ticked: true }, { itemId: MILK, move: { atTop: true } }],
  });
  assert.deepEqual(out.notEdited, [{ itemId: MILK, reason: "Already so." }, { itemId: MILK, reason: "Already so." }]);
  assert.deepEqual(out.edited.map((i) => i.itemId), [EGGS]);
  out = await call(EDIT, { list: "Freezer", changes: [{ itemId: BOL, by: 0 }, { itemId: BOL, count: 4 }] });
  assert.deepEqual(out.notEdited.map((n) => n.reason), ["Already so.", "Already so."]);
});

test("J18.17 · the agent can always set any count from 0 to 9999, however often it swings", async () => {
  const { call, serverList, L } = await aBook();
  for (let round = 0; round < 15; round++) {
    for (const target of [9999, 0]) {
      const out = await call(EDIT, { list: "Freezer", changes: [{ itemId: BOL, count: target }] });
      assert.equal(out.notEdited, undefined, `round ${round}: ${JSON.stringify(out.notEdited)}`);
      assert.equal(out.edited[0].count, target, `round ${round}`);
    }
  }
  const bol = serverList(FREEZER).items.find((i) => i.id === BOL);
  assert.equal(L.count(bol), 0);
  assert.ok(bol.tally.length <= 4, "a few slots of its own, not one per change");
});
