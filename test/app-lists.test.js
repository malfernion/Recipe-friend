/**
 * J18 · Lists — the screens, driven through the app.
 *
 * The model (lists.js) and the store (liststore.js) have their own tests;
 * what is checked here is what a tap, a key or a swipe does to the list
 * underneath, and what the screen then says.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadUI, clickCrumb } = require("./helpers/load.js");

/** A loaded app, with a helper for everything a finger does to a list. */
function lists(options = {}) {
  const ui = loadUI(options);
  ui.app.render();
  const Lists = ui.win.RecipeLists;
  const content = ui.el("list-content");

  const api = {
    ...ui,
    Lists,
    // The row's "All lists" button, under the app bar (J18.27).
    openLists: () =>
      ui.el("lists-row").fire("click", {
        target: { closest: (sel) => (sel === "[data-home-lists]" ? {} : null) },
      }),
    /** Fill in the New list form and press Make. */
    make: (name, kind = "checklist") =>
      ui.el("lists-content").fire("submit", {
        target: {
          closest: (sel) =>
            sel === "[data-lists-new]"
              ? { elements: { name: { value: name, focus() {} }, kind: { value: kind } } }
              : null,
        },
      }),
    tapList: (id) =>
      ui.el("lists-content").fire("click", {
        target: { closest: (sel) => (sel === "[data-lists-open]" ? { dataset: { listsOpen: id } } : null) },
      }),
    list: () => ui.listStore.get(api.openId()),
    openId: () => {
      const m = /^#list\/(.+)$/.exec(ui.win.location.hash);
      return m ? m[1] : null;
    },
    /** The open list as drawn: "  [x] text" per row, folds as "Ticked (n)". */
    rows: (open) =>
      Lists.rows(api.list(), open).map((r) =>
        r.type === "ticked"
          ? `${"  ".repeat(r.depth)}Ticked (${r.count})`
          : `${"  ".repeat(r.depth)}${r.counter !== null ? `${r.counter} ` : ""}${r.item.text}`
      ),
    idOf: (text) => Lists.liveItems(api.list()).find((i) => i.text === text).id,
    /** Press a [data-li] control in the list. */
    tap: (dataset) =>
      content.fire("click", {
        target: { closest: (sel) => (sel === "[data-li]" ? { dataset } : null) },
      }),
    /**
     * Put the caret in an item, as a tap does, and hand back what can be
     * done there: type, press a key, leave.
     */
    edit: (id) => {
      const item = Lists.liveItems(api.list()).find((i) => i.id === id);
      const el = {
        dataset: { liText: id },
        textContent: item ? item.text : "",
        blur: () => content.fire("focusout", { target: at }),
      };
      const at = { closest: (sel) => (sel === "[data-li-text]" ? el : null) };
      content.fire("focusin", { target: at });
      return {
        el,
        type: (text) => { el.textContent = text; },
        press: (key, extra = {}) => {
          let prevented = false;
          content.fire("keydown", { target: at, key, preventDefault: () => { prevented = true; }, ...extra });
          return prevented;
        },
        leave: () => el.blur(),
      };
    },
    /** A finger across a row: down, along, up. */
    swipe: (id, dx) => {
      const row = {
        dataset: { liRow: id, level: "0" },
        style: {},
        classList: { add() {}, remove() {} },
      };
      const target = { closest: (sel) => (sel === "[data-li-row]" ? row : null) };
      content.fire("pointerdown", { target, clientX: 100, clientY: 100, pointerId: 1, button: 0 });
      content.fire("pointermove", { target, clientX: 100 + dx / 2, clientY: 101, pointerId: 1 });
      content.fire("pointermove", { target, clientX: 100 + dx, clientY: 102, pointerId: 1 });
      content.fire("pointerup", { target, clientX: 100 + dx, clientY: 102, pointerId: 1 });
    },
    /** Type a list out: an item, Enter, the next, and so on. */
    typeOut: (...texts) => {
      api.tap({ li: "add" });
      let id = api.Lists.liveItems(api.list()).find((i) => i.text === "").id;
      texts.forEach((text, n) => {
        const e = api.edit(id);
        e.type(text);
        if (n < texts.length - 1) {
          e.press("Enter");
          id = api.Lists.liveItems(api.list()).find((i) => i.text === "").id;
        } else {
          e.leave();
        }
      });
    },
  };
  return api;
}

/** A checklist made through the screen, open, with these items typed in. */
function checklist(...texts) {
  const app = lists();
  app.openLists();
  app.make("Shopping");
  if (texts.length) app.typeOut(...texts);
  return app;
}

// ---------------------------------------------------------------------
// The Lists screen (J18.1 – J18.4)
// ---------------------------------------------------------------------

