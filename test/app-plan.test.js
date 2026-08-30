/**
 * J12 planning, J13 shopping, J14 finishing — driven through the app.
 *
 * In the front door, like the rest of the app tests: turn on Plan, press
 * the + on a card, open the plan, tap ✗ and ✓, press Done. The arithmetic
 * has its own tests in plan.test.js and shoplist.test.js; what is checked
 * here is the screen — which control exists, what it says, and what a tap
 * on it actually does to the plan underneath.
 *
 * Finishing a plan is the one thing that goes through the sync layer, so
 * the two calls it makes are stood up here rather than the whole of
 * sync.js: a fake that does what completePlan and undoComplete do to the
 * plan store, so the app is talking to a real plan either way.
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

/** Let every queued promise callback run. setTimeout is a no-op in the stub. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The two things the sync layer does for a plan, done to the same store
 * the screen is reading. Deliberately the same steps as sync.js's:
 * archive the finished plan, put a later generation in its place, and —
 * for Undo — reach the server first, because that is the one call in the
 * plan that needs a network (J14.2).
 */
function fakeCloud(ui, { undoFails = false } = {}) {
  const plan = ui.win.RecipePlan;
  const calls = { completed: [], undone: [] };
  ui.win.RecipeCloud = {
    sync: {
      async completePlan(now = Date.now()) {
        const live = ui.planStore.plan;
        const finished = plan.complete(live, now);
        if (!finished || finished === live) return null;
        ui.planStore.archivePlan(finished);
        ui.planStore.setPlan(plan.emptyPlan(plan.generationAfter(finished, now)));
        calls.completed.push(finished);
        return { archived: finished, plan: ui.planStore.plan };
      },
      async undoComplete(planId, now = Date.now()) {
        if (undoFails) throw new Error("offline");
        const archived = ui.planStore.archive.find((p) => p.id === planId);
        if (!archived) return null;
        ui.planStore.removeArchived(planId);
        ui.planStore.setPlan({
          ...archived,
          completedAt: null,
          createdAt: plan.generationAfter(ui.planStore.plan, now),
        });
        calls.undone.push(planId);
        return ui.planStore.plan;
      },
    },
  };
  return calls;
}

/** A loaded app holding the given recipes, with the planner to hand. */
function planning(recipes, options = {}) {
  const ui = loadUI(options);
  const saved = recipes.map((r) => ui.store.add(r));
  ui.app.render();

  const api = {
    ...ui,
    saved,
    named: (name) => saved.find((r) => r.name === name),
    /** The plan as it stands. */
    plan: () => ui.planStore.plan,
    /** The shop as the screen builds it. */
    list: () =>
      ui.win.RecipeShopList.build(ui.planStore.plan, ui.store.recipes, ui.store.prefs),
    /** The key a line is settled under, found the way the screen finds it. */
    keyFor: (item) => {
      const line = api.list().lines.find((l) => l.item.includes(item));
      return line && line.key;
    },
    planOn: () => ui.el("plan-btn").fire("click"),
    /** Press one of a card's plan controls. */
    card: (action, id) =>
      ui.el("recipe-list").fire("click", {
        target: { closest: (sel) => (sel === "[data-plan]" ? { dataset: { plan: action, id } } : null) },
      }),
    /** Press something in the plan readout. */
    tap: (dataset) =>
      ui.el("plan-content").fire("click", {
        target: { closest: (sel) => (sel === "[data-plan]" ? { dataset } : null) },
      }),
    open: () => ui.el("plan-open-btn").fire("click"),
    readout: () => ui.el("plan-content").innerHTML,
    /** The readout as it reads, with the markup taken out of the way. */
    words: () =>
      ui
        .el("plan-content")
        .innerHTML.replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
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
  };
  return api;
}

/** Plan mode on, with everything already in the box. */
function planMode(recipes, options) {
  const app = planning(recipes, options);
  app.planOn();
  return app;
}

// ---------------------------------------------------------------------
// J12 · Planning a week
// ---------------------------------------------------------------------

