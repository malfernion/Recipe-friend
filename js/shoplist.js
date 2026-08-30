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
 *     shortfall, shortfallText,  // what is left to buy — J13.10, and
 *                                // what Copy takes: "1 onion"
 *     partText,                  // "3 sorted, 1 to get", on a line that
 *                                // is part-settled and only then
 *     settled,                   // "" | "have" | "got"
 *     toTaste,                   // J13.8 — a presence, not a quantity
 *     unitIsItem,                // "2 cloves": the unit is the only name
 *     from: [{mealId, recipeId, name, item, base, amount, text}]   // J13.7
 *   }
 *
 * `from[].item` is what that recipe wrote, which the line's own `item`
 * need not be: J13.7 wants "3 peppers · Bolognese 2 (red pepper), Curry 1
 * (black pepper)", and only the contribution knows the second half of it.
 */
(function (global) {
  "use strict";

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
        const written = String(ing.item || "").trim();
        // An ingredient may be a unit with no item — "2 cloves", "a pinch"
        // — because J2.1 asks for an amount, a unit or an item and not all
        // three. The unit is then the only name the line has, and saying
        // it twice is what "400 g g" was: the item fell back to the unit
        // and the unit was printed beside it. So the line remembers that
        // its name came from the unit, and prints one of them.
        const item = written || global.RecipeUnits.normalizeLabel(ing.unit);
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
            // The item is the unit, so the unit is not printed again.
            unitIsItem: !written,
            from: new Map(),
            // How much of the total arrived in each unit as written, so a
            // reader who keeps units as entered can be told which unit
            // most of the line came from (J13.6).
            units: new Map(),
          };
          bucket.set(key, line);
        }

        const scaled = Number(ing.amount) * factor;
        const converts = line.family === "mass" || line.family === "volume";
        const contribution = !hasAmount ? 0 : converts ? global.RecipeUnits.toBase(scaled, ing.unit) : scaled;
        if (converts) {
          const asWritten = global.RecipeUnits.normalizeLabel(ing.unit);
          line.units.set(asWritten, (line.units.get(asWritten) || 0) + contribution);
        }
        // "To taste" is never summed (J13.8): one presence is what such a
        // line requires however many recipes ask for it. That is also
        // what stops a second recipe wanting salt from un-settling the
        // salt somebody has already said they have.
        line.required = hasAmount ? line.required + contribution : 1;

        const seen = line.from.get(meal.id);
        if (seen) seen.base += contribution;
        else
          line.from.set(meal.id, {
            mealId: meal.id,
            recipeId: meal.recipeId,
            name: meal.name || recipe.name,
            // What this recipe actually wrote, which is not always what
            // the line is filed under: the plural rule (J13.4) files
            // "red pepper" and "black pepper" together, and J13.7 is only
            // a promise it can keep if the line can say so. A recipe that
            // spells one item two ways keeps the first spelling — it has
            // already agreed with itself that they are one thing.
            item,
            base: contribution,
          });
      }
    }

    const lines = [...quantified.values(), ...toTaste.values()].map((line) => finish(line, plan, prefs));
    return {
      lines,
      // What is left to buy, what is struck out in place, and what
      // collapsed into "you already have" (J13.9, J13.14).
      toBuy: lines.filter((l) => l.settled === ""),
      inBasket: lines.filter((l) => l.settled === "got"),
      alreadyHave: lines.filter((l) => l.settled === "have"),
      // Nothing left to buy: what Done reports on, and what an empty plan
      // never reaches, having nothing to record (J14.3). It is a state and
      // not a gesture, so it is not on its own the moment a plan finishes
      // itself — see `finishesShop` (J14.2).
      allSettled: lines.length > 0 && lines.every((l) => l.outstanding === 0),
    };
  }

  /** Settle up one accumulated line and work out how it should read. */
  function finish(line, plan, prefs) {
    const settledAmounts = global.RecipePlan.settledFor(plan, line.key);
    const sorted = settledAmounts.have + settledAmounts.got;
    const outstanding = Math.max(0, line.required - sorted);

    // Three numbers, one set of maths: what the plan asks for, what has
    // been settled against it, and what is left (J13.10). Each is
    // converted and formatted in its own right rather than being scaled
    // off the total afterwards, so a shortfall of 100 g under a total of
    // 1.5 kg reads as 100 g rather than as 0.1 kg — and so a shortfall
    // too small to render is caught by the same J13.3 rule the total is.
    // The screen shows all three and Copy takes the last of them; they
    // are worked out here precisely so the two cannot disagree about
    // which number is which.
    const total = displayAmount(line, prefs, line.required);
    // All three read the same item, and it is the one J13.4 has earned the
    // right to choose between (see `plurally`).
    const named = { ...line, item: plurally(line, total.amount) };
    const whole = render(named, total);
    const short = render(named, displayAmount(line, prefs, outstanding));
    const done = render(named, displayAmount(line, prefs, sorted));

    const ratio = whole.amount !== null && line.required > 0 ? whole.amount / line.required : 0;

    return {
      key: line.key,
      item: whole.label,
      unit: whole.unit,
      amount: whole.amount,
      text: whole.text,
      family: line.family,
      baseUnit: line.baseUnit,
      required: line.required,
      have: settledAmounts.have,
      got: settledAmounts.got,
      outstanding,
      // What is actually missing, ready to go to a shop (J13.10). On a
      // line nothing has been said about this is the total, word for
      // word — which is what keeps an unsettled line reading exactly as
      // it did before there was such a thing as settling.
      shortfall: short.amount,
      shortfallText: short.text,
      // "3 sorted, 1 to get": said only where some of the line is
      // settled and some of it is not. The total stays on screen beside
      // what it is made of (J13.7), because that is what the plan asks
      // for; this is the half of the line a shop cares about.
      partText: sorted > 0 && outstanding > 0 ? partly(done.measure, short.measure) : "",
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

  /**
   * Which spelling of the item the line prints (J13.4).
   *
   * A line is filed under the first spelling asked for, which on a
   * combination reads "6 onion" — the Bolognese said "onion" and the curry
   * said "onions" and the line took the earlier one. Pluralising it would
   * be inventing grammar the app has never had, and it has stayed out of
   * this deliberately; but choosing between spellings people actually
   * wrote is not inventing anything. So where the recipes disagree and the
   * line asks for more than one, it prints a plural somebody already
   * typed: a spelling that is another contributor's plus an "s" or an
   * "es", and nothing else qualifies. One thing keeps its own word,
   * because "1 onions" would be a worse lie than the one this fixes.
   *
   * What each of them wrote still sits under the line (J13.7), so the
   * choice is visible rather than silent.
   */
  function plurally(line, amount) {
    if (!(amount > 1)) return line.item;
    const written = [...line.from.values()].map((c) => c.item);
    const plural = written.find((a) =>
      written.some((b) => a !== b && (a === `${b}s` || a === `${b}es`))
    );
    return plural || line.item;
  }

  /**
   * How one amount of a line reads: "400 g", "4", "1 clove". The total,
   * what is settled and what is left all come through here, so they are
   * spelled the same way and rounded by the same rule.
   *
   * A shopping quantity is never rendered as 0 (J13.3). J4.8 accepts it
   * in a recipe, where the recipe as written is one tap away at full
   * portions; a list that says "0 g butter" is telling you to buy
   * nothing. Below that size the amount shows the item and no amount —
   * and no unit either, since "g butter" is no better.
   *
   * Where the item is the unit, the unit shown is the item: "1.5 kg",
   * not "1.5 kg g" and not "1500 g" printed as "1.5 kg g" either. The
   * converted label is the one to use, since that is the size the reader
   * is being given (J13.6).
   */
  function render(line, shown) {
    const amountText = shown.amount === null ? "" : global.RecipeScale.formatQuantity(shown.amount);
    const readable = Boolean(amountText) && amountText !== "0";
    const label = line.unitIsItem && readable ? shown.unit : line.item;
    const unit = readable && !line.unitIsItem ? shown.unit : "";
    return {
      amount: readable ? shown.amount : null,
      unit,
      label,
      // The amount on its own, for the places that have already said what
      // the item is: "400 g", "4", "1 clove".
      measure: readable ? [amountText, line.unitIsItem ? shown.unit : unit].filter(Boolean).join(" ") : "",
      text: [readable ? amountText : "", unit, label].filter(Boolean).join(" "),
    };
  }

  /**
   * Both numbers on a part-settled line (J13.10). Either can be too small
   * to render (J13.3) without the other being, and half a sentence is
   * better than a sentence with a hole in it.
   */
  function partly(done, short) {
    if (done && short) return `${done} sorted, ${short} to get`;
    if (done) return `${done} sorted`;
    return short ? `${short} to get` : "";
  }

  /**
   * The amount to show and the unit to show it in, in the reader's
   * preferences (J13.6, J8), with the unit picked by size the way J8.4
   * picks it — grams below a kilo, cups at half a cup and up. That
   * picking is units.js's `fromBase`, the same function a recipe's
   * conversion goes through, so a total and an ingredient read the same
   * way round.
   *
   * Where the reader keeps units as entered (J8.1) there is no system to
   * convert to, and a summed line has no single "as entered" to keep
   * either: what was written was several things, possibly in several
   * units. So it reads in the unit most of it came from — the largest
   * contributor's (J13.6). Someone who writes in cups and asked for no
   * conversion must not be handed millilitres, which is the preference
   * they expressed arriving by the back door. The size is left alone
   * there: 1500 g stays 1500 g, because promoting it to kilos is a
   * conversion too, and this reader declined those.
   *
   * Spoons and unrecognised units are already in the only unit they have
   * (J4.6), and are shown in it.
   *
   * The amount is a parameter rather than always the line's total,
   * because a part-settled line has three of them to show — what is
   * asked for, what is settled and what is left (J13.10) — and each is
   * an amount of the same thing. Sizing each one on its own is what
   * lets 100 g outstanding under a 1.5 kg total read as 100 g; it is
   * also the only way the copy can be trusted, since a shortfall taken
   * as a fraction of the total afterwards would inherit the total's unit
   * and, below 0.05 of it, would round away to nothing.
   */
  function displayAmount(line, prefs, amount) {
    const wanted = amount === undefined ? line.required : amount;
    if (line.toTaste) return { amount: null, unit: "" };
    if (line.family !== "mass" && line.family !== "volume") {
      return { amount: wanted, unit: line.baseUnit };
    }
    const system = line.family === "mass" ? prefs && prefs.mass : prefs && prefs.volume;
    // An amount too small for the reader's units comes back as 0, which
    // `render` shows as the item alone (J13.3) — there is one place a
    // shopping quantity can be zero, and it is caught there.
    if (system) return global.RecipeUnits.fromBase(line.family, system, wanted);
    const unit = largestContributor(line);
    const size = global.RecipeUnits.toBase(1, unit);
    return { amount: size ? wanted / size : wanted, unit };
  }

  /**
   * The unit most of this line came from, counted in base units so that a
   * cup outweighs a spoonful of millilitres rather than being outvoted by
   * a longer list of small ones (J13.6). An exact tie keeps the unit seen
   * first, so the same plan reads the same way on two phones.
   */
  function largestContributor(line) {
    let best = null;
    for (const [unit, base] of line.units) {
      if (!best || base > best.base) best = { unit, base };
    }
    return best ? best.unit : line.baseUnit;
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

  /** One tap puts a removed line back (J13.14). */
  function unsettleLine(plan, line, field, now) {
    return global.RecipePlan.unsettle(plan, line.key, field, now);
  }

  /**
   * Does settling this line finish the shop (J14.2)? Asked of the list as
   * it stands, before the gesture: this line still has something
   * outstanding and every other line has not.
   *
   * Done happens by itself because settling the last line is somebody
   * saying they are finished, which is why it does not also ask. A
   * requirement falling away says nothing of the kind, and `allSettled`
   * cannot tell the two apart: dropping a meal, or a recipe leaving the
   * book from another device (J12.8), can take the last outstanding
   * amount away with nobody touching the list. A plan that archived
   * itself on that would be recording a shop nobody said they had done,
   * and offering Undo for something they never did.
   */
  function finishesShop(list, line) {
    if (!list || !line || !(line.outstanding > 0)) return false;
    return (list.lines || []).every((l) => l.key === line.key || l.outstanding === 0);
  }

  /**
   * What is left, ready to paste into whatever shopping app somebody
   * keeps (J13.13): everything neither removed nor settled, one line per
   * item, amount first. A static site has no supermarket to talk to, so
   * this is the interop — and because it is derived from what is still
   * outstanding, copying twice never asks for the same thing twice.
   *
   * What goes out is the shortfall, not the total (J13.10). A line whose
   * four onions are three-quarters settled says "4 onions · 3 sorted, 1
   * to get" on screen, because the total is what the plan asks for and
   * belongs beside what it is made of; but the only useful thing to take
   * to a shop is the one onion. Copying the total would buy four to get
   * one, which is the mistake settling a line exists to prevent. On a
   * line nothing has been said about the two are the same string.
   */
  function copyText(list) {
    return (list && list.toBuy ? list.toBuy : []).map((l) => l.shortfallText).join("\n");
  }

  global.RecipeShopList = { build, copyText, itemKey, stemWord, settleAmount, settleLine, unsettleLine, finishesShop };
})(window);