test("J18.1 · the Lists screen has an address, and a list is made with a name and a kind", () => {
  const app = lists();
  app.openLists();
  assert.equal(app.el("lists-view").open, true);
  assert.equal(app.win.location.hash, "#lists");
  assert.match(app.el("lists-index").innerHTML, /No lists in this book yet/);
  assert.match(app.el("lists-make").innerHTML, /value="stock"/, "both kinds are offered (J18.2)");

  app.make("Freezer", "stock");
  assert.equal(app.el("list-view").open, true, "making a list opens it");
  assert.equal(app.list().name, "Freezer");
  assert.equal(app.list().kind, "stock");
  assert.match(app.win.location.hash, /^#list\//);
});

test("J18.1 · a list is not made without a name", () => {
  const app = lists();
  app.openLists();
  app.make("   ");
  assert.equal(app.listStore.lists.length, 0);
  assert.match(app.el("toast").textContent, /name/);
});

test("J18.1 · the Lists screen shows every list, and a tap opens one; Back returns", () => {
  const app = lists();
  app.listStore.create("Shopping", "checklist", 1000);
  const freezer = app.listStore.create("Freezer", "stock", 2000);
  app.openLists();
  const html = app.el("lists-index").innerHTML;
  assert.ok(html.indexOf("Shopping") < html.indexOf("Freezer"), "oldest first, so Shopping leads");
  assert.match(html, /Stock list · empty/);

  app.tapList(freezer.id);
  assert.equal(app.el("list-view").open, true);
  assert.equal(app.el("lists-view").open, false, "one screen at a time");

  app.win.history.back();
  assert.equal(app.el("list-view").open, false);
  assert.equal(app.el("lists-view").open, true, "Back from a list is the Lists screen");
  app.win.history.back();
  assert.equal(app.el("lists-view").open, false, "and Back again is the recipes");
});

test("J18.1 · the breadcrumb climbs to Lists, or home in one tap", () => {
  const app = lists();
  const list = app.listStore.create("Shopping", "checklist");
  app.openLists();
  app.tapList(list.id);
  assert.match(app.el("list-crumbs").innerHTML, /data-crumb="lists"/);

  clickCrumb(app, "list", "list");
  assert.equal(app.el("list-view").open, false);
  assert.equal(app.el("lists-view").open, false, "home, not the Lists screen");
  assert.equal(app.win.location.hash, "");
});

test("J18.1 · a list opens from its address", () => {
  const ui = lists();
  const list = ui.listStore.create("Shopping", "checklist");
  ui.win.location.hash = `#list/${list.id}`;
  ui.app.openFromHash();
  assert.equal(ui.el("list-view").open, true);
  clickCrumb(ui, "list", "lists");
  assert.equal(ui.el("lists-view").open, true, "with nothing underneath, Lists is opened rather than returned to");
});

test("J18.3 · a list is renamed by its title", () => {
  const app = checklist();
  const heading = app.el("list-heading");
  const el = { textContent: "Shopping" };
  const target = { closest: (sel) => (sel === "[data-li-name]" ? el : null) };
  heading.fire("focusin", { target });
  el.textContent = "Big shop";
  heading.fire("focusout", { target });
  assert.equal(app.list().name, "Big shop");

  heading.fire("focusin", { target });
  el.textContent = "";
  heading.fire("focusout", { target });
  assert.equal(app.list().name, "Big shop", "a list always has a name");
});

test("J18.3 · deleting a list asks first, and No keeps it", async () => {
  const app = checklist("milk");
  const id = app.list().id;
  app.el("confirm-dialog").answer = "";
  await app.el("list-delete-btn").fire("click");
  assert.ok(app.listStore.get(id), "kept");
  assert.match(app.el("confirm-message").textContent, /Everything on it goes too — 1 item/);

  app.el("confirm-dialog").answer = "yes";
  await app.el("list-delete-btn").fire("click");
  assert.equal(app.listStore.get(id), null);
  assert.equal(app.el("lists-view").open, true, "back on the Lists screen");
});

test("J18.4 · a viewer reads lists and changes nothing", () => {
  const app = lists();
  const list = app.listStore.create("Shopping", "checklist");
  app.listStore.change(list.id, (l) => app.Lists.addItem(l, { text: "milk" }));
  app.app.setCanEdit(false);
  app.openLists();
  assert.doesNotMatch(app.el("lists-make").innerHTML, /data-lists-new/, "no way to make one");
  app.tapList(list.id);
  const html = app.el("list-content").innerHTML;
  assert.match(html, /milk/);
  assert.doesNotMatch(html, /contenteditable/, "the words are not an editor");
  assert.doesNotMatch(html, /data-li="add"/);
  assert.match(html, /class="li-tick"[^>]*disabled/);
  assert.equal(app.el("list-delete-btn").hidden, true);

  app.tap({ li: "tick", id: app.idOf("milk") });
  assert.equal(app.list().items[0].ticked, false, "a tap that got through anyway is refused");
});

// ---------------------------------------------------------------------
// Items (J18.5 – J18.10)
// ---------------------------------------------------------------------

test("J18.5 · an item's row is its words and its tick box, nothing else", () => {
  const app = checklist("milk");
  const row = /<li class="li-row[^"]*"[^>]*>([\s\S]*?)<\/li>/.exec(app.el("list-content").innerHTML)[1];
  assert.equal((row.match(/<button/g) || []).length, 1, "the tick box is the only control");
  assert.match(row, /contenteditable="plaintext-only"/);
});