test("J12.4 · planning is a mode over the list: search, chips and Favourites go on working", () => {
  const app = planMode([BOLOGNESE, CURRY, PANCAKES]);

  app.el("search-input").value = "curry";
  app.el("search-input").fire("input");
  assert.deepEqual(app.titles(), ["Curry"], "search still narrows the list in plan mode");

  app.el("search-input").value = "";
  app.el("search-input").fire("input");
  app.el("tag-filters").fire("click", {
    target: { closest: () => ({ dataset: { tag: "quick" } }) },
  });
  assert.deepEqual(app.titles().sort(), ["Curry", "Pancakes"], "and so does a tag chip");

  const curry = app.named("Curry");
  app.store.toggleFavorite(curry.id);
  app.el("favorites-filter").fire("click");
  assert.deepEqual(app.titles(), ["Curry"], "and so does Favourites");
});

test("J12.4 · a card in plan mode gains a way in, and the toggle carries a count", () => {
  const app = planMode([BOLOGNESE]);
  assert.match(app.el("recipe-list").innerHTML, /data-plan="add"/,
    "every card offers a way into the plan");
  assert.equal(app.el("plan-count").hidden, true, "an empty plan is not a count");

  app.card("add", app.named("Bolognese").id);
  assert.equal(app.el("plan-count").textContent, "1");
  assert.equal(app.el("plan-count").hidden, false);
});

test("J12.4 · outside plan mode the cards are the cards", () => {
  const app = planning([BOLOGNESE]);
  assert.doesNotMatch(app.el("recipe-list").innerHTML, /data-plan/,
    "nothing is added to a list somebody is only reading");
  assert.equal(app.el("plan-bar").hidden, true);
});

test("J12.5 · portions default to the recipe's servings and step as the recipe view steps them", () => {
  const app = planMode([BOLOGNESE]);
  const id = app.named("Bolognese").id;
  app.card("add", id);
  assert.equal(app.plan().meals[0].portions, 4, "the recipe's own servings");
  assert.match(app.el("recipe-list").innerHTML, /Serves 4/);

  app.card("up", id);
  assert.equal(app.plan().meals[0].portions, 5, "one serving at a time");
  app.card("down", id);
  app.card("down", id);
  assert.equal(app.plan().meals[0].portions, 3);
  assert.equal(app.store.getById(id).servings, 4, "and the recipe itself is never edited");
});

test("J12.5 · a recipe with no servings steps by half a batch", () => {
  const app = planMode([aRecipe({ name: "Stock", steps: ["Boil."] })]);
  const id = app.named("Stock").id;
  app.card("add", id);
  assert.equal(app.plan().meals[0].multiplier, 1);
  app.card("up", id);
  assert.equal(app.plan().meals[0].multiplier, 1.5);
  assert.match(app.el("recipe-list").innerHTML, /× 1½/);
});

test("J12.6 · a recipe can be planned more than once, its own portions each", () => {
  const app = planMode([BOLOGNESE]);
  const id = app.named("Bolognese").id;
  app.card("add", id);
  app.card("up", id); // the first entry, at five
  app.card("add", id);

  const meals = app.plan().meals;
  assert.equal(meals.length, 2, "two nights, two entries");
  assert.deepEqual(meals.map((m) => m.portions), [5, 4],
    "and the second starts from the recipe's own servings rather than the first's");
  assert.match(app.el("recipe-list").innerHTML, /×2/, "the card says it is in twice");
});

test("J12.6 · the shopping list sums the entries without caring", () => {
  const app = planMode([BOLOGNESE]);
  const id = app.named("Bolognese").id;
  app.card("add", id);
  app.card("add", id);
  const onions = app.list().lines.find((l) => l.item.includes("onion"));
  assert.equal(onions.required, 4, "two lots of two onions");
});

test("J12.7 · outside plan mode the recipe view gains nothing", () => {
  const app = planning([BOLOGNESE]);
  app.openRecipe(app.named("Bolognese").id);
  assert.equal(app.el("detail-dialog").open, true);
  assert.equal(app.el("detail-plan-btn").hidden, true,
    "the row J4.19 fought for is not spent on something you are not doing");
});

test("J12.7 · in plan mode the recipe view gains a way to add what is open", () => {
  const app = planMode([BOLOGNESE]);
  app.openRecipe(app.named("Bolognese").id);
  assert.equal(app.el("detail-plan-btn").hidden, false);

  app.el("detail-plan-btn").fire("click");
  assert.deepEqual(app.plan().meals.map((m) => m.name), ["Bolognese"]);
});

