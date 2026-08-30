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
   * criteria: {terms, tags, favoritesOnly, sort, plannedIndex, prefs}
   *
   * Tags combine as "both", not "either" (J15.3): two of them is a
   * shorter list than either alone, which is what somebody deciding what
   * to cook means by saying both. An "any of these" filter is a different
   * question, and one control cannot answer both legibly.
   *
   * A recipe answering none of the terms is not shown. That makes a list
   * of ingredients a question about what you can cook tonight rather than
   * a re-ordering of everything you have ever saved (J3.3).
   */
  function matchesFilters(recipe, criteria) {
    const c = criteria || {};
    if (c.favoritesOnly && !recipe.favorite) return false;
    const tags = c.tags || [];
    if (tags.length && !tags.every((tag) => recipe.tags.includes(tag))) return false;
    if (!c.terms || c.terms.length === 0) return true;
    return matchedTerms(recipe, c.terms, c.prefs).length > 0;
  }

  /**
   * The sorts, in the order the menu offers them (J15.6). A small closed
   * set on purpose: a list of every order a collection could be put in is
   * another wall. `added` is what the list has always done — the
   * collection's own order — and stays the default.
   *
   * `short` is what a chip has room for; `label` is what the menu says.
   * The two sorts that read the archive say so, so a page without the
   * planner can leave them out rather than offer an order it cannot make.
   */
  const SORTS = [
    { id: "added", label: "Recently added", short: "Newest" },
    { id: "name", label: "Name A–Z", short: "A–Z" },
    { id: "least-planned", label: "Least recently planned", short: "Not lately", needsPlan: true },
    { id: "most-planned", label: "Most often planned", short: "Most often", needsPlan: true },
    { id: "quickest", label: "Quickest first", short: "Quickest" },
  ];

  const sortById = (id) => SORTS.find((s) => s.id === id) || null;

  /** A sort that keeps the incoming order between equals. */
  function orderBy(list, compare) {
    return list
      .map((r, i) => ({ r, i }))
      .sort((a, b) => compare(a.r, b.r) || a.i - b.i)
      .map((x) => x.r);
  }

  /**
   * How long a recipe takes, for "quickest first". A recipe that does not
   * say goes last rather than first: no timings is not the same claim as
   * ten minutes, and a list of quick suppers headed by everything nobody
   * has filled in is not the list that was asked for.
   */
  function minutes(recipe) {
    const total = (recipe.prepMinutes || 0) + (recipe.cookMinutes || 0);
    return total > 0 ? total : Infinity;
  }

  function plannedCount(recipe, index) {
    const entry = index && index[recipe.id];
    return entry ? entry.count : 0;
  }

  /**
   * Put the list in the chosen order (J15.6), keeping whatever order it
   * arrived in between recipes the sort cannot separate — which is what
   * makes the search's ranking the tiebreak (J15.7).
   *
   * The archive is the only record of when anything was planned (J14.11)
   * and it is handed in: this file knows about recipes, not about where a
   * book keeps its plans. A page without plan.js is offered neither of
   * the sorts that need it, and answers with the order it already had if
   * one is asked for anyway.
   */
  function applySort(list, c) {
    const sort = c.sort || "added";
    if (sort === "name") {
      return orderBy(list, (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    }
    if (sort === "quickest") return orderBy(list, (a, b) => minutes(a) - minutes(b));
    if (!global.RecipePlan) return list;
    if (sort === "least-planned") {
      // One definition of "least recently planned", in the file that
      // already had it (J14.9) — and it keeps the incoming order between
      // equals, like everything here.
      return global.RecipePlan.byLeastRecentlyPlanned(list, c.plannedIndex);
    }
    if (sort === "most-planned") {
      // Every appearance counts, and the count is worked out from the
      // archive rather than stored (J14.10).
      return orderBy(list, (a, b) => plannedCount(b, c.plannedIndex) - plannedCount(a, c.plannedIndex));
    }
    return list; // `added`, and anything unrecognised: the collection's own order
  }

  /**
   * The recipes to show, in the order to show them: filtered, then — when
   * several terms were listed — best matches first, stable within an equal
   * count so the list does not shuffle on every keystroke, and then put in
   * whichever order was chosen by name.
   *
   * One term is skipped rather than ranked: everything shown matches it
   * exactly once, so sorting by count is a no-op on a stable sort. The
   * skip saves recomputing the matches, and changes nothing observable.
   *
   * **The sort has the last word, and the ranking breaks its ties**
   * (J15.7). It used to be the other way about, when the only sort was a
   * chip reading "not planned lately": beside a search box that chip was
   * ambiguous about which of the two decided the order, so the search —
   * the thing the reader had just typed — won, and the chip ordered
   * within each group of equally good matches. Picking an order out of a
   * menu called Sort is not ambiguous, and this is the answer that
   * matches what was asked: a person who says "name A to Z" and gets
   * something else has been overruled. Where no sort is chosen a listed
   * search ranks exactly as it always has (J3.3).
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
    return applySort(ranked, c);
  }

  /**
   * Every tag in the book, each with the number of recipes it would leave
   * (J15.4) — which is the thing a row of bare chips could not say at all.
   *
   * The count is taken against what the other filters and the search have
   * already left, and with the tag filter itself set aside, so it is the
   * size of the list the tap would actually give you rather than a promise
   * the rest of the toolbar has already broken. For a tag that is already
   * on, that is the list as it stands.
   *
   * A tag that would leave nothing counts 0 and is still listed (J15.5):
   * the caller greys it rather than dropping it, because a tag vanishing
   * as you filter reads as a book losing things.
   */
  function tagCounts(recipes, criteria) {
    const c = criteria || {};
    const active = c.tags || [];
    // Everything the rest of the toolbar leaves, then everything the tags
    // already chosen leave of that. Adding one more tag can only narrow
    // the second, so counting within it is the answer to "and this one?".
    const pool = recipes.filter((r) => matchesFilters(r, { ...c, tags: [] }));
    const chosen = pool.filter((r) => active.every((tag) => r.tags.includes(tag)));
    const counts = new Map();
    // The universe is the book, not the pool: a tag filtered down to
    // nothing still has to be there to say so.
    for (const r of recipes) for (const tag of r.tags) if (!counts.has(tag)) counts.set(tag, 0);
    for (const r of chosen) for (const tag of r.tags) counts.set(tag, counts.get(tag) + 1);
    return [...counts.keys()]
      .sort()
      .map((tag) => ({ tag, count: counts.get(tag), active: active.includes(tag) }));
  }

  global.RecipeSearch = {
    readable,
    parseTerms,
    matchedTerms,
    matchesFilters,
    visibleRecipes,
    tagCounts,
    SORTS,
    sortById,
  };
})(window);