test("J18.7 · Enter makes the next item, below and at the same depth, with the caret in it", () => {
  const app = checklist("eggs", "milk", "bread");
  assert.deepEqual(app.rows(), ["eggs", "milk", "bread"]);

  const e = app.edit(app.idOf("eggs"));
  assert.equal(e.press("Enter"), true);
  const blank = app.Lists.liveItems(app.list()).find((i) => i.text === "");
  assert.deepEqual(app.rows(), ["eggs", "", "milk", "bread"]);
  assert.equal(app.el(`li-${blank.id}`).focused, true, "the caret goes into it");
});

test("J18.7 · Enter on an empty item ends the typing, and the empty item goes quietly", () => {
  const app = checklist("eggs");
  app.edit(app.idOf("eggs")).press("Enter");
  const blank = app.Lists.liveItems(app.list()).find((i) => i.text === "");
  app.el("toast").textContent = "";
  const e = app.edit(blank.id);
  e.press("Enter");
  e.leave();
  assert.deepEqual(app.rows(), ["eggs"]);
  assert.equal(app.el("toast").textContent, "", "nothing was there, so there is nothing to undo");
});

test("J18.6 · leaving saves, an unchanged item writes nothing, and Escape puts back what was there", () => {
  const app = checklist("milk");
  const id = app.idOf("milk");
  const e = app.edit(id);
  e.type("2 l\nmilk");
  e.leave();
  assert.deepEqual(app.rows(), ["2 l milk"], "a line break becomes a space");

  const stamp = app.list().items[0].textAt;
  const again = app.edit(id);
  // Another phone's edit lands while the caret is here.
  app.listStore.change(app.list().id, (l) => app.Lists.editText(l, id, "oat milk", stamp + 10));
  again.leave();
  assert.deepEqual(app.rows(), ["oat milk"], "leaving untouched does not write the old words back");

  const esc = app.edit(id);
  esc.type("cream");
  esc.press("Escape");
  assert.deepEqual(app.rows(), ["oat milk"]);
});

test("J18.10 · emptying an item deletes it, says so, and Undo brings it back", () => {
  const app = checklist("milk", "bread");
  const e = app.edit(app.idOf("milk"));
  e.type("");
  e.leave();
  assert.deepEqual(app.rows(), ["bread"]);
  assert.match(app.el("toast").textContent, /Deleted “milk”/);
  app.el("toast-action").fire("click");
  assert.deepEqual(app.rows(), ["milk", "bread"]);
});

test("J18.10 · Backspace in an empty item deletes it and moves the caret up", () => {
  const app = checklist("milk", "bread");
  const bread = app.edit(app.idOf("bread"));
  bread.type("");
  assert.equal(bread.press("Backspace"), true);
  assert.deepEqual(app.rows(), ["milk"]);
  assert.equal(app.el(`li-${app.idOf("milk")}`).focused, true);
  assert.match(app.el("toast").textContent, /Deleted “bread”/, "it had words, so it says so");

  const kept = app.edit(app.idOf("milk"));
  assert.equal(kept.press("Backspace"), false, "Backspace in words is just Backspace");
});

test("J18.8 · Tab nests an item under the one above, Shift-Tab brings it out, and its children come too", () => {
  const app = checklist("Bolognese", "onions", "tomatoes");
  app.edit(app.idOf("onions")).press("Tab");
  app.edit(app.idOf("tomatoes")).press("Tab");
  assert.deepEqual(app.rows(), ["Bolognese", "  onions", "  tomatoes"]);
  assert.equal(app.el(`li-${app.idOf("tomatoes")}`).focused, true, "the caret stays where it was");

  app.edit(app.idOf("tomatoes")).press("Tab", { shiftKey: true });
  assert.deepEqual(app.rows(), ["Bolognese", "  onions", "tomatoes"]);
});

test("J18.8 · a swipe right nests, a swipe left un-nests, and a short one does nothing", () => {
  const app = checklist("Bolognese", "onions");
  app.swipe(app.idOf("onions"), 20);
  assert.deepEqual(app.rows(), ["Bolognese", "onions"], "a wobble is not a swipe");
  app.swipe(app.idOf("onions"), 80);
  assert.deepEqual(app.rows(), ["Bolognese", "  onions"]);
  app.swipe(app.idOf("onions"), -80);
  assert.deepEqual(app.rows(), ["Bolognese", "onions"]);
});