test("J12.7 · what is open goes in at the portions on screen", () => {
  const app = planMode([BOLOGNESE]);
  app.openRecipe(app.named("Bolognese").id);
  // The recipe view's own stepper, twice: six servings on screen.
  app.el("detail-content").fire("click", {
    target: { closest: (sel) => (sel === "[data-scale]" ? { dataset: { scale: "up" } } : null) },
  });
  app.el("detail-content").fire("click", {
    target: { closest: (sel) => (sel === "[data-scale]" ? { dataset: { scale: "up" } } : null) },
  });
  app.el("detail-plan-btn").fire("click");
  assert.equal(app.plan().meals[0].portions, 6,
    "what the stepper says is what goes in the plan");
});

test("J12.8 · a recipe that leaves the book leaves the plan", () => {
  const app = planMode([BOLOGNESE, CURRY]);
  app.card("add", app.named("Bolognese").id);
  app.card("add", app.named("Curry").id);
  assert.equal(app.plan().meals.length, 2);

  app.store.remove(app.named("Bolognese").id);
  app.app.render();

  assert.deepEqual(app.plan().meals.map((m) => m.name), ["Curry"],
    "a plan is a list of things to cook, and that is no longer one of them");
});

test("J12.8 · a plan with nothing to prune is not rewritten", () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  const before = app.plan();
  app.app.render();
  assert.equal(app.plan(), before,
    "an ordinary redraw must not restamp the plan and start winning merges");
});

test("J12.9 · the plan has an address, and Back closes it", () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  app.open();

  assert.equal(app.el("plan-dialog").open, true);
  assert.equal(app.win.location.hash, "#plan");

  app.win.history.back();
  assert.equal(app.el("plan-dialog").open, false, "Back closed the plan");
  assert.notEqual(app.win.leftTheApp, true, "rather than walking out of the app");
  assert.equal(app.win.location.hash, "");
});

test("J12.9 · closing the plan takes its history entry with it", () => {
  const app = planMode([BOLOGNESE]);
  app.open();
  const before = app.win.history.length;
  app.el("plan-close-btn").fire("click");

  assert.equal(app.el("plan-dialog").open, false);
  assert.equal(app.win.history.length, before - 1);
  assert.equal(app.win.location.hash, "");
});

test("J12.9, J4.21 · the plan reopens from its address, with focus on the heading", () => {
  const app = planning([BOLOGNESE], { hash: "#plan" });
  assert.equal(app.el("plan-dialog").open, true, "a reload comes back to it");
  assert.equal(app.el("plan-heading").focused, true,
    "focus names what has filled the screen, not the first control in the markup");
});

test("J12.9 · a recipe restored from its address does not open over the readout", () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  const id = app.named("Bolognese").id;
  app.openRecipe(id);
  assert.equal(app.el("detail-dialog").open, true);

  // An address arriving over an open recipe — a bookmark, or a step
  // through history — puts the plan up and takes the recipe down.
  app.win.history.pushState({}, "", "#plan");
  app.win.fire("popstate", {});
  assert.equal(app.el("plan-dialog").open, true);
  assert.equal(app.el("detail-dialog").open, false);

  app.win.history.back();

  assert.equal(app.el("detail-dialog").open, true, "Back brings the recipe back");
  assert.equal(app.el("plan-dialog").open, false,
    "and does not leave the readout open underneath it, holding the page still");
});

test("J4.22 · the page behind the plan is held still", () => {
  const app = planMode([BOLOGNESE]);
  app.open();
  assert.equal(app.win.document.body.classList.contains("dialog-open"), true);
  app.el("plan-close-btn").fire("click");
  assert.equal(app.win.document.body.classList.contains("dialog-open"), false);
});

test("J12.10 · a viewer gets the recipes and no planner", () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  app.app.setCanEdit(false);
  app.app.render();

  assert.equal(app.el("plan-btn").hidden, true, "no way into plan mode");
  assert.equal(app.el("plan-bar").hidden, true);
  assert.doesNotMatch(app.el("recipe-list").innerHTML, /data-plan/,
    "and no way in on the cards");
  assert.deepEqual(app.titles(), ["Bolognese"], "the recipes are still theirs to read");
});

