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
  const listsView = $("#lists-view");
  const listsContent = $("#lists-content");
  const listView = $("#list-view");
  const listContent = $("#list-content");
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

  /**
   * The book's lists (J18), shared with the sync layer the same way: made
   * here, adopted by account.js. A pull that changed something redraws
   * whatever list is on screen (J18.24).
   */
  const listStore =
    window.RecipeListStore && window.RecipeLists ? new window.RecipeListStore() : null;
  if (listStore) listStore.onRemote = (ids) => listsChanged(ids);

  // --- Helpers ---
  const escapeHTML = RecipeHTML.escapeHTML;

  /**
   * --- Screens you go to, rather than boxes that open over one (J4.22) --
   *
   * The recipe, the lists and the editor were modal <dialog>s. A dialog is
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
  const VIEWS = [editorView, detailView, listsView, listView];

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
    // A list on screen is polled for what the others did (J18.24).
    syncListPolling();
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
    if (route.name === "lists") return [root, { label: "Lists" }];
    if (route.name === "openlist") {
      const list = listStore && listStore.get(route.id);
      return [root, { label: "Lists", to: "lists" }, { label: list ? list.name : "List" }];
    }
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
    for (const id of ["#detail-crumbs", "#lists-crumbs", "#list-crumbs", "#editor-crumbs"]) {
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
    if (target === "lists") {
      if (listView.open) backToLists();
      return;
    }
    if (target !== "list") return;
    if (detailView.open) closeView(detailView);
    if (listsView.open) closeView(listsView);
    if (listView.open) {
      // A list sits on the Lists screen's entry, so the way home is two
      // steps back: the second is taken when the first lands (popstate).
      climbingHome = pushedDepth > 1;
      closeView(listView);
    }
  }

  let climbingHome = false;

  for (const id of ["#detail-crumbs", "#lists-crumbs", "#list-crumbs", "#editor-crumbs"]) {
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
    const entry = planningIndex()[recipe.id];
    const label = RecipePlan.plannedLabel(entry && entry.lastPlannedAt);
    return label ? { text: label } : null;
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
    return `<span class="card-planned">${escapeHTML(note.text)}</span>`;
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
    // A viewer reads the lists and changes nothing (J18.4, J7.17): the
    // controls that write go, and plan mode with them. Hiding them is a
    // courtesy — the gate is row-level security.
    if (!canPlan()) {
      planMode = false;
      forgetPendingPortions();
    }
    syncPlanUI();
    if (listsView.open) renderLists();
    if (listView.open) renderList(true);
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
    // The lists are places too, and full-screen on a phone they read as
    // pages: Back closes them as it closes a recipe (J12.9). The old
    // plan's address leads to the lists that replaced it.
    { name: "lists", re: /^#(?:lists|plan)$/ },
    { name: "openlist", re: /^#list\/(.+)$/ },
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
   * The lists are addresses like the others, so what the address names is
   * the one thing on screen (J12.9). Quietly, because history has already
   * moved past the entry that opened them.
   */
  function leaveLists() {
    if (listsView.open) closeQuietly(listsView);
    if (listView.open) closeQuietly(listView);
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
      leaveLists();
      openRecipeView(recipe, { restoring: true });
      return true;
    }
    if (route.name === "edit") {
      if (editorView.open && editingId === route.id) return true;
      const recipe = store.getById(route.id);
      if (!recipe) return false;
      if (detailView.open) closeQuietly(detailView);
      leaveLists();
      openEditor(recipe, false, { restoring: true });
      return true;
    }
    if (route.name === "new") {
      if (editorView.open) return true;
      if (detailView.open) closeQuietly(detailView);
      leaveLists();
      openEditor(null, false, { restoring: true });
      return true;
    }
    if (route.name === "lists") {
      if (!listStore) return false;
      if (listsView.open) return true;
      if (editorView.open) closeQuietly(editorView);
      return openListsView({ restoring: true });
    }
    if (route.name === "openlist") {
      if (listView.open && openListId === route.id) return true;
      // A list this device has not pulled yet is a miss, like a recipe:
      // account.js asks again once the book has synced.
      if (!listStore || !listStore.get(route.id)) return false;
      if (editorView.open) closeQuietly(editorView);
      return openList(route.id, { restoring: true });
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
   * --- Plan mode, until "Add to list" replaces it (J12.4, J18 step 2) --
   *
   * The plan readout and its summed shopping list are gone (J18.26): the
   * book's lists are where the shopping lives now. What stays until step
   * 2 is the mode over the recipe list, and its add puts the recipe on the
   * book's first checklist as one item with its ingredients nested under
   * it, at the portions the card's stepper shows (J18.18).
   */

  /** May this reader put things on the book's lists? (J18.4, J7.17) */
  function canPlan() {
    return Boolean(listStore) && canEditBook;
  }

  /** The list plan mode adds to: the book's first checklist, Shopping. */
  function firstChecklist() {
    return listStore ? listStore.lists.find((l) => l.kind === "checklist") || null : null;
  }

  /**
   * The portions a card's stepper is showing — what the next add will
   * use. UI state like which tag is on, and like it never stored or
   * synced: leaving plan mode forgets it (J12.5).
   */
  let pendingPortions = Object.create(null);

  function forgetPendingPortions() {
    pendingPortions = Object.create(null);
  }

  /** Servings where the recipe says them, else the J4.2 multiplier. */
  function portionsFor(recipe) {
    const held = pendingPortions[recipe.id];
    if (held) return held;
    return Number(recipe.servings) > 0 ? Number(recipe.servings) : 1;
  }

  /** Step the way the recipe view steps (J4.2): a serving, or half a batch. */
  function stepPending(recipe, direction) {
    const now = portionsFor(recipe);
    pendingPortions[recipe.id] =
      Number(recipe.servings) > 0
        ? direction === "up" ? now + 1 : Math.max(1, now - 1)
        : Math.min(8, Math.max(0.5, now + (direction === "up" ? 0.5 : -0.5)));
  }

  function portionsLabel(recipe, portions) {
    return Number(recipe.servings) > 0
      ? `Serves ${Math.round(portions * 10) / 10}`
      : `× ${RecipeScale.formatQuantity(portions)}`;
  }

  /**
   * Put a recipe on the first checklist, at the top, as one item with its
   * ingredients under it, scaled and in this reader's units (J18.18). It
   * says so with an Undo, like every other way an item comes or goes here.
   */
  function addRecipeToList(recipe, portions) {
    if (!canPlan() || !recipe) return false;
    const list = firstChecklist();
    if (!list) {
      toast("There is no checklist to put it on — make one in Lists.");
      return false;
    }
    const rootId = RecipeLists.newId();
    const node = RecipeLists.recipeItems(recipe, portions, store.prefs);
    const after = listStore.change(list.id, (l) =>
      RecipeLists.addTree(l, node, {
        atTop: true,
        makeId: (_, path) => (path.length === 0 ? rootId : RecipeLists.newId()),
      })
    );
    if (!after || !after.items.some((i) => i.id === rootId)) {
      toast(`“${list.name}” is full — clear some of it first.`);
      return false;
    }
    toast(`Added “${recipe.name}” to ${list.name}.`, {
      label: "Undo",
      run: () => {
        listStore.change(list.id, (l) => RecipeLists.deleteItems(l, RecipeLists.subtree(l, rootId)));
        listsChanged([list.id]);
      },
    });
    listsChanged([list.id]);
    return true;
  }

  /** What a card offers in plan mode: a way on, and the portions it adds at. */
  function planCardRow(recipe) {
    if (!planMode || !canPlan()) return "";
    const id = escapeHTML(recipe.id);
    const name = escapeHTML(recipe.name);
    const target = firstChecklist();
    const where = escapeHTML(target ? target.name : "a list");
    return `
        <div class="plan-card-row">
          <button type="button" class="btn btn-ghost plan-add" data-plan="add" data-id="${id}"
                  aria-label="Add ${name} to ${where}">+ Add</button>
          <span class="plan-portions" role="group" aria-label="Portions of ${name}">
            <button type="button" class="scale-btn" data-plan="down" data-id="${id}"
                    aria-label="Fewer portions of ${name}">−</button>
            <span class="scale-value">${escapeHTML(portionsLabel(recipe, portionsFor(recipe)))}</span>
            <button type="button" class="scale-btn" data-plan="up" data-id="${id}"
                    aria-label="More portions of ${name}">+</button>
          </span>
        </div>`;
  }

  function cardPlanAction(action, recipeId) {
    if (!canPlan()) return;
    const recipe = store.getById(recipeId);
    if (!recipe) return;
    if (action === "add") {
      addRecipeToList(recipe, portionsFor(recipe));
      delete pendingPortions[recipeId];
    } else {
      stepPending(recipe, action);
    }
    render();
  }

  /** The header toggle and the bar over the list. Called from render(). */
  function syncPlanUI() {
    const available = canPlan();
    const planBtn = $("#plan-btn");
    if (planBtn) {
      planBtn.hidden = !available;
      planBtn.setAttribute("aria-pressed", String(planMode));
      planBtn.classList.toggle("is-on", planMode);
    }
    // Lists are read by everyone in the book (J18.4), so the way in is
    // there for a viewer too.
    const listsBtn = $("#lists-btn");
    if (listsBtn) listsBtn.hidden = !listStore;
    const bar = $("#plan-bar");
    if (bar) bar.hidden = !(available && planMode);
    const barText = $("#plan-bar-text");
    if (barText && available && planMode) {
      const target = firstChecklist();
      barText.textContent = target
        ? `Adding to ${target.name} — choose the portions on a card, then + Add.`
        : "No checklist to add to yet — make one in Lists.";
      const open = $("#plan-open-btn");
      if (open) open.textContent = target ? `Open ${target.name}` : "Open lists";
    }
    const detailBtn = $("#detail-plan-btn");
    if (detailBtn) detailBtn.hidden = !(available && planMode);
  }

  /**
   * --- Lists (J18) -----------------------------------------------------
   *
   * The model is lists.js and the cache liststore.js; sync.js merges and
   * polls. Everything here is the screen, and the screen is for a phone
   * held in one hand: an item is its words and nothing else but its tick
   * box or its counter (J18.5), the words are the editor (J18.6), and
   * every change is a tap, a swipe or a hold rather than a button.
   */

  /** Which "Ticked (n)" groups are open, per list. Not kept (J18.12). */
  const tickedOpen = new Map();
  const openSet = (id) => {
    if (!tickedOpen.has(id)) tickedOpen.set(id, new Set());
    return tickedOpen.get(id);
  };

  let openListId = null;
  /**
   * The item being typed in, and what it said when the caret arrived —
   * what Escape puts back and what decides whether leaving writes
   * anything (J18.6, J13.16). While it is set a pull does not redraw the
   * list; `listStale` remembers the redraw is owed.
   */
  let editingItem = null;
  let editingName = null;
  let listStale = false;
  // A redraw this screen makes itself, with the caret going straight back
  // in: the focusout it causes is not somebody leaving an item.
  let restructuring = false;

  const currentList = () => (listStore && openListId ? listStore.get(openListId) : null);

  function listMeta(list) {
    const live = RecipeLists.liveItems(list);
    if (list.kind === "stock") {
      return `Stock list · ${live.length ? `${live.length} ${live.length === 1 ? "item" : "items"}` : "empty"}`;
    }
    const left = live.filter((i) => !i.ticked).length;
    return `Checklist · ${live.length === 0 ? "empty" : left === 0 ? "all ticked" : `${left} left`}`;
  }

  function renderLists() {
    if (!listStore) return;
    const lists = listStore.lists;
    const index = lists.length
      ? `<ul class="lists-index">${lists
          .map(
            (l) => `
          <li><button type="button" class="lists-row" data-lists-open="${escapeHTML(l.id)}">
            <span class="lists-name">${escapeHTML(l.name)}</span>
            <span class="lists-meta">${escapeHTML(listMeta(l))}</span>
          </button></li>`
          )
          .join("")}</ul>`
      : `<p class="plan-empty">No lists in this book yet.</p>`;
    // A list is made with its kind, and the kind is for good (J18.2).
    const make = canEditBook
      ? `
        <form class="lists-new" data-lists-new autocomplete="off">
          <h3>New list</h3>
          <input type="text" name="name" class="plan-add-input" maxlength="${RecipeLists.limits.MAX_NAME_CHARS}"
                 placeholder="Name — e.g. Freezer" aria-label="Name of the new list" enterkeyhint="done">
          <div class="lists-kind" role="radiogroup" aria-label="Kind of list">
            <label class="lists-kind-opt"><input type="radio" name="kind" value="checklist" checked>
              <span><strong>Checklist</strong> — tick things off</span></label>
            <label class="lists-kind-opt"><input type="radio" name="kind" value="stock">
              <span><strong>Stock list</strong> — count what you have</span></label>
          </div>
          <p class="lists-hint">The kind can't be changed afterwards.</p>
          <button type="submit" class="btn btn-primary lists-make">Make the list</button>
        </form>`
      : "";
    listsContent.innerHTML = index + make;
  }

  function openListsView({ restoring = false } = {}) {
    if (!listStore) return false;
    renderLists();
    if (!listsView.open) {
      if (!restoring) pushRoute("#lists");
      showView(listsView);
      renderCrumbs();
      const heading = $("#lists-heading");
      if (heading && heading.focus) heading.focus();
      catchUpLists();
    }
    return true;
  }

  function openList(id, { restoring = false } = {}) {
    if (!listStore || !listStore.get(id)) return false;
    const wasOpen = listView.open && openListId === id;
    openListId = id;
    editingItem = null;
    editingName = null;
    renderList(true);
    if (!wasOpen) {
      if (!restoring) pushRoute(`#list/${id}`);
      showView(listView);
      renderCrumbs();
      const heading = $("#list-heading");
      if (heading && heading.focus) heading.focus();
      pullLists();
    }
    return true;
  }

  /** Back to the Lists screen from a list, however the list was reached. */
  function backToLists() {
    const cold = pushedDepth === 0;
    closeView(listView);
    // Opened from its address, there is no Lists entry underneath to go
    // back to, so the screen is opened rather than returned to.
    if (cold) openListsView();
  }

  function itemRowHTML(list, row, editable) {
    const item = row.item;
    const id = escapeHTML(item.id);
    const text = escapeHTML(item.text);
    const said = text || "this item";
    const checklist = list.kind === "checklist";
    const cls = ["li-row"];
    if (checklist && item.ticked) cls.push("li-ticked");
    if (row.faded) cls.push("li-faded");
    if (row.hasChildren) cls.push("li-parent");
    const tick = checklist
      ? `<button type="button" class="li-tick" data-li="tick" data-id="${id}" aria-pressed="${item.ticked}"
                 aria-label="${item.ticked ? "Untick" : "Tick"} ${said}"${editable ? "" : " disabled"}><span
                 aria-hidden="true">${item.ticked ? "✓" : ""}</span></button>`
      : "";
    // The words are the editor (J18.6): plain text only, one line.
    const words = editable
      ? `<span class="li-text" id="li-${id}" contenteditable="plaintext-only" role="textbox"
               aria-label="Item" spellcheck="true" enterkeyhint="next" data-li-text="${id}">${text}</span>`
      : `<span class="li-text">${text}</span>`;
    let counter = "";
    if (row.counter !== null) {
      counter = editable
        ? `<span class="li-count" role="group" aria-label="How many ${said}">
            <button type="button" class="li-step" data-li="down" data-id="${id}"
                    aria-label="One fewer ${said}"${row.counter === 0 ? " disabled" : ""}>−</button>
            <span class="li-n">${row.counter}</span>
            <button type="button" class="li-step" data-li="up" data-id="${id}"
                    aria-label="One more ${said}">+</button>
          </span>`
        : `<span class="li-count"><span class="li-n">${row.counter}</span></span>`;
    }
    return `
        <li class="${cls.join(" ")}" data-li-row="${id}" data-depth="${Math.min(row.depth, 8)}"
            data-level="${row.depth}">${tick}${words}${counter}</li>`;
  }

  function foldRowHTML(row) {
    return `
        <li class="li-fold" data-depth="${Math.min(row.depth, 8)}"><button type="button" class="li-fold-btn"
            data-li="fold" data-parent="${escapeHTML(row.parentId || "")}" aria-expanded="${row.open}"
            >Ticked (${row.count})</button></li>`;
  }

  /**
   * Draw the open list. Not under an item being typed in, unless `force`:
   * a pull landing mid-word would take the words and the caret with it
   * (J18.24), so it waits until the item is left.
   */
  function renderList(force = false) {
    if (!listStore || !openListId) return;
    if (!force && editingItem && listView.open) {
      listStale = true;
      return;
    }
    listStale = false;
    if (force) editingItem = null;
    const list = currentList();
    if (!list) return;
    const editable = canEditBook;
    const heading = $("#list-heading");
    if (heading && !editingName) {
      heading.innerHTML = editable
        ? `<span class="li-name" contenteditable="plaintext-only" role="textbox" aria-label="List name"
                 spellcheck="true" enterkeyhint="done" data-li-name>${escapeHTML(list.name)}</span>`
        : escapeHTML(list.name);
    }
    const rows = RecipeLists.rows(list, openSet(list.id));
    const body = rows.map((r) => (r.type === "ticked" ? foldRowHTML(r) : itemRowHTML(list, r, editable))).join("");
    const add = editable
      ? `<button type="button" class="li-add" data-li="add"><span aria-hidden="true">+</span> Add an item</button>`
      : "";
    listContent.innerHTML =
      (rows.length
        ? `<ul class="li-rows li-${list.kind}">${body}</ul>`
        : `<p class="plan-empty">Nothing on this list yet.</p>`) + add;
    const clear = $("#list-clear-btn");
    if (clear) clear.hidden = !(editable && list.kind === "checklist" && RecipeLists.tickedIds(list).length > 0);
    const del = $("#list-delete-btn");
    if (del) del.hidden = !editable;
  }

  /** A pull, an Undo or an add from plan mode changed these lists. */
  function listsChanged(ids = []) {
    if (listView.open && openListId) {
      if (!listStore.get(openListId)) {
        // Deleted on another phone while it was open here.
        editingItem = null;
        backToLists();
        toast("That list was deleted.");
      } else if (ids.includes(openListId)) {
        renderList();
        renderCrumbs();
      }
    }
    if (listsView.open) renderLists();
    syncPlanUI();
  }

  // --- Polling: "within seconds" with no realtime service (J18.24) ----

  const LIST_POLL_MS = 5000;
  let listPollTimer = null;

  const listsOnScreen = () => Boolean(listStore) && (listsView.open || listView.open);
  const pageVisible = () => document.visibilityState !== "hidden";

  /** Ask the server for the open list — or every list, on the Lists screen. */
  function pullLists() {
    const cloud = window.RecipeCloud;
    const sync = cloud && cloud.sync;
    if (!sync || typeof sync.pullLists !== "function" || !listsOnScreen() || !pageVisible()) return null;
    return sync.pullLists(listView.open ? openListId : null);
  }

  /**
   * On the Lists screen: a full sync for a book whose plan has not yet
   * moved into Shopping (build step 1) — only syncNow does that, after
   * the plan itself has synced — and a pull otherwise.
   */
  function catchUpLists() {
    const cloud = window.RecipeCloud;
    const sync = cloud && cloud.sync;
    if (listStore && !listStore.seeded && sync && typeof sync.syncNow === "function") {
      return sync.syncNow();
    }
    return pullLists();
  }

  /** Poll while a list is on screen and the tab can be seen, and only then. */
  function syncListPolling() {
    const want = listsOnScreen() && pageVisible() && typeof window.setInterval === "function";
    if (want && !listPollTimer) listPollTimer = window.setInterval(pullLists, LIST_POLL_MS);
    if (!want && listPollTimer) {
      window.clearInterval(listPollTimer);
      listPollTimer = null;
    }
  }

  document.addEventListener("visibilitychange", () => {
    syncListPolling();
    if (pageVisible()) pullLists();
  });
  window.addEventListener("focus", () => pullLists());

  // --- Editing an item in place (J18.6, J18.7, J18.10) -----------------

  let listRedrawOwed = false;
  /** Redraw a moment from now: see `redrawSoon` for why not now. */
  function listRedrawSoon() {
    listRedrawOwed = true;
    window.setTimeout(listRedrawNow, 350);
  }
  function listRedrawNow() {
    if (!listRedrawOwed) return;
    listRedrawOwed = false;
    renderList();
  }

  /** Redraw after a change made from the keyboard, and put the caret back. */
  function redrawAndFocus(id) {
    restructuring = true;
    try {
      renderList(true);
    } finally {
      restructuring = false;
    }
    if (id) focusItem(id);
  }

  function focusItem(id) {
    const el = document.getElementById(`li-${id}`);
    if (!el || !el.focus) return;
    el.focus();
    // The caret at the end, where Backspace from the item below means it.
    const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (!sel || typeof document.createRange !== "function") return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /** Take items off, saying so with an Undo (J18.10). */
  function deleteWithUndo(ids, label) {
    const listId = openListId;
    listStore.change(listId, (l) => RecipeLists.deleteItems(l, ids));
    toast(label, {
      label: "Undo",
      run: () => {
        listStore.change(listId, (l) => RecipeLists.restoreItems(l, ids));
        listsChanged([listId]);
      },
    });
  }

  function deletedLabel(item, count) {
    const what = item.text ? `“${item.text}”` : "an item";
    return count > 1 ? `Deleted ${what} and ${count - 1} under it.` : `Deleted ${what}.`;
  }

  /**
   * Save what an item says. `leaving`: the caret has gone, so an empty
   * item is deleted — silently if it never said anything and held
   * nothing (a line Enter made and nobody used), with an Undo otherwise.
   * An item left as it was writes nothing (J13.16).
   */
  function commitText(el, leaving = false) {
    const id = el.dataset.liText;
    const began = editingItem && editingItem.id === id ? editingItem : null;
    const list = currentList();
    const item = list && RecipeLists.liveItems(list).find((i) => i.id === id);
    if (!item || !canEditBook) return "missing";
    const typed = lineWords(el);
    const words = RecipeLists.cleanText(typed);
    if (!words) {
      if (!leaving) return "empty";
      const ids = RecipeLists.subtree(list, id);
      if (!item.text && ids.length === 1) listStore.change(openListId, (l) => RecipeLists.deleteItems(l, ids));
      else deleteWithUndo(ids, deletedLabel(item, ids.length));
      return "deleted";
    }
    const before = began ? RecipeLists.cleanText(began.before) : item.text;
    if (words === before) return "same";
    listStore.change(openListId, (l) => RecipeLists.editText(l, id, words));
    if (began) began.before = words;
    if (el.textContent !== words) el.textContent = words;
    const max = RecipeLists.limits.MAX_TEXT_CHARS;
    if (typed.length > max) toast(`An item is ${max} characters at most — the end was left off.`);
    return "saved";
  }

  /** Enter: the next item, directly below at the same depth (J18.7). */
  function enterAt(el) {
    if (!lineWords(el)) {
      // Enter on an empty item is the end of typing: it goes, quietly.
      el.blur();
      return;
    }
    const id = el.dataset.liText;
    commitText(el);
    const newId = RecipeLists.newId();
    const after = listStore.change(openListId, (l) => RecipeLists.addItem(l, { afterId: id, id: newId }));
    if (!after || !after.items.some((i) => i.id === newId)) {
      toast(`This list is full — it holds ${RecipeLists.limits.MAX_LIVE} items.`);
      return;
    }
    redrawAndFocus(newId);
  }

  /** Backspace in an empty item: it goes, and the caret goes up (J18.10). */
  function backspaceAt(el) {
    const id = el.dataset.liText;
    const list = currentList();
    if (!list) return;
    const item = RecipeLists.liveItems(list).find((i) => i.id === id);
    if (!item) return;
    const items = RecipeLists.rows(list, openSet(list.id)).filter((r) => r.type === "item");
    const at = items.findIndex((r) => r.id === id);
    const above = at > 0 ? items[at - 1].id : null;
    const ids = RecipeLists.subtree(list, id);
    if (!item.text && ids.length === 1) listStore.change(openListId, (l) => RecipeLists.deleteItems(l, ids));
    else deleteWithUndo(ids, deletedLabel(item, ids.length));
    redrawAndFocus(above);
  }

  /** Nest or un-nest an item (J18.8), keeping the caret if it had it. */
  function nest(id, direction) {
    if (!canEditBook || !currentList()) return;
    const el = document.getElementById(`li-${id}`);
    const typing = Boolean(editingItem && editingItem.id === id);
    if (typing && el) commitText(el);
    const before = currentList();
    const after = listStore.change(openListId, (l) =>
      direction === "in" ? RecipeLists.indent(l, id) : RecipeLists.outdent(l, id)
    );
    if (after === before) return;
    if (typing) redrawAndFocus(id);
    else renderList(true);
  }

  function listAction(action, data) {
    const list = currentList();
    if (!list) return;
    if (action === "fold") {
      const set = openSet(list.id);
      const key = data.parent || "";
      if (set.has(key)) set.delete(key);
      else set.add(key);
      renderList();
      return;
    }
    if (!canEditBook) return;
    if (action === "tick") {
      const item = RecipeLists.liveItems(list).find((i) => i.id === data.id);
      if (!item) return;
      listStore.change(list.id, (l) => RecipeLists.setTicked(l, data.id, !item.ticked));
      renderList();
    } else if (action === "up" || action === "down") {
      listStore.change(list.id, (l) => RecipeLists.bump(l, data.id, action === "up" ? 1 : -1, listStore.deviceId));
      renderList();
    } else if (action === "add") {
      const newId = RecipeLists.newId();
      const after = listStore.change(list.id, (l) => RecipeLists.addItem(l, { id: newId }));
      if (!after || !after.items.some((i) => i.id === newId)) {
        toast(`This list is full — it holds ${RecipeLists.limits.MAX_LIVE} items.`);
        return;
      }
      redrawAndFocus(newId);
    }
  }

  /**
   * The words of an item being edited, as one line. innerText where there
   * is one: a line break that got in is a <br> there, which textContent
   * reads as nothing and runs two words together.
   */
  const lineWords = (el) =>
    String((el && (el.innerText !== undefined ? el.innerText : el.textContent)) || "")
      .replace(/\s+/g, " ")
      .trim();

  const itemTarget = (event) =>
    event.target && event.target.closest ? event.target.closest("[data-li-text]") : null;

  listsContent.addEventListener("click", (event) => {
    const row = event.target.closest ? event.target.closest("[data-lists-open]") : null;
    if (row) openList(row.dataset.listsOpen);
  });

  listsContent.addEventListener("submit", (event) => {
    const form = event.target.closest ? event.target.closest("[data-lists-new]") : null;
    if (!form) return;
    event.preventDefault();
    if (!canEditBook) return;
    const nameEl = form.elements && form.elements.name;
    const name = RecipeLists.cleanText(nameEl ? nameEl.value : "", RecipeLists.limits.MAX_NAME_CHARS);
    if (!name) {
      toast("Give the list a name first.");
      if (nameEl && nameEl.focus) nameEl.focus();
      return;
    }
    const kindEl = form.elements && form.elements.kind;
    const kind = kindEl && kindEl.value === "stock" ? "stock" : "checklist";
    const made = listStore.create(name, kind);
    if (!made) {
      toast("This book has as many lists as it can hold.");
      return;
    }
    openList(made.id);
  });

  listContent.addEventListener("click", (event) => {
    if (suppressClick) {
      suppressClick = false;
      return undefined;
    }
    const btn = event.target.closest ? event.target.closest("[data-li]") : null;
    if (!btn || !btn.dataset.li) {
      listRedrawNow();
      return undefined;
    }
    const done = listAction(btn.dataset.li, btn.dataset);
    listRedrawNow();
    return done;
  });

  listContent.addEventListener("focusin", (event) => {
    const el = itemTarget(event);
    if (!el || !canEditBook) return;
    editingItem = { id: el.dataset.liText, before: el.textContent };
  });

  listContent.addEventListener("focusout", (event) => {
    const el = itemTarget(event);
    if (!el || restructuring) return;
    const result = commitText(el, true);
    editingItem = null;
    if (result === "deleted" || result === "missing" || listStale) listRedrawSoon();
  });

  listContent.addEventListener("keydown", (event) => {
    const el = itemTarget(event);
    if (!el || event.isComposing || !canEditBook) return;
    const id = el.dataset.liText;
    if (event.key === "Enter") {
      event.preventDefault();
      enterAt(el);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (editingItem && editingItem.id === id) el.textContent = editingItem.before;
      el.blur();
    } else if (event.key === "Tab") {
      // Tab and Shift-Tab nest, as a swipe does (J18.8).
      event.preventDefault();
      nest(id, event.shiftKey ? "out" : "in");
    } else if (event.key === "Backspace" && !lineWords(el)) {
      event.preventDefault();
      backspaceAt(el);
    }
  });

  // One line is one line (J18.6). A keyboard that sends Enter as input
  // rather than as a key still means Enter.
  listContent.addEventListener("beforeinput", (event) => {
    const el = itemTarget(event);
    if (!el) return;
    if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
      event.preventDefault();
      enterAt(el);
    }
  });

  listContent.addEventListener("paste", (event) => {
    if (!itemTarget(event) || !event.clipboardData) return;
    event.preventDefault();
    const text = String(event.clipboardData.getData("text/plain") || "").replace(/\s+/g, " ");
    if (document.execCommand) document.execCommand("insertText", false, text);
  });

  // --- Swipe to nest, hold to drag (J18.8, J18.9) ----------------------

  const SWIPE_PX = 56; // far enough that a wobbly tap is not a swipe
  const SLOP_PX = 10;
  const HOLD_MS = 450;
  const STEP_PX = 32; // a level of depth, carried sideways while dragging
  let gesture = null;
  let suppressClick = false;

  function endGesture() {
    const g = gesture;
    gesture = null;
    if (!g) return;
    window.clearTimeout(g.timer);
    if (g.row && g.row.style) g.row.style.transform = "";
    if (g.row) {
      g.row.classList.remove("li-swiping");
      g.row.classList.remove("li-dragging");
    }
  }

  listContent.addEventListener("pointerdown", (event) => {
    if (!canEditBook || gesture || (event.button !== undefined && event.button !== 0)) return;
    const row = event.target && event.target.closest ? event.target.closest("[data-li-row]") : null;
    if (!row || event.target.closest("button")) return;
    const id = row.dataset.liRow;
    // In the item being typed in, a hold is the browser's — selecting
    // words — and only a swipe is ours.
    const typing = Boolean(editingItem && editingItem.id === id);
    gesture = { id, row, x0: event.clientX, y0: event.clientY, dx: 0, mode: "pending", typing, pointerId: event.pointerId };
    if (!typing) gesture.timer = window.setTimeout(startDrag, HOLD_MS);
  });

  listContent.addEventListener("pointermove", (event) => {
    const g = gesture;
    if (!g || event.pointerId !== g.pointerId) return;
    const dx = event.clientX - g.x0;
    const dy = event.clientY - g.y0;
    g.dx = dx;
    if (g.mode === "pending") {
      if (Math.abs(dx) > SLOP_PX && Math.abs(dx) > 2 * Math.abs(dy)) {
        g.mode = "swipe";
        window.clearTimeout(g.timer);
        g.row.classList.add("li-swiping");
      } else if (Math.abs(dx) > SLOP_PX || Math.abs(dy) > SLOP_PX) {
        endGesture(); // a scroll, which is the browser's
        return;
      }
    }
    if (g.mode === "swipe") {
      g.row.style.transform = `translateX(${Math.max(-72, Math.min(72, dx))}px)`;
    } else if (g.mode === "drag") {
      if (event.preventDefault) event.preventDefault();
      dragMove(event.clientY, dx);
    }
  });

  function finishGesture(event) {
    const g = gesture;
    if (!g || (event && event.pointerId !== g.pointerId)) return;
    if (g.mode === "swipe") {
      suppressClick = true;
      endGesture();
      if (g.dx >= SWIPE_PX) nest(g.id, "in");
      else if (g.dx <= -SWIPE_PX) nest(g.id, "out");
      return;
    }
    if (g.mode === "drag") {
      endGesture();
      finishDrag(g);
      return;
    }
    endGesture();
  }

  listContent.addEventListener("pointerup", finishGesture);
  listContent.addEventListener("pointercancel", (event) => {
    const g = gesture;
    if (!g || event.pointerId !== g.pointerId) return;
    endGesture();
    if (g.mode === "drag") renderList(true);
  });

  // While a finger is swiping or dragging, the page must not scroll under
  // it, and a hold must not become the browser's text selection.
  listContent.addEventListener(
    "touchmove",
    (event) => {
      if (gesture && (gesture.mode === "drag" || gesture.mode === "swipe")) event.preventDefault();
    },
    { passive: false }
  );
  for (const type of ["contextmenu", "selectstart"]) {
    listContent.addEventListener(type, (event) => {
      if (gesture && !gesture.typing) event.preventDefault();
    });
  }

  /** The hold has lasted: the item lifts and follows the finger (J18.9). */
  function startDrag() {
    const g = gesture;
    if (!g || g.mode !== "pending") return;
    const list = currentList();
    if (!list) return;
    g.mode = "drag";
    g.carried = new Set(RecipeLists.subtree(list, g.id));
    g.depth0 = Number(g.row.dataset.level) || 0;
    g.drop = null;
    g.row.classList.add("li-dragging");
    // What is nested under it moves with it, out of the way while it does.
    for (const r of listContent.querySelectorAll("[data-li-row]")) {
      if (r !== g.row && g.carried.has(r.dataset.liRow)) r.classList.add("li-carried");
    }
    const active = document.activeElement;
    if (active && active.blur && listContent.contains(active)) active.blur();
    const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
    if (sel) sel.removeAllRanges();
    if (listContent.setPointerCapture && g.pointerId !== undefined) {
      try {
        listContent.setPointerCapture(g.pointerId);
      } catch {
        /* a pointer that has already gone */
      }
    }
    if (navigator.vibrate) navigator.vibrate(12);
    suppressClick = true;
    dragMove(g.y0, 0);
  }

  const shown = (r) => !r.classList.contains("li-carried");

  /** Move the lifted row to where the finger is, at the depth it is carried to. */
  function dragMove(y, dx) {
    const g = gesture;
    const ul = g.row.parentNode;
    if (!ul) return;
    const others = [...ul.children].filter((r) => r !== g.row && shown(r));
    let before = null;
    for (const r of others) {
      const box = r.getBoundingClientRect();
      if (y < box.top + box.height / 2) {
        before = r;
        break;
      }
    }
    if (before) {
      if (g.row.nextElementSibling !== before) ul.insertBefore(g.row, before);
    } else if (ul.lastElementChild !== g.row) {
      ul.appendChild(g.row);
    }
    // The item rows either side of where it now sits.
    const near = (step) => {
      let r = step(g.row);
      while (r && (!r.dataset.liRow || !shown(r))) r = step(r);
      return r;
    };
    const prev = near((r) => r.previousElementSibling);
    const next = near((r) => r.nextElementSibling);
    const level = (r) => (r ? { depth: Number(r.dataset.level) || 0 } : null);
    const { min, max } = RecipeListDrop.depthRange(level(prev), level(next));
    const depth = Math.max(min, Math.min(max, g.depth0 + Math.round(dx / STEP_PX)));
    g.row.dataset.depth = String(Math.min(depth, 8));
    g.drop = { prevId: prev ? prev.dataset.liRow : null, depth };
    // Near an edge, the page comes to meet the finger.
    const h = window.innerHeight || 0;
    if (typeof window.scrollBy === "function" && h) {
      if (y < 64) window.scrollBy(0, -14);
      else if (y > h - 64) window.scrollBy(0, 14);
    }
  }

  function finishDrag(g) {
    dropItem(g.id, g.drop ? g.drop.prevId : undefined, g.drop ? g.drop.depth : g.depth0);
  }

  /**
   * Put an item after the row `prevId` (null: the top), at `depth`. The
   * one place a drag turns into a change to the list.
   */
  function dropItem(id, prevId, depth) {
    const list = currentList();
    if (!list || !canEditBook || prevId === undefined) {
      renderList(true);
      return;
    }
    const carried = new Set(RecipeLists.subtree(list, id));
    const rows = RecipeLists.rows(list, openSet(list.id)).filter((r) => r.type === "item" && !carried.has(r.id));
    const prevIndex = prevId ? rows.findIndex((r) => r.id === prevId) : -1;
    const spot = RecipeListDrop.place(rows, prevIndex, depth);
    listStore.change(list.id, (l) => RecipeLists.move(l, id, spot));
    renderList(true);
  }

  // --- The list's name, Clear ticked, Delete (J18.3, J18.13) ----------

  const nameTarget = (event) =>
    event.target && event.target.closest ? event.target.closest("[data-li-name]") : null;

  $("#list-heading").addEventListener("focusin", (event) => {
    const el = nameTarget(event);
    if (el && canEditBook) editingName = { before: el.textContent };
  });

  $("#list-heading").addEventListener("keydown", (event) => {
    const el = nameTarget(event);
    if (!el || event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      el.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (editingName) el.textContent = editingName.before;
      el.blur();
    }
  });

  $("#list-heading").addEventListener("focusout", (event) => {
    const el = nameTarget(event);
    if (!el) return;
    const began = editingName;
    editingName = null;
    const list = currentList();
    if (!list || !canEditBook) return;
    const words = RecipeLists.cleanText(lineWords(el), RecipeLists.limits.MAX_NAME_CHARS);
    // A list always has a name: emptied, it keeps the one it had.
    if (!words || (began && words === RecipeLists.cleanText(began.before))) {
      el.textContent = list.name;
      return;
    }
    const renamed = listStore.rename(list.id, words);
    if (renamed) el.textContent = renamed.name;
    renderCrumbs();
  });

  $("#list-clear-btn").addEventListener("click", () => {
    const list = currentList();
    if (!list || !canEditBook) return;
    const ids = RecipeLists.tickedIds(list);
    if (!ids.length) return;
    // What Clear takes is lists.js's to say (J18.13); the count is of that.
    deleteWithUndo(ids, `Cleared ${ids.length} ticked ${ids.length === 1 ? "item" : "items"}.`);
    renderList(true);
  });

  $("#list-delete-btn").addEventListener("click", async () => {
    const list = currentList();
    if (!list || !canEditBook) return;
    const count = RecipeLists.liveItems(list).length;
    const ok = await RecipeAsk.ask(
      `Delete “${list.name}”?${count ? ` Everything on it goes too — ${count} ${count === 1 ? "item" : "items"}.` : ""}`,
      { confirmLabel: "Delete", danger: true }
    );
    if (!ok || !listStore.get(list.id)) return;
    listStore.remove(list.id);
    editingItem = null;
    backToLists();
    toast(`Deleted “${list.name}”.`);
  });

  onViewClose(listsView, () => unwind(currentRoute().name === "lists"));
  onViewClose(listView, () => {
    editingItem = null;
    editingName = null;
    unwind(currentRoute().name === "openlist");
  });

  // --- Wiring ----------------------------------------------------------

  $("#lists-btn").addEventListener("click", () => openListsView());

  $("#plan-btn").addEventListener("click", () => {
    if (!canPlan()) return;
    planMode = !planMode;
    if (!planMode) forgetPendingPortions();
    render();
  });

  // Over the Lists screen, so Back from the list goes where it always does.
  $("#plan-open-btn").addEventListener("click", () => {
    const target = firstChecklist();
    openListsView();
    if (target) openList(target.id);
  });

  $("#detail-plan-btn").addEventListener("click", () => {
    const recipe = detailId && store.getById(detailId);
    if (!recipe || !canPlan()) return;
    // At the portions on screen: the recipe view's own stepper (J18.18).
    const portions = Number(recipe.servings) > 0 ? Math.round(recipe.servings * detailScale * 10) / 10 : detailScale;
    addRecipeToList(recipe, portions);
    render();
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

    // Home from a list is two steps back, and this is the first landing
    // (see climbTo).
    if (climbingHome) {
      climbingHome = false;
      if (route.name === "lists" && pushedDepth > 0) {
        history.back();
        return;
      }
    }

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
    leaveLists();
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
  for (const dialog of [detailView, prefsDialog, aiHelpDialog, pasteDialog]) {
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
  // planStore and listStore go out with it: account.js adopts these rather
  // than making second ones, so the screen and the sync layer read one copy.
  window.RecipeApp = {
    store, planStore, listStore, render, toast, showPendingShare, openFromHash, setCanEdit,
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