test("J18.8 · a vertical move is the page's scroll, not a swipe", () => {
  const app = checklist("Bolognese", "onions");
  const content = app.el("list-content");
  const row = { dataset: { liRow: app.idOf("onions") }, style: {}, classList: { add() {}, remove() {} } };
  const target = { closest: (sel) => (sel === "[data-li-row]" ? row : null) };
  content.fire("pointerdown", { target, clientX: 100, clientY: 100, pointerId: 1, button: 0 });
  content.fire("pointermove", { target, clientX: 104, clientY: 160, pointerId: 1 });
  content.fire("pointermove", { target, clientX: 190, clientY: 160, pointerId: 1 });
  content.fire("pointerup", { target, clientX: 190, clientY: 160, pointerId: 1 });
  assert.deepEqual(app.rows(), ["Bolognese", "onions"]);
});

// ---------------------------------------------------------------------
// Checklists (J18.11 – J18.13)
// ---------------------------------------------------------------------

test("J18.11, J18.12 · a tick folds the item into Ticked (n), and unticking puts it back", () => {
  const app = checklist("eggs", "milk", "bread");
  app.tap({ li: "tick", id: app.idOf("milk") });
  assert.deepEqual(app.rows(), ["eggs", "bread", "Ticked (1)"]);
  assert.match(app.el("list-content").innerHTML, /data-li="fold"[^>]*aria-expanded="false"[^>]*>Ticked \(1\)/);

  app.tap({ li: "fold", parent: "" });
  assert.match(app.el("list-content").innerHTML, /aria-expanded="true"/, "a tap opens the group");
  app.tap({ li: "tick", id: app.idOf("milk") });
  assert.deepEqual(app.rows(), ["eggs", "milk", "bread"], "back where it was");
});

test("J18.11 · ticking a recipe ticks what is nested under it", () => {
  const app = checklist("Curry", "onion", "rice");
  app.edit(app.idOf("onion")).press("Tab");
  app.tap({ li: "tick", id: app.idOf("Curry") });
  assert.ok(app.Lists.liveItems(app.list()).filter((i) => i.text !== "rice").every((i) => i.ticked));
  assert.deepEqual(app.rows(), ["rice", "Ticked (1)"]);
});

test("J18.13 · Clear ticked deletes the ticked, with an Undo", () => {
  const app = checklist("eggs", "milk");
  assert.equal(app.el("list-clear-btn").hidden, true, "nothing ticked, nothing to clear");
  app.tap({ li: "tick", id: app.idOf("milk") });
  assert.equal(app.el("list-clear-btn").hidden, false);
  app.el("list-clear-btn").fire("click");
  assert.deepEqual(app.rows(), ["eggs"]);
  assert.match(app.el("toast").textContent, /Cleared 1 ticked item/);
  app.el("toast-action").fire("click");
  assert.deepEqual(app.rows(), ["eggs", "Ticked (1)"]);
});

// ---------------------------------------------------------------------
// Stock lists (J18.14 – J18.16)
// ---------------------------------------------------------------------

test("J18.14, J18.15 · a counter starts at 1, steps with − and +, and fades at 0 without going below", () => {
  const app = lists();
  app.openLists();
  app.make("Freezer", "stock");
  app.typeOut("Bolognese");
  const id = app.idOf("Bolognese");
  assert.deepEqual(app.rows(), ["1 Bolognese"]);
  app.tap({ li: "up", id });
  app.tap({ li: "up", id });
  assert.deepEqual(app.rows(), ["3 Bolognese"]);
  for (let i = 0; i < 4; i++) app.tap({ li: "down", id });
  assert.deepEqual(app.rows(), ["0 Bolognese"], "never below 0, and still on the list");
  const html = app.el("list-content").innerHTML;
  assert.match(html, /class="li-row li-faded"/);
  assert.match(html, /data-li="down"[^>]*disabled/);
});

test("J18.16 · an item with something nested under it is a heading, with no counter", () => {
  const app = lists();
  app.openLists();
  app.make("Freezer", "stock");
  app.typeOut("Top drawer", "peas");
  app.edit(app.idOf("peas")).press("Tab");
  assert.deepEqual(app.rows(), ["Top drawer", "  1 peas"]);
  assert.equal((app.el("list-content").innerHTML.match(/data-li="up"/g) || []).length, 1);
});

// ---------------------------------------------------------------------
// Sync (J18.24)
// ---------------------------------------------------------------------