test("J12.10 · a viewer sees what is in the book's plan, having none of their own", () => {
  const app = planMode([BOLOGNESE, CURRY]);
  app.card("add", app.named("Bolognese").id);
  app.app.setCanEdit(false);
  app.app.render();

  // "In the plan" is read off the live plan, not off whether this reader
  // may add to it: the plan is the book's (J12.2, J14.8).
  assert.match(app.el("recipe-list").innerHTML, /class="card-planned card-planned-live">In the plan</);
  app.openRecipe(app.named("Bolognese").id);
  assert.match(app.el("detail-content").innerHTML, /class="card-planned card-planned-live">In the plan</);
});

test("J12.10 · a viewer's tap on the planner is refused, not merely hidden", () => {
  const app = planMode([BOLOGNESE]);
  app.app.setCanEdit(false);
  // The app hiding a button is a courtesy; the answer has to hold anyway.
  app.planOn();
  app.card("add", app.named("Bolognese").id);
  app.open();

  assert.deepEqual(app.plan().meals, [], "nothing went into the book's plan");
  assert.equal(app.el("plan-dialog").open, false);
  assert.equal(app.app.openFromHash(), false, "and its address opens nothing either");
});

// ---------------------------------------------------------------------
// J13 · Shopping from a plan
// ---------------------------------------------------------------------

test("J13.7 · every line says what it is made of, and names what each recipe wrote", () => {
  const app = planMode([BOLOGNESE, CURRY]);
  app.card("add", app.named("Bolognese").id);
  app.card("add", app.named("Curry").id);
  app.open();

  const html = app.words();
  assert.match(html, /3 onions/, "two recipes' onions come to one line");
  assert.match(html, /Bolognese 2 \(onions\)/);
  assert.match(html, /Curry 1 \(onion\)/,
    "where the recipes wrote it differently, the line says what each of them wrote");
});

test("J13.7 · where the recipes wrote the same thing, the parenthetical is not there", () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  app.card("add", app.named("Bolognese").id);
  app.open();

  assert.match(app.words(), /Bolognese 2 · Bolognese 2/);
  assert.doesNotMatch(app.words(), /\(onions\)/, "on the common case it is noise");
});

test("J13.9 · ✓ records the amount that was on the line, not that it is done", () => {
  const app = planMode([BOLOGNESE, CURRY]);
  app.card("add", app.named("Bolognese").id);
  app.card("add", app.named("Curry").id);
  app.open();
  const key = app.keyFor("onion");

  app.tap({ plan: "got", key });
  assert.equal(app.plan().settled[key].got.amount, 3, "three onions are in the basket");
  assert.equal(app.list().toBuy.some((l) => l.key === key), false, "so nothing is outstanding");

  // Planning another curry wants one more onion, and brings one back —
  // without disturbing the three already settled.
  app.card("add", app.named("Curry").id);
  const onions = app.list().lines.find((l) => l.key === key);
  assert.equal(onions.outstanding, 1);
  assert.equal(app.plan().settled[key].got.amount, 3, "what was settled was never forgotten");
});

test("J13.9 · ✗ settles an amount too — the line is a quantity, not a tick", () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  app.open();
  const key = app.keyFor("onion");

  app.tap({ plan: "have", key });
  assert.equal(app.plan().settled[key].have.amount, 2);
  assert.equal(app.list().alreadyHave.length, 1);
});

test("J13.14 · removed lines collapse into a group that says how many", () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  app.open();

  app.tap({ plan: "have", key: app.keyFor("onion") });
  assert.match(app.words(), /1 thing you already have/);

  app.tap({ plan: "have", key: app.keyFor("tomato") });
  assert.match(app.words(), /2 things you already have/);
});

test("J13.14 · one tap puts a removed line back, and retracts the settlement whole", () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  app.open();
  const key = app.keyFor("onion");

  app.tap({ plan: "have", key });
  app.tap({ plan: "unhave", key });

  assert.equal(app.plan().settled[key].have.amount, 0,
    "the whole settlement goes, not some part of it — the gesture that made it was one tap");
  assert.equal(app.list().toBuy.some((l) => l.key === key), true, "and it is back on the list");
});

test("J13.14 · a line in the basket can be taken back out of it", () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  app.open();
  const key = app.keyFor("onion");

  app.tap({ plan: "got", key });
  assert.equal(app.list().inBasket.length, 1);
  app.tap({ plan: "unget", key });
  assert.equal(app.list().toBuy.some((l) => l.key === key), true);
});

