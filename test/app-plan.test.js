/**
 * J18.18-J18.21 "Add to list", and J14 "Last planned" — driven through the app.
 *
 * Add to list replaced plan mode (J12.4, J18 build step 2): the recipe
 * view opens a small chooser — which checklist, how many portions — and an
 * add puts the recipe on that list as one item with its ingredients under
 * it, and records one archived plan the cards and the sorts read (J14.5
 * on). The list screen itself is test/app-lists.test.js.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadUI, aRecipe } = require("./helpers/load.js");

const BOLOGNESE = aRecipe({
  name: "Bolognese",
  servings: 4,
  ingredients: [
    { amount: 2, unit: "", item: "onions" },
    { amount: 400, unit: "g", item: "tomatoes" },
  ],
  steps: ["Simmer it."],
  tags: ["dinner"],
});

const CURRY = aRecipe({
  name: "Curry",
  servings: 2,
  ingredients: [
    { amount: 1, unit: "", item: "onion" },
    { amount: 2, unit: "tbsp", item: "curry paste" },
  ],
  steps: ["Cook it."],
  tags: ["quick"],
});

const PANCAKES = aRecipe({
  name: "Pancakes",
  servings: 2,
  ingredients: [{ amount: 300, unit: "g", item: "flour" }],
  steps: ["Whisk it."],
  tags: ["quick"],
});

/** A loaded app holding the given recipes, and a Shopping checklist. */
function planning(recipes, options = {}) {
  const ui = loadUI(options);
  const saved = recipes.map((r) => ui.store.add(r));
  const shopping =
    ui.listStore && options.shopping !== false ? ui.listStore.create("Shopping", "checklist") : null;
  ui.app.render();
  const Lists = ui.win.RecipeLists;

  const api = {
    ...ui,
    saved,
    shopping,
    named: (name) => saved.find((r) => r.name === name),
    /** Shopping's items as drawn: text and depth, top to bottom. */
    items: () =>
      Lists.rows(ui.listStore.get(shopping.id)).map((r) => `${"  ".repeat(r.depth)}${r.item.text}`),
    /** Press one of the chooser's controls. */
    choose: (action, id) =>
      ui.el("addlist-content").fire("click", {
        target: { closest: (sel) => (sel === "[data-al]" ? { dataset: { al: action, id } } : null) },
      }),
    /** Open a recipe and press its Add to list. */
    openChooser: (name) => {
      api.openRecipe(api.named(name).id);
      ui.el("detail-addlist-btn").fire("click");
    },
    stepper: () => ui.el("addlist-value").textContent,
    /** Add from the chooser as it stands, then answer to the archive. */
    addAs: (name) => {
      api.openChooser(name);
      api.choose("add");
    },
    archived: () => ui.planStore.archive,
    titles: () => {
      const out = [];
      const re = /<h3 class="card-title">([^<]*)<\/h3>/g;
      let m;
      while ((m = re.exec(ui.el("recipe-list").innerHTML))) out.push(m[1]);
      return out;
    },
    openRecipe: (id) =>
      ui.el("recipe-list").fire("click", {
        target: { closest: (sel) => (sel === ".recipe-card" ? { dataset: { id } } : null) },
      }),
    tapTag: (tag) =>
      ui.el("tag-menu").fire("click", {
        target: { closest: (sel) => (sel === "[data-tag]" ? { dataset: { tag } } : null) },
      }),
    chooseSort: (sort) =>
      ui.el("sort-options").fire("click", {
        target: { closest: (sel) => (sel === "[data-sort]" ? { dataset: { sort } } : null) },
      }),
  };
  return api;
}

// ---------------------------------------------------------------------
// J18.18 · Add to list
// ---------------------------------------------------------------------

test("J18.18 · the recipe list has no plan mode: no toggle, no card steppers", () => {
  const app = planning([BOLOGNESE]);
  assert.doesNotMatch(app.el("recipe-list").innerHTML, /data-plan|plan-card-row/);
  const page = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.html"), "utf8");
  assert.doesNotMatch(page, /id="plan-btn"|id="plan-bar"|id="detail-plan-btn"/, "and the page has neither");
});