test("J18.24 · while a list is on screen it is polled, and not once it has gone", () => {
  const ui = lists();
  const calls = [];
  const timers = new Map();
  let next = 1;
  ui.win.setInterval = (fn) => { timers.set(next, fn); return next++; };
  ui.win.clearInterval = (id) => timers.delete(id);
  ui.win.RecipeCloud = { sync: { pullLists: async (id) => calls.push(id), syncNow: async () => calls.push("all") } };
  const list = ui.listStore.create("Shopping", "checklist");
  ui.listStore.markSeeded();

  ui.openLists();
  assert.deepEqual(calls, [null], "the Lists screen pulls every list");
  assert.equal(timers.size, 1);
  ui.tapList(list.id);
  assert.deepEqual(calls, [null, list.id], "and a list pulls itself");
  [...timers.values()][0]();
  assert.deepEqual(calls.slice(-1), [list.id], "every few seconds");

  ui.win.history.back();
  ui.win.history.back();
  assert.equal(timers.size, 0, "off the lists, the poll stops");
});

test("J18.24, build step 1 · a book whose plan has not moved yet gets a full sync on the Lists screen", () => {
  const ui = lists();
  const calls = [];
  ui.win.RecipeCloud = { sync: { pullLists: async () => calls.push("pull"), syncNow: async () => calls.push("sync") } };
  ui.openLists();
  assert.deepEqual(calls, ["sync"]);
});

test("J18.24 · a change from another phone does not redraw under an item being edited", () => {
  const app = checklist("milk", "bread");
  const listId = app.list().id;
  const e = app.edit(app.idOf("milk"));
  const before = app.el("list-content").innerHTML;
  app.listStore.change(listId, (l) => app.Lists.addItem(l, { text: "eggs" }));
  app.listStore.onRemote([listId]);
  assert.equal(app.el("list-content").innerHTML, before, "the caret's row is left alone");
  e.leave();
  // The redraw waits a moment (so the tap that left lands); a tap pays it.
  app.tap({});
  assert.match(app.el("list-content").innerHTML, /eggs/);
});

test("J18.24 · a list deleted on another phone while open goes back to Lists, and says so", () => {
  const app = checklist("milk");
  const id = app.list().id;
  app.listStore.drop(id);
  app.listStore.onRemote([id]);
  assert.equal(app.el("list-view").open, false);
  assert.equal(app.el("lists-view").open, true);
  assert.match(app.el("toast").textContent, /deleted/);
});

// ---------------------------------------------------------------------
// Where a dragged item lands (J18.9)
// ---------------------------------------------------------------------

test("J18.9 · a drop lands after the row above, at a depth the rows either side allow", () => {
  const app = lists();
  const { place, depthRange } = app.win.RecipeListDrop;
  const rows = [
    { id: "a", depth: 0, parentId: null },
    { id: "b", depth: 1, parentId: "a" },
    { id: "c", depth: 0, parentId: null },
  ];
  assert.deepEqual(place(rows, -1, 3), { depth: 0, parentId: null, atTop: true }, "the top is the top");
  assert.deepEqual(place(rows, 1, 1), { depth: 1, parentId: "a", afterId: "b" }, "beside b");
  assert.deepEqual(place(rows, 1, 2), { depth: 2, parentId: "b", atTop: true }, "carried right: under b");
  assert.deepEqual(place(rows, 1, 0), { depth: 0, parentId: null, afterId: "a" }, "carried left: after a");
  assert.deepEqual(place(rows, 0, 0), { depth: 1, parentId: "a", atTop: true },
    "between a and its child it can only be a's child, or b would draw above it");
  assert.deepEqual(depthRange({ depth: 2 }, { depth: 1 }), { min: 1, max: 3 });
});

test("J18.9 · a drag that is let go moves the item through the model", () => {
  const app = checklist("eggs", "milk", "bread");
  // Hold to drag needs a real clock and real geometry; the drop itself is
  // the same call either way, so it is reached through RecipeListDrop and
  // RecipeLists.move as the screen makes it.
  const list = app.list();
  const rows = app.Lists.rows(list).filter((r) => r.type === "item" && r.id !== app.idOf("bread"));
  const spot = app.win.RecipeListDrop.place(rows, -1, 0);
  app.listStore.change(list.id, (l) => app.Lists.move(l, app.idOf("bread"), spot));
  assert.deepEqual(app.rows(), ["bread", "eggs", "milk"]);
});

/**
 * A hold and a drag, with rows that have somewhere to be: each row 48px
 * tall, in a <ul> that moves the lifted row as the app asks it to.
 */
