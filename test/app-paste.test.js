/**
 * J5 · Bringing in a recipe from outside — driven through the app.
 *
 * The paste box is where a recipe written by an assistant arrives, so it
 * has to cope with what assistants actually produce: JSON on its own, JSON
 * in a code fence, and JSON buried in a sentence of explanation. J5.8 says
 * anything it cannot use is explained rather than dropped in silence.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadUI, loadApp, aRecipe } = require("./helpers/load.js");

/** Paste this text, press the button, and see what the app did. */
async function paste(text) {
  const ui = loadUI();
  ui.el("paste-input").value = text;
  // The save handler is async — decoding a share link takes several turns.
  await ui.el("paste-save-btn").fire("click");
  return {
    error: ui.el("paste-error").textContent,
    dialogTitle: ui.el("dialog-title").textContent,
    reviewing: ui.el("recipe-dialog").open,
    nameField: ui.el("recipe-form").elements.name.value,
    store: ui.store,
  };
}

const RECIPE_JSON = JSON.stringify({
  name: "Coleslaw",
  servings: 4,
  ingredients: [
    { amount: 250, unit: "g", item: "white cabbage" },
    { amount: null, unit: "", item: "salt and pepper, to taste" },
  ],
  steps: ["Mix everything in a bowl."],
  tags: ["salad"],
});

test("J5.7 · bare JSON is accepted", async () => {
  const out = await paste(RECIPE_JSON);
  assert.equal(out.error, "");
  assert.equal(out.reviewing, true);
  assert.equal(out.nameField, "Coleslaw");
});

test("J5.7 · JSON inside a code fence is accepted", async () => {
  const out = await paste("```json\n" + RECIPE_JSON + "\n```");
  assert.equal(out.nameField, "Coleslaw");
  assert.equal(out.error, "");
});

test("J5.7 · JSON inside an unlabelled fence is accepted", async () => {
  const out = await paste("```\n" + RECIPE_JSON + "\n```");
  assert.equal(out.nameField, "Coleslaw");
});

test("J5.7 · an assistant's chatter around the JSON is tolerated", async () => {
  const out = await paste(
    "Sure! Here's that recipe in the format you asked for:\n\n" +
      RECIPE_JSON +
      "\n\nLet me know if you'd like me to adjust the quantities."
  );
  assert.equal(out.nameField, "Coleslaw");
  assert.equal(out.error, "");
});

test("J5.7 · a fence wins over braces in the surrounding prose", async () => {
  // Without the fence, the widest-braces scan would start at the aside and
  // end at the sign-off, and parse neither. This is the case that makes
  // fence handling load-bearing rather than decorative.
  const out = await paste(
    "Here you go! {note: I guessed the cabbage weight}\n\n" +
      "```json\n" + RECIPE_JSON + "\n```\n\n" +
      "Tell me if you want it scaled {say, for 8}."
  );
  assert.equal(out.nameField, "Coleslaw");
  assert.equal(out.error, "");
});

test("J5.7 · a share link can be pasted in the same box", async () => {
  const win = loadApp("units.js", "scale.js", "storage.js", "share.js");
  const recipe = win.RecipeStore.sanitizeRecipe(aRecipe({ name: "Shared Soup" }));
  const encoded = await win.RecipeShare.encodeRecipeShare(recipe);

  const out = await paste(`https://malfernion.github.io/Recipe-friend/#add=${encoded}`);
  assert.equal(out.nameField, "Shared Soup");
  assert.equal(out.error, "");
});

test("J5.1 · a pasted recipe is reviewed, not saved on the spot", async () => {
  const out = await paste(RECIPE_JSON);
  assert.equal(out.dialogTitle, "Review recipe");
  assert.equal(out.store.recipes.length, 0, "nothing is stored until it is confirmed");
});

test("J5.8 · text that is not a recipe at all is explained", async () => {
  const out = await paste("here is a lovely recipe for coleslaw, enjoy!");
  assert.match(out.error, /JSON or a share link/);
  assert.equal(out.reviewing, false);
});

test("J5.8 · malformed JSON says what is wrong with it", async () => {
  const out = await paste('{"name": "Coleslaw", ingredients: []}');
  assert.match(out.error, /isn't valid JSON/);
});

test("J5.8 · JSON that is not a usable recipe names the rule it breaks", async () => {
  const out = await paste('{"name": "Coleslaw", "ingredients": [], "steps": []}');
  assert.match(out.error, /at least one ingredient/);
  assert.equal(out.reviewing, false);
});

test("J5.8, J5.4 · a share link that was cut short says so", async () => {
  const out = await paste("https://malfernion.github.io/Recipe-friend/#add=1.notrealbase64");
  assert.match(out.error, /couldn't be read/);
});

test("J5.8 · an empty box is not an error, it just does nothing", async () => {
  const out = await paste("   ");
  assert.match(out.error, /JSON or a share link/);
  assert.equal(out.reviewing, false);
});

test("a pasted recipe keeps a valid id it was given, so a re-paste updates", async () => {
  const id = "77777777-7777-4777-8777-777777777777";
  const out = await paste(JSON.stringify({ ...JSON.parse(RECIPE_JSON), id }));
  assert.equal(out.reviewing, true);
  assert.equal(out.nameField, "Coleslaw");
});
