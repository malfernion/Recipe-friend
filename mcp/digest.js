/**
 * mcp/digest.js — what a recipe looks like to something with a budget.
 *
 * Sixty recipes as full JSON is about 20k tokens; the same sixty as the
 * digest below is about 4.4k. So the listing tools answer in digests and
 * `get_recipe` fetches the few that matter in full. Nothing here is a
 * summary in the lossy sense — every field is the recipe's own, chosen
 * because it is what a question about what to cook is actually asked
 * against.
 *
 * The ingredient keys are `stemWord`, not `itemKey`. `itemKey` is
 * deliberately unit-aware, so 500 g of chicken and 1 chicken are
 * different lines — right for a shopping list, wrong for "what else uses
 * chicken".
 */
"use strict";

/** A picture an agent may not have, said in a way that is not a lie. */
const NO_PHOTO = "not available to an agent";

function minutesFor(recipe) {
  const prep = recipe.prepMinutes;
  const cook = recipe.cookMinutes;
  if (prep === null && cook === null) return null;
  return (prep || 0) + (cook || 0);
}

/**
 * The things this recipe is about: stem to written word.
 *
 * The stem is the right thing to match on and the wrong thing to print.
 * In `js/shoplist.js` it is only ever a key — what a line displays is
 * the word somebody typed, which is what makes an over-eager join
 * visible (J13.7). Printing the stem instead gives a model "ric",
 * "chees" and "win" to read back to the household.
 *
 * So: keyed by stem, valued by the first spelling seen, and callers take
 * whichever they need.
 */
function ingredientKeys(win, recipe) {
  const seen = new Map();
  for (const ing of recipe.ingredients || []) {
    const written = String(ing.item || "").trim() || win.RecipeUnits.normalizeLabel(ing.unit);
    const stem = written && win.RecipeShopList.stemWord(written);
    if (stem && !seen.has(stem)) seen.set(stem, written);
  }
  return seen;
}

function digest(win, recipe, planned) {
  const entry = (planned && planned[recipe.id]) || null;
  return {
    id: recipe.id,
    name: recipe.name,
    tags: recipe.tags,
    servings: recipe.servings,
    minutes: minutesFor(recipe),
    ingredients: [...ingredientKeys(win, recipe).values()],
    lastPlanned: entry && entry.lastPlannedAt ? new Date(entry.lastPlannedAt).toISOString() : null,
    timesPlanned: entry ? entry.count : 0,
  };
}

/**
 * A recipe in full, minus the pictures an agent has no business with
 * (J16.10).
 *
 * `imagePath` names a file in private storage, which every policy refuses
 * an agent — handing over a path it cannot open would be an invitation to
 * keep trying. A `data:` image is on the recipe rather than in storage,
 * so nothing refuses it, but it is a megabyte of base64 that would eat
 * the conversation and tell nobody anything. A linked picture is a url
 * and travels, which is the line J6.2 already draws for a share link.
 */
function full(win, recipe, planned) {
  // Three cases, and the middle one is the trap: a linked picture
  // travels, a stored or pasted one becomes a note, and a recipe with no
  // picture at all says nothing rather than saying it was withheld.
  const linked = typeof recipe.image === "string" && /^https?:\/\//i.test(recipe.image);
  const hasPicture = Boolean(recipe.image || recipe.imagePath);
  const image = linked ? recipe.image : hasPicture ? NO_PHOTO : null;
  return {
    ...digest(win, recipe, planned),
    description: recipe.description,
    prepMinutes: recipe.prepMinutes,
    cookMinutes: recipe.cookMinutes,
    ingredientLines: (recipe.ingredients || []).map((ing) => ({
      amount: ing.amount,
      unit: ing.unit,
      item: ing.item,
    })),
    steps: recipe.steps,
    image,
    favorite: recipe.favorite,
    addedAt: new Date(recipe.createdAt).toISOString(),
  };
}

module.exports = { digest, full, ingredientKeys, minutesFor, NO_PHOTO };