function dragRig(app) {
  const ids = app.Lists.rows(app.list()).filter((r) => r.type === "item").map((r) => r.id);
  const ul = { children: [] };
  const place = (r) => ul.children.indexOf(r);
  const rowFor = (id) => {
    const row = {
      dataset: { liRow: id, level: String(app.Lists.rows(app.list()).find((r) => r.id === id).depth) },
      style: {},
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      parentNode: ul,
      getBoundingClientRect: () => ({ top: place(row) * 48, height: 48 }),
      get previousElementSibling() { return ul.children[place(row) - 1] || null; },
      get nextElementSibling() { return ul.children[place(row) + 1] || null; },
    };
    return row;
  };
  ul.children = ids.map(rowFor);
  ul.insertBefore = (a, b) => {
    ul.children.splice(place(a), 1);
    ul.children.splice(place(b), 0, a);
  };
  ul.appendChild = (a) => {
    ul.children.splice(place(a), 1);
    ul.children.push(a);
  };
  Object.defineProperty(ul, "lastElementChild", { get: () => ul.children[ul.children.length - 1] });
  let held = null;
  app.win.setTimeout = (fn) => { held = fn; return 1; };
  const content = app.el("list-content");
  return {
    drag(id, { toY, dx = 0 }) {
      const row = ul.children.find((r) => r.dataset.liRow === id);
      const y0 = place(row) * 48 + 24;
      const target = { closest: (sel) => (sel === "[data-li-row]" ? row : null) };
      content.fire("pointerdown", { target, clientX: 100, clientY: y0, pointerId: 7, button: 0 });
      held(); // the hold lasts
      content.fire("pointermove", { target, clientX: 100 + dx, clientY: toY, pointerId: 7 });
      content.fire("pointerup", { target, clientX: 100 + dx, clientY: toY, pointerId: 7 });
    },
  };
}

test("J18.9 · hold and drag moves an item, and carried sideways it changes depth", () => {
  const app = checklist("eggs", "milk", "bread");
  dragRig(app).drag(app.idOf("bread"), { toY: 5 });
  assert.deepEqual(app.rows(), ["bread", "eggs", "milk"]);

  // milk, from the bottom, to just under eggs and a step to the right.
  dragRig(app).drag(app.idOf("milk"), { toY: 80, dx: 40 });
  assert.deepEqual(app.rows(), ["bread", "eggs", "  milk"]);
});

test("J18.9 · a hold let go where it started writes nothing", () => {
  const app = checklist("eggs", "milk");
  const before = JSON.stringify(app.list());
  dragRig(app).drag(app.idOf("milk"), { toY: 72 });
  assert.equal(JSON.stringify(app.list()), before);
});

test("J18.8 · a swipe that made no click does not swallow the next tap", () => {
  const app = checklist("Bolognese", "onions");
  app.swipe(app.idOf("onions"), 80);
  // A touch swipe ends with no click; the next pointer starts fresh.
  app.el("list-content").fire("pointerdown", { target: { closest: () => null }, pointerId: 2 });
  app.tap({ li: "tick", id: app.idOf("Bolognese") });
  assert.equal(app.list().items.find((i) => i.text === "Bolognese").ticked, true);
});

test("J18.24 · a pull redraws the Lists screen without wiping a name being typed", () => {
  const app = lists();
  app.openLists();
  app.el("lists-make").innerHTML = "half-typed";
  app.listStore.create("Freezer", "stock");
  app.listStore.onRemote(["x"]);
  assert.match(app.el("lists-index").innerHTML, /Freezer/);
  assert.equal(app.el("lists-make").innerHTML, "half-typed");
});

// ---------------------------------------------------------------------
// Review of #58: B1, S1, S3, and phone keyboards
// ---------------------------------------------------------------------

/** Every timer the app sets, by delay, so a test decides when each runs. */
function clock(app) {
  const timers = [];
  app.win.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  app.win.clearTimeout = (n) => { if (timers[n - 1]) timers[n - 1].fn = null; };
  return {
    run(ms) {
      for (const t of timers.filter((x) => x.ms === ms && x.fn)) {
        const fn = t.fn;
        t.fn = null;
        fn();
      }
    },
  };
}

/** The drag rig again, but with the hold and the pointer moves apart. */
function holdRow(app, c, id) {
  const ids = app.Lists.rows(app.list()).filter((r) => r.type === "item").map((r) => r.id);
  const ul = { children: [] };
  const place = (r) => ul.children.indexOf(r);
  ul.children = ids.map((rid) => {
    const row = {
      dataset: { liRow: rid, level: String(app.Lists.rows(app.list()).find((r) => r.id === rid).depth) },
      style: {},
      classList: { _s: new Set(), add(x) { this._s.add(x); }, remove(x) { this._s.delete(x); }, contains(x) { return this._s.has(x); } },
      parentNode: ul,
      getBoundingClientRect: () => ({ top: place(row) * 48, height: 48 }),
      get previousElementSibling() { return ul.children[place(row) - 1] || null; },
      get nextElementSibling() { return ul.children[place(row) + 1] || null; },
    };
    return row;
  });
  ul.insertBefore = (a, b) => { ul.children.splice(place(a), 1); ul.children.splice(place(b), 0, a); };
  ul.appendChild = (a) => { ul.children.splice(place(a), 1); ul.children.push(a); };
  Object.defineProperty(ul, "lastElementChild", { get: () => ul.children[ul.children.length - 1] });
  const content = app.el("list-content");
  const row = ul.children.find((r) => r.dataset.liRow === id);
  const target = { closest: (sel) => (sel === "[data-li-row]" ? row : null) };
  content.fire("pointerdown", { target, clientX: 100, clientY: place(row) * 48 + 24, pointerId: 9, button: 0 });
  c.run(450); // the hold lasts
  return {
    move: (y, dx = 0) => content.fire("pointermove", { target, clientX: 100 + dx, clientY: y, pointerId: 9 }),
    up: (y, dx = 0) => content.fire("pointerup", { target, clientX: 100 + dx, clientY: y, pointerId: 9 }),
  };
}