test("J13.13 · Copy gives what is left, neither removed nor settled", async () => {
  const app = planMode([BOLOGNESE, CURRY]);
  app.card("add", app.named("Bolognese").id);
  app.card("add", app.named("Curry").id);
  app.open();

  let copied = null;
  app.win.navigator.clipboard.writeText = async (text) => {
    copied = text;
  };
  app.tap({ plan: "have", key: app.keyFor("onion") }); // we have these
  app.tap({ plan: "got", key: app.keyFor("tomato") }); // these are in the basket

  await app.el("plan-copy-btn").fire("click");
  await flush();

  assert.equal(copied, "2 tbsp curry paste",
    "what is removed and what is settled are both off the list");
});

test("J13.10 · a part-settled line shows both numbers on screen", () => {
  const app = planMode([BOLOGNESE, CURRY]);
  app.card("add", app.named("Bolognese").id); // two onions
  app.open();
  app.tap({ plan: "got", key: app.keyFor("onion") }); // both in the basket
  app.card("add", app.named("Curry").id); // and now one more is wanted

  assert.match(app.words(), /3 onions · 2 sorted, 1 to get/,
    "the total belongs on screen beside what it is made of; the shortfall is what a shop is for");
});

test("J13.10 · what Copy gives is the shortfall, not the total", async () => {
  const app = planMode([BOLOGNESE, CURRY]);
  app.card("add", app.named("Bolognese").id);
  app.open();
  app.tap({ plan: "got", key: app.keyFor("onion") });
  app.card("add", app.named("Curry").id);

  let copied = null;
  app.win.navigator.clipboard.writeText = async (text) => {
    copied = text;
  };
  await app.el("plan-copy-btn").fire("click");
  await flush();

  // The number is the one onion missing rather than the three the plan
  // asks for, and it is named as one of them: the singular is a word one
  // of these recipes typed, not grammar the app invented (J13.4).
  assert.match(copied, /^1 onion$/m);
  assert.doesNotMatch(copied, /3 onions/,
    "copying the total would buy three onions to get one");
});

test("J13.10 · a line nothing has been settled against reads exactly as it did", async () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  app.open();

  assert.match(app.words(), /2 onions/);
  assert.doesNotMatch(app.words(), /sorted|to get/, "there is no second number to show");

  let copied = null;
  app.win.navigator.clipboard.writeText = async (text) => {
    copied = text;
  };
  await app.el("plan-copy-btn").fire("click");
  await flush();
  assert.equal(copied, "2 onions\n400 g tomatoes");
});

test("J13.13 · sharing is offered only where the browser can do it", () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  app.open();
  assert.equal(app.el("plan-share-btn").hidden, true,
    "a control that would do nothing is not offered at all");

  app.win.navigator.share = async () => {};
  app.app.render();
  assert.equal(app.el("plan-share-btn").hidden, false);
});

// ---------------------------------------------------------------------
// J14 · What the plan remembers
// ---------------------------------------------------------------------

test("J14.2 · Done happens by itself when the last outstanding line is settled", async () => {
  const app = planMode([BOLOGNESE]);
  const calls = fakeCloud(app);
  app.card("add", app.named("Bolognese").id);
  app.open();

  await app.tap({ plan: "have", key: app.keyFor("onion") });
  assert.equal(calls.completed.length, 0, "there is still something outstanding");

  await app.tap({ plan: "got", key: app.keyFor("tomato") });
  await flush();

  assert.equal(calls.completed.length, 1, "settling the last line is saying you have finished");
  assert.deepEqual(calls.completed[0].meals.map((m) => m.name), ["Bolognese"]);
  assert.deepEqual(app.plan().meals, [], "and an empty plan takes its place");
});

test("J14.2 · settling the last line with ✗ counts — a week you had everything for was still planned", async () => {
  const app = planMode([BOLOGNESE]);
  const calls = fakeCloud(app);
  app.card("add", app.named("Bolognese").id);
  app.open();

  await app.tap({ plan: "have", key: app.keyFor("onion") });
  await app.tap({ plan: "have", key: app.keyFor("tomato") });
  await flush();

  assert.equal(calls.completed.length, 1);
});

