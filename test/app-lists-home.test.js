/**
 * J18.27 · the book's lists on the main page, and J18.28 · "Edited …" by a
 * list's title — driven through the app, as app-lists.test.js does.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadUI } = require("./helpers/load.js");

const DAY = 86400000;

function app() {
  const ui = loadUI();
  ui.app.render();
  return ui;
}

/** Open a list from the Lists screen, as a finger does. */
function open(ui, id) {
  tapHome(ui.el("lists-row"), "[data-home-lists]", {});
  ui.el("lists-content").fire("click", {
    target: { closest: (sel) => (sel === "[data-lists-open]" ? { dataset: { listsOpen: id } } : null) },
  });
}

/**
 * The row's buttons as drawn, given fake widths: the stub DOM does not lay
 * anything out, so the row is told how wide it is and each button how wide
 * it wants to be.
 */
function layout(ui, { widths = {}, avail = 300, allWidth = 80 } = {}) {
  const row = ui.el("lists-row");
  const buttons = [...row.innerHTML.matchAll(/<button[^>]*data-home-list="([^"]+)"[^>]*>([^<]*)<\/button>/g)].map(
    (m) => ({ id: m[1], text: m[2], hidden: false, offsetWidth: widths[m[2]] ?? 60, dataset: { homeList: m[1] } })
  );
  const all = { hidden: false, offsetWidth: allWidth };
  row.clientWidth = avail;
  row.querySelectorAll = () => buttons;
  row.querySelector = () => all;
  // No ResizeObserver in the stub, so the app listens for resize.
  ui.win.fire("resize");
  return { row, buttons, all, hidden: () => buttons.map((b) => b.hidden) };
}

const tapHome = (row, sel, dataset) =>
  row.fire("click", { target: { closest: (s) => (s === sel ? { dataset } : null) } });