test("J18.18 · Add to list opens a chooser: the first checklist, the recipe's servings", () => {
  const app = planning([BOLOGNESE]);
  app.openRecipe(app.named("Bolognese").id);
  assert.equal(app.el("detail-addlist-btn").hidden, false);
  app.el("detail-addlist-btn").fire("click");
  assert.equal(app.el("addlist-dialog").open, true);
  const html = app.el("addlist-content").innerHTML;
  assert.match(html, new RegExp(`data-id="${app.shopping.id}"[^>]*>Shopping<`));
  assert.match(html, /Bolognese/);
  assert.equal(app.stepper(), "Serves 4");
  assert.match(html, /aria-live="polite"/, "the number is read out as it changes");
  assert.match(html, /btn btn-primary" data-al="add"/, "and Add is the primary action");
});

test("J18.18 · only checklists are offered, and a stock list is not one", () => {
  const app = planning([BOLOGNESE]);
  app.listStore.create("Freezer", "stock");
  app.openChooser("Bolognese");
  assert.doesNotMatch(app.el("addlist-content").innerHTML, /Freezer/);
});

test("J18.18 · Add puts the recipe on the list as one item, its ingredients nested under it", () => {
  const app = planning([BOLOGNESE]);
  app.addAs("Bolognese");
  assert.deepEqual(app.items(), ["Bolognese", "  2 onions", "  400 g tomatoes"]);
  assert.equal(app.el("addlist-dialog").open, false, "and the chooser closes");
  assert.equal(app.planStore.plan.meals.length, 0, "nothing goes into the old plan");
  assert.match(app.el("toast").textContent, /Added “Bolognese” to Shopping/);
});

test("J18.18 · it goes at the top, at the portions the stepper shows, and the recipe is never edited", () => {
  const app = planning([CURRY, BOLOGNESE]);
  app.addAs("Curry");
  app.openChooser("Bolognese");
  app.choose("up");
  app.choose("up");
  assert.equal(app.stepper(), "Serves 6");
  assert.equal(app.items().length, 3, "stepping adds nothing");
  app.choose("add");
  assert.deepEqual(app.items().slice(0, 3), ["Bolognese", "  3 onions", "  600 g tomatoes"],
    "six servings of a recipe for four, above the curry");
  assert.equal(app.store.getById(app.named("Bolognese").id).servings, 4);
});

test("J18.18 · the stepper steps a serving at a time, and never below one", () => {
  const app = planning([aRecipe({ name: "Toast", servings: 2 })]);
  app.openChooser("Toast");
  app.choose("down");
  app.choose("down");
  assert.equal(app.stepper(), "Serves 1");
});

test("J18.18 · a recipe with no servings steps by half a batch", () => {
  const app = planning([aRecipe({ name: "Stock", ingredients: [{ amount: 1, unit: "l", item: "water" }] })]);
  app.openChooser("Stock");
  assert.equal(app.stepper(), "× 1");
  app.choose("up");
  assert.equal(app.stepper(), "× 1½");
  app.choose("add");
  assert.deepEqual(app.items(), ["Stock", "  1½ l water"]);
});

test("J18.18 · the chooser starts again from the servings each time: the number is not kept", () => {
  const app = planning([BOLOGNESE]);
  app.openChooser("Bolognese");
  app.choose("up");
  app.el("addlist-dialog").close();
  app.el("detail-addlist-btn").fire("click");
  assert.equal(app.stepper(), "Serves 4");
});

test("J18.18 · with several checklists the one picked is the one used, and is remembered next time", () => {
  const app = planning([BOLOGNESE, CURRY]);
  const party = app.listStore.create("Party", "checklist");
  app.openChooser("Bolognese");
  const drawn = app.el("addlist-content").innerHTML;
  app.choose("pick", party.id);
  assert.equal(app.el("addlist-content").innerHTML, drawn, "picking changes the controls in place, so focus stays");
  app.choose("add");
  assert.equal(app.listStore.get(party.id).items.filter((i) => i.text === "Bolognese").length, 1);
  assert.equal(app.items().length, 0, "Shopping is untouched");

  app.openChooser("Curry");
  app.choose("add");
  assert.equal(app.listStore.get(party.id).items.filter((i) => i.text === "Curry").length, 1,
    "the last list used is where the next chooser starts");
});

test("J18.20 · a recipe can go on more than once, each its own item", () => {
  const app = planning([CURRY]);
  app.addAs("Curry");
  app.addAs("Curry");
  assert.equal(app.items().filter((t) => t === "Curry").length, 2);
});

test("J18.10 · the add says so with an Undo, and Undo takes it all back off", () => {
  const app = planning([BOLOGNESE]);
  app.addAs("Bolognese");
  app.el("toast-action").fire("click");
  assert.deepEqual(app.items(), []);
});

test("J18.18 · with no checklist, the chooser says so and offers to make Shopping", () => {
  const app = planning([BOLOGNESE], { shopping: false });
  app.openChooser("Bolognese");
  const html = app.el("addlist-content").innerHTML;
  assert.match(html, /no checklist/);
  assert.match(html, /Make “Shopping”/);
  assert.doesNotMatch(html, /data-al="add"/);

  app.choose("make");
  assert.equal(app.listStore.lists[0].name, "Shopping");
  assert.equal(app.listStore.lists[0].kind, "checklist");
  assert.match(app.el("addlist-content").innerHTML, /data-al="add"/);
  app.choose("add");
  assert.equal(app.listStore.lists[0].items.some((i) => i.text === "Bolognese"), true);
});

test("J18.4 · a viewer sees no Add to list, and a tap that got through anyway is refused", () => {
  const app = planning([BOLOGNESE]);
  app.app.setCanEdit(false);
  app.openRecipe(app.named("Bolognese").id);
  assert.equal(app.el("detail-addlist-btn").hidden, true);
  assert.equal(app.el("lists-btn").hidden, false, "but the lists are there to read");
  app.el("detail-addlist-btn").fire("click");
  assert.equal(app.el("addlist-dialog").open, false);
  assert.equal(app.items().length, 0);
});

// ---------------------------------------------------------------------
// J18.21 · What an add records
// ---------------------------------------------------------------------

test("J18.21 · an add writes one archived plan holding that one meal, at its portions", () => {
  const app = planning([BOLOGNESE]);
  app.openChooser("Bolognese");
  app.choose("up");
  app.choose("add");
  assert.equal(app.archived().length, 1);
  const [record] = app.archived();
  assert.equal(record.meals.length, 1);
  assert.equal(record.meals[0].name, "Bolognese");
  assert.equal(record.meals[0].portions, 5);
  assert.ok(record.completedAt > 0);
  assert.match(noteOnCard(app), /^Last planned/);
});

test("J18.21 · each add is its own record, so a recipe added twice is counted twice", () => {
  const app = planning([CURRY]);
  app.addAs("Curry");
  app.addAs("Curry");
  assert.equal(app.archived().length, 2);
  const index = app.planStore.plannedIndex();
  assert.equal(index[app.named("Curry").id].count, 2);
});

test("J18.21 · Undo takes the record back, and the recipe says nothing again", async () => {
  const app = planning([BOLOGNESE]);
  app.addAs("Bolognese");
  assert.equal(app.archived().length, 1);
  await app.el("toast-action").fire("click");
  assert.deepEqual(app.items(), []);
  assert.equal(app.archived().length, 0);
  assert.equal(noteOnCard(app), "");
});

test("J18.21 · Undo with no network still takes the item off, and says the record clears when back online", async () => {
  const app = planning([BOLOGNESE]);
  const sync = {
    recordPlanned: (r, p) => app.planStore.archivePlan(app.win.RecipePlan.plannedMeal(r, p)).id,
    unrecordPlanned: async (id) => { app.planStore.removeArchived(id); return false; },
  };
  app.win.RecipeCloud = { sync };
  app.addAs("Bolognese");
  await app.el("toast-action").fire("click");
  assert.deepEqual(app.items(), [], "the list item Undo works offline");
  assert.match(app.el("toast").textContent, /back online/);
});

test("J14.6 · the open recipe's Last planned follows an add and its Undo", async () => {
  const app = planning([BOLOGNESE]);
  app.openRecipe(app.named("Bolognese").id);
  app.el("detail-addlist-btn").fire("click");
  app.choose("add");
  assert.match(app.el("detail-content").innerHTML, /Last planned/);
  await app.el("toast-action").fire("click");
  assert.doesNotMatch(app.el("detail-content").innerHTML, /Last planned/);
});

test("J18.18 · a list deleted while the chooser is open says so, and adds nothing", () => {
  const app = planning([BOLOGNESE]);
  app.openChooser("Bolognese");
  app.listStore.remove(app.shopping.id);
  app.choose("add");
  assert.match(app.el("toast").textContent, /gone/);
  assert.equal(app.archived().length, 0);
});

test("J18.18 · Make Shopping makes the book's own Shopping list, so two devices cannot make two", () => {
  const app = planning([BOLOGNESE], { shopping: false });
  const bookId = "11111111-1111-4111-8111-111111111111";
  app.win.RecipeCloud = { sync: { bookId } };
  app.openChooser("Bolognese");
  app.choose("make");
  assert.equal(app.listStore.lists[0].id, app.win.RecipeLists.shoppingListId(bookId));
  app.listStore.create("Shopping", "checklist", Date.now(), app.win.RecipeLists.shoppingListId(bookId));
  assert.equal(app.listStore.lists.length, 1, "asking again finds it");
});

test("J18.21 · with a sync layer the record is handed to it, and Undo asks it to take it back", async () => {
  const app = planning([BOLOGNESE]);
  const seen = [];
  app.win.RecipeCloud = {
    sync: {
      recordPlanned: (r, p) => { seen.push(["record", r.name, p]); return "rec-1"; },
      unrecordPlanned: async (id) => { seen.push(["undo", id]); },
    },
  };
  app.addAs("Bolognese");
  await app.el("toast-action").fire("click");
  assert.deepEqual(seen, [["record", "Bolognese", 4], ["undo", "rec-1"]]);
});

test("J18 · the old plan's readout is not reachable: #plan is the Lists screen", () => {
  const app = planning([BOLOGNESE], { hash: "#plan" });
  assert.equal(app.el("lists-view").open, true);
  assert.equal(app.el("plan-view").open, false);
});

// ---------------------------------------------------------------------
// J14 · What was planned, and the sorts that read it
// ---------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

/** A plan recorded `daysAgo` days back, the way the archive holds one. */
function planned(app, recipe, daysAgo) {
  const plan = app.win.RecipePlan;
  const at = Date.now() - daysAgo * DAY;
  const week = plan.addMeal(plan.emptyPlan(at - 1000), recipe, at - 500);
  app.planStore.archivePlan(plan.complete(week, at));
  app.app.render();
}

const noteOnCard = (app) => {
  const m = /<span class="card-planned[^"]*">([^<]*)<\/span>/.exec(app.el("recipe-list").innerHTML);
  return m ? m[1] : "";
};

