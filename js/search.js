/**
 * search.js — deciding which recipes to show, and in what order (J3).
 *
 * Pulled out of app.js because it is a decision about recipes, not about
 * the page: nothing here touches the DOM or reads the app's state. What
 * the person is looking for arrives as a criteria object, so the same
 * question can be asked from a test as from a keystroke.
 */
(function (global) {
  "use strict";

  /**
   * One ingredient as this reader sees it: converted into their units.
   * Search matches this as well as the text as written (J3.1), so a recipe
   * stored in grams is findable by "oz" by someone reading in ounces —
   * which is what keeps search aligned with the screen now that units are
   * converted for display rather than stored.
   */
  function readable(ing, prefs) {
    return global.RecipeScale.ingredientText(global.RecipeUnits.convertIngredient(ing, prefs));
  }

  /** The text a search runs against. */
  function haystack(recipe, prefs) {
    return [
      recipe.name,
      recipe.description,
      ...recipe.ingredients.map((i) => global.RecipeScale.ingredientText(i)),
      ...recipe.ingredients.map((i) => readable(i, prefs)),
      ...recipe.tags,
    ]
      .join("\n")
      .toLowerCase();
  }

  /**
   * Split what someone typed into terms. A query is a comma-separated
   * list: one term is an ordinary search, several are a list of things
   * they have (J3.3). Blanks are dropped; a single letter is not, because
   * as a lone term it is a legitimate narrowing of a long list.
   */
  function parseTerms(text) {
    return String(text || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  /**
   * Which of these terms this recipe answers to (J3.3). The haystack is
   * built once per recipe rather than once per term — every term is
   * matched against the same text, so there is nothing to rebuild.
   */
  function matchedTerms(recipe, terms, prefs) {
    if (!terms || terms.length === 0) return [];
    const hay = haystack(recipe, prefs);
    return terms.filter((term) => {
      if (hay.includes(term)) return true;
      // Also try a crude singular so "tomatoes" finds "tomato purée" and
      // vice versa (J3.4). Short stems would match far too much.
      const stem = term.replace(/(es|s)$/, "");
      return stem.length >= 3 && hay.includes(stem);
    });
  }

  /**
   * Does this recipe survive the current filters?
   * criteria: {terms, tag, favoritesOnly, prefs}
   *
   * A recipe answering none of the terms is not shown. That makes a list
   * of ingredients a question about what you can cook tonight rather than
   * a re-ordering of everything you have ever saved (J3.3).
   */
  function matchesFilters(recipe, criteria) {
    const c = criteria || {};
    if (c.favoritesOnly && !recipe.favorite) return false;
    if (c.tag && !recipe.tags.includes(c.tag)) return false;
    if (!c.terms || c.terms.length === 0) return true;
    return matchedTerms(recipe, c.terms, c.prefs).length > 0;
  }

  /**
   * The recipes to show, in the order to show them: filtered, and — when
   * several terms were listed — best matches first, stable within an equal
   * count so the list does not shuffle on every keystroke.
   *
   * One term is skipped rather than ranked: everything shown matches it
   * exactly once, so sorting by count is a no-op on a stable sort. The
   * skip saves recomputing the matches, and changes nothing observable.
   *
   * "Not planned lately" (J14.9) is the last word on the order, and it
   * orders rather than hides: J14.9 calls it a sort, and any line drawn
   * between "lately" and "not lately" would be a number nobody chose. It
   * is applied after the ranking rather than instead of it, so a search
   * still decides between two recipes planned the same day — the chip
   * combines with search and tags exactly as Favourites does (J3.2),
   * which is what makes it a chip and not a screen.
   */
  function visibleRecipes(recipes, criteria) {
    const c = criteria || {};
    const visible = recipes.filter((r) => matchesFilters(r, c));
    const ranked =
      !c.terms || c.terms.length < 2
        ? visible
        : visible
            .map((r, i) => ({ r, i, n: matchedTerms(r, c.terms, c.prefs).length }))
            .sort((a, b) => b.n - a.n || a.i - b.i)
            .map((x) => x.r);
    // The archive is the only record of when anything was planned
    // (J14.11), and it is handed in: this file knows about recipes, not
    // about where a book keeps its plans. A page without plan.js simply
    // does not offer the chip.
    if (!c.notPlannedLately || !global.RecipePlan) return ranked;
    const byPlanned = (list) => global.RecipePlan.byLeastRecentlyPlanned(list, c.plannedIndex);
    // Two chips, one order, and one of them has to lose (J14.9). The
    // search wins: a card says which terms it matched (J3.3), so a
    // recipe answering one of two terms sitting above one answering
    // both makes the caption look like a lie. The chip orders within
    // each group of equally good matches instead — which is the whole
    // list whenever there are fewer than two terms, and that is the
    // case somebody planning a week is actually in.
    if (!c.terms || c.terms.length < 2) return byPlanned(ranked);
    const groups = new Map();
    for (const r of ranked) {
      const n = matchedTerms(r, c.terms, c.prefs).length;
      if (!groups.has(n)) groups.set(n, []);
      groups.get(n).push(r);
    }
    // `ranked` is already best-first, so the groups come out in order.
    return [...groups.values()].flatMap(byPlanned);
  }

  global.RecipeSearch = { readable, parseTerms, matchedTerms, matchesFilters, visibleRecipes };
})(window);
