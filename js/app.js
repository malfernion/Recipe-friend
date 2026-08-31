/**
 * app.js — UI layer for Recipe Friend.
 * Renders the recipe grid, search/filter toolbar, and the add/edit and
 * detail dialogs. All persistence goes through RecipeStore (storage.js).
 */
(function () {
  "use strict";

  const store = new RecipeStore();

  // --- UI state (not persisted) ---
  let searchTerms = []; // the query, split on commas (J3.3)
  let favoritesOnly = false;
  // The tags that are on, all of which a recipe must carry (J15.3).
  let activeTags = [];
  // The order the list is in, by name (J15.6). "added" is the collection's
  // own order, which is what the list has always done.
  let sortBy = "added";
  let editingId = null; // recipe id being edited, or null when adding
  let incomingId = null; // id of a shared/pasted recipe being reviewed before saving
  let detailId = null; // recipe id shown in the detail dialog
  let pendingImage = ""; // data URI chosen via the file picker, pre-save
  let existingPhotoPath = ""; // photo already in Storage for the recipe being edited
  let formBaseline = ""; // the editor's contents as it opened, to spot unsaved work
  let detailScale = 1; // display-only scaling factor for the open detail view
  // Planning is a mode over the list, not a screen of its own (J12.4).
  // Nothing about it is stored: turning it off changes nothing but what
  // the cards offer.
  let planMode = false;

  // --- Elements ---
  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#recipe-list");
  const emptyStateEl = $("#empty-state");
  const resultCountEl = $("#result-count");
  const searchInput = $("#search-input");
  const favoritesBtn = $("#favorites-filter");
  const filterMenu = $("#filter-menu");
  const filterSummaryEl = $("#filter-summary");
  const tagMenuEl = $("#tag-menu");
  const sortMenu = $("#sort-menu");
  const sortSummaryEl = $("#sort-summary");
  const sortOptionsEl = $("#sort-options");
  const activeFiltersEl = $("#active-filters");
  const editorView = $("#editor-view");
  const recipeForm = $("#recipe-form");
  const editorTitle = $("#editor-title");
  const detailView = $("#detail-view");
  const detailContent = $("#detail-content");
  const planView = $("#plan-view");
  const planContent = $("#plan-content");
  const toastEl = $("#toast");
  const toastActionEl = $("#toast-action");

  /**
   * Where this book's plan is kept (J12.2). Made here so the screen and
   * the sync layer share one object — account.js adopts this one rather
   * than making a second (see window.RecipeApp at the foot of the file).
   * Absent only in a page that has not loaded planstore.js, where the
   * planner is simply not offered rather than half-offered.
   */
  const planStore = window.RecipePlanStore ? new window.RecipePlanStore() : null;

  // --- Helpers ---
  const escapeHTML = RecipeHTML.escapeHTML;

  /**
   * --- Screens you go to, rather than boxes that open over one (J4.22) --
   *
   * The recipe, the plan and the editor were modal <dialog>s. A dialog is
   * the wrong shape for a screen you read with your hands full: it is a
   * scrolling box inside a page held still, and pinching, panning and
   * rotating are all things the browser does to a page rather than to a
   * box inside one. Zooming into an ingredient asks to pan; panning is a
   * document scroll; and the lock a dialog needs — so that reaching the
   * end of a long method does not carry on into the list behind it — had
   * just turned that off. Measured on a phone: zoom in, and the recipe
   * would not move under your thumb.
   *
   * So they are sections in the page, shown one at a time. Nothing is
   * held still, because there is nothing behind to hold: the list is
   * hidden rather than covered, which is also what takes it out of a
   * screen reader's way now that no dialog is making the rest of the
   * page inert for us.
   *
   * What a dialog did give us is a close event, and the routing below
   * hangs the history unwind and the wake lock on it. That is kept —
   * `closeView` calls the one handler each view registers — so
   * everything written against it goes on reading the same.
   */
  const VIEWS = [editorView, detailView, planView];

  const aViewIsOpen = () => VIEWS.some((v) => v.open);

  /** One handler each, called however the view closes. */
  const viewCloseHandlers = new Map();
  const onViewClose = (el, fn) => viewCloseHandlers.set(el, fn);

  /**
   * Where the list had got to when you left it. A browser restores this
   * for a page you navigate away from and come back to; inside one
   * document it is ours to remember, or opening a recipe and closing it
   * puts you back at the top of a list you had scrolled a long way down.
   */
  let listScrollY = 0;

  function scrollPageTo(y) {
    // Absent in the stub DOM, where there is no page to move.
    if (typeof window.scrollTo === "function") window.scrollTo(0, y);
  }

  function syncViewState() {
    const open = aViewIsOpen();
    // The app bar, the list and the footer go rather than sit behind a
    // view: on a phone a row of chrome is a row of ingredients nobody can
    // see (J4.19), and a view carries its own way back in the breadcrumb.
    document.body.classList.toggle("viewing", open);
  }

  function showView(el) {
    if (el.open) return;
    // Opening one view over another is a handover, not a new place: the
    // one underneath goes without unwinding the entry that opened it.
    if (!aViewIsOpen()) listScrollY = window.scrollY || 0;
    for (const other of VIEWS) if (other !== el && other.open) closeQuietly(other);
    el.open = true;
    el.hidden = false;
    syncViewState();
    scrollPageTo(0);
  }

  function closeView(el) {
    if (!el.open) return;
    el.open = false;
    el.hidden = true;
    syncViewState();
    if (!aViewIsOpen()) scrollPageTo(listScrollY);
    const handler = viewCloseHandlers.get(el);
    if (handler) handler();
  }

  /**
   * Back to the list, whatever was on screen — for the moments when the
   * ground moves rather than the person: signing out, or a book going
   * out from under a recipe. Quietly, because the address is rewritten
   * here rather than walked back through one entry at a time.
   */
  function leaveAllViews() {
    if (!aViewIsOpen()) return;
    for (const view of VIEWS) if (view.open) closeQuietly(view);
    toListAddress();
  }

  /**
   * --- The way back up (J4.19) -----------------------------------------
   *
   * A view has no × and no backdrop to tap, and Escape went with the
   * dialog that answered it. What it has instead is a breadcrumb, which
   * says where you are as well as how to leave — and which is the only
   * navigation on screen, the app bar being hidden behind a view.
   *
   * The trail is read off the address rather than off the history stack,
   * so a link opened cold gets the same trail as one you walked to: the
   * editor sits under the recipe it edits whether or not you came
   * through it.
   *
   * On a phone the trail collapses to its last link — the way up, and
   * nothing else — because the heading underneath already says where you
   * are, and a wrapped trail costs a row of ingredients.
   */
  function bookName() {
    const cloud = window.RecipeCloud;
    const book = cloud && cloud.books && cloud.books.currentBook && cloud.books.currentBook();
    // Signed out, or a page with no backend behind it: the recipes are
    // still yours, they just have nobody's name on them.
    return (book && book.name) || "Recipes";
  }

  /** The trail for whatever the address names, root first. */
  function crumbTrail() {
    const route = currentRoute();
    const root = { label: bookName(), to: "list" };
    if (route.name === "plan") return [root, { label: "The plan" }];
    if (route.name === "new") return [root, { label: "New recipe" }];
    if (route.name === "review") return [root, { label: "Review recipe" }];
    if (route.name === "recipe") {
      const recipe = store.getById(route.id);
      return [root, { label: recipe ? recipe.name : "Recipe" }];
    }
    if (route.name === "edit") {
      const recipe = store.getById(route.id);
      // The recipe is a step of its own: Back from the editor returns to
      // it, and so does the crumb naming it.
      return recipe
        ? [root, { label: recipe.name, to: "recipe" }, { label: "Edit" }]
        : [root, { label: "Edit" }];
    }
    return [root];
  }

  function renderCrumbs() {
    const trail = crumbTrail();
    const html = trail
      .map((crumb, i) => {
        const last = i === trail.length - 1;
        if (last) {
          return `<span class="crumb crumb-here" aria-current="page">${escapeHTML(crumb.label)}</span>`;
        }
        // The last link is the way up, and the only one a phone shows.
        const parent = i === trail.length - 2 ? " crumb-parent" : "";
        return `<button type="button" class="crumb${parent}" data-crumb="${escapeHTML(crumb.to)}">${escapeHTML(crumb.label)}</button>`;
      })
      .join('<span class="crumb-sep" aria-hidden="true">\u203a</span>');
    for (const id of ["#detail-crumbs", "#plan-crumbs", "#editor-crumbs"]) {
      const el = $(id);
      if (el) el.innerHTML = html;
    }
  }

  /**
   * Climbing is closing: each screen's close already unwinds the entry
   * that opened it (J4.17), so one step up is one close, and the root
   * from the editor is two. The editor asks about typed work first, and
   * a "keep editing" stops the climb where it is (J2.9).
   */
  async function climbTo(target) {
    if (editorView.open && !(await tryCloseEditor())) return;
    if (target !== "list") return;
    if (detailView.open) closeView(detailView);
    if (planView.open) closeView(planView);
  }

  for (const id of ["#detail-crumbs", "#plan-crumbs", "#editor-crumbs"]) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener("click", (event) => {
      const crumb = event.target.closest("[data-crumb]");
      if (!crumb) return undefined;
      return climbTo(crumb.dataset.crumb); // returned so a test can await it
    });
  }

  let toastTimer = null;
  let toastAction = null;

  /**
   * A message, and at most one thing to do about it.
   *
   * The action is a sibling of the message rather than a child of it: the
   * message is written by assigning textContent, which would take any
   * child element with it. Finishing a plan is the one thing in the app
   * that offers a way back this way (J14.2) — somebody who has just said
   * they are finished is told what happened and offered Undo, not asked
   * whether they meant it.
   *
   * A toast carrying an action stays up longer than one that only
   * reports: 2.6 seconds is enough to read "Planned 4 meals" and not
   * enough to reach for it.
   */
  function toast(message, action) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    toastAction = action || null;
    if (toastActionEl) {
      toastActionEl.hidden = !toastAction;
      if (toastAction) toastActionEl.textContent = toastAction.label;
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, toastAction ? 9000 : 2600);
  }

  function hideToast() {
    toastEl.hidden = true;
    toastAction = null;
    if (toastActionEl) toastActionEl.hidden = true;
  }

  if (toastActionEl) {
    toastActionEl.addEventListener("click", () => {
      const action = toastAction;
      clearTimeout(toastTimer);
      hideToast();
      if (action) action.run();
    });
  }

  function totalTime(recipe) {
    const total = (recipe.prepMinutes || 0) + (recipe.cookMinutes || 0);
    return total > 0 ? `${total} min` : null;
  }

  /** What the person is currently looking for, as RecipeSearch wants it. */
  function criteria() {
    return {
      terms: searchTerms,
      tags: activeTags,
      favoritesOnly,
      sort: sortBy,
      // What the two planned sorts need to answer: which recipes were
      // planned when, and how often (J15.6). The index goes with them
      // rather than being fetched inside search.js, which knows about
      // recipes and not about where a book keeps its plans. Built only
      // for the sorts that read it — the whole archive is walked to make
      // it, and four of the six ways of looking at the list do not care.
      plannedIndex: sortNeedsPlan(sortBy) ? planningIndex() : null,
      prefs: store.prefs,
    };
  }

  /** Does this sort read the archive? (J15.6) */
  function sortNeedsPlan(id) {
    const sort = RecipeSearch.sortById(id);
    return Boolean(sort && sort.needsPlan);
  }

  // Built at most once a redraw and answered from (see `render`).
  let plannedIndexCache = null;

  /**
   * When each recipe was last planned, worked out from the archive and
   * nothing else (J14.11). Every card asks, and a hundred cards asking a
   * hundred times would walk the whole archive a hundred times over.
   */
  function planningIndex() {
    if (!plannedIndexCache) {
      plannedIndexCache = planStore ? planStore.plannedIndex() : Object.create(null);
    }
    return plannedIndexCache;
  }

  /**
   * What a card and the recipe view say about planning (J14.6).
   *
   * A recipe in the live plan says so instead of saying a date (J14.8):
   * while you are deciding, that is the more useful of the two, and it
   * is what stops the same recipe going in twice by accident.
   *
   * A recipe that has never been planned says nothing at all (J14.7).
   * Not "Never planned" — that reads as a reproach on a recipe typed in
   * five minutes ago, and it still sorts where it matters (J14.9).
   */
  function plannedNote(recipe) {
    // A page that never loaded the planner says nothing about planning
    // rather than failing to draw a card at all: `planStore` is absent
    // exactly there, and a card is not the place to discover it. The
    // same guard search.js keeps over the chip (J14.9).
    if (!planStore || !window.RecipePlan) return null;
    // Read off the live plan itself, not off whether this reader may add
    // to it: a viewer has no planner (J12.10) but the plan is the book's
    // and they can see what is in it.
    // Two different kinds of fact wearing one line. "In the plan" is
    // live — it is about the thing being built right now, and it is what
    // stops a recipe going in twice (J14.8) — where a date is history and
    // belongs with the meta it sits under. So the live one takes the
    // accent the Plan count already wears, because they are the same
    // fact said in two places.
    if (RecipePlan.isPlanned(thePlan(), recipe.id)) return { text: "In the plan", live: true };
    const entry = planningIndex()[recipe.id];
    const label = RecipePlan.plannedLabel(entry && entry.lastPlannedAt);
    return label ? { text: label, live: false } : null;
  }

  /**
   * The line of particulars, with what the plan has to say about this
   * recipe on the end of it (J14.8). A card's rows are the scarcest thing
   * it has, and this note was spending one of them on three words. "In the
   * plan" is a particular like "Serves 4", so it goes where the
   * particulars are, in italic so the two kinds of fact stay apart.
   *
   * The meta line may be empty — a recipe with no servings and no timings
   * has nothing to say there — and the note still needs somewhere to sit,
   * so the line is built from whichever of the two exist.
   */
  function metaLineHTML(bits, recipe) {
    const note = plannedNote(recipe);
    if (!bits && !note) return "";
    const lead = bits ? escapeHTML(bits) : "";
    return `<p class="card-meta">${lead}${note ? `${lead ? " · " : ""}${plannedNoteHTML(note)}` : ""}</p>`;
  }

  /* The separator stays outside the span: the accent is for the words. */
  function plannedNoteHTML(note) {
    return `<span class="card-planned${note.live ? " card-planned-live" : ""}">${escapeHTML(
      note.text
    )}</span>`;
  }

  /**
   * Which of the listed terms this recipe answers to — named on the card
   * so a ranked list explains its own order (J3.3). One term explains
   * nothing worth saying: every result matches it, and the reader just
   * typed it.
   */
  function matchedTerms(recipe) {
    if (searchTerms.length < 2) return [];
    return RecipeSearch.matchedTerms(recipe, searchTerms, store.prefs);
  }

  /**
   * One ingredient as this viewer should read it: scaled for the chosen
   * portions, then converted into their preferred units. Recipes are
   * stored exactly as entered, so this is the only place units change —
   * which is what lets two people share a book and each see their own.
   */
  function displayIngredient(ing, factor) {
    const scaled =
      ing.amount === null || ing.amount === undefined || factor === 1
        ? ing
        : { ...ing, amount: ing.amount * factor };
    return RecipeSearch.readable(scaled, store.prefs);
  }

  // --- Rendering ---
  /**
   * The tag menu (J15.1). Every tag in the book is listed, each with the
   * size of the list with that tag on (J15.4) — and a tag that would leave
   * none is greyed rather than dropped (J15.5), because a tag vanishing
   * as you filter reads as a book losing things. A tag already on is never
   * greyed, whatever its count: that tap is the way off, and a search
   * matching nothing takes every count to nought.
   *
   * The menu draws every tag, which is what the filter row used to do and
   * what made it a wall (J15.2). In a menu that is the right shape: it is
   * shut until it is asked for, and it scrolls.
   */
  function renderFilterMenu() {
    const counts = RecipeSearch.tagCounts(store.recipes, criteria());
    tagMenuEl.innerHTML = counts.length
      ? counts
          .map(({ tag, count, active }) => {
            // Nothing left to choose, and nothing to undo: a nought is an
            // answer, and pressing it would be a way of getting no list.
            const dead = count === 0 && !active;
            return `
        <button class="more-item tag-option ${active ? "tag-option-on" : ""}"
                data-tag="${escapeHTML(tag)}" aria-pressed="${active}"
                ${dead ? "disabled" : ""}>
          <span class="tag-option-name">${escapeHTML(tag)}</span>
          <span class="tag-option-count">${count}</span>
        </button>`;
          })
          .join("")
      : `<p class="menu-empty">No tags in this book yet.</p>`;
    // The label carries the state, so the row below is not the only place
    // it is said (J15.1) — and it is said in words to anyone who cannot
    // see it, where a middle dot and a numeral are not a sentence.
    filterSummaryEl.textContent = activeTags.length ? `Filter · ${activeTags.length}` : "Filter";
    filterSummaryEl.setAttribute(
      "aria-label",
      activeTags.length === 0
        ? "Filter by tag"
        : `Filter by tag — ${activeTags.length} ${activeTags.length === 1 ? "tag" : "tags"} on`
    );
  }

  /**
   * The sorts, drawn from the one list of them (J15.6). The two that read
   * the archive are offered only where there is an archive to read: a
   * page without the planner is short of a fact, not short of a menu.
   */
  function renderSortMenu() {
    const sorts = RecipeSearch.SORTS.filter((s) => !s.needsPlan || planStore);
    if (!sorts.some((s) => s.id === sortBy)) sortBy = "added";
    sortOptionsEl.innerHTML = sorts
      .map(
        (sort) => `
        <button class="more-item sort-option ${sort.id === sortBy ? "sort-option-on" : ""}"
                data-sort="${escapeHTML(sort.id)}"
                aria-pressed="${sort.id === sortBy}">${escapeHTML(sort.label)}</button>`
      )
      .join("");
    // The chip has room for the short of it; the menu and the screen
    // reader get the whole name.
    const chosen = RecipeSearch.sortById(sortBy) || RecipeSearch.SORTS[0];
    sortSummaryEl.textContent = `Sort · ${chosen.short}`;
    sortSummaryEl.setAttribute("aria-label", `Sort the list — ${chosen.label}`);
  }

  /**
   * What is on, and only what is on (J15.2) — each with a way to take
   * that one off, and one way to clear the lot. Nothing on, nothing here:
   * an empty row is a row of chrome above the recipes.
   */
  function renderActiveRow() {
    const chips = [];
    // Favourites is chosen in the toolbar and taken off in either place:
    // the row is what is on, and leaving it out would make "Clear
    // filters" clear something the row never mentioned.
    if (favoritesOnly) {
      chips.push(activeChip({ remove: "favorites", label: "★ Favourites", spoken: "Favourites" }));
    }
    for (const tag of activeTags) chips.push(activeChip({ remove: "tag", tag, label: tag, spoken: tag }));
    activeFiltersEl.hidden = chips.length === 0;
    activeFiltersEl.innerHTML = chips.length
      ? `${chips.join("")}
         <button class="btn btn-ghost clear-filters" data-remove="filters">Clear filters</button>`
      : "";
  }

  /*
    One thing that is on. The whole chip takes it off — a × drawn small
    enough to be only a hint is not a target — and it is spoken as what it
    does, since "★ Favourites" read out as a black star is not a control
    anybody can find.
  */
  function activeChip({ remove, label, spoken, tag }) {
    return `
      <button class="chip chip-active active-chip" data-remove="${remove}"
              ${tag ? `data-tag="${escapeHTML(tag)}"` : ""}
              aria-label="Remove filter ${escapeHTML(spoken)}">${escapeHTML(label)}<span
              class="active-chip-x" aria-hidden="true">×</span></button>`;
  }

  function recipeCard(recipe, index) {
    const time = totalTime(recipe);
    // How many ingredients a recipe has is not a thing anybody chooses a
    // dinner by, and it was the longest of the three particulars — long
    // enough that what the plan has to say about the recipe (J14.8) could
    // not join the line without wrapping it, which put the row back that
    // moving it there was meant to save.
    const meta = [recipe.servings ? `Serves ${recipe.servings}` : null, time]
      .filter(Boolean)
      .join(" · ");

    const matched = matchedTerms(recipe);
    return `
      <article class="recipe-card" data-id="${escapeHTML(recipe.id)}" tabindex="0"
               role="button" aria-label="Open ${escapeHTML(recipe.name)}">
        ${(() => {
          const src = photoSrc(recipe);
          return src
            ? `<img class="card-img" src="${escapeHTML(src)}" alt="" loading="lazy"
                    referrerpolicy="no-referrer">`
            : "";
        })()}
        <span class="card-index">№ ${String(index + 1).padStart(2, "0")}</span>
        <div class="card-top">
          <h3 class="card-title">${escapeHTML(recipe.name)}</h3>
          <button class="fav-btn ${recipe.favorite ? "fav-active" : ""}"
                  data-action="favorite" data-id="${escapeHTML(recipe.id)}"
                  aria-pressed="${recipe.favorite}"
                  aria-label="${recipe.favorite ? "Remove from" : "Add to"} favourites"
                  title="${recipe.favorite ? "Remove from" : "Add to"} favourites">${recipe.favorite ? "★" : "☆"}</button>
        </div>
        ${recipe.description ? `<p class="card-desc">${escapeHTML(recipe.description)}</p>` : ""}
        ${metaLineHTML(meta, recipe)}
        ${
          matched.length
            ? `<p class="card-matches">Matches ${matched.map((t) => escapeHTML(t)).join(" · ")}</p>`
            : ""
        }
        ${
          recipe.tags.length
            ? `<div class="card-tags">${recipe.tags
                .map((t) => `<span class="tag">${escapeHTML(t)}</span>`)
                .join("")}</div>`
            : ""
        }
        ${planCardRow(recipe)}
      </article>`;
  }

  /**
   * A tag the book no longer has anywhere cannot go on filtering by it —
   * the last recipe carrying it was edited or deleted, and the filter
   * would leave an empty list nobody asked for.
   */
  function pruneTags() {
    const tags = store.allTags();
    activeTags = activeTags.filter((tag) => tags.includes(tag));
  }

  /** Why the list is empty, said as it happened. */
  function noMatchText() {
    return searchTerms.length ? "No recipes match your search." : "No recipes match these filters.";
  }

  /** The way out, named after what it clears (J15.10). */
  function clearLabel() {
    const filters = activeTags.length > 0 || favoritesOnly;
    if (filters && searchTerms.length) return "Clear the search and filters";
    return filters ? "Clear the filters" : "Clear the search";
  }

  function render() {
    // A recipe that has left the book leaves the plan (J12.8), and this is
    // where the book's recipes are read. `prune` hands the plan straight
    // back when nothing has gone, so an ordinary redraw writes nothing and
    // pushes nothing.
    prunePlan();
    // The archive may have moved since the last redraw — a plan finished
    // here, or one that arrived from another device — so the index is
    // dropped and rebuilt at most once for the cards that ask (J14.6).
    plannedIndexCache = null;
    pruneTags();
    const visible = RecipeSearch.visibleRecipes(store.recipes, criteria());
    listEl.innerHTML = visible.map((r, i) => recipeCard(r, i)).join("");

    const hasAny = store.recipes.length > 0;
    emptyStateEl.hidden = hasAny;
    listEl.hidden = !hasAny;

    if (hasAny && visible.length === 0) {
      listEl.hidden = false;
      // The way out of an empty list is the thing you cannot see when the
      // list is empty (J15.10), so it is offered here rather than left to
      // be found in the toolbar above. Nothing on cannot empty the list,
      // so there is always something for this to clear.
      listEl.innerHTML = `<p class="no-results">${escapeHTML(noMatchText())}</p>
        <p class="no-results-out">
          <button class="btn btn-ghost" data-remove="all">${escapeHTML(clearLabel())}</button>
        </p>`;
    }

    announceCount(hasAny ? visible.length : null);
    favoritesBtn.classList.toggle("chip-active", favoritesOnly);
    favoritesBtn.setAttribute("aria-pressed", String(favoritesOnly));
    renderFilterMenu();
    renderSortMenu();
    renderActiveRow();
    syncPlanUI();
    // The plan is read from the same store, so a redraw it did not cause
    // — a sync landing somebody else's meal — still reaches it.
    if (planView.open) renderPlan();
  }

  /**
   * Say how many recipes are showing, for anyone who cannot see the list.
   * The grid itself used to be the live region, which re-read every
   * visible card on every keystroke in the search box.
   *
   * Only written when the wording changes: assigning the same text again
   * makes a screen reader repeat it, and searching is a lot of keystrokes
   * that do not change the answer.
   */
  function announceCount(count) {
    const text =
      count === null
        ? ""
        : count === 0
          ? noMatchText()
          : `${count} ${count === 1 ? "recipe" : "recipes"}`;
    if (resultCountEl.textContent !== text) resultCountEl.textContent = text;
  }

  // --- Ingredient row editor ---
  const ingredientRowsEl = $("#ingredient-rows");

  function addIngredientRow(ing) {
    const row = document.createElement("div");
    row.className = "ing-row";
    row.innerHTML = `
      <input type="text" class="ing-amount" inputmode="decimal" placeholder="200"
             aria-label="Amount" value="${ing && ing.amount !== null ? escapeHTML(RecipeScale.formatQuantity(ing.amount)) : ""}">
      <input type="text" class="ing-unit" list="unit-list" placeholder="g" maxlength="24"
             aria-label="Unit" value="${ing ? escapeHTML(ing.unit) : ""}">
      <input type="text" class="ing-item" placeholder="spaghetti" maxlength="200"
             aria-label="Ingredient" value="${ing ? escapeHTML(ing.item) : ""}">
      <button type="button" class="ing-remove" aria-label="Remove ingredient" title="Remove">×</button>`;
    ingredientRowsEl.appendChild(row);
    return row;
  }

  function fillIngredientRows(ingredients) {
    ingredientRowsEl.innerHTML = "";
    for (const ing of ingredients) addIngredientRow(ing);
    if (ingredients.length === 0) addIngredientRow(null);
  }

  /**
   * Read the rows back. Blank rows are skipped; a row with an amount the
   * quantity parser can't read aborts with {error} so nothing saves wrong.
   */
  function readIngredientRows() {
    const ingredients = [];
    for (const row of ingredientRowsEl.querySelectorAll(".ing-row")) {
      const amountText = row.querySelector(".ing-amount").value.trim();
      const unit = row.querySelector(".ing-unit").value.trim();
      const item = row.querySelector(".ing-item").value.trim();
      if (!amountText && !unit && !item) continue; // blank row
      let amount = null;
      if (amountText) {
        amount = RecipeScale.quantityToNumber(amountText);
        if (amount === null) return { error: amountText };
      }
      ingredients.push({ amount, unit, item });
    }
    return { ingredients };
  }

  $("#add-ingredient-btn").addEventListener("click", () => {
    const row = addIngredientRow(null);
    row.querySelector(".ing-amount").focus();
  });

  ingredientRowsEl.addEventListener("click", (event) => {
    const btn = event.target.closest(".ing-remove");
    if (!btn) return;
    btn.closest(".ing-row").remove();
    if (ingredientRowsEl.children.length === 0) addIngredientRow(null);
  });

  // --- Add / edit dialog ---
  /**
   * The add/edit form. `review` means the recipe arrived from a share link
   * or a paste: it is not in the box yet, so the form is pre-filled but
   * saving adds rather than updates, keeping the incoming id so opening the
   * same link twice never duplicates.
   */
  function openEditor(recipe, review, { restoring = false } = {}) {
    editingId = recipe && !review ? recipe.id : null;
    incomingId = review && recipe ? recipe.id : null;
    editorTitle.textContent = review ? "Review recipe" : recipe ? "Edit recipe" : "New recipe";
    // Re-opening a link you already saved shows the sender's version again,
    // so say that saving replaces your copy rather than adding a second.
    // An incoming recipe carries its own id, and the sender chose it. If it
    // matches something already here, saving replaces that recipe with what
    // is on screen — so name the one at stake rather than saying "my copy"
    // and leaving the person to guess which.
    const existing = review && recipe ? store.findIncoming(recipe.id) : null;
    const warning = $("#review-warning");
    if (warning) {
      warning.hidden = !existing;
      if (existing) {
        warning.textContent =
          `This will replace “${existing.name}” in your recipe box. ` +
          "Everything below is the version you were sent.";
      }
    }
    // Only an existing recipe can be deleted: not a new one, and not a
    // recipe arriving from a link, which is not yours until you save it.
    const deleteBtn = $("#edit-delete-btn");
    if (deleteBtn) deleteBtn.hidden = !editingId;
    $("#save-recipe-btn").textContent = review
      ? existing
        ? `Replace “${existing.name.length > 28 ? existing.name.slice(0, 27) + "…" : existing.name}”`
        : "Add to my recipes"
      : recipe
        ? "Save changes"
        : "Save recipe";
    recipeForm.reset();
    if (recipe) {
      const f = recipeForm.elements;
      f.name.value = recipe.name;
      f.description.value = recipe.description;
      // `|| ""` also blanks a legacy stored 0, which the servings min=1
      // constraint would otherwise reject on re-save.
      f.servings.value = recipe.servings || "";
      f.prepMinutes.value = recipe.prepMinutes ?? "";
      f.cookMinutes.value = recipe.cookMinutes ?? "";
      f.steps.value = recipe.steps.join("\n");
      f.tags.value = recipe.tags.join(", ");
    }
    fillIngredientRows(recipe ? recipe.ingredients : []);
    // Restore photo state: URLs go back into the text field, data URIs into
    // the pending slot, and a stored photo is kept by reference.
    const image = recipe ? recipe.image : "";
    pendingImage = image.startsWith("data:") ? image : "";
    existingPhotoPath = recipe ? recipe.imagePath : "";
    recipeForm.elements.imageUrl.value = image.startsWith("http") ? image : "";
    updatePhotoPreview();
    formBaseline = formSnapshot();
    const wasOpen = editorView.open;
    showView(editorView);
    // After the address, not before it: the trail is read off the route
    // (J4.23), and until this has pushed, the route is still the recipe.
    if (!wasOpen && !restoring) pushRoute(editorHash());
    renderCrumbs();
  }

  /**
   * Everything the editor is holding, as one comparable string. Taken as
   * the form opens and again when something tries to close it, so an
   * accidental dismissal can be told from an untouched one.
   */
  function formSnapshot() {
    const f = recipeForm.elements;
    return JSON.stringify([
      f.name.value,
      f.description.value,
      f.servings.value,
      f.prepMinutes.value,
      f.cookMinutes.value,
      f.steps.value,
      f.tags.value,
      f.imageUrl.value,
      pendingImage,
      existingPhotoPath,
      readIngredientRows(),
    ]);
  }

  /**
   * Closing the editor is the one way to lose work in this app: a recipe
   * typed out of a cookbook is minutes of it, and the backdrop on a phone
   * is a thin margin around a long scrolling form — exactly where a thumb
   * lands. Both ways out still work. They just ask first, and only when
   * there is something to lose, so open-look-leave stays a single tap.
   */
  /**
   * Returns whether the editor actually closed, so Back can put its
   * history entry back when the answer is "keep editing".
   */
  async function tryCloseEditor({ quiet = false } = {}) {
    if (formSnapshot() !== formBaseline &&
        !(await RecipeAsk.ask("Discard this recipe? What you have typed will be lost.", {
          confirmLabel: "Discard",
          danger: true,
        }))) {
      return false;
    }
    if (quiet) closeQuietly(editorView);
    else closeView(editorView);
    return true;
  }

  function currentFormImage() {
    return pendingImage || recipeForm.elements.imageUrl.value.trim();
  }

  /** What the preview should show: a new pick, a typed URL, or what's stored. */
  function currentPreviewSrc() {
    const chosen = currentFormImage();
    if (chosen) return chosen;
    if (!existingPhotoPath) return "";
    const hit = photoUrls.get(existingPhotoPath);
    if (hit && hit.expiresAt > Date.now()) return hit.url;
    resolvePhoto(existingPhotoPath);
    return "";
  }

  function updatePhotoPreview() {
    const preview = $("#photo-preview");
    const src = currentPreviewSrc();
    preview.src = src || "";
    preview.hidden = !src;
    $("#photo-remove-btn").hidden = !(src || existingPhotoPath);
  }

  // --- Private photos ---
  // Stored photos live in a private bucket, so each one needs a signed URL
  // that expires. Cache them per path and re-render once they arrive; a
  // recipe's stored data only ever holds the path.
  const photoUrls = new Map(); // path -> { url, expiresAt }
  const photoPending = new Set();
  const SIGNED_TTL_MS = 55 * 60 * 1000; // refresh inside the hour it's valid for
  let photoRerender = null;

  function photoSrc(recipe) {
    if (recipe.imagePath) {
      const hit = photoUrls.get(recipe.imagePath);
      if (hit && hit.expiresAt > Date.now()) return hit.url;
      resolvePhoto(recipe.imagePath);
      return "";
    }
    return recipe.image || "";
  }

  function resolvePhoto(path) {
    const cloud = window.RecipeCloud;
    if (photoPending.has(path) || !cloud || !cloud.api || !cloud.api.userId) return;
    photoPending.add(path);
    cloud.api
      .signedPhotoUrl(path)
      .then((url) => {
        photoUrls.set(path, { url, expiresAt: Date.now() + SIGNED_TTL_MS });
        // Coalesce: a grid of photos would otherwise redraw once each.
        clearTimeout(photoRerender);
        photoRerender = setTimeout(() => {
          render();
          if (detailView.open && detailId) {
            const recipe = store.getById(detailId);
            if (recipe) detailContent.innerHTML = recipeDetailHTML(recipe, true);
          }
        }, 60);
      })
      .catch((err) => console.warn("Recipe Friend: could not load a photo.", err))
      .finally(() => photoPending.delete(path));
  }

  /** Turn a data URI back into bytes for upload. */
  function dataUrlToBlob(dataUrl) {
    const [head, body] = String(dataUrl).split(",");
    const mime = (head.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  /**
   * Signed in, a picked photo goes to Storage and the recipe keeps only
   * the URL — that keeps the database small and lets share links carry
   * the photo. Signed out (or if the upload fails) the data URI stays, so
   * a photo is never silently lost.
   */
  async function uploadPendingPhoto(recipeId, image) {
    const cloud = window.RecipeCloud;
    if (!image.startsWith("data:") || !cloud || !cloud.api || !cloud.sync || !cloud.sync.bookId) return "";
    try {
      return await cloud.api.uploadPhoto(cloud.sync.bookId, recipeId, dataUrlToBlob(image));
    } catch (err) {
      console.warn("Recipe Friend: photo upload failed, keeping it on this device.", err);
      return "";
    }
  }

  /** Downscale a picked file to a storage-friendly JPEG data URI. */
  function compressImageFile(file, maxDim = 1200, quality = 0.78) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("unreadable image"));
      };
      img.src = objectUrl;
    });
  }

  function readRecipeForm(ingredients) {
    const f = recipeForm.elements;
    const lines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);
    return {
      name: f.name.value,
      description: f.description.value,
      servings: f.servings.value || null,
      prepMinutes: f.prepMinutes.value || null,
      cookMinutes: f.cookMinutes.value || null,
      ingredients,
      steps: lines(f.steps.value),
      tags: f.tags.value.split(",").map((s) => s.trim()).filter(Boolean),
      image: currentFormImage(),
      imagePath: currentFormImage() ? "" : existingPhotoPath,
    };
  }

  recipeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!recipeForm.reportValidity()) return;
    const rows = readIngredientRows();
    if (rows.error) {
      toast(`Couldn't read the amount “${rows.error}” — use numbers like 250, 1.5 or ½.`);
      return;
    }
    const input = readRecipeForm(rows.ingredients);
    if (input.ingredients.length === 0 || input.steps.length === 0) {
      toast("A recipe needs at least one ingredient and one step.");
      return;
    }
    let saved;
    if (editingId) {
      saved = store.update(editingId, input);
    } else if (incomingId) {
      // Already here (the same link opened twice): the review wins, so the
      // recipe is updated rather than the edits being thrown away.
      //
      // Otherwise it is new, and takes an id of ours rather than the
      // sender's — theirs belongs to their book, and ids are unique
      // across every book on the server. Where it came from is kept as
      // `sharedFrom` so the same link still finds it next time.
      const already = store.findIncoming(incomingId);
      const result = already
        ? { recipe: store.update(already.id, input) }
        : store.addShared({ ...input, id: null, sharedFrom: incomingId });
      saved = result && result.recipe;
    } else {
      saved = store.add(input);
    }
    if (!saved) {
      toast("Could not save that recipe — check the name, ingredients, and steps.");
      return;
    }
    // The recipe needs an id before its photo can be filed under one. On
    // success the data URI is swapped for the storage path; on failure it
    // stays put, so the photo is never silently lost.
    if (saved.image.startsWith("data:")) {
      uploadPendingPhoto(saved.id, saved.image).then((path) => {
        if (path) {
          store.update(saved.id, { image: "", imagePath: path });
          render();
        }
      });
    }
    closeView(editorView);
    if (!store.persistOk) {
      toast("Saved for this visit, but browser storage is full — try a smaller photo or export a backup.");
    } else {
      toast(editingId ? "Recipe updated." : `Added “${saved.name}”.`);
    }
    editingId = null;
    incomingId = null;
    render();
  });

  // --- Photo picker ---
  $("#photo-pick-btn").addEventListener("click", () => $("#photo-file").click());

  $("#photo-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    try {
      pendingImage = await compressImageFile(file);
      recipeForm.elements.imageUrl.value = "";
      existingPhotoPath = ""; // replaced by the new pick
      updatePhotoPreview();
    } catch {
      toast("Couldn't read that image file.");
    }
  });

  recipeForm.elements.imageUrl.addEventListener("input", () => {
    if (recipeForm.elements.imageUrl.value.trim()) pendingImage = "";
    updatePhotoPreview();
  });

  $("#photo-remove-btn").addEventListener("click", () => {
    pendingImage = "";
    existingPhotoPath = "";
    recipeForm.elements.imageUrl.value = "";
    updatePhotoPreview();
  });

  // --- Detail dialog ---
  /**
   * The kicker and title are markup rather than rendered string, because
   * the Favourite control sits inline at the end of the title and Close
   * sits opposite it — both are real elements, and neither survives having
   * the content re-rendered under it when a photo resolves or the portions
   * change.
   */
  function renderDetailHead(recipe) {
    $("#detail-title-text").textContent = recipe.name;
  }

  /** scalable: render the portion-scaling controls and apply detailScale. */
  function recipeDetailHTML(recipe, scalable) {
    const factor = scalable ? detailScale : 1;
    const scaledServings = recipe.servings ? Math.round(recipe.servings * factor * 10) / 10 : null;
    const scaleValue = recipe.servings
      ? `Serves ${scaledServings}`
      : `× ${RecipeScale.formatQuantity(factor)}`;
    const scaleControls = scalable
      ? `
      <div class="scale-row" role="group" aria-label="Scale portions">
        <span class="scale-label">Portions</span>
        <button type="button" class="scale-btn" data-scale="down" aria-label="Fewer portions">−</button>
        <span class="scale-value">${escapeHTML(scaleValue)}</span>
        <button type="button" class="scale-btn" data-scale="up" aria-label="More portions">+</button>
        ${factor !== 1 ? '<button type="button" class="scale-reset" data-scale="reset">Reset</button>' : ""}
      </div>
      ${factor !== 1 ? '<p class="scale-note">Quantities below are scaled; timings and the method are not.</p>' : ""}`
      : "";
    const time = totalTime(recipe);
    const metaBits = [
      recipe.servings ? `Serves ${recipe.servings}` : null,
      recipe.prepMinutes ? `Prep ${recipe.prepMinutes} min` : null,
      recipe.cookMinutes ? `Cook ${recipe.cookMinutes} min` : null,
      time && recipe.prepMinutes && recipe.cookMinutes ? `Total ${time}` : null,
    ].filter(Boolean);

    return `
      ${(() => {
        const src = photoSrc(recipe);
        return src
          ? `<img class="detail-img" src="${escapeHTML(src)}"
                  alt="Photo of ${escapeHTML(recipe.name)}" referrerpolicy="no-referrer">`
          : "";
      })()}
      ${recipe.description ? `<p class="detail-desc">${escapeHTML(recipe.description)}</p>` : ""}
      ${metaLineHTML(metaBits.join(" · "), recipe)}
      ${
        recipe.tags.length
          ? `<div class="card-tags">${recipe.tags
              .map((t) => `<span class="tag">${escapeHTML(t)}</span>`)
              .join("")}</div>`
          : ""
      }
      <div class="detail-body">
        <section class="detail-col">
          <h3>Ingredients</h3>
          ${scaleControls}
          <ul class="detail-ingredients">
            ${recipe.ingredients
              .map((i) => `<li>${escapeHTML(displayIngredient(i, factor))}</li>`)
              .join("")}
          </ul>
        </section>
        <section class="detail-col">
          <h3>Steps</h3>
          <ol class="detail-steps">
            ${recipe.steps.map((s) => `<li>${escapeHTML(s)}</li>`).join("")}
          </ol>
        </section>
      </div>`;
  }

  /**
   * Copy and Move both need somewhere to go, so neither is offered until
   * there is a second book. Beyond that they part company: copying takes
   * nothing from anyone and is everyone's, while moving takes the recipe
   * out of a book other people are reading, so it belongs to whoever owns
   * this one (J7.10, J7.16).
   */
  /**
   * Whether this book is ours to change (J7.17).
   *
   * Row-level security is the real gate; this is about not offering a
   * control that would fail. Favourite goes too, because a favourite is a
   * property of the recipe and so a write like any other (J3.6) — which
   * is the cost of keeping the household's shortlist shared.
   */
  let canEditBook = true;

  function setCanEdit(editable) {
    canEditBook = Boolean(editable);
    const write = [
      "#add-recipe-btn",
      "#empty-add-btn",
      "#import-btn",
      "#paste-btn",
      "#ai-help-btn",
      "#detail-edit-btn",
      "#detail-fav-btn",
    ];
    for (const sel of write) {
      const el = $(sel);
      if (el) el.hidden = !canEditBook;
    }
    document.body.classList.toggle("read-only", !canEditBook);
    syncTransferButtons();
    // A viewer gets no planner at all (J12.10, J7.17): the plan belongs to
    // the book, so putting anything in it is a write like any other, and a
    // viewer's client never pushes. Hiding the controls is a courtesy — the
    // gate is row-level security, and nothing here is asked to be one.
    if (!canPlan()) {
      planMode = false;
      forgetPendingPortions();
      if (planView.open) closeView(planView);
    }
    syncPlanUI();
  }

  function syncTransferButtons() {
    const cloud = window.RecipeCloud;
    const books = (cloud && cloud.books && cloud.books.books) || [];
    const elsewhere = books.length > 1;
    const ownsThisBook = Boolean(
      cloud && cloud.sync && books.some((b) => b.id === cloud.sync.bookId && b.isOwner)
    );
    // Copy needs somewhere to put it; move needs that and this book to
    // be yours to take it out of.
    const somewhereToPut = (cloud && cloud.books && cloud.books.writableBooks
      ? cloud.books.writableBooks().filter((b) => b.id !== cloud.sync.bookId).length > 0
      : elsewhere);
    $("#detail-copy-btn").hidden = !somewhereToPut;
    $("#detail-move-btn").hidden = !(somewhereToPut && ownsThisBook);
  }

  /**
   * Keeping the screen awake while cooking (J4.9-J4.14). Off until asked
   * for, remembered on this device, and released the moment the recipe
   * closes — a phone back in a pocket must not still be awake.
   */
  const cookMode = new RecipeCookMode.CookMode({
    navigator,
    storage: window.localStorage,
    onChange: () => syncCookButton(),
  });

  function syncCookButton() {
    const btn = $("#detail-cook-btn");
    if (!btn) return;
    // Not offered at all where the browser cannot do it (J4.13).
    btn.hidden = !cookMode.supported;
    if (!cookMode.supported) return;
    const on = cookMode.active;
    btn.setAttribute("aria-pressed", String(on));
    btn.classList.toggle("cook-on", on);
    // Short enough to share one row with the rest of the bar on a phone,
    // but still worded — a bare moon is the control nobody would find.
    btn.textContent = on ? "☀ Staying on" : "☾ Screen on";
  }

  /**
   * An open recipe is a place, not a state (J4.15-J4.17).
   *
   * Full-screen on a phone, it reads as a page, and people leave a page
   * with the Back button — which, on a bare <dialog>, walks out of the app
   * instead. So opening one pushes `#recipe=<id>`: Back closes the recipe,
   * a refresh mid-cook comes back to it, and the address bar says where
   * you are. `restoring` marks the opens that are replaying history rather
   * than making it, so the two do not push each other in circles.
   */
  function openRecipeView(recipe, { restoring = false } = {}) {
    const wasOpen = detailView.open;
    // Keep the scale when re-rendering the same open recipe (e.g. after a
    // favourite toggle); reset it when a different recipe opens.
    if (detailId !== recipe.id || !wasOpen) detailScale = 1;
    detailId = recipe.id;
    renderDetailHead(recipe);
    detailContent.innerHTML = recipeDetailHTML(recipe, true);
    syncDetailFavButton(recipe);
    syncTransferButtons();
    syncCookButton();
    if (!wasOpen) {
      if (!restoring) pushRoute(`#recipe=${recipe.id}`);
      showView(detailView);
      renderCrumbs();
      // showModal() takes the first focusable thing it finds, which is
      // whichever control happens to be first in the markup — the star,
      // today; the portions stepper before that. Neither says what has
      // just opened. The heading does (J4.22).
      const heading = $("#detail-heading");
      if (heading && heading.focus) heading.focus();
      cookMode.enter();
    }
  }

  /**
   * --- Where you are, in the address bar (J4.17, J2.11) ---------------
   *
   * Two screens have an address: the recipe you are reading, and the
   * editor. Browsers do not put a <dialog> in history, so Back would walk
   * out of the app from either — and out of the editor it would take
   * whatever had been typed with it, without asking, which is the one
   * thing J2.9 exists to prevent.
   *
   * Each open pushes an entry, each close takes one back, and popstate
   * reconciles what is on screen with what the address now says. Editing
   * a recipe stacks on top of reading it, so Back from the editor returns
   * to the recipe rather than all the way out to the list.
   *
   * Everything else — books, units, paste, the AI prompt — stays a plain
   * dialog. None of them holds anything you would mind losing to a stray
   * Back, and an address each would be noise.
   */
  const ROUTES = [
    { name: "recipe", re: /^#recipe=(.+)$/ },
    { name: "edit", re: /^#edit=(.+)$/ },
    { name: "new", re: /^#new$/ },
    { name: "review", re: /^#review$/ },
    // The plan is a place too, and full-screen on a phone it reads as a
    // page: Back closes it exactly as it closes an open recipe (J12.9).
    { name: "plan", re: /^#plan$/ },
  ];

  const isEditorRoute = (name) => name === "edit" || name === "new" || name === "review";

  function currentRoute() {
    for (const route of ROUTES) {
      const match = location.hash.match(route.re);
      if (match) return { name: route.name, id: match[1] ? decodeURIComponent(match[1]) : null };
    }
    return { name: "list", id: null };
  }

  /** The address for the editor as it is currently open. */
  function editorHash() {
    if (incomingId) return "#review";
    if (editingId) return `#edit=${editingId}`;
    return "#new";
  }

  /**
   * How many entries this session pushed and has not yet walked back out
   * of. A screen restored from the address — a link opened cold, a reload
   * mid-cook — pushed nothing, so there is nothing behind it to go back
   * to, and going back anyway walks out of the app: exactly what having
   * an address was meant to prevent (J4.17). Measured before this
   * existed: open a shared #recipe= link, press the breadcrumb, and you
   * were out of Recipe Friend rather than in the list.
   */
  let pushedDepth = 0;

  function pushRoute(hash) {
    try {
      history.pushState({ hash }, "", hash);
      pushedDepth += 1;
    } catch {
      /* history is a convenience here; the screen still opens without it */
    }
  }

  function toListAddress() {
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      /* nothing to rewrite */
    }
  }

  /*
    Closing a screen unwinds the entry that opened it — except when
    history is already doing the closing (Back removed the entry before we
    got here), or one screen is handing over to another and means to keep
    its entry underneath.
  */
  let suppressUnwind = 0;

  function closeQuietly(view) {
    suppressUnwind += 1;
    try {
      closeView(view);
    } finally {
      suppressUnwind -= 1;
    }
  }

  function unwind(mine) {
    if (suppressUnwind) return;
    if (!mine) return;
    if (pushedDepth === 0) {
      // Nothing of ours underneath: rewrite the address to the list
      // rather than reaching for somebody else's page.
      toListAddress();
      return;
    }
    try {
      history.back();
    } catch {
      /* nothing to unwind */
    }
  }

  /**
   * The plan is an address like the others, so what the address names is
   * the one thing on screen (J12.9). Restoring a recipe or the editor
   * while the readout was up used to leave both open: the recipe took the
   * top layer and the plan sat under it, holding the page still, and
   * closing the recipe put you back in a readout the address no longer
   * named. Quietly, because history has already moved past the entry that
   * opened it.
   */
  function leavePlanReadout() {
    if (planView.open) closeQuietly(planView);
  }

  /**
   * Open whatever the address names, if we can. A recipe we do not hold
   * is a miss rather than an error: signed in, it may simply not have
   * synced down yet, and account.js calls this again once it has.
   */
  function openFromHash() {
    if (document.body.classList.contains("gated")) return false;
    const route = currentRoute();
    if (route.name === "recipe") {
      if (detailView.open && detailId === route.id) return true;
      const recipe = store.getById(route.id);
      if (!recipe) return false;
      if (editorView.open) closeQuietly(editorView);
      leavePlanReadout();
      openRecipeView(recipe, { restoring: true });
      return true;
    }
    if (route.name === "edit") {
      if (editorView.open && editingId === route.id) return true;
      const recipe = store.getById(route.id);
      if (!recipe) return false;
      if (detailView.open) closeQuietly(detailView);
      leavePlanReadout();
      openEditor(recipe, false, { restoring: true });
      return true;
    }
    if (route.name === "new") {
      if (editorView.open) return true;
      if (detailView.open) closeQuietly(detailView);
      leavePlanReadout();
      openEditor(null, false, { restoring: true });
      return true;
    }
    if (route.name === "plan") {
      if (planView.open) return true;
      // A viewer has no planner to come back to (J12.10).
      if (!canPlan()) return false;
      if (detailView.open) closeQuietly(detailView);
      if (editorView.open) closeQuietly(editorView);
      openPlanView({ restoring: true });
      return true;
    }
    // A review holds a recipe that is not in the box yet, so there is
    // nothing to rebuild it from once it has gone.
    if (route.name === "review") return editorView.open;
    return false;
  }

  // Portion stepper: with known servings, step one serving at a time;
  // without, step the multiplier by ½.
  detailContent.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-scale]");
    if (!btn) return;
    const recipe = store.getById(detailId);
    if (!recipe) return;
    const action = btn.dataset.scale;
    if (action === "reset") {
      detailScale = 1;
    } else if (recipe.servings) {
      const current = Math.round(recipe.servings * detailScale);
      const next = action === "up" ? current + 1 : Math.max(1, current - 1);
      detailScale = next / recipe.servings;
    } else {
      const next = action === "up" ? detailScale + 0.5 : detailScale - 0.5;
      detailScale = Math.min(8, Math.max(0.5, next));
    }
    detailContent.innerHTML = recipeDetailHTML(recipe, true);
  });

  function syncDetailFavButton(recipe) {
    const btn = $("#detail-fav-btn");
    // A filled star against an outline is the whole message here, so the
    // word goes and the accessible name carries what the glyph cannot.
    btn.textContent = recipe.favorite ? "★" : "☆";
    btn.setAttribute("aria-pressed", String(recipe.favorite));
    btn.setAttribute("aria-label", recipe.favorite ? "Favourited" : "Favourite");
    btn.classList.toggle("is-on", recipe.favorite);
  }

  /**
   * --- Planning a week, and shopping for it (J12, J13, J14) -----------
   *
   * The arithmetic is elsewhere and pure: plan.js knows what a meal is,
   * shoplist.js knows what a shop is, planstore.js knows where the plan
   * lives. Everything here is the screen — which control exists, what it
   * says, and what it does when a thumb lands on it.
   *
   * Two things are worth saying out loud, because they are decisions
   * rather than plumbing. Planning is a mode over the list and not a
   * screen of its own (J12.4), so nothing below narrows or reorders
   * anything: search, the chips, Favourites and the ranking all go on
   * working exactly as they were, because choosing between recipes is
   * what the list is already for. And a viewer gets no planner at all
   * (J12.10) — the plan is the book's, so adding to it is a write.
   */
  const thePlan = () => (planStore ? planStore.plan : null);

  /** Is there a planner here at all, and is this book ours to plan in? */
  function canPlan() {
    return Boolean(planStore) && canEditBook;
  }

  /** The shop as it stands, for this reader's units (J13.6). */
  function shopList() {
    return RecipeShopList.build(thePlan(), store.recipes, store.prefs);
  }

  function prunePlan() {
    if (!planStore) return;
    const plan = planStore.plan;
    const pruned = RecipePlan.prune(plan, store.recipes.map((r) => r.id));
    if (pruned !== plan) planStore.setPlan(pruned);
  }

  /** Every entry this recipe has in the plan — it may have several (J12.6). */
  function mealsFor(recipeId) {
    const plan = thePlan();
    return plan ? plan.meals.filter((m) => m.recipeId === recipeId) : [];
  }

  /**
   * How a meal's portions read, in the words the recipe view uses for the
   * same thing (J12.5): servings where the recipe has them, a multiplier
   * where it has not.
   */
  function portionsLabel(meal, recipe) {
    if (meal.portions) return `Serves ${Math.round(meal.portions * 10) / 10}`;
    return `× ${RecipeScale.formatQuantity(RecipePlan.factorFor(meal, recipe))}`;
  }

  /**
   * Put a recipe in the plan at the portions on screen.
   *
   * `addMeal` puts it in at the recipe's own servings, which is the
   * default J12.5 asks for. Where the reader has already stepped the
   * portions — in the recipe view, whose stepper this reuses — the new
   * meal is walked to match by the same steps a finger would take,
   * rather than by writing a number in behind them: one definition of
   * what a step is, and it is plan.js's.
   */
  function addToPlan(recipe, factor = 1) {
    if (!planStore || !recipe) return null;
    const now = Date.now();
    let plan = RecipePlan.addMeal(thePlan(), recipe, now);
    const id = plan.meals[plan.meals.length - 1].id;
    const at = (p) => RecipePlan.factorFor(p.meals.find((m) => m.id === id), recipe);
    // Bounded twice over: by the step that stops improving — a limit
    // reached, or a half-batch step that would overshoot — and by a
    // guard, because a loop that walks towards a number must not be the
    // one thing in the app that can spin.
    for (let guard = 0; guard < 32; guard++) {
      const current = at(plan);
      if (Math.abs(current - factor) < 0.01) break;
      const next = RecipePlan.stepPortions(plan, id, current < factor ? "up" : "down", recipe, now);
      if (next === plan || Math.abs(at(next) - factor) >= Math.abs(current - factor)) break;
      plan = next;
    }
    planStore.setPlan(plan);
    return id;
  }

  // --- Plan mode over the list -----------------------------------------

  /**
   * The portions a card's stepper is showing before anything of this
   * recipe is in the plan — what the next add will use (J12.4).
   *
   * It sits in the same UI state as which tag is selected and is written
   * nowhere else: the plan is the only place portions live for real
   * (J12.5, J4.3). A number nobody has acted on is not a fact about the
   * book, so it is neither cached nor synced — two people steering one
   * stepper neither of them can see is not a feature — and plan mode
   * going off takes it with it.
   */
  let pendingPortions = Object.create(null);
  const PENDING = "pending";

  function forgetPendingPortions() {
    pendingPortions = Object.create(null);
  }

  /**
   * A meal-shaped thing for a recipe that has no meal yet, so the label,
   * the factor and the step can all be asked about it in the words they
   * already use for a real one. Defaults are the recipe's own servings,
   * exactly as `addMeal` would have set them (J12.5).
   */
  function pendingMeal(recipe) {
    const held = pendingPortions[recipe.id];
    if (held) return held;
    const servings = Number(recipe.servings) > 0 ? Number(recipe.servings) : null;
    return {
      id: PENDING,
      recipeId: recipe.id,
      name: recipe.name,
      portions: servings,
      multiplier: servings ? null : 1,
    };
  }

  /**
   * Step that number. It goes through plan.js on a plan of one meal that
   * is not the plan, so what a step is has one definition and this is not
   * a second one: one serving where servings are known, half a batch
   * where they are not (J4.2, J12.5).
   */
  function stepPending(recipe, direction) {
    const meal = pendingMeal(recipe);
    const stepped = RecipePlan.stepPortions({ meals: [meal] }, PENDING, direction, recipe);
    pendingPortions[recipe.id] = stepped.meals[0];
  }

  /** What a card's stepper is showing: the plan's meal, or the pending number. */
  function showingFor(recipe) {
    const mine = mealsFor(recipe.id);
    return mine[mine.length - 1] || pendingMeal(recipe);
  }

  /**
   * What a card offers in plan mode: a way in, and a stepper that is
   * always there. It has one meaning — the portions this recipe is in the
   * plan at, or is about to go in at — so the row does not change shape
   * under a thumb that has already reached for it, and the portions can
   * be chosen before the add rather than corrected after it. The row's
   * height was being spent either way.
   */
  function planCardRow(recipe) {
    if (!planMode || !canPlan()) return "";
    const mine = mealsFor(recipe.id);
    const showing = showingFor(recipe);
    const id = escapeHTML(recipe.id);
    const name = escapeHTML(recipe.name);
    return `
        <div class="plan-card-row">
          <button type="button" class="btn btn-ghost plan-add" data-plan="add" data-id="${id}"
                  aria-label="${mine.length ? `Add ${name} to the plan again` : `Add ${name} to the plan`}"
                  >${mine.length ? "+ Again" : "+ Plan"}</button>
          ${
            `<span class="plan-portions" role="group" aria-label="Portions of ${name}">
              <button type="button" class="scale-btn" data-plan="down" data-id="${id}"
                      aria-label="Fewer portions of ${name}">−</button>
              <span class="scale-value">${escapeHTML(portionsLabel(showing, recipe))}</span>
              <button type="button" class="scale-btn" data-plan="up" data-id="${id}"
                      aria-label="More portions of ${name}">+</button>
            </span>`
          }
          ${
            // The glyph is a count, and "times 2" is not what it says. The
            // words go beside it where a screen reader will read them.
            mine.length > 1
              ? `<span class="plan-times"><span aria-hidden="true">×${mine.length}</span
                 ><span class="visually-hidden">${mine.length} meals of ${name} planned</span></span>`
              : ""
          }
        </div>`;
  }

  /**
   * A tap on a card's plan controls. The stepper edits the most recent
   * meal of this recipe once there is one, and the number the next add
   * will use before there is; adding takes whatever it is showing, so
   * "+ Again" puts a second night in at the portions on screen rather
   * than back at the recipe's own servings.
   */
  function cardPlanAction(action, recipeId) {
    if (!canPlan()) return;
    const recipe = store.getById(recipeId);
    if (!recipe) return;
    const mine = mealsFor(recipeId);
    const last = mine[mine.length - 1];
    if (action === "add") {
      addToPlan(recipe, RecipePlan.factorFor(showingFor(recipe), recipe));
      // The plan holds those portions now, and it is the only place they
      // live: the stepper reads the meal from here on.
      delete pendingPortions[recipeId];
      toast(`Added “${recipe.name}” to the plan.`);
    } else if (last) {
      planStore.setPlan(RecipePlan.stepPortions(thePlan(), last.id, action, recipe));
    } else {
      stepPending(recipe, action);
    }
    render();
  }

  /**
   * The header toggle, its count, and the bar over the list. Called from
   * render(), so anything that changes the plan keeps them honest.
   */
  function syncPlanUI() {
    const available = canPlan();
    const planBtn = $("#plan-btn");
    if (planBtn) {
      planBtn.hidden = !available;
      planBtn.setAttribute("aria-pressed", String(planMode));
      planBtn.classList.toggle("is-on", planMode);
    }
    const meals = available ? thePlan().meals.length : 0;
    const count = $("#plan-count");
    if (count) {
      // A count of nothing is not a count: the toggle carries a number
      // once there is a plan to have one (J12.4).
      count.hidden = meals === 0;
      const text = meals ? String(meals) : "";
      if (count.textContent !== text) count.textContent = text;
    }
    const bar = $("#plan-bar");
    if (bar) bar.hidden = !(available && planMode);
    const barText = $("#plan-bar-text");
    if (barText && available && planMode) {
      const left = shopList().toBuy.length;
      barText.textContent =
        meals === 0
          ? "Nothing in the plan yet — add recipes below."
          : `${meals} ${meals === 1 ? "meal" : "meals"} in the plan · ` +
            (left === 0 ? "nothing left to buy" : `${left} ${left === 1 ? "thing" : "things"} to buy`);
    }
    syncPlanButtons();
  }

  /**
   * The recipe view gains a way in only in plan mode (J12.7) — the rule
   * Copy and Move already follow. J4.19 fought to keep that row on one
   * line at 360px, and a control for something you are not doing is not
   * what the room is spent on.
   */
  function syncPlanButtons() {
    const btn = $("#detail-plan-btn");
    if (btn) btn.hidden = !(canPlan() && planMode);
  }

  // --- The plan readout (J12.9, J13) -----------------------------------

  /**
   * Meals above the shopping list, sharing one scroll, for the reason
   * J4.16 gives for ingredients above steps: two panes would be the top
   * half of each, and neither list would ever be finished.
   */
  function openPlanView({ restoring = false } = {}) {
    if (!planStore) return false;
    const wasOpen = planView.open;
    renderPlan();
    if (!wasOpen) {
      if (!restoring) pushRoute("#plan");
      showView(planView);
      renderCrumbs();
      // The heading, not the first control — which is a portions stepper
      // and does not say what has just filled the screen (J4.21).
      const heading = $("#plan-heading");
      if (heading && heading.focus) heading.focus();
    }
    return true;
  }

  function renderPlan() {
    if (!planStore) return;
    const plan = thePlan();
    const list = shopList();
    planContent.innerHTML = planMealsHTML(plan) + shopListHTML(list);

    const nothingToBuy = list.toBuy.length === 0;
    // Offered only where there is something for it to do (J4.13).
    $("#plan-copy-btn").hidden = nothingToBuy;
    $("#plan-share-btn").hidden = nothingToBuy || !canShareText();
    // Finishing needs at least one recipe: an empty plan has nothing to
    // record and offers no Done (J14.3).
    $("#plan-done-btn").hidden = plan.meals.length === 0;
    $("#plan-clear-btn").hidden = plan.meals.length === 0;
  }

  function planMealsHTML(plan) {
    if (!plan || plan.meals.length === 0) {
      return `
        <section class="plan-section">
          <h3>Meals</h3>
          <p class="plan-empty">Nothing in the plan yet. Turn on Meal plan above the
             recipe list, then add recipes from there.</p>
        </section>`;
    }
    return `
      <section class="plan-section">
        <h3>Meals</h3>
        <ul class="plan-meals">${plan.meals.map(planMealHTML).join("")}</ul>
      </section>`;
  }

  function planMealHTML(meal) {
    const recipe = store.getById(meal.recipeId);
    // The name the plan copied down, so an archived plan still reads
    // correctly after the recipe has gone (J14.12).
    const name = escapeHTML(meal.name || (recipe && recipe.name) || "");
    const id = escapeHTML(meal.id);
    return `
          <li class="plan-meal">
            <span class="plan-meal-name">${name}</span>
            <span class="plan-portions" role="group" aria-label="Portions of ${name}">
              <button type="button" class="scale-btn" data-plan="meal-down" data-meal="${id}"
                      aria-label="Fewer portions of ${name}">−</button>
              <span class="scale-value">${escapeHTML(portionsLabel(meal, recipe))}</span>
              <button type="button" class="scale-btn" data-plan="meal-up" data-meal="${id}"
                      aria-label="More portions of ${name}">+</button>
            </span>
            <button type="button" class="icon-btn plan-meal-remove" data-plan="meal-remove"
                    data-meal="${id}" aria-label="Take ${name} out of the plan">×</button>
          </li>`;
  }

  function shopListHTML(list) {
    if (list.lines.length === 0) {
      return `
        <section class="plan-section">
          <h3>Shopping list</h3>
          <p class="plan-empty">The shopping list is whatever the meals above ask for.</p>
        </section>`;
    }
    const removed = list.alreadyHave;
    return `
      <section class="plan-section">
        <h3>Shopping list</h3>
        <ul class="shop-lines">
          ${list.toBuy.map((l) => shopLineHTML(l, "")).join("")}
          ${list.inBasket.map((l) => shopLineHTML(l, "got")).join("")}
        </ul>
        ${
          removed.length
            ? `<details class="shop-have">
          <summary>${removed.length} ${removed.length === 1 ? "thing" : "things"} you already have</summary>
          <ul class="shop-lines shop-lines-have">
            ${removed.map((l) => shopLineHTML(l, "have")).join("")}
          </ul>
        </details>`
            : ""
        }
      </section>`;
  }

  /**
   * One line of the shop: the combined amount, what it is made of, and
   * the two gestures that settle it.
   *
   * `state` is how the line stands — still wanted, in the basket, or at
   * home already. ✗ and ✓ both record an amount rather than a tick
   * (J13.9), and both can be taken back, because ✗ is a fast gesture and
   * fast gestures are mistyped (J13.14).
   */
  function shopLineHTML(line, state) {
    const amount = line.amount === null ? "" : RecipeScale.formatQuantity(line.amount);
    const measure = [amount, line.unit].filter(Boolean).join(" ");
    // Both numbers, on the one line that has two (J13.10). The total is
    // what the plan asks for and stays where it was; the shortfall is
    // what a shop is for, and is the number Copy takes away. Worked out
    // in shoplist.js with the rest of the display-unit arithmetic, so
    // the screen and the copy cannot end up meaning different things by
    // the same word.
    const part = line.partText
      ? ` <span class="shop-part">· ${escapeHTML(line.partText)}</span>`
      : "";
    const item = escapeHTML(line.item);
    const key = escapeHTML(line.key);
    const buttons =
      state === "have"
        ? `<button type="button" class="btn btn-ghost shop-restore" data-plan="unhave" data-key="${key}"
                   aria-label="Put ${item} back on the list">Put back</button>`
        : state === "got"
          ? `<button type="button" class="icon-btn shop-btn is-on" data-plan="unget" data-key="${key}"
                     aria-pressed="true" aria-label="Take ${item} out of the basket">✓</button>`
          : `<button type="button" class="icon-btn shop-btn" data-plan="have" data-key="${key}"
                     aria-label="We already have ${item}">✗</button>
             <button type="button" class="icon-btn shop-btn" data-plan="got" data-key="${key}"
                     aria-pressed="false" aria-label="Put ${item} in the basket">✓</button>`;
    return `
            <li class="shop-line${state === "got" ? " shop-line-got" : ""}">
              <div class="shop-line-text">
                <p class="shop-what">${
                  measure ? `<span class="shop-amount">${escapeHTML(measure)}</span> ` : ""
                }${item}${line.toTaste ? ' <span class="shop-taste">to taste</span>' : ""}${part}</p>
                ${shopFromHTML(line)}
              </div>
              <div class="shop-line-btns">${buttons}</div>
            </li>`;
  }

  /**
   * What the line is made of (J13.7) — "Bolognese 4 · Curry 2".
   *
   * Where the recipes wrote the item differently the line says what each
   * of them wrote, because the plural rule (J13.4) is what makes a wrong
   * merge and naming the recipes alone would not show it. Where they all
   * wrote the same thing that parenthetical is noise, and goes.
   */
  function shopFromHTML(line) {
    if (!line.from.length) return "";
    const differ = new Set(line.from.map((f) => f.item)).size > 1;
    const bits = line.from.map((f) => {
      const written = differ ? ` (${f.item})` : "";
      return escapeHTML(`${f.name}${f.text ? ` ${f.text}` : ""}${written}`);
    });
    return `<p class="shop-from">${bits.join(" · ")}</p>`;
  }

  /** A tap inside the readout: the meals above, the shop below. */
  function planAction(action, dataset) {
    if (!canPlan()) return;
    if (action === "meal-remove") {
      const plan = thePlan();
      const meal = plan.meals.find((m) => m.id === dataset.meal);
      planStore.setPlan(RecipePlan.removeMeal(plan, dataset.meal));
      if (meal) toast(`Took “${meal.name}” out of the plan.`);
      render();
      return;
    }
    if (action === "meal-up" || action === "meal-down") {
      const plan = thePlan();
      const meal = plan.meals.find((m) => m.id === dataset.meal);
      if (!meal) return;
      const direction = action === "meal-up" ? "up" : "down";
      planStore.setPlan(
        RecipePlan.stepPortions(plan, meal.id, direction, store.getById(meal.recipeId))
      );
      render();
      return;
    }
    // Returned rather than dropped: settling the last line finishes the
    // plan, which is a promise, and a test wants to be able to wait for it.
    if (action === "have" || action === "got") return settleShopLine(dataset.key, action);
    if (action === "unhave" || action === "unget") {
      unsettleShopLine(dataset.key, action === "unhave" ? "have" : "got");
    }
    return undefined;
  }

  /**
   * ✗ and ✓, and the one moment a plan finishes itself.
   *
   * Whether this tap finishes the shop is asked of the list **before** the
   * tap lands (J14.2). `allSettled` after the fact cannot tell somebody
   * settling the last line from a requirement that fell away — dropping a
   * meal, or a recipe leaving the book from another device, takes an
   * outstanding amount off the list with nobody touching it, and a plan
   * that archived itself on that would be recording a shop nobody said
   * they had done.
   */
  function settleShopLine(key, field) {
    const list = shopList();
    const line = list.lines.find((l) => l.key === key);
    if (!line) return;
    const finishes = RecipeShopList.finishesShop(list, line);
    planStore.setPlan(RecipeShopList.settleLine(thePlan(), line, field, Date.now()));
    render();
    return finishes ? finishPlan() : undefined;
  }

  function unsettleShopLine(key, field) {
    const line = shopList().lines.find((l) => l.key === key);
    if (!line) return;
    planStore.setPlan(RecipeShopList.unsettleLine(thePlan(), line, field, Date.now()));
    render();
  }

  // --- Finishing, and taking it back (J14.1, J14.2) --------------------

  /**
   * Done: every recipe in the plan is stamped as planned, the plan is
   * archived, and an empty one takes its place. It says what it did and
   * offers Undo rather than asking first — pressing Done, or settling the
   * last line, is somebody saying they have finished, and you do not
   * interrogate them about it.
   *
   * The plan closes with it: the shop is over, and what is left to say
   * fits in the toast that carries the way back.
   */
  async function finishPlan() {
    if (!canPlan()) return;
    const plan = thePlan();
    if (!plan || plan.meals.length === 0) return; // J14.3
    const cloud = window.RecipeCloud;
    const sync = cloud && cloud.sync;
    if (!sync || !sync.completePlan) {
      toast("Finishing a plan needs your account — sign in and try again.");
      return;
    }
    let done;
    try {
      done = await sync.completePlan(Date.now());
    } catch (err) {
      console.warn("Recipe Friend: could not finish the plan.", err);
      toast("Couldn't finish that plan — it is still here.");
      render();
      return;
    }
    if (!done) return;
    const count = done.archived.meals.length;
    if (planView.open) closeView(planView);
    render();
    toast(`Planned ${count} ${count === 1 ? "meal" : "meals"}.`, {
      label: "Undo",
      run: () => undoFinishPlan(done.archived.id),
    });
  }

  /**
   * Undo is the one thing in the plan that needs a network (J14.2). A
   * finished plan is recorded for the whole book, so taking the record
   * back has to reach the server — a device that dropped it locally would
   * be handed it straight back by the next sync. It says so rather than
   * appearing to work.
   */
  async function undoFinishPlan(planId) {
    const cloud = window.RecipeCloud;
    const sync = cloud && cloud.sync;
    if (!sync || !sync.undoComplete) {
      toast("Undo needs a connection — that plan is on the record for the whole book.");
      return;
    }
    try {
      const restored = await sync.undoComplete(planId, Date.now());
      render();
      toast(restored ? "The plan is back." : "That plan has already gone from the record.");
    } catch (err) {
      console.warn("Recipe Friend: could not undo finishing the plan.", err);
      toast("Couldn't undo that — it needs a connection, and the plan is still recorded.");
    }
  }

  /**
   * Clear discards a plan without recording it: a week that never
   * happened should not claim to have been planned (J14.4). Unlike Done
   * it is not something you have just said you wanted, and it cannot be
   * taken back, so it asks first — the same question everything
   * destructive here asks (J2.10).
   */
  async function clearPlan() {
    if (!canPlan()) return;
    const plan = thePlan();
    const meals = plan.meals.length;
    if (meals === 0) return;
    const ok = await RecipeAsk.ask(
      `Clear the plan? ${meals} ${meals === 1 ? "meal goes" : "meals go"} from it, along with ` +
        "everything ticked off the shopping list, and nothing is recorded as planned.",
      { confirmLabel: "Clear", danger: true }
    );
    if (!ok) return;
    // A new plan is a new generation, and a generation carries the moment
    // it began: stamped past the plan it replaces, so a device still
    // holding the old one yields to this rather than handing it back
    // (see mergePlans in plan.js). `generationAfter` is where that sum
    // lives, so Clear, Done and Undo all order themselves the same way.
    planStore.setPlan(RecipePlan.emptyPlan(RecipePlan.generationAfter(plan)));
    if (planView.open) closeView(planView);
    toast("Plan cleared.");
    render();
  }

  // --- Taking the list to the shop (J13.13) ----------------------------

  const canShareText = () => Boolean(navigator && typeof navigator.share === "function");

  /** What is left: neither removed nor settled, and never asked for twice. */
  const outstandingText = () => RecipeShopList.copyText(shopList());

  // --- Wiring ----------------------------------------------------------

  $("#plan-btn").addEventListener("click", () => {
    if (!canPlan()) return;
    planMode = !planMode;
    // Leaving the mode leaves nothing behind: a portion somebody dialled
    // up and never added is a thought, not a decision (J12.4).
    if (!planMode) forgetPendingPortions();
    render();
  });

  $("#plan-open-btn").addEventListener("click", () => {
    if (canPlan()) openPlanView();
  });

  $("#detail-plan-btn").addEventListener("click", () => {
    const recipe = detailId && store.getById(detailId);
    if (!recipe || !canPlan()) return;
    // At the portions on screen: the recipe view's own stepper is the one
    // the plan reuses, so what it says is what goes in (J12.5).
    addToPlan(recipe, detailScale);
    toast(`Added “${recipe.name}” to the plan.`);
    render();
  });

  planContent.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-plan]");
    if (!btn || !btn.dataset.plan) return undefined;
    return planAction(btn.dataset.plan, btn.dataset);
  });


  onViewClose(planView, () => {
    unwind(currentRoute().name === "plan");
  });

  $("#plan-done-btn").addEventListener("click", () => finishPlan());
  $("#plan-clear-btn").addEventListener("click", () => clearPlan());

  $("#plan-copy-btn").addEventListener("click", async () => {
    const text = outstandingText();
    if (!text) {
      toast("Nothing left to buy.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast("Shopping list copied.");
    } catch {
      // No clipboard permission, or an insecure context: fall back to
      // something the person can actually get at.
      window.prompt("Copy your shopping list:", text);
    }
  });

  $("#plan-share-btn").addEventListener("click", async () => {
    const text = outstandingText();
    if (!text || !canShareText()) return;
    try {
      await navigator.share({ title: "Shopping list", text });
    } catch (err) {
      // Backing out of the share sheet is an answer, not a failure.
      if (err && err.name === "AbortError") return;
      console.warn("Recipe Friend: could not share the shopping list.", err);
      toast("Couldn't share that list — it is still on the clipboard's Copy.");
    }
  });

  // --- Import / export ---
  function exportRecipes() {
    const blob = new Blob([store.exportJSON()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `recipe-friend-export-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
    // Stored photos are private to the book and travel as a path only, so
    // an export of them is a file of broken references (J10.4). Say so
    // when there is actually a photo to lose.
    const stored = store.recipes.filter((r) => r.imagePath).length;
    toast(
      `Exported ${store.recipes.length} recipe${store.recipes.length === 1 ? "" : "s"}.` +
        (stored ? " Photos aren't included." : "")
    );
  }

  function importRecipes(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const result = store.importJSON(String(reader.result));
      if (!result) {
        toast("That file doesn't look like a Recipe Friend export.");
        return;
      }
      // Say what actually happened: an import that only updates would
      // otherwise report "Imported 0 recipes" and look like it failed.
      const bits = [];
      if (result.imported) bits.push(`added ${result.imported}`);
      if (result.updated) bits.push(`updated ${result.updated}`);
      if (result.skipped) bits.push(`skipped ${result.skipped}`);
      toast(bits.length ? `Import: ${bits.join(", ")}.` : "Nothing new in that file.");
      render();
    };
    reader.onerror = () => toast("Could not read that file.");
    reader.readAsText(file);
  }

  // --- Event wiring ---
  $("#add-recipe-btn").addEventListener("click", () => openEditor(null));
  $("#empty-add-btn").addEventListener("click", () => openEditor(null));
  $("#cancel-edit-btn").addEventListener("click", () => closeView(editorView));

  // --- AI assistance: a prompt to take away, and a box to bring JSON back to ---
  const aiHelpDialog = $("#ai-help-dialog");
  const pasteDialog = $("#paste-dialog");
  const pasteInput = $("#paste-input");
  const pasteError = $("#paste-error");

  function openPasteDialog() {
    pasteInput.value = "";
    pasteError.hidden = true;
    pasteDialog.showModal();
    pasteInput.focus();
  }

  $("#ai-help-btn").addEventListener("click", () => {
    $("#more-menu").open = false;
    aiHelpDialog.showModal();
  });

  $("#ai-help-close-btn").addEventListener("click", () => aiHelpDialog.close());

  $("#ai-copy-btn").addEventListener("click", async () => {
    const prompt = $("#ai-prompt").textContent;
    try {
      await navigator.clipboard.writeText(prompt);
      toast("Prompt copied. Paste it into your AI of choice.");
    } catch {
      // Clipboard blocked (no permission, or an insecure context): select
      // the text so a manual copy still works.
      const range = document.createRange();
      range.selectNodeContents($("#ai-prompt"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      toast("Select-all is ready — press Ctrl/Cmd+C to copy.");
    }
  });

  $("#ai-to-paste-btn").addEventListener("click", () => {
    aiHelpDialog.close();
    openPasteDialog();
  });

  $("#paste-btn").addEventListener("click", () => {
    $("#more-menu").open = false;
    openPasteDialog();
  });

  $("#paste-close-btn").addEventListener("click", () => pasteDialog.close());

  /**
   * What an assistant hands back, loosely: bare JSON, JSON inside a markdown
   * code fence, prose wrapped around it, or a share link pasted by mistake.
   */
  function readPasted(text) {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const link = trimmed.match(/#add=([A-Za-z0-9._~-]+)/);
    if (link) return { kind: "link", payload: link[1] };
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : trimmed;
    const open = body.indexOf("{");
    const close = body.lastIndexOf("}");
    if (open === -1 || close <= open) return null;
    return { kind: "json", text: body.slice(open, close + 1) };
  }

  function pasteFailed(message) {
    pasteError.textContent = message;
    pasteError.hidden = false;
  }

  $("#paste-save-btn").addEventListener("click", async () => {
    const parsed = readPasted(pasteInput.value);
    if (!parsed) {
      pasteFailed("That doesn't look like JSON or a share link.");
      return;
    }

    let raw;
    if (parsed.kind === "link") {
      raw = await RecipeShare.decodeRecipeShare(parsed.payload);
      if (!raw) {
        pasteFailed("That share link couldn't be read — it may have been cut short.");
        return;
      }
    } else {
      try {
        raw = JSON.parse(parsed.text);
      } catch (err) {
        pasteFailed(`That isn't valid JSON: ${err.message}`);
        return;
      }
    }

    const preview = RecipeStore.sanitizeRecipe(raw);
    if (!preview) {
      pasteFailed(
        "A recipe needs a name, at least one ingredient and at least one step, " +
          "and each amount must be a number or null."
      );
      return;
    }
    pasteDialog.close();
    reviewIncoming(preview);
  });

  // --- Measurement preferences ---
  const prefsDialog = $("#prefs-dialog");

  $("#prefs-btn").addEventListener("click", () => {
    $("#mass-pref").value = store.prefs.mass;
    $("#volume-pref").value = store.prefs.volume;
    prefsDialog.showModal();
  });

  $("#prefs-close-btn").addEventListener("click", () => prefsDialog.close());

  $("#prefs-save-btn").addEventListener("click", () => {
    store.setPrefs({ mass: $("#mass-pref").value, volume: $("#volume-pref").value });
    const cloud = window.RecipeCloud;
    if (cloud && cloud.api && cloud.api.userId) {
      cloud.api.pushPrefs(store.prefs).catch((err) => {
        console.warn("Recipe Friend: could not save preferences to your account.", err);
      });
    }
    prefsDialog.close();
    toast("Preferences saved.");
    // Nothing stored changed — only how amounts are shown.
    if (detailView.open && detailId) {
      const recipe = store.getById(detailId);
      if (recipe) detailContent.innerHTML = recipeDetailHTML(recipe, true);
    }
    render();
  });

  $("#export-btn").addEventListener("click", exportRecipes);
  $("#import-btn").addEventListener("click", () => $("#import-file").click());
  $("#import-file").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) importRecipes(file);
    event.target.value = "";
  });

  searchInput.addEventListener("input", () => {
    searchTerms = RecipeSearch.parseTerms(searchInput.value);
    render();
  });

  favoritesBtn.addEventListener("click", () => {
    favoritesOnly = !favoritesOnly;
    render();
  });

  /**
   * A choice redraws the thing it was made in, and rewriting innerHTML
   * throws away the button the keyboard was on — which left you on the
   * body after choosing a tag, in the one menu built for choosing several
   * things in a row (J15.3). So the caller says where focus belongs
   * afterwards, and the first candidate that is there and choosable gets
   * it: the same control where it survives, and the one that governs it
   * where the choice was to take that control away.
   */
  function renderKeepingFocus(...candidates) {
    render();
    for (const find of candidates) {
      const el = find();
      if (el && !el.disabled) {
        el.focus();
        return;
      }
    }
  }

  /** The tag's own row in the redrawn menu, found by its name rather than
      by a selector: a tag is free text and need not be one. */
  const tagOption = (tag) => () =>
    Array.from(tagMenuEl.querySelectorAll("[data-tag]")).find((b) => b.dataset.tag === tag);

  // A tag goes on or off and the menu stays open: two tags mean both
  // (J15.3), so choosing one is rarely the end of the sentence.
  tagMenuEl.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-tag]");
    if (!btn || !btn.dataset.tag) return;
    const tag = btn.dataset.tag;
    activeTags = activeTags.includes(tag)
      ? activeTags.filter((t) => t !== tag)
      : [...activeTags, tag];
    // Taking a tag off can take its count to nought against what is still
    // on, and a nought is not choosable (J15.5) — so the summary catches
    // focus in the one case the row cannot.
    renderKeepingFocus(tagOption(tag), () => filterSummaryEl);
  });

  sortOptionsEl.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-sort]");
    if (!btn || !btn.dataset.sort) return;
    sortBy = btn.dataset.sort;
    if (sortMenu) sortMenu.open = false; // one choice, so the menu is done
    // The menu it was chosen in has gone, and the chip is now what says
    // what was chosen, so that is where the keyboard lands.
    renderKeepingFocus(() => sortSummaryEl);
  });

  activeFiltersEl.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-remove]");
    if (!btn || !btn.dataset.remove) return;
    // The chip you press is the thing you are taking away, so there is no
    // equivalent to come back to: focus goes to whatever now stands where
    // it stood, and to the control that turned it on once the row is
    // empty and gone.
    const row = Array.from(activeFiltersEl.querySelectorAll("[data-remove]"));
    const at = row.indexOf(btn);
    const wasFavorites = btn.dataset.remove === "favorites";
    removeFilter(btn.dataset.remove, btn.dataset.tag, [
      () => {
        const left = activeFiltersEl.querySelectorAll("[data-remove]");
        return left[Math.min(at, left.length - 1)];
      },
      () => (wasFavorites ? favoritesBtn : filterSummaryEl),
    ]);
  });

  /**
   * Take one thing off, or the lot (J15.2). "all" takes the search with
   * them: it is what the empty list offers as a way out (J15.10), and
   * there a search is as likely to be the reason as a filter.
   */
  function removeFilter(what, tag, focusAfter) {
    if (what === "tag") activeTags = activeTags.filter((t) => t !== tag);
    if (what === "favorites") favoritesOnly = false;
    if (what === "filters" || what === "all") {
      activeTags = [];
      favoritesOnly = false;
    }
    if (what === "all") {
      searchTerms = [];
      searchInput.value = "";
    }
    renderKeepingFocus(...(focusAfter || []));
  }

  /**
   * Switching books clears the toolbar with it (J15.8). A book you have
   * just opened showing you a third of itself, for reasons set on a
   * different book last week, is a bug that looks like missing recipes.
   *
   * It hangs off the store rather than off books.js because every way
   * into another book — switching, deleting one, leaving one, being
   * removed from one — goes through `useBook`, and only that one knows
   * whether the list underneath actually changed.
   */
  store.onUseBook = () => {
    searchTerms = [];
    searchInput.value = "";
    activeTags = [];
    favoritesOnly = false;
    sortBy = "added";
    // A recipe you were reading belongs to the book you were in. Landing
    // in another one — switching, or being removed from one while you
    // read (J7.13) — leaves it naming something that is not in the list
    // underneath any more, so it goes back to the list with everything
    // else the old book took with it.
    leaveAllViews();
  };

  listEl.addEventListener("click", (event) => {
    // The way out of an empty list (J15.10) is drawn where the cards
    // would be, so it is answered here.
    const clearBtn = event.target.closest("[data-remove]");
    if (clearBtn && clearBtn.dataset.remove) {
      // This one clears the search with the filters, and it draws itself
      // where the recipes are — so once they are back it is gone, and the
      // top of the toolbar is where the keyboard belongs rather than the
      // body. Only for a keyboard, though: a click synthesised by Enter
      // carries a detail of 0, and putting a thumb on the search box
      // would raise the on-screen one over the recipes just asked for.
      const byKey = event.detail === 0;
      removeFilter(clearBtn.dataset.remove, undefined, byKey ? [() => searchInput] : []);
      return;
    }
    // Checked first: these sit inside a card, which is itself a button.
    const planBtn = event.target.closest("[data-plan]");
    if (planBtn && planBtn.dataset.plan) {
      cardPlanAction(planBtn.dataset.plan, planBtn.dataset.id);
      return;
    }
    const favBtn = event.target.closest('[data-action="favorite"]');
    if (favBtn) {
      store.toggleFavorite(favBtn.dataset.id);
      render();
      return;
    }
    const card = event.target.closest(".recipe-card");
    if (card) {
      const recipe = store.getById(card.dataset.id);
      if (recipe) openRecipeView(recipe);
    }
  });

  listEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest(".recipe-card");
    if (!card) return;
    event.preventDefault();
    const recipe = store.getById(card.dataset.id);
    if (recipe) openRecipeView(recipe);
  });

  // --- Share links ---
  let incomingShare = null; // raw payload awaiting the user's decision

  const PENDING_SHARE_KEY = "recipe-friend:pending-share";

  async function handleIncomingShare() {
    // A bare #paste is a deep link to the paste box — what an assistant
    // hands out alongside the JSON it wrote.
    if (location.hash === "#paste") {
      // Signed out there is nothing to paste into yet; leave the fragment
      // alone so it still opens once the sign-in round trip finishes.
      if (document.body.classList.contains("gated")) return;
      history.replaceState(null, "", location.pathname + location.search);
      openPasteDialog();
      return;
    }
    const match = location.hash.match(/^#add=(.+)$/);
    if (!match) return;
    // Clear the fragment so reloads and copied URLs don't re-trigger.
    history.replaceState(null, "", location.pathname + location.search);
    const raw = await RecipeShare.decodeRecipeShare(match[1]);
    const preview = raw && RecipeStore.sanitizeRecipe(raw);
    if (!preview) {
      toast("That share link couldn't be read.");
      return;
    }
    incomingShare = raw;
    // Opened while signed out: hold it across the sign-in round trip
    // instead of losing the recipe.
    if (document.body.classList.contains("gated")) {
      try {
        sessionStorage.setItem(PENDING_SHARE_KEY, JSON.stringify(raw));
      } catch {
        /* held in memory instead */
      }
      return;
    }
    reviewIncoming(preview);
  }

  /**
   * A shared or pasted recipe lands in the normal form first, so it can be
   * renamed or tweaked before it joins the box.
   */
  function reviewIncoming(preview) {
    clearPendingShare();
    openEditor(preview, true);
  }

  /** Called once signed in, for a link that arrived before sign-in. */
  function showPendingShare() {
    if (location.hash === "#paste") {
      handleIncomingShare();
      return;
    }
    if (!incomingShare) {
      try {
        const held = sessionStorage.getItem(PENDING_SHARE_KEY);
        if (held) incomingShare = JSON.parse(held);
      } catch {
        return;
      }
    }
    if (!incomingShare) return;
    const preview = RecipeStore.sanitizeRecipe(incomingShare);
    if (preview) reviewIncoming(preview);
  }

  function clearPendingShare() {
    incomingShare = null;
    try {
      sessionStorage.removeItem(PENDING_SHARE_KEY);
    } catch {
      /* nothing to clear */
    }
  }

  /**
   * Share the open recipe as a link. The recipe travels compressed in the
   * URL fragment, so nothing is uploaded and no server sees it — but that
   * also means a stored photo cannot come along, since those are private to
   * their book and readable only through a signed URL.
   */
  $("#detail-share-btn").addEventListener("click", async () => {
    const recipe = detailId && store.getById(detailId);
    if (!recipe) return;
    const btn = $("#detail-share-btn");
    btn.disabled = true;
    try {
      const encoded = await RecipeShare.encodeRecipeShare(recipe);
      const url = `${location.origin}${location.pathname}#add=${encoded}`;
      // Long enough to break in a chat app is long enough to warn about.
      if (url.length > 8000) {
        toast("That recipe is too long to fit in a share link — try Export instead.");
        return;
      }
      const lostPhoto = Boolean(recipe.imagePath);
      try {
        await navigator.clipboard.writeText(url);
        toast(
          lostPhoto
            ? "Link copied — the photo stays behind, since it's private to this book."
            : "Share link copied."
        );
      } catch {
        // No clipboard permission (or an insecure context): fall back to
        // something the person can actually get at.
        window.prompt("Copy this share link:", url);
      }
    } catch (err) {
      console.warn("Recipe Friend: could not build a share link.", err);
      toast("Couldn't build a share link for that recipe.");
    } finally {
      btn.disabled = false;
    }
  });

  // Copying and moving both live with books, so hand off to that layer.
  // Neither button appears until there is somewhere else to put it.
  const openTransfer = (verb) => () => {
    const cloud = window.RecipeCloud;
    if (!cloud || !cloud.books || !detailId) return;
    closeView(detailView);
    cloud.books.openMove(detailId, verb);
  };
  $("#detail-copy-btn").addEventListener("click", openTransfer("copy"));
  $("#detail-move-btn").addEventListener("click", openTransfer("move"));


  // Escape and the backdrop close a <dialog> without going through any
  // button, so the lock is let go here rather than at each call site (J4.10).
  //
  // Every one of those exits also has to unwind the history entry the open
  // pushed, or the entry outlives the recipe and Back re-opens something
  // the person has already closed. `poppingBack` marks the close that Back
  // itself caused — that entry is already gone.
  onViewClose(detailView, () => {
    // Before the history guard: the lock goes whichever way the recipe
    // closed, a handover to the editor included (J4.10).
    cookMode.leave();
    syncCookButton();
    unwind(currentRoute().name === "recipe");
  });

  onViewClose(editorView, () => {
    unwind(isEditorRoute(currentRoute().name));
  });

  /**
   * Back, Forward, or a hash the app did not set: make the screen match
   * the address (J4.17, J2.11).
   */
  window.addEventListener("popstate", async () => {
    const route = currentRoute();
    // Whatever Back just walked out of, it is no longer ours to unwind.
    if (pushedDepth > 0) pushedDepth -= 1;

    // Leaving the editor by Back is still leaving the editor, so typed
    // work gets the question it gets from Escape (J2.9). "Keep editing"
    // puts the entry back, so Back still means Back next time.
    if (editorView.open && !isEditorRoute(route.name)) {
      const hash = editorHash();
      if (!(await tryCloseEditor({ quiet: true }))) {
        pushRoute(hash);
        return;
      }
    }

    if (openFromHash()) return;

    if (detailView.open) closeQuietly(detailView);
    if (editorView.open) closeQuietly(editorView);
    if (planView.open) closeQuietly(planView);
    // Back into a recipe that has since been deleted or moved away: the
    // address must not go on naming it. Only ever reached from a live
    // navigation, so this cannot strip a link that is merely waiting on
    // a sync — that path goes through openFromHash on load instead.
    if (route.name !== "list") toListAddress();
  });

  $("#detail-cook-btn").addEventListener("click", async () => {
    await cookMode.toggle();
    syncCookButton();
  });

  // A wake lock does not survive the page being hidden, and the browser
  // does not hand it back — so take it again on the way in (J4.11).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") cookMode.resume();
  });

  $("#detail-fav-btn").addEventListener("click", () => {
    const recipe = store.toggleFavorite(detailId);
    if (!recipe) return;
    openRecipeView(recipe); // re-render the open dialog with the new state
    render();
  });

  $("#detail-edit-btn").addEventListener("click", () => {
    const recipe = store.getById(detailId);
    if (!recipe) {
      closeView(detailView);
      return;
    }
    // A handover, not an exit: the recipe's entry stays underneath so
    // Back from the editor returns to the recipe you were reading.
    closeQuietly(detailView);
    openEditor(recipe);
  });

  // Deleting happens from the editor (J4.20): by then you have said you
  // mean to change this recipe, which the screen you cook from has not.
  $("#edit-delete-btn").addEventListener("click", async () => {
    const recipe = editingId && store.getById(editingId);
    if (!recipe) return;
    const ok = await RecipeAsk.ask(`Delete “${recipe.name}”? This can't be undone.`, {
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    // Take the stored photo with it. Best effort — an orphaned file costs
    // a little quota, a failed delete shouldn't block removing the recipe.
    const cloud = window.RecipeCloud;
    if (recipe.imagePath && cloud && cloud.api && cloud.sync && cloud.sync.bookId) {
      cloud.api
        .deletePhoto(cloud.sync.bookId, recipe.id)
        .catch((err) => console.warn("Recipe Friend: could not remove the photo.", err));
    }
    store.remove(recipe.id);
    // The editor closes without the unsaved-work guard: what it was
    // holding was edits to a recipe that no longer exists.
    editingId = null;
    closeView(editorView);
    toast("Recipe deleted.");
    render();
  });

  // Close dialogs when clicking the backdrop. These hold nothing that
  // isn't already saved, so they go without asking.
  for (const dialog of [detailView, planView, prefsDialog, aiHelpDialog, pasteDialog]) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  // --- Menus ---
  // <details> doesn't close on outside clicks or after choosing an item,
  // and there are three of them now (J15.1), so the closing is written
  // once. Choosing does not always finish the question — the tags do not
  // (J15.3) — so each menu says whether an item ends it.
  function wireMenu(menu, { closeOnChoose = true } = {}) {
    if (!menu) return;
    if (closeOnChoose) {
      menu.addEventListener("click", (event) => {
        if (event.target.closest(".more-item")) menu.open = false;
      });
    }
    // Asked on the way down, not on the way up. Choosing a tag redraws
    // the menu under the thumb — it stays open, because two tags mean
    // both and one is rarely the end of the sentence (J15.3) — which
    // throws away the button the tap started on. By the time a bubbling
    // listener saw the tap, `contains` was being asked about a node no
    // longer in the page, said no, and shut the menu on every choice.
    // In the capture phase the page has not moved yet.
    document.addEventListener(
      "click",
      (event) => {
        if (menu.open && !menu.contains(event.target)) menu.open = false;
      },
      true
    );
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !menu.open) return;
      // Escape hides the panel, and the keyboard was very likely inside
      // it: left there it is parked on a control nobody can see, and the
      // next Tab starts from somewhere off the screen. It comes back to
      // the summary, which is what shutting a menu leaves you looking at.
      const inside = menu.contains(document.activeElement);
      menu.open = false;
      if (inside) {
        const summary = menu.querySelector("summary");
        if (summary) summary.focus();
      }
    });
  }

  wireMenu($("#more-menu"));
  wireMenu(sortMenu);
  wireMenu(filterMenu, { closeOnChoose: false });

  // Handle for the sync layer (account.js/sync.js): shared store plus a
  // way to redraw once remote changes land.
  // planStore goes out with it: account.js adopts this one rather than
  // making a second, so the screen and the sync layer read one plan.
  window.RecipeApp = {
    store, planStore, render, toast, showPendingShare, openFromHash, setCanEdit,
    leaveAllViews,
  };

  render();
  handleIncomingShare();
  // Signed out, or before the book has synced, there is nothing to open
  // yet; account.js calls this again once there is.
  openFromHash();
  // A share link opened in an already-loaded tab only changes the fragment.
  window.addEventListener("hashchange", handleIncomingShare);
})();
