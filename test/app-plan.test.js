/**
 * J12 plan mode and J14 "Last planned" — driven through the app.
 *
 * The plan readout, its summed shopping list, Done and Clear went with
 * lists (J18, build step 1). What is left until step 2 is plan mode over
 * the recipe list, whose add now puts the recipe on the book's first
 * checklist as one item with its ingredients under it (J18.18), and the
 * record of what was planned, which the cards and the sorts read (J14.5
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
    planOn: () => ui.el("plan-btn").fire("click"),
    /** Press one of a card's plan controls. */
    card: (action, id) =>
      ui.el("recipe-list").fire("click", {
        target: { closest: (sel) => (sel === "[data-plan]" ? { dataset: { plan: action, id } } : null) },
      }),
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

function planMode(recipes, options) {
  const app = planning(recipes, options);
  app.planOn();
  return app;
}

const stepperOnCard = (app) => {
  const m = /<span class="scale-value">([^<]*)<\/span>/.exec(app.el("recipe-list").innerHTML);
  return m ? m[1] : "";
};

// ---------------------------------------------------------------------
// J12 · Plan mode, putting recipes on Shopping (J18.18)
// ---------------------------------------------------------------------

test("J12.4 · planning is a mode over the list: search, filters and Favourites go on working", () => {
  const app = planMode([BOLOGNESE, CURRY, PANCAKES]);

  app.el("search-input").value = "curry";
  app.el("search-input").fire("input");
  assert.deepEqual(app.titles(), ["Curry"], "search still narrows the list in plan mode");

  app.el("search-input").value = "";
  app.el("search-input").fire("input");
  app.tapTag("quick");
  assert.deepEqual(app.titles().sort(), ["Curry", "Pancakes"], "and so does a tag");

  const curry = app.named("Curry");
  app.store.toggleFavorite(curry.id);
  app.el("favorites-filter").fire("click");
  assert.deepEqual(app.titles(), ["Curry"], "and so does Favourites");
});

test("J12.4 · outside plan mode the cards are the cards", () => {
  const app = planning([BOLOGNESE]);
  assert.doesNotMatch(app.el("recipe-list").innerHTML, /data-plan/);
  assert.equal(app.el("plan-bar").hidden, true);
});

test("J18.18 · + Add puts the recipe on Shopping as one item, its ingredients nested under it", () => {
  const app = planMode([BOLOGNESE]);
  assert.match(app.el("recipe-list").innerHTML, /data-plan="add"[^>]*aria-label="Add Bolognese to Shopping"/);
  assert.match(app.el("plan-bar-text").textContent, /Adding to Shopping/);

  app.card("add", app.named("Bolognese").id);
  assert.deepEqual(app.items(), ["Bolognese", "  2 onions", "  400 g tomatoes"]);
  assert.equal(app.planStore.plan.meals.length, 0, "and nothing goes into the old plan");
  assert.match(app.el("toast").textContent, /Added “Bolognese” to Shopping/);
});

test("J18.18 · it goes at the top, and at the portions the stepper shows", () => {
  const app = planMode([CURRY, BOLOGNESE]);
  app.card("add", app.named("Curry").id);
  const id = app.named("Bolognese").id;
  assert.match(stepperOnCard(app), /Serves 4/, "the stepper is there before anything is added");
  app.card("up", id);
  app.card("up", id);
  assert.equal(app.items().length, 3, "stepping adds nothing");
  app.card("add", id);
  assert.deepEqual(app.items().slice(0, 3), ["Bolognese", "  3 onions", "  600 g tomatoes"],
    "six servings of a recipe for four, at the top of the list");
  assert.equal(app.store.getById(id).servings, 4, "and the recipe itself is never edited");
});

test("J12.5 · a recipe with no servings steps by half a batch", () => {
  const app = planMode([aRecipe({ name: "Stock", ingredients: [{ amount: 1, unit: "l", item: "water" }] })]);
  const id = app.named("Stock").id;
  app.card("up", id);
  assert.match(stepperOnCard(app), /× 1½/);
  app.card("add", id);
  assert.deepEqual(app.items(), ["Stock", "  1½ l water"]);
});

test("J18.20 · a recipe can go on more than once, each its own item", () => {
  const app = planMode([CURRY]);
  app.card("add", app.named("Curry").id);
  app.card("add", app.named("Curry").id);
  assert.equal(app.items().filter((t) => t === "Curry").length, 2);
});

test("J18.10 · the add says so with an Undo, and Undo takes it all back off", () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  app.el("toast-action").fire("click");
  assert.deepEqual(app.items(), []);
});

test("J12.5 · a number nobody has acted on is not kept — leaving plan mode forgets it", () => {
  const app = planMode([BOLOGNESE]);
  app.card("up", app.named("Bolognese").id);
  assert.match(stepperOnCard(app), /5/);
  app.planOn();
  app.planOn();
  assert.match(stepperOnCard(app), /4/);
});

test("J12.7 · the recipe view gains a way to add what is open only in plan mode, at its portions", () => {
  const app = planning([BOLOGNESE]);
  app.openRecipe(app.named("Bolognese").id);
  assert.equal(app.el("detail-plan-btn").hidden, true);

  app.planOn();
  assert.equal(app.el("detail-plan-btn").hidden, false);
  const up = { target: { closest: (sel) => (sel === "[data-scale]" ? { dataset: { scale: "up" } } : null) } };
  app.el("detail-content").fire("click", up);
  app.el("detail-content").fire("click", up);
  app.el("detail-plan-btn").fire("click");
  assert.deepEqual(app.items(), ["Bolognese", "  3 onions", "  600 g tomatoes"]);
});

test("J18.18 · with no checklist in the book, plan mode says where to make one", () => {
  const app = planMode([BOLOGNESE], { shopping: false });
  assert.match(app.el("plan-bar-text").textContent, /make one in Lists/);
  app.card("add", app.named("Bolognese").id);
  assert.match(app.el("toast").textContent, /no checklist/);
});

test("J18.4 · a viewer gets the recipes and no plan mode", () => {
  const app = planning([BOLOGNESE]);
  app.app.setCanEdit(false);
  assert.equal(app.el("plan-btn").hidden, true);
  assert.equal(app.el("lists-btn").hidden, false, "but the lists are there to read");
  app.card("add", app.named("Bolognese").id);
  assert.equal(app.items().length, 0, "and a tap that got through anyway is refused");
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
  const app = planMode([BOLOGNESE]);
  planned(app, app.named("Bolognese"), 21);
  app.card("add", app.named("Bolognese").id);
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
  assert.equal(app.el("plan-btn").hidden, true);
});