test("J14.2 · a plan edited down to nothing outstanding does not archive itself", async () => {
  const app = planMode([BOLOGNESE, PANCAKES]);
  const calls = fakeCloud(app);
  app.card("add", app.named("Bolognese").id);
  app.card("add", app.named("Pancakes").id);
  app.open();

  await app.tap({ plan: "have", key: app.keyFor("onion") });
  await app.tap({ plan: "got", key: app.keyFor("tomato") });
  assert.equal(calls.completed.length, 0, "the flour is still outstanding");

  // Dropping the meal that wanted the flour leaves nothing outstanding —
  // which is a state, not somebody saying they have finished.
  const pancakes = app.plan().meals.find((m) => m.name === "Pancakes");
  await app.tap({ plan: "meal-remove", meal: pancakes.id });
  await flush();

  assert.equal(calls.completed.length, 0,
    "archiving here would record a shop nobody said they had done");
  assert.equal(app.plan().meals.length, 1, "and the plan is still the book's live one");
});

test("J14.2 · finishing says what it did and offers Undo", async () => {
  const app = planMode([BOLOGNESE]);
  const calls = fakeCloud(app);
  app.card("add", app.named("Bolognese").id);
  app.open();
  await app.el("plan-done-btn").fire("click");
  await flush();

  assert.equal(app.el("toast").textContent, "Planned 1 meal.");
  assert.equal(app.el("toast-action").hidden, false, "and it is offered, not asked about");
  assert.equal(app.el("confirm-dialog").open, false, "nobody is interrogated about it");

  await app.el("toast-action").fire("click");
  await flush();

  assert.deepEqual(calls.undone, [calls.completed[0].id]);
  assert.deepEqual(app.plan().meals.map((m) => m.name), ["Bolognese"], "the plan came back");
});

test("J14.2 · an Undo that cannot reach the server says so rather than appearing to work", async () => {
  const app = planMode([BOLOGNESE]);
  const calls = fakeCloud(app, { undoFails: true });
  app.card("add", app.named("Bolognese").id);
  app.open();
  await app.el("plan-done-btn").fire("click");
  await flush();

  await app.el("toast-action").fire("click");
  await flush();

  assert.match(app.el("toast").textContent, /needs a connection/);
  assert.equal(app.planStore.hasArchived(calls.completed[0].id), true,
    "the record is still there, because taking it back never happened");
});

test("J14.3 · finishing needs at least one recipe: an empty plan offers no Done", async () => {
  const app = planMode([BOLOGNESE]);
  const calls = fakeCloud(app);
  app.open();

  assert.equal(app.el("plan-done-btn").hidden, true, "an empty plan has nothing to record");
  await app.el("plan-done-btn").fire("click");
  await flush();
  assert.deepEqual(calls.completed, [], "and pressing it anyway records nothing");

  app.card("add", app.named("Bolognese").id);
  app.open();
  assert.equal(app.el("plan-done-btn").hidden, false);
});

test("J14.4 · Clear asks first, and discards without recording", async () => {
  const app = planMode([BOLOGNESE]);
  fakeCloud(app);
  app.card("add", app.named("Bolognese").id);
  app.open();

  app.el("confirm-dialog").answer = ""; // "no"
  await app.el("plan-clear-btn").fire("click");
  assert.deepEqual(app.plan().meals.map((m) => m.name), ["Bolognese"],
    "answering no leaves the plan exactly where it was");

  app.el("confirm-dialog").answer = "yes";
  await app.el("plan-clear-btn").fire("click");
  await flush();

  assert.deepEqual(app.plan().meals, [], "the plan is discarded");
  assert.deepEqual(app.planStore.archive, [],
    "and a week that never happened does not claim to have been planned");
});

test("J14.4 · a cleared plan is a new generation, so an older device cannot hand it back", async () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  const before = app.plan();
  app.open();
  await app.el("plan-clear-btn").fire("click");
  await flush();

  assert.notEqual(app.plan().id, before.id);
  assert.ok(app.plan().createdAt > before.createdAt);
  assert.equal(
    app.win.RecipePlan.mergePlans(before, app.plan()).id,
    app.plan().id,
    "the cleared plan wins the merge against the one it replaced"
  );
});

// ---------------------------------------------------------------------
// J14.6-J14.9 · what the list says about what was planned
// ---------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

/**
 * A week that was planned and finished, `daysAgo` days back. Recorded the
 * way Done records one — a plan with the recipe in it, stamped completed —
 * because the archive is the only record there is (J14.11).
 */
