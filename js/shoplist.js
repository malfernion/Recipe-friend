/**
 * shoplist.js — turning a plan into the shop (J13).
 *
 * Every planned recipe's ingredients, scaled to the portions planned and
 * summed into one line per thing to buy. Pure, like plan.js: it is handed
 * a plan, the recipes it names and the reader's unit preferences, and
 * gives back lines. Nothing here touches the DOM, and nothing it returns
 * is stored — the list is derived from the plan every time, so the only
 * thing anybody has to keep is what they have settled.
 *
 * A line:
 *   {
 *     key,                       // the item key settlements are held under
 *     item, unit, amount, text,  // what to show: "400 g tomatoes"
 *     family, baseUnit,          // how it was summed
 *     required, have, got, outstanding,   // all in base units
 *     settled,                   // "" | "have" | "got"
 *     toTaste,                   // J13.8 — a presence, not a quantity
 *     from: [{mealId, recipeId, name, base, amount, text}]   // J13.7
 *   }
 */
(function (global) {
  "use strict";

  // Grams for mass, millilitres for volume.
  const CANONICAL = Object.freeze({ mass: "metric", volume: "metric" });

  /**
   * An amount in its family's base unit. The conversion table lives in
   * units.js and stays there — asking it to convert a thousand of
   * something and dividing by a thousand keeps the rounding it does for
   * display (whole grams, two decimals on kilos) far below anything a
   * shop cares about, and leaves one table in the app rather than two.
   * Kilos and litres are the one thing it hands back unconverted when the
   * reader is already metric, and multiplying by a thousand there is an
   * SI prefix rather than a second opinion about what an ounce weighs.
   */
  function toBase(amount, unit) {
    const probe = global.RecipeUnits.convertIngredient({ amount: amount * 1000, unit, item: "" }, CANONICAL);
    const scale = probe.unit === "kg" || probe.unit === "l" ? 1000 : 1;
    return (probe.amount * scale) / 1000;
  }

  /**
   * The word a line is filed under. Lowercased, trimmed, and plural-
   * stemmed by search's rule (J3.4) rather than a second one of our own:
   * the app already believes "tomatoes" and "tomato" are the same word
   * when looking for a recipe, and believing it here too is what J13.4
   * asks for.
   *
   * Search can stop at that rule because it uses the stem as a substring
   * probe — "limes" stems to "lim", which is inside "lime". A key has to
   * be a form both spellings actually reach, so a trailing "e" the plural
   * rule would have eaten goes too, and "lime" and "limes" both key as
   * "lim". Erring towards over-stemming is the safe direction here: it
   * joins lines that should be joined, and every line says what it is
   * made of (J13.7), so a join that should not have happened is visible.
   */
  function stemWord(text) {
    const s = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
    const stripped = s.replace(/(?:es|s)$/, "");
    const singular = stripped.length >= 3 ? stripped : s;
    const trimmed = singular.replace(/e$/, "");
    return trimmed.length >= 3 ? trimmed : singular;
  }

  /**
   * The key a settlement is held against: the item, plus what it is
   * measured in. Mass keys with mass and volume with volume because those
   * convert; spoons and unrecognised units key by their own unit, because
   * those do not (J13.5, J4.6). So "400 g tomatoes" and "1 tin tomatoes"
   * are two lines, and so are teaspoons and tablespoons — nothing in the
   * app knows how big a tin is, and saying so is the same honesty as
   * letting "clove" and "pinch" through untouched.
   *
   * An amount-less line ("to taste", J2.3) is filed apart from a
   * quantified one of the same item: it is a thing you might be out of,
   * not a quantity, and the two are never summed (J13.8).
   */
  function itemKey(item, unit, toTaste) {
    const stem = stemWord(item);
    if (toTaste) return `${stem}|taste`;
    const family = global.RecipeUnits.familyOf(unit);
    if (family === "mass" || family === "volume") return `${stem}|${family}`;
    // The unit as written, give or take the plural — "2 cloves" and
    // "1 clove" are the same unit spelled two ways, not two units.
    return `${stem}|unit:${stemWord(global.RecipeUnits.normalizeLabel(unit))}`;
  }

  function recipeIndex(recipes) {
    if (recipes instanceof Map) return recipes;
    const map = new Map();
    for (const r of recipes || []) map.set(r.id, r);
    return map;
  }

  /**
   * The shopping list for a plan.
   *
   * Amounts are summed in base units and formatted exactly once, at the
   * end (J13.2). Formatting first and adding the results loses
   * ingredients: J4.8 renders anything below 0.05 as 0, and three lots of
   * "0 tsp" is not none.
   */
  function build(plan, recipes, prefs) {
    const byId = recipeIndex(recipes);
    const quantified = new Map();
    const toTaste = new Map();

    for (const meal of (plan && plan.meals) || []) {
      const recipe = byId.get(meal.recipeId);
      // A recipe that has left the book leaves the plan (J12.8); a plan
      // that has not been pruned yet must not invent a blank line for it.
      if (!recipe) continue;
      const factor = global.RecipePlan.factorFor(meal, recipe);

      for (const ing of recipe.ingredients || []) {
        const item = String(ing.item || "").trim() || global.RecipeUnits.normalizeLabel(ing.unit);
        if (!item) continue;
        const hasAmount = ing.amount !== null && ing.amount !== undefined && Number(ing.amount) > 0;
        const bucket = hasAmount ? quantified : toTaste;
        const key = itemKey(item, ing.unit, !hasAmount);

        let line = bucket.get(key);
        if (!line) {
          const family = hasAmount ? global.RecipeUnits.familyOf(ing.unit) : "none";
          line = {
            key,
            item,
            family,
            baseUnit:
              !hasAmount ? "presence" : family === "mass" ? "g" : family === "volume" ? "ml" : global.RecipeUnits.normalizeLabel(ing.unit),
            required: 0,
            toTaste: !hasAmount,
            from: new Map(),
          };
          bucket.set(key, line);
        }

        const scaled = Number(ing.amount) * factor;
        const contribution = !hasAmount
          ? 0
          : line.family === "mass" || line.family === "volume"
            ? toBase(scaled, ing.unit)
            : scaled;
        // "To taste" is never summed (J13.8): one presence is what such a
        // line requires however many recipes ask for it. That is also
        // what stops a second recipe wanting salt from un-settling the
        // salt somebody has already said they have.
        line.required = hasAmount ? line.required + contribution : 1;

        const seen = line.from.get(meal.id);
        if (seen) seen.base += contribution;
        else line.from.set(meal.id, { mealId: meal.id, recipeId: meal.recipeId, name: meal.name || recipe.name, base: contribution });
      }
    }

    const lines = [...quantified.values(), ...toTaste.values()].map((line) => finish(line, plan, prefs));
    return {
      lines,
      // What is left to buy, what is struck out in place, and what
      // collapsed into "you already have" (J13.9, J13.13).
      toBuy: lines.filter((l) => l.settled === ""),
      inBasket: lines.filter((l) => l.settled === "got"),
      alreadyHave: lines.filter((l) => l.settled === "have"),
      // Every line settled is what finishes a plan by itself (J14.2) — and
      // an empty plan has nothing to record and never finishes (J14.3).
      allSettled: lines.length > 0 && lines.every((l) => l.outstanding === 0),
    };
  }

  /** Settle up one accumulated line and work out how it should read. */
  function finish(line, plan, prefs) {
    const settledAmounts = global.RecipePlan.settledFor(plan, line.key);
    const outstanding = Math.max(0, line.required - settledAmounts.have - settledAmounts.got);

    // Formatted once, here, and in the reader's units (J13.6, J8): two
    // people in one book read one list each their own way.
    const shown = displayAmount(line, prefs);
    const amountText = shown.amount === null ? "" : global.RecipeScale.formatQuantity(shown.amount);
    // A shopping quantity is never rendered as 0 (J13.3). J4.8 accepts it
    // in a recipe, where the recipe as written is one tap away at full
    // portions; a list that says "0 g butter" is telling you to buy
    // nothing. Below that size the line shows the item and no amount —
    // and no unit either, since "g butter" is no better.
    const readable = amountText && amountText !== "0";
    const ratio = readable && line.required > 0 ? shown.amount / line.required : 0;

    return {
      key: line.key,
      item: line.item,
      unit: readable ? shown.unit : "",
      amount: readable ? shown.amount : null,
      text: [readable ? amountText : "", readable ? shown.unit : "", line.item].filter(Boolean).join(" "),
      family: line.family,
      baseUnit: line.baseUnit,
      required: line.required,
      have: settledAmounts.have,
      got: settledAmounts.got,
      outstanding,
      // Still wanted, in the basket, or already at home. A line settled
      // both ways reads as in the basket: it is the half that is still
      // worth seeing on the list.
      settled: outstanding > 0 ? "" : settledAmounts.got > 0 ? "got" : "have",
      toTaste: line.toTaste,
      // What the line is made of (J13.7), in the same unit the line is
      // shown in — "6 onions · Bolognese 4, Curry 2".
      from: [...line.from.values()].map((c) => {
        const amount = ratio ? c.base * ratio : null;
        const text = amount === null ? "" : global.RecipeScale.formatQuantity(amount);
        return { ...c, amount, text: text === "0" ? "" : text };
      }),
    };
  }

  // How many grams in an ounce, and millilitres in a fluid ounce, asked of
  // units.js rather than written down again.
  const OZ_IN_BASE = toBase(1, "oz");
  const FL_OZ_IN_BASE = toBase(1, "fl oz");

  /**
   * The amount to show and the unit to show it in, in the reader's
   * preferences (J13.6, J8) and with the unit picked by size the way J8.4
   * picks it — grams below a kilo, cups at half a cup and up.
   *
   * The conversion is RecipeUnits.convertIngredient's, so the reader's
   * preferences are applied by the same code that applies them to a
   * recipe. It converts only between systems, though — a recipe written
   * in grams keeps its grams (J4.4) — so a metric reader's line is handed
   * over in ounces and asked for metric back. A summed line has no
   * written unit to keep: what was entered was several things, in several
   * units, and the only honest answer is the size of the total. That is
   * also why "as entered" reads as metric here rather than as nothing:
   * base units are metric, and 1500 g is better said as 1.5 kg.
   *
   * Spoons and unrecognised units are already in the only unit they have
   * (J4.6), and are shown in it.
   */
  function displayAmount(line, prefs) {
    if (line.toTaste) return { amount: null, unit: "" };
    if (line.family === "mass") {
      const target = (prefs && prefs.mass) || "metric";
      const via =
        target === "metric"
          ? { amount: line.required / OZ_IN_BASE, unit: "oz" }
          : { amount: line.required, unit: "g" };
      return picked(converted(via, { mass: target, volume: "" }, line), via);
    }
    if (line.family === "volume") {
      const target = (prefs && prefs.volume) || "metric";
      const via =
        target === "metric"
          ? { amount: line.required / FL_OZ_IN_BASE, unit: "fl oz" }
          : { amount: line.required, unit: "ml" };
      return picked(converted(via, { mass: "", volume: target }, line), via);
    }
    return { amount: line.required, unit: line.baseUnit };
  }

  function converted(via, prefs, line) {
    return global.RecipeUnits.convertIngredient({ ...via, item: line.item }, prefs);
  }

  /**
   * units.js hands an amount back in the unit it arrived in when the
   * conversion would round it away to nothing. Since the unit it arrived
   * in is the one the reader did not ask for, that is the shopping list's
   * "below that size" (J13.3): the line shows the item and no amount,
   * rather than a stray gram for somebody reading in ounces.
   */
  function picked(result, via) {
    if (result.unit === via.unit) return { amount: null, unit: "" };
    return { amount: result.amount, unit: result.unit };
  }

  /**
   * What ✗ and ✓ record: the amount that was on the line when the gesture
   * was made (J13.9), as an absolute total rather than a step. Whatever
   * was already settled the other way is left where it is, so pressing ✓
   * on a line three of whose six onions are at home asks for the three
   * that are not.
   */
  function settleAmount(line, field) {
    return (field === "have" ? line.have : line.got) + line.outstanding;
  }

  function settleLine(plan, line, field, now) {
    return global.RecipePlan.settle(plan, line.key, field, settleAmount(line, field), now);
  }

  /** One tap puts a removed line back (J13.13). */
  function unsettleLine(plan, line, field, now) {
    return global.RecipePlan.unsettle(plan, line.key, field, now);
  }

  /**
   * What is left, ready to paste into whatever shopping app somebody
   * keeps (J13.12): everything neither removed nor settled, one line per
   * item, amount first. A static site has no supermarket to talk to, so
   * this is the interop — and because it is derived from what is still
   * outstanding, copying twice never asks for the same thing twice.
   */
  function copyText(list) {
    return (list && list.toBuy ? list.toBuy : []).map((l) => l.text).join("\n");
  }

  global.RecipeShopList = { build, copyText, itemKey, stemWord, settleAmount, settleLine, unsettleLine };
})(window);
