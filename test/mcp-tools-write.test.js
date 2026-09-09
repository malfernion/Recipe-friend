/**
 * mcp/tools-write.js — the three tools that change something.
 *
 * The interesting assertions are about what an agent must *not* do, and
 * about the failures in between: a tool that says it filed a recipe when
 * it did not, or says it failed when it did, is how a household ends up
 * with two of the same dinner and no way to delete either (J16.3).
 *
 * Every tool here is called through the harness's `call`, which pulls
 * first the way the server does (J17.9). Going straight to `tool.run` is
 * testing a path no host takes.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { agentBook, BOOK } = require("./helpers/agent.js");
const write = require("../mcp/tools-write.js");
const read = require("../mcp/tools-read.js");

const by = (name) => [...write, ...read].find((t) => t.name === name);
const ADD = by("add_to_plan");
const REMOVE = by("remove_from_plan");
const FILE = by("add_recipe");

const PIE = {
  name: "Chicken pie",
  servings: 4,
  ingredients: [
    { amount: 500, unit: "g", item: "chicken" },
    { amount: 1, unit: "", item: "onion" },
  ],
  steps: ["Bake it."],
};
const SOUP = {
  name: "Lentil soup",
  servings: 2,
  ingredients: [
    { amount: 200, unit: "g", item: "lentils" },
    { amount: 2, unit: "", item: "onions" },
  ],
  steps: ["Simmer it."],
};
const DAL = {
  name: "Dal",
  ingredients: [{ amount: 200, unit: "g", item: "red lentils" }],
  steps: ["Simmer it."],
};

const aBook = () => agentBook({ recipes: [PIE, SOUP] });

// --- the plan ---------------------------------------------------------

test("J12.4 · a meal goes in at what the recipe serves unless asked otherwise", async () => {
  const { call, idOf, sent } = await aBook();

  const out = await call(ADD, { meals: [{ recipeId: idOf("Chicken pie") }] });

  assert.deepEqual(out.added.map((m) => [m.name, m.portions]), [["Chicken pie", 4]]);
  assert.equal(sent.livePlans.length, 1, "the plan belongs to the book, so it goes up now");
  assert.deepEqual(sent.livePlans[0].meals.map((m) => m.name), ["Chicken pie"]);
});

test("portions are stepped the way a tap steps them, not written into the meal", async () => {
  const { call, idOf } = await aBook();

  const out = await call(ADD, {
    meals: [{ recipeId: idOf("Chicken pie"), portions: 6 }, { recipeId: idOf("Lentil soup"), portions: 1 }],
  });

  assert.deepEqual(out.added.map((m) => [m.name, m.portions]), [["Chicken pie", 6], ["Lentil soup", 1]]);
  assert.ok(out.plan.toBuy.includes("750 g chicken"), out.plan.toBuy.join(" · "));
});

test("a recipe that is not in the book is reported rather than silently skipped", async () => {
  const { call, idOf } = await aBook();

  const out = await call(ADD, { meals: [{ recipeId: idOf("Lentil soup") }, { recipeId: "gone" }] });

  assert.deepEqual(out.added.map((m) => m.name), ["Lentil soup"]);
  assert.deepEqual(out.missing, ["gone"]);
});

test("J14.4 · a meal can come back out, and nothing is written down about it", async () => {
  const { call, idOf, sent } = await aBook();
  const added = await call(ADD, { meals: [{ recipeId: idOf("Chicken pie") }] });
  // Real milliseconds, because the merge runs on them: two writes inside
  // one tick are a tie, and a tie is broken on the fingerprint rather
  // than on which came second (J12.11). The tool reports that honestly
  // when it happens — there is a test for it above — but it is not what
  // this test is about.
  await new Promise((resume) => setTimeout(resume, 2));

  const out = await call(REMOVE, { mealIds: [added.added[0].mealId] });

  assert.deepEqual(out.removed.map((m) => m.name), ["Chicken pie"]);
  assert.deepEqual(out.plan.meals, []);
  assert.deepEqual(sent.archived, [], "clearing records nothing");
});

test("a mealId that is not in the plan is an answer, not a failure", async () => {
  const { call } = await aBook();

  const out = await call(REMOVE, { mealIds: ["not-a-meal"] });

  assert.deepEqual(out.removed, []);
  assert.deepEqual(out.missing, ["not-a-meal"]);
});

test("J17.9 · a meal somebody added from a phone survives the agent's write (J12.11)", async () => {
  const { call, win, idOf, setRemotePlan, sent, book } = await aBook();
  await call(ADD, { meals: [{ recipeId: idOf("Lentil soup") }] });
  const asPushed = sent.livePlans.at(-1);

  // A phone puts a pie in the same plan, a moment later. Meals do not
  // merge — the more recently touched body wins whole — so the agent has
  // to be looking at that plan before it writes, not at the one it read.
  const pie = book.recipes.find((r) => r.name === "Chicken pie");
  setRemotePlan(win.RecipePlan.addMeal(asPushed, pie, asPushed.updatedAt + 1));
  await new Promise((resume) => setTimeout(resume, 5));

  await call(ADD, { meals: [{ recipeId: idOf("Lentil soup") }] });

  assert.deepEqual(
    sent.livePlans.at(-1).meals.map((m) => m.name).sort(),
    ["Chicken pie", "Lentil soup", "Lentil soup"]
  );
});

test("J17.9 · a meal is stamped after the pull, or the plan it was pulled from outranks it", async () => {
  const { book, api, win, idOf } = await aBook();
  // The book's plan, stamped the moment it is first read — which is what
  // a plan somebody else has just written looks like when it arrives.
  // A stamp taken before that read is older than the plan it is being
  // written onto, and the merge hands the whole plan to the other side
  // (J12.11): the meal goes, and only the report would say otherwise.
  let held = null;
  api.fetchLivePlan = async () => {
    if (!held) {
      const plan = win.RecipePlan.emptyPlan(Date.now());
      held = { book_id: BOOK, data: plan, updated_at: new Date().toISOString() };
    }
    return held;
  };
  await book.refresh();

  const out = await ADD.run(book, { meals: [{ recipeId: idOf("Chicken pie") }] });

  assert.deepEqual(out.added.map((m) => m.name), ["Chicken pie"]);
  assert.ok(!out.dropped, "nothing outranked it");
});

test("J17.9 · a write dropped by somebody else's is reported as dropped, not as done", async () => {
  const { book, win, idOf, setRemotePlan } = await aBook();
  await book.refresh();

  // The other device's plan lands between this tool's pull and its
  // push, and is the newer body — so it wins whole and takes the
  // agent's meal with it (J12.11). Saying "added" here would be a tool
  // reporting something the book does not contain.
  const pie = book.recipes.find((r) => r.name === "Chicken pie");
  setRemotePlan(win.RecipePlan.addMeal(book.plan, pie, Date.now() + 60000));

  const out = await ADD.run(book, { meals: [{ recipeId: idOf("Lentil soup") }] });

  assert.deepEqual(out.added, [], "nothing of ours survived");
  assert.deepEqual(out.dropped, ["Lentil soup"]);
  assert.match(out.note, /another device at the same moment/);
  assert.deepEqual(out.plan.meals.map((m) => m.name), ["Chicken pie"], "and the plan says so too");
});

test("J17.10 · a plan write that could not be sent is taken back out, not left to land later", async () => {
  const { call, book, idOf, breakPlanPush, mendNetwork, sent } = await aBook();
  // The pull succeeds and the push does not, which is the only way this
  // failure happens: the server pulls before the tool runs.
  await book.refresh();
  breakPlanPush();

  await assert.rejects(() => ADD.run(book, { meals: [{ recipeId: idOf("Chicken pie") }] }));

  // The bug this replaces: the meal stayed in the plan this process
  // holds, and the next call pushed it — so a model retrying after a
  // reported failure put two pies in the household's week.
  mendNetwork();
  const out = await call(ADD, { meals: [{ recipeId: idOf("Lentil soup") }] });

  assert.deepEqual(out.plan.meals.map((m) => m.name), ["Lentil soup"]);
  assert.deepEqual(sent.livePlans.at(-1).meals.map((m) => m.name), ["Lentil soup"]);
});

test("J17.10 · two plan writes at once, both failing, leave nothing behind between them", async () => {
  const { book, idOf, breakPlanPush, mendNetwork, sent } = await aBook();
  await book.refresh();
  breakPlanPush();

  // Two tool calls in one model turn is ordinary, and this is where the
  // undo used to go wrong: it restored the whole plan as it was at the
  // top of the call, so the second call's idea of "as it was" already
  // contained the first call's meal — and putting that back after the
  // first had rolled it back left a meal both calls had reported as
  // failed, for the next call to push.
  const both = await Promise.allSettled([
    ADD.run(book, { meals: [{ recipeId: idOf("Chicken pie") }] }),
    ADD.run(book, { meals: [{ recipeId: idOf("Lentil soup") }] }),
  ]);

  assert.deepEqual(both.map((r) => r.status), ["rejected", "rejected"]);
  assert.deepEqual(book.plan.meals, [], "nothing survived a failure both callers were told about");

  mendNetwork();
  await book.refresh();
  assert.deepEqual(sent.livePlans, [], "and no later call pushes what nobody asked for");
});

test("a dropped removal is never blamed on a full plan, which is not a reason to fail one", async () => {
  const { book, win, setRemotePlan } = await aBook();
  await book.refresh();
  const pie = book.recipes.find((r) => r.name === "Chicken pie");

  // A full plan, and somebody else's newer body arriving before the push
  // — so taking a meal out is dropped, and the plan is still at the cap.
  let full = book.plan;
  for (let i = 0; i < win.RecipePlanStore.limits.MAX_MEALS; i++) {
    full = win.RecipePlan.addMeal(full, pie, Date.now() + i);
  }
  book.planStore.setPlan(full);
  setRemotePlan({ ...full, updatedAt: Date.now() + 60000 });

  const out = await REMOVE.run(book, { mealIds: [full.meals[0].id] });

  assert.deepEqual(out.removed, []);
  assert.equal(out.dropped.length, 1);
  assert.match(out.note, /another device at the same moment/);
  assert.ok(
    !/plan is full/.test(out.note),
    "telling somebody emptying a plan that it is full and to empty it is not advice"
  );
});

test("a plan with no room says so, rather than blaming another device", async () => {
  const { book, win, idOf } = await aBook();
  await book.refresh();
  const pie = book.recipes.find((r) => r.name === "Chicken pie");
  let full = book.plan;
  for (let i = 0; i < win.RecipePlanStore.limits.MAX_MEALS; i++) {
    full = win.RecipePlan.addMeal(full, pie, Date.now() + i);
  }
  book.planStore.setPlan(full);

  const out = await ADD.run(book, { meals: [{ recipeId: idOf("Lentil soup") }] });

  assert.deepEqual(out.added, []);
  assert.deepEqual(out.dropped, ["Lentil soup"]);
  assert.match(out.note, /plan is full/);
  assert.ok(!/another device/.test(out.note), "a full plan is not somebody else's write");
});

test("J16.4 · a week that has been finished is not one an agent adds to", async () => {
  const { call, idOf, win, setRemotePlan, sent } = await aBook();
  // A Done that landed half way: on the record, and the empty plan that
  // should have replaced it has not arrived. An agent leaves it for a
  // person's device — and writing into it would put this meal into the
  // record when that device finishes the job.
  setRemotePlan({ ...win.RecipePlan.emptyPlan(1), completedAt: 5000 });

  const out = await call(ADD, { meals: [{ recipeId: idOf("Chicken pie") }] });

  assert.match(out.error, /finished/);
  assert.deepEqual(sent.livePlans, [], "nothing went up");
  const removing = await call(REMOVE, { mealIds: ["anything"] });
  assert.match(removing.error, /finished/);
});

// --- filing a recipe --------------------------------------------------

test("J16.3 · a filed recipe goes up as a row the server has never seen", async () => {
  const { call, sent } = await aBook();

  const out = await call(FILE, { ...DAL, servings: 2, tags: ["quick"] });

  assert.equal(out.added.name, "Dal");
  assert.match(out.note, /cannot delete/);
  assert.deepEqual(sent.recipes.map((r) => r.data.name), ["Dal"], "and nothing else went with it");
  assert.equal(sent.recipes[0].book_id, BOOK, "as a row for this book, built by sync");
});

test("J16.3 · a recipe the server already holds is never sent again", async () => {
  const { call, book, sent, idOf } = await aBook();
  // Make the local copy of a held recipe newer than the server's, which
  // is what puts it in `toPush`. An agent pushing it would send an
  // upsert against a row that exists — an UPDATE no policy matches —
  // and one refusal fails the batch, taking the new recipe with it.
  book.store.update(idOf("Chicken pie"), { description: "edited locally" });

  await call(FILE, DAL);

  assert.deepEqual(sent.recipes.map((r) => r.data.name), ["Dal"]);
});

test("J16.11 · a recipe below the floor is refused, the same as from anybody", async () => {
  const { call, sent } = await aBook();

  for (const short of [
    { name: "", ingredients: [{ item: "x" }], steps: ["do"] },
    { name: "No steps", ingredients: [{ item: "x" }], steps: [] },
    { name: "No ingredients", ingredients: [], steps: ["do"] },
  ]) {
    const out = await call(FILE, short);
    assert.match(out.error, /needs a name, at least one ingredient and at least one step/);
  }
  assert.deepEqual(sent.recipes, [], "nothing refused was sent anywhere");
});

test("J17.10 · a recipe that reached the book is reported as filed, whatever else failed", async () => {
  const { call, breakPlanHalf, mendNetwork, book, sent } = await aBook();
  await book.refresh();
  // The shape that made this lie: recipes go up first and succeed, and
  // the plan half of the same trip fails afterwards. `syncNow` reports
  // one failure for both, so a tool that rolled back on it would take
  // back a recipe the book already holds — and the retry it invites
  // would file a second copy nobody on this side can delete.
  breakPlanHalf();

  const out = await FILE.run(book, DAL);

  assert.equal(out.landed, "confirmed");
  assert.equal(out.added.name, "Dal");
  assert.ok(!out.error, "it landed; saying otherwise invites a duplicate");
  assert.deepEqual(sent.recipes.map((r) => r.data.name), ["Dal"]);

  // The cache is a cache: the row comes out of it while the book is
  // being asked — so that no sync started by a call arriving in that
  // window can push it — and the next pull brings it back, because by
  // then it is the book's.
  mendNetwork();
  await book.refresh();
  assert.ok(book.recipes.some((r) => r.name === "Dal"), "and nothing was lost taking it out");
});

test("J17.10 · a recipe that never reached the book is taken back out and said to be safe to resend", async () => {
  const { breakRecipePush, book } = await aBook();
  await book.refresh();
  // The push failed but the book is readable, so this can be checked
  // rather than guessed.
  breakRecipePush();

  const out = await FILE.run(book, DAL);

  assert.match(out.error, /was not filed/);
  assert.match(out.error, /safe to send again/);
  assert.ok(!out.added, "nothing to report as added");
  assert.ok(!book.recipes.some((r) => r.name === "Dal"), "the cache dies with the process");
});

test("J17.10 · a recipe nobody can check on is not called filed and not called failed", async () => {
  const { breakNetwork, mendNetwork, book, sent } = await aBook();
  await book.refresh();
  breakNetwork();

  const out = await FILE.run(book, DAL);

  assert.equal(out.landed, "unknown");
  assert.match(out.error, /may or may not have been filed/);
  assert.match(out.error, /Do not send it again without looking/);
  // Kept. Nobody could find out, so throwing the recipe away would lose
  // one that was never filed — and putting it back is safe because it
  // keeps its own id, which a later sync pushes only if the server has
  // never seen it (J16.3).
  assert.ok(book.recipes.some((r) => r.name === "Dal"), "not thrown away on an unanswered question");

  // And it does land, once there is a network to land on.
  mendNetwork();
  await book.refresh();
  assert.deepEqual(sent.recipes.map((r) => r.data.name), ["Dal"], "exactly once");
});

test("J17.9 · a change started while somebody else's sync is in flight still lands, and says so truly", async () => {
  const { book, api, idOf, sent } = await aBook();
  await book.refresh();

  // An ordinary read's sync, parked mid-flight at an await every sync
  // makes. It has already read the plan it will apply and push.
  let release;
  const parked = new Promise((resume) => (release = resume));
  const real = api.fetchArchivedPlanIds.bind(api);
  let once = false;
  api.fetchArchivedPlanIds = async () => {
    if (!once) {
      once = true;
      await parked;
    }
    return real();
  };
  const stranger = book.refresh();
  await new Promise((resume) => setTimeout(resume, 5));

  // A change starts. If it shares the book with that sync, the sync
  // applies the plan it read over the top of this one and pushes what it
  // read — and the change is judged against a plan it never got into.
  const writing = ADD.run(book, { meals: [{ recipeId: idOf("Lentil soup") }] });
  await new Promise((resume) => setTimeout(resume, 5));
  release();

  const out = await writing;
  await stranger.catch(() => {});

  assert.deepEqual(out.added.map((m) => m.name), ["Lentil soup"]);
  assert.ok(!out.dropped, "nothing was dropped, so nothing should say it was");
  assert.deepEqual(
    sent.livePlans.at(-1).meals.map((m) => m.name),
    ["Lentil soup"],
    "and the book got what the tool said it got"
  );
});

test("J17.9 · a question arriving while a change is in flight waits for it", async () => {
  const { book, api, idOf } = await aBook();
  await book.refresh();

  // The order is the assertion: a change reads, then pushes. A question
  // that lands between those two has seen the book half-changed, which
  // is where every one of this file's harder bugs came from.
  const order = [];
  const realRead = api.fetchRecipes.bind(api);
  const realPush = api.pushLivePlan.bind(api);
  api.fetchRecipes = async () => {
    order.push("read");
    return realRead();
  };
  api.pushLivePlan = async (id, plan) => {
    order.push("push");
    return realPush(id, plan);
  };

  const writing = ADD.run(book, { meals: [{ recipeId: idOf("Chicken pie") }] });
  const question = book.refresh();
  await Promise.all([writing, question]);

  assert.deepEqual(order, ["read", "push", "read"], "the question waited its turn");
});

test("J16.10 · a picture arrives as a link or not at all", async () => {
  const { call, book } = await aBook();
  const tiny = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  await call(FILE, { ...DAL, name: "Pasted photo", image: tiny });
  await call(FILE, { ...DAL, name: "Linked photo", image: "https://example.com/dal.jpg" });

  const pasted = book.recipes.find((r) => r.name === "Pasted photo");
  const linked = book.recipes.find((r) => r.name === "Linked photo");
  assert.equal(pasted.image, "", "an agent can neither see the pictures in the book nor add one");
  assert.equal(linked.image, "https://example.com/dal.jpg", "a link lives on the recipe (J6.2)");
});

// --- the shape of the whole set ---------------------------------------

test("J17.6 · no tool exists for anything the credential cannot do", () => {
  const names = [...read, ...write].map((t) => t.name);

  assert.deepEqual(
    names.filter((n) => /edit|update|delete|remove_recipe|favourite|favorite|star|done|finish|complete/.test(n)),
    []
  );
  assert.deepEqual(names.sort(), [
    "add_recipe", "add_to_plan", "find_recipes", "get_plan", "get_recipe",
    "list_recipes", "planning_history", "recipes_sharing_ingredients", "remove_from_plan",
  ]);
});

test("J17.10 · the one-way tool says so twice: to the client in a hint, to the model in words", () => {
  assert.equal(FILE.annotations.readOnlyHint, false);
  assert.equal(FILE.annotations.destructiveHint, true);
  assert.match(FILE.description, /cannot be undone/i);
  assert.match(FILE.description, /permanent until a person removes it/);

  for (const tool of [ADD, REMOVE]) {
    assert.equal(tool.annotations.readOnlyHint, false, tool.name);
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
  }
});