function planned(app, recipe, daysAgo) {
  const plan = app.win.RecipePlan;
  const at = Date.now() - daysAgo * DAY;
  const week = plan.addMeal(plan.emptyPlan(at - 1000), recipe, at - 500);
  app.planStore.archivePlan(plan.complete(week, at));
  app.app.render();
}

/** What a card says about planning, if anything. */
const noteOnCard = (app) => {
  const m = /<p class="card-planned[^"]*">([^<]*)<\/p>/.exec(app.el("recipe-list").innerHTML);
  return m ? m[1] : "";
};

test("J14.6 · a recipe's card and its recipe view say when it was last planned", () => {
  const app = planning([BOLOGNESE]);
  planned(app, app.named("Bolognese"), 21);

  assert.equal(noteOnCard(app), "Planned 3 weeks ago",
    "the ordinary way of saying it, not which Tuesday it was");

  app.openRecipe(app.named("Bolognese").id);
  assert.match(app.el("detail-content").innerHTML, /Planned 3 weeks ago/);
});

test("J14.6 · the word is always planned, and the date is the date the plan was finished", () => {
  const app = planning([BOLOGNESE]);
  planned(app, app.named("Bolognese"), 1);

  assert.equal(noteOnCard(app), "Planned yesterday");
  assert.doesNotMatch(app.el("recipe-list").innerHTML, /cook/i,
    "this is a planner, not an oven: nothing here knows whether a pan was used");
});

test("J14.6 · the newest of several plans is the one a recipe reports", () => {
  const app = planning([BOLOGNESE]);
  planned(app, app.named("Bolognese"), 40);
  planned(app, app.named("Bolognese"), 3);

  assert.equal(noteOnCard(app), "Planned 3 days ago");
});

test("J14.7 · a recipe that has never been planned says nothing at all", () => {
  const app = planning([BOLOGNESE]);

  assert.equal(noteOnCard(app), "", "no line at all, rather than an empty one");
  assert.doesNotMatch(app.el("recipe-list").innerHTML, /never/i,
    "“Never planned” reads as a reproach on a recipe typed five minutes ago");
  app.openRecipe(app.named("Bolognese").id);
  assert.doesNotMatch(app.el("detail-content").innerHTML, /planned/i);
});

test("J14.4 · a plan that was cleared rather than finished says nothing either", () => {
  const app = planning([BOLOGNESE]);
  const plan = app.win.RecipePlan;
  // Archived without ever being completed is not a record of anything.
  app.planStore.archivePlan(plan.addMeal(plan.emptyPlan(1000), app.named("Bolognese"), 1001));
  app.app.render();

  assert.equal(noteOnCard(app), "", "a week that never happened should not claim to have been planned");
});

test("J14.8 · a recipe in the live plan says so instead", () => {
  const app = planMode([BOLOGNESE]);
  planned(app, app.named("Bolognese"), 21);
  app.card("add", app.named("Bolognese").id);

  assert.equal(noteOnCard(app), "In the plan",
    "more use than a date while you are deciding, and it stops it going in twice by accident");
  app.openRecipe(app.named("Bolognese").id);
  assert.match(app.el("detail-content").innerHTML, /In the plan/);
  assert.doesNotMatch(app.el("detail-content").innerHTML, /Planned 3 weeks ago/);
});

test("J14.9 · Not planned lately sorts least recently planned first, never-planned before them", () => {
  const app = planning([BOLOGNESE, CURRY, PANCAKES]);
  planned(app, app.named("Curry"), 2);
  planned(app, app.named("Bolognese"), 30);

  assert.deepEqual(app.titles(), ["Pancakes", "Curry", "Bolognese"],
    "the box as it stands, newest first");

  app.el("not-planned-filter").fire("click");
  assert.deepEqual(app.titles(), ["Pancakes", "Bolognese", "Curry"],
    "the one nobody has ever planned, then the oldest, then the newest");

  app.el("not-planned-filter").fire("click");
  assert.deepEqual(app.titles(), ["Pancakes", "Curry", "Bolognese"], "and off again");
});