test("J14.6 · a recipe's card and its recipe view say when it was last planned", () => {
  const app = planning([BOLOGNESE]);
  planned(app, app.named("Bolognese"), 21);
  assert.equal(noteOnCard(app), "Last planned 3 weeks ago");
  app.openRecipe(app.named("Bolognese").id);
  assert.match(app.el("detail-content").innerHTML, /Last planned 3 weeks ago/);
});

test("J14.6 · the newest of several plans is the one a recipe reports", () => {
  const app = planning([BOLOGNESE]);
  planned(app, app.named("Bolognese"), 40);
  planned(app, app.named("Bolognese"), 3);
  assert.equal(noteOnCard(app), "Last planned 3 days ago");
});

test("J14.7 · a recipe that has never been planned says nothing at all", () => {
  const app = planning([BOLOGNESE]);
  assert.equal(noteOnCard(app), "");
  assert.doesNotMatch(app.el("recipe-list").innerHTML, /never/i);
});

test("J14.8 · the note sits on the line of particulars, and the live plan no longer speaks", () => {
  const app = planning([BOLOGNESE]);
  planned(app, app.named("Bolognese"), 21);
  const html = app.el("recipe-list").innerHTML;
  assert.match(html, /<p class="card-meta">[^<]*·\s*<span class="card-planned/);
  assert.equal(noteOnCard(app), "Last planned 3 weeks ago");
  assert.doesNotMatch(html, /In the plan/);
});

test("J14.9, J15.6 · least recently planned sorts them first, never-planned before them", () => {
  const app = planning([BOLOGNESE, CURRY, PANCAKES]);
  planned(app, app.named("Curry"), 2);
  planned(app, app.named("Bolognese"), 30);
  app.chooseSort("least-planned");
  assert.deepEqual(app.titles(), ["Pancakes", "Bolognese", "Curry"]);
});

test("J14.10, J15.6 · most often planned counts every appearance", () => {
  const app = planning([BOLOGNESE, CURRY, PANCAKES]);
  planned(app, app.named("Curry"), 2);
  planned(app, app.named("Curry"), 9);
  planned(app, app.named("Bolognese"), 30);
  app.chooseSort("most-planned");
  assert.deepEqual(app.titles(), ["Curry", "Bolognese", "Pancakes"]);
});

test("J15.6 · a page without the planner is offered neither of the sorts that read it", () => {
  const app = planning([BOLOGNESE, CURRY], { planner: false });
  const menu = app.el("sort-options").innerHTML;
  assert.doesNotMatch(menu, /data-sort="least-planned"/);
  assert.doesNotMatch(menu, /card-planned/);
  assert.deepEqual(app.titles(), ["Curry", "Bolognese"], "and the list still draws");
});

test("J18 · a page that never loaded the lists still draws its cards, and offers no lists", () => {
  const app = planning([BOLOGNESE], { lists: false });
  assert.deepEqual(app.titles(), ["Bolognese"]);
  assert.equal(app.el("lists-btn").hidden, true);
  assert.equal(app.el("detail-addlist-btn").hidden, true);
});

test("S3 · Undo of an add takes the whole recipe off, even after another phone edited an ingredient", () => {
  const app = planning([BOLOGNESE]);
  app.addAs("Bolognese");
  const Lists = app.win.RecipeLists;
  const onions = Lists.liveItems(app.listStore.get(app.shopping.id)).find((i) => i.text === "2 onions");
  app.listStore.change(app.shopping.id, (l) => Lists.editText(l, onions.id, "3 red onions", Date.now() + 5));
  app.el("toast-action").fire("click");
  assert.deepEqual(app.items(), []);
});