test("B1 · a pull landing mid-drag does not redraw under the finger, and the drop lands where it was let go", () => {
  const app = checklist("eggs", "milk", "bread");
  const c = clock(app);
  const listId = app.list().id;
  const hold = holdRow(app, c, app.idOf("bread"));
  hold.move(5);
  const during = app.el("list-content").innerHTML;
  // Another phone adds something; the poll brings it in.
  app.listStore.change(listId, (l) => app.Lists.addItem(l, { text: "jam" }));
  app.listStore.onRemote([listId]);
  assert.equal(app.el("list-content").innerHTML, during, "no redraw while the finger is down");
  hold.up(5);
  assert.deepEqual(app.rows(), ["bread", "eggs", "milk", "jam"], "bread went to the top, not the bottom");
  assert.match(app.el("list-content").innerHTML, /jam/, "and the owed redraw happened");
});

test("B1 · type, Enter, then hold another row: the empty item goes without redrawing under the drag", () => {
  const app = checklist("eggs", "milk", "bread");
  const c = clock(app);
  const e = app.edit(app.idOf("bread"));
  e.press("Enter");
  const blank = app.Lists.liveItems(app.list()).find((i) => i.text === "");
  const typing = app.edit(blank.id);
  // The hold blurs the empty item, which deletes it and owes a redraw.
  app.win.document.activeElement = { blur: () => typing.leave() };
  app.el("list-content").contains = () => true;
  const hold = holdRow(app, c, app.idOf("eggs"));
  hold.move(120);
  const during = app.el("list-content").innerHTML;
  c.run(350); // the redraw the deleted item owed
  assert.equal(app.el("list-content").innerHTML, during, "held back while dragging");
  hold.up(120);
  assert.deepEqual(app.rows(), ["milk", "bread", "eggs"], "eggs landed where it was let go");
});

test("S1 · Enter on an item that holds others makes its first child, with the caret in it", () => {
  const app = checklist("Bolognese", "mince", "onions", "milk");
  app.edit(app.idOf("mince")).press("Tab");
  app.edit(app.idOf("onions")).press("Tab");
  app.edit(app.idOf("Bolognese")).press("Enter");
  const blank = app.Lists.liveItems(app.list()).find((i) => i.text === "");
  assert.deepEqual(app.rows(), ["Bolognese", "  ", "  mince", "  onions", "milk"]);
  assert.equal(app.el(`li-${blank.id}`).focused, true);
});

test("S1 · Enter on a leaf still makes the next item at its depth", () => {
  const app = checklist("Bolognese", "mince", "milk");
  app.edit(app.idOf("mince")).press("Tab");
  app.edit(app.idOf("mince")).press("Enter");
  assert.deepEqual(app.rows(), ["Bolognese", "  mince", "  ", "milk"]);
});

/** A row element that can take a new row after it, or be taken out. */
function liveRow(app, id) {
  const row = { inserted: [], removed: false };
  row.insertAdjacentHTML = (where, html) => row.inserted.push([where, html]);
  row.remove = () => { row.removed = true; };
  app.el(`li-${id}`).closest = (sel) => (sel === "[data-li-row]" ? row : null);
  return row;
}

test("phones · Enter puts the new row in place and focuses it without replacing the focused element", () => {
  const app = checklist("eggs", "milk");
  const row = liveRow(app, app.idOf("eggs"));
  const drawn = app.el("list-content").innerHTML;
  app.edit(app.idOf("eggs")).press("Enter");
  const blank = app.Lists.liveItems(app.list()).find((i) => i.text === "");
  assert.equal(app.el("list-content").innerHTML, drawn, "no redraw: iOS keeps its keyboard");
  assert.equal(row.inserted.length, 1);
  assert.equal(row.inserted[0][0], "afterend");
  assert.match(row.inserted[0][1], new RegExp(`data-li-text="${blank.id}"`));
  assert.equal(app.el(`li-${blank.id}`).focused, true);
});

test("phones · Backspace in an empty item takes its row out in place, the caret going up first", () => {
  const app = checklist("eggs", "milk");
  const row = liveRow(app, app.idOf("milk"));
  const drawn = app.el("list-content").innerHTML;
  const milk = app.edit(app.idOf("milk"));
  milk.type("");
  milk.press("Backspace");
  assert.deepEqual(app.rows(), ["eggs"]);
  assert.equal(row.removed, true);
  assert.equal(app.el("list-content").innerHTML, drawn, "no redraw");
  assert.equal(app.el(`li-${app.idOf("eggs")}`).focused, true);
});