test("J14.9, J3.2 · the chip combines with search and tags as the others do", () => {
  const app = planning([BOLOGNESE, CURRY, PANCAKES]);
  planned(app, app.named("Curry"), 2);
  planned(app, app.named("Pancakes"), 30);
  app.el("not-planned-filter").fire("click");

  app.el("tag-filters").fire("click", {
    target: { closest: () => ({ dataset: { tag: "quick" } }) },
  });
  assert.deepEqual(app.titles(), ["Pancakes", "Curry"],
    "the tag still narrows, and the chip still orders what is left");

  app.el("tag-filters").fire("click", {
    target: { closest: () => ({ dataset: { tag: "quick" } }) },
  });
  app.el("search-input").value = "onion";
  app.el("search-input").fire("input");
  assert.deepEqual(app.titles(), ["Bolognese", "Curry"],
    "and so does a search: never planned first, then the least recent of the rest");
});

test("J14.9 · Favourites and the chip narrow and order together", () => {
  const app = planning([BOLOGNESE, CURRY, PANCAKES]);
  planned(app, app.named("Curry"), 2);
  app.store.toggleFavorite(app.named("Curry").id);
  app.store.toggleFavorite(app.named("Pancakes").id);
  app.app.render();

  app.el("favorites-filter").fire("click");
  app.el("not-planned-filter").fire("click");
  assert.deepEqual(app.titles(), ["Pancakes", "Curry"]);
});

test("J13.1 · the readout is the meals, and under them everything they ask for", () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  app.open();
  const html = app.readout();
  assert.ok(html.indexOf("<h3>Meals</h3>") < html.indexOf("<h3>Shopping list</h3>"),
    "one thread to follow, and one scroll to follow it with");
});

test("J12.1 · a plan is a bag of meals, and one can be taken back out of it", async () => {
  const app = planMode([BOLOGNESE, CURRY]);
  app.card("add", app.named("Bolognese").id);
  app.card("add", app.named("Curry").id);
  app.open();

  const bolognese = app.plan().meals[0];
  await app.tap({ plan: "meal-remove", meal: bolognese.id });
  assert.deepEqual(app.plan().meals.map((m) => m.name), ["Curry"]);
  assert.doesNotMatch(app.words(), /Bolognese/);
});

test("J12.5 · portions step from the readout the way the recipe view steps them", async () => {
  const app = planMode([BOLOGNESE]);
  app.card("add", app.named("Bolognese").id);
  app.open();

  const meal = app.plan().meals[0];
  await app.tap({ plan: "meal-up", meal: meal.id });
  assert.equal(app.plan().meals[0].portions, 5);
  assert.match(app.words(), /Serves 5/);
  assert.equal(app.list().lines.find((l) => l.item.includes("onion")).required, 2.5,
    "and the shopping list follows the portions");
});

test("J14.6 · a page that never loaded the planner still draws its cards", () => {
  // index.html asks for plan.js, planstore.js and shoplist.js, but a
  // script that does not arrive leaves a page that has the rest of the
  // app and no planner. Saying nothing about planning is the whole of
  // what that should cost — a card that cannot be drawn costs the list.
  const app = planning([BOLOGNESE, CURRY], { planner: false });

  assert.deepEqual(app.titles(), ["Curry", "Bolognese"], "the list is still a list");
  assert.doesNotMatch(app.el("recipe-list").innerHTML, /card-planned/,
    "with nothing to say about planning");
  assert.equal(app.el("plan-btn").hidden, true, "and no planner offered");
  app.openRecipe(app.named("Curry").id);
  assert.equal(app.el("detail-dialog").open, true, "and a recipe still opens");
});

test("J13.7 · a recipe name off a share link reaches the readout as text", () => {
  const hostile = '"><img src=x onerror=alert(1)>';
  const app = planMode([
    aRecipe({
      name: hostile,
      servings: 2,
      ingredients: [{ amount: 2, unit: hostile, item: hostile }],
      steps: ["Cook it."],
    }),
  ]);
  app.card("add", app.saved[0].id);
  app.open();
  // Part-settle it so the second number, the one J13.10 added, is on
  // screen carrying the same untrusted words.
  const line = app.list().lines[0];
  app.planStore.setPlan(app.win.RecipePlan.settle(app.plan(), line.key, "have", 1, Date.now()));
  app.app.render();

  for (const html of [app.readout(), app.el("recipe-list").innerHTML]) {
    assert.doesNotMatch(html, /<img/, "a name is text wherever it is printed");
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /aria-label="[^"]*"><img/, "including inside a quoted attribute");
  }
});
