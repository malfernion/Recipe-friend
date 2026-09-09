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
 * One ingredient line, as written or at the size that was asked for
 * (J17.12).
 *
 * `text` only appears on a scaled line, and it is `RecipeScale`'s own
 * rendering rather than a second opinion of it: kitchen fractions, so
 * half of "1½ tbsp" is "¾ tbsp" and not "0.75 tbsp" (J4.7). It is the
 * line the screen would show, minus the reader's unit preferences, which
 * belong to a person and not to an agent (J8.2).
 *
 * `amount` stays a number, and is the truth where the text is not:
 * J4.8's floor renders anything below 0.05 as "0", so a recipe taken far
 * enough down says "0 tsp" for something that is present — accepted on
 * screen because the recipe as written is one tap away, and worth
 * keeping the number beside here because a model has no tap.
 *
 * Rounded to the thousandth, because 200 ÷ 3 is 66.66666666666667 and
 * that is float noise wearing the clothes of a precision no recipe was
 * ever written to — except where that rounding would itself reach zero,
 * which is the one thing this field must never say about an ingredient
 * that is present.
 */
function ingredientLine(win, ing, scale) {
  const line = { amount: ing.amount, unit: ing.unit, item: ing.item };
  if (!scale) return line;
  if (ing.amount === null || ing.amount === undefined) {
    return { ...line, text: win.RecipeScale.ingredientText(ing, scale.factor) };
  }
  const scaled = ing.amount * scale.factor;
  const rounded = Math.round(scaled * 1000) / 1000;
  // Rounding that reached zero would put the thing this field exists to
  // prevent back one order of magnitude down: `amount: 0` is a value
  // `sanitizeIngredient` never produces, so a caller cannot tell it from
  // the `null` of a line that never had an amount, and both fields would
  // then say nothing is there. Three figures of what there is instead.
  const amount = rounded === 0 ? Number(scaled.toPrecision(3)) : rounded;
  return { ...line, amount, text: win.RecipeScale.ingredientText(ing, scale.factor) };
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
 *
 * `scale` is null for the recipe as it was written down, or
 * `{ factor, servings? }` for the size somebody asked to cook it at
 * (J17.12). It reaches the ingredient lines and nothing else: times and
 * the method are the recipe's whatever size it is cooked at, and
 * `servings` below stays the number the household wrote, with `scaledTo`
 * saying what this answer is at. A field that changed meaning under a
 * caller would be one recipe answering about two different dinners.
 */
function full(win, recipe, planned, scale = null) {
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
    ingredientLines: (recipe.ingredients || []).map((ing) => ingredientLine(win, ing, scale)),
    ...(scale ? { scaledTo: scale } : {}),
    steps: recipe.steps,
    image,
    favorite: recipe.favorite,
    addedAt: new Date(recipe.createdAt).toISOString(),
  };
}

/**
 * The meals in a plan whose recipe is still in the book (J12.8).
 *
 * A recipe that leaves the book leaves the plan, and the app makes that
 * true on every render: `prunePlan` runs before it draws anything, and
 * the shopping list independently skips a meal whose recipe has gone so
 * it cannot "invent a blank line for it". A tool reporting the plan raw
 * lists a meal the phone does not show and buys nothing for it — one
 * answer contradicting itself.
 *
 * Reported, not pruned: taking the meal out is a write, and a question
 * must not make one. The next device that draws the plan will do it.
 */
function mealsInBook(book) {
  const have = new Set(book.recipes.map((recipe) => recipe.id));
  return book.plan.meals.filter((meal) => have.has(meal.recipeId));
}

/** How much of a recipe a meal is, said the way the screen says it. */
function mealAmount(meal) {
  return {
    mealId: meal.id,
    recipeId: meal.recipeId,
    name: meal.name,
    portions: meal.portions,
    // A recipe that does not say what it serves is planned by a
    // multiplier (J12.4), and the screen shows "× 2". Without this a
    // meal at ×1 and the same meal at ×3 are the same two lines of JSON.
    ...(Number(meal.portions) > 0 ? {} : { multiplier: meal.multiplier || 1 }),
  };
}

module.exports = { digest, full, ingredientLine, ingredientKeys, minutesFor, mealsInBook, mealAmount, NO_PHOTO };