test("phones · Gboard's Backspace (beforeinput deleteContentBackward) in an empty item deletes it", () => {
  const app = checklist("eggs", "milk");
  const milk = app.edit(app.idOf("milk"));
  milk.type("");
  let prevented = false;
  app.el("list-content").fire("beforeinput", {
    target: { closest: (sel) => (sel === "[data-li-text]" ? milk.el : null) },
    inputType: "deleteContentBackward",
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.deepEqual(app.rows(), ["eggs"]);

  const eggs = app.edit(app.idOf("eggs"));
  let left = false;
  app.el("list-content").fire("beforeinput", {
    target: { closest: (sel) => (sel === "[data-li-text]" ? eggs.el : null) },
    inputType: "deleteContentBackward",
    preventDefault: () => { left = true; },
  });
  assert.equal(left, false, "in words, Backspace is the browser's");
});

test("S3 · Undo puts back copies under new ids, and nothing holds the old ones", () => {
  const app = checklist("eggs", "milk");
  const old = app.idOf("milk");
  const e = app.edit(old);
  e.type("");
  e.leave();
  app.el("toast-action").fire("click");
  assert.deepEqual(app.rows(), ["eggs", "milk"]);
  assert.notEqual(app.idOf("milk"), old, "deleted is final; what comes back is a copy");
  // The copy is an ordinary item: it ticks, and Clear ticked takes it.
  app.tap({ li: "tick", id: app.idOf("milk") });
  app.el("list-clear-btn").fire("click");
  assert.deepEqual(app.rows(), ["eggs"]);
  app.el("toast-action").fire("click");
  assert.deepEqual(app.rows(), ["eggs", "Ticked (1)"], "and its Undo works on the copy too");
});

test("S3 · a restored parent whose Ticked group was open keeps it open", () => {
  const app = checklist("Curry", "onion", "rice");
  app.edit(app.idOf("onion")).press("Tab");
  app.edit(app.idOf("rice")).press("Tab");
  app.tap({ li: "tick", id: app.idOf("onion") });
  app.tap({ li: "fold", parent: app.idOf("Curry") });
  assert.match(app.el("list-content").innerHTML, /aria-expanded="true"/);
  const curry = app.edit(app.idOf("Curry"));
  curry.type("");
  curry.leave();
  assert.deepEqual(app.rows(), []);
  app.el("toast-action").fire("click");
  assert.match(app.el("list-content").innerHTML, /aria-expanded="true"[^>]*>Ticked \(1\)/);
});

test("re-review · a swipe let go outside the list still ends: the next tick redraws and the next swipe works", () => {
  const app = checklist("Bolognese", "onions", "milk");
  const content = app.el("list-content");
  const row = { dataset: { liRow: app.idOf("onions"), level: "0" }, style: {}, classList: { add() {}, remove() {} } };
  const target = { closest: (sel) => (sel === "[data-li-row]" ? row : null) };
  content.fire("pointerdown", { target, clientX: 100, clientY: 100, pointerId: 4, button: 0 });
  content.fire("pointermove", { target, clientX: 140, clientY: 101, pointerId: 4 });
  // Released over something else: the list never hears it, the window does.
  app.win.fire("pointerup", { clientX: 900, clientY: 101, pointerId: 4 });

  // The next tap, as a browser sends it: a pointer goes down on the box.
  content.fire("pointerdown", { target: { closest: () => null }, pointerId: 6, button: 0 });
  app.tap({ li: "tick", id: app.idOf("milk") });
  assert.match(content.innerHTML, /Ticked \(1\)/, "the tick is drawn, not held off for good");
  app.swipe(app.idOf("onions"), 80);
  assert.deepEqual(app.rows(), ["Bolognese", "  onions", "Ticked (1)"], "and a later swipe works");
});

test("re-review · leaving the list ends a gesture whose release never arrived", () => {
  const app = checklist("eggs", "milk");
  const id = app.list().id;
  const content = app.el("list-content");
  const row = { dataset: { liRow: app.idOf("milk"), level: "0" }, style: {}, classList: { add() {}, remove() {} } };
  const target = { closest: (sel) => (sel === "[data-li-row]" ? row : null) };
  content.fire("pointerdown", { target, clientX: 100, clientY: 100, pointerId: 5, button: 0 });
  content.fire("pointermove", { target, clientX: 140, clientY: 101, pointerId: 5 });
  app.win.history.back();
  app.tapList(id);
  app.tap({ li: "tick", id: app.idOf("eggs") });
  assert.match(content.innerHTML, /Ticked \(1\)/);
});
