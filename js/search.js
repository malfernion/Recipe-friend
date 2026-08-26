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
   * Split what someone typed into "What can I cook?" into terms.
   * Single letters are dropped — they match everything and mean nothing.
   */
  function parsePantryTerms(text) {
    return String(text || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 2);
  }

  /** Which of these terms the recipe's ingredients mention (J3.3). */
  function pantryMatches(recipe, terms) {
    if (!terms || terms.length === 0) return [];
    const lines = recipe.ingredients.map((i) => `${i.item} ${i.unit}`.toLowerCase());
    return terms.filter((term) => {
      // Also try a crude singular so "tomatoes" finds "tomato purée" and
      // vice versa (J3.4). Short stems would match far too much.
      const singular = term.replace(/(es|s)$/, "");
      return lines.some((l) => l.includes(term) || (singular.length >= 3 && l.includes(singular)));
    });
  }

  /**
   * Does this recipe survive the current filters?
   * criteria: {query, tag, favoritesOnly, pantryTerms, prefs}
   */
  function matchesFilters(recipe, criteria) {
    const c = criteria || {};
    if (c.favoritesOnly && !recipe.favorite) return false;
    if (c.tag && !recipe.tags.includes(c.tag)) return false;
    if (c.query && !haystack(recipe, c.prefs).includes(c.query)) return false;
    if (c.pantryTerms && c.pantryTerms.length > 0 && pantryMatches(recipe, c.pantryTerms).length === 0) {
      return false;
    }
    return true;
  }

  /**
   * The recipes to show, in the order to show them: filtered, and — when
   * cooking from what's in the cupboard — best matches first, stable
   * within an equal count so the list does not shuffle on every keystroke.
   */
  function visibleRecipes(recipes, criteria) {
    const c = criteria || {};
    const visible = recipes.filter((r) => matchesFilters(r, c));
    if (!c.pantryTerms || c.pantryTerms.length === 0) return visible;
    return visible
      .map((r, i) => ({ r, i, n: pantryMatches(r, c.pantryTerms).length }))
      .sort((a, b) => b.n - a.n || a.i - b.i)
      .map((x) => x.r);
  }

  global.RecipeSearch = { readable, parsePantryTerms, pantryMatches, matchesFilters, visibleRecipes };
})(window);