test("J18.27 · the main page has one button per list, in the Lists screen's order, then All lists", () => {
  const ui = app();
  ui.listStore.create("Shopping", "checklist");
  ui.listStore.create("Freezer <b>", "stock");
  ui.app.render();
  const html = ui.el("lists-row").innerHTML;
  assert.equal(ui.el("lists-row").hidden, false);
  const names = [...html.matchAll(/data-home-list="[^"]+"[^>]*>([^<]*)</g)].map((m) => m[1]);
  assert.equal(names.length, 2);
  assert.match(names[0], /Shopping|Freezer/);
  assert.deepEqual(
    names,
    ui.listStore.lists.map((l) => ui.win.RecipeHTML.escapeHTML(l.name)),
    "the order the Lists screen uses"
  );
  assert.match(html, /Freezer &lt;b&gt;/, "names are escaped");
  assert.match(html, /data-home-lists[^>]*>All lists</);
  assert.doesNotMatch(html, /style=/, "no inline styles (CSP)");
});

test("J18.27 · the row is the app bar's second row, so it goes wherever the bar goes", () => {
  const html = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.html"), "utf8");
  const header = html.slice(html.indexOf('<header class="appbar"'), html.indexOf("</header>"));
  assert.match(header, /<nav id="lists-row" class="lists-bar"/);
  assert.equal(html.match(/id="lists-row"/g).length, 1, "and nowhere else");
});

test("J18.27 · the row is not rebuilt when the names have not changed, and refits when the font arrives", async () => {
  let loaded;
  const listeners = {};
  const fonts = {
    ready: new Promise((r) => { loaded = r; }),
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const ui = loadUI({ fonts });
  ui.listStore.create("Shopping", "checklist");
  ui.app.render();
  const row = ui.el("lists-row");
  row.innerHTML = row.innerHTML + "<!--marker-->";
  ui.app.render();
  assert.match(row.innerHTML, /marker/, "same lists: left alone");

  const { buttons } = layout(ui, { avail: 100 });
  assert.equal(buttons[0].hidden, true);
  row.clientWidth = 1000; // the font arrived and the names got narrower
  listeners.loadingdone();
  assert.equal(buttons[0].hidden, false, "refit on loadingdone");
  buttons[0].hidden = true;
  loaded();
  await fonts.ready;
  assert.equal(buttons[0].hidden, false, "and on fonts.ready");
});

test("J18.27 · a book with no lists gets one Lists button", () => {
  const ui = app();
  const html = ui.el("lists-row").innerHTML;
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, /data-home-lists[^>]*>Lists</);
});

test("J18.27 · what does not fit is hidden in order, and All lists never is", () => {
  const ui = app();
  for (const n of ["Shopping", "Freezer", "Cupboard", "Garden"]) ui.listStore.create(n, "checklist");
  ui.app.render();

  // All lists 80, then 6 of gap and 60 per list: three fit in 300 (278), a fourth (344) does not.
  assert.deepEqual(layout(ui, { avail: 300 }).hidden(), [false, false, false, true]);

  const narrow = layout(ui, { avail: 100 });
  assert.ok(narrow.hidden().every(Boolean), "none fit beside All lists");
  assert.equal(narrow.all.hidden, false, "All lists stays");

  const wide = layout(ui, { avail: 1000 });
  assert.ok(wide.hidden().every((h) => !h), "everything shows when there is room");

  // A wide name that does not fit is not jumped by a narrow one behind it.
  const names = ui.listStore.lists.map((l) => l.name);
  const skewed = layout(ui, { widths: { [names[1]]: 400 }, avail: 300 });
  assert.deepEqual(skewed.hidden(), [false, true, true, true]);
});

test("J18.27 · the row is drawn again when the lists change", () => {
  const ui = app();
  ui.listStore.create("Shopping", "checklist");
  ui.app.render();
  assert.doesNotMatch(ui.el("lists-row").innerHTML, /Freezer/);
  const made = ui.listStore.create("Freezer", "stock");
  ui.listStore.onRemote([made.id]);
  assert.match(ui.el("lists-row").innerHTML, /Freezer/);
});

test("J18.27 · a list's button opens it; All lists opens the Lists screen", () => {
  const ui = app();
  const a = ui.listStore.create("Shopping", "checklist");
  ui.app.render();
  const { row } = layout(ui);
  tapHome(row, "[data-home-list]", { homeList: a.id });
  assert.equal(ui.el("list-view").open, true);
  assert.equal(ui.win.location.hash, `#list/${a.id}`);
  ui.win.history.back();
  assert.equal(ui.el("list-view").open, false);
  tapHome(row, "[data-home-lists]", {});
  assert.equal(ui.win.location.hash, "#lists");
  assert.equal(ui.el("lists-view").open, true);
});

test("J18.27 · a viewer sees the row, and the lists still open", () => {
  const ui = app();
  const a = ui.listStore.create("Shopping", "checklist");
  ui.app.setCanEdit(false);
  assert.equal(ui.el("lists-row").hidden, false);
  assert.match(ui.el("lists-row").innerHTML, /Shopping/);
  const { row } = layout(ui);
  tapHome(row, "[data-home-list]", { homeList: a.id });
  assert.equal(ui.el("list-view").open, true);
});

test("J18.28 · a list says when it was last edited, from the newest stamp it holds", () => {
  const ui = app();
  const made = ui.listStore.create("Shopping", "checklist");
  const old = Date.now() - 40 * DAY;
  ui.listStore.change(made.id, (l) => ({ ...l, nameAt: old, createdAt: old }));
  open(ui, made.id);
  assert.equal(ui.el("list-edited").textContent, "Edited 1 month ago");
  assert.equal(ui.el("list-edited").hidden, false);

  // An item stamped three days ago is newer than the name.
  ui.listStore.change(made.id, (l) => ui.win.RecipeLists.addItem(l, { text: "milk", now: Date.now() - 3 * DAY }));
  ui.listStore.onRemote([made.id]);
  assert.equal(ui.el("list-edited").textContent, "Edited 3 days ago");
});

test("J18.28 · with no known date nothing is said", () => {
  const ui = app();
  const made = ui.listStore.create("Shopping", "checklist");
  ui.listStore.change(made.id, (l) => ({ ...l, nameAt: 0, createdAt: 0, items: [] }));
  open(ui, made.id);
  assert.equal(ui.el("list-edited").hidden, true);
  assert.equal(ui.el("list-edited").textContent, "");
});

test("J18.28 · a pull updates it without redrawing the items under an edit", () => {
  const ui = app();
  const made = ui.listStore.create("Shopping", "checklist");
  ui.listStore.change(made.id, (l) => ({ ...l, nameAt: Date.now() - 9 * DAY, createdAt: Date.now() - 9 * DAY }));
  ui.listStore.change(made.id, (l) => ui.win.RecipeLists.addItem(l, { text: "milk", now: Date.now() - 5 * DAY }));
  open(ui, made.id);
  assert.equal(ui.el("list-edited").textContent, "Edited 5 days ago");

  const item = ui.win.RecipeLists.liveItems(ui.listStore.get(made.id))[0];
  const el = { dataset: { liText: item.id }, textContent: "milk", blur() {} };
  const at = { closest: (sel) => (sel === "[data-li-text]" ? el : null) };
  ui.el("list-content").fire("focusin", { target: at });
  el.textContent = "milk, oat";
  // A marker: any redraw would overwrite it.
  const before = "NOT REDRAWN";
  ui.el("list-content").innerHTML = before;

  // Another phone ticks something a day ago and the pull arrives.
  ui.listStore.change(made.id, (l) => ({ ...l, nameAt: Date.now() - DAY }));
  ui.listStore.onRemote([made.id]);
  assert.equal(ui.el("list-edited").textContent, "Edited yesterday");
  assert.equal(ui.el("list-content").innerHTML, before, "the items were not drawn again under the caret");
});
