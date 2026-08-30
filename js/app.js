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
  // Least recently planned first, never-planned before them (J14.9). A
  // chip beside Favourites, and like Favourites it is not persisted: it
  // is a way of looking at the list, not a property of the book.
  let notPlannedLately = false;
  let activeTag = null;
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
  const notPlannedBtn = $("#not-planned-filter");
  const tagFiltersEl = $("#tag-filters");
  const recipeDialog = $("#recipe-dialog");
  const recipeForm = $("#recipe-form");
  const dialogTitle = $("#dialog-title");
  const detailDialog = $("#detail-dialog");
  const detailContent = $("#detail-content");
  const planDialog = $("#plan-dialog");
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
   * Hold the page still behind a full-screen recipe (J4.22).
   *
   * A modal <dialog> makes the page inert, not unscrollable: reaching the
   * end of a long method and carrying on scrolls the recipe list behind
   * it, so closing the recipe leaves you somewhere you never chose to be.
   * `overscroll-behavior: contain` on the dialog stops the chaining where
   * it is honoured; this stops the page moving at all.
   */
  function syncScrollLock() {
    const open = detailDialog.open || recipeDialog.open || planDialog.open;
    document.body.classList.toggle("dialog-open", open);
    // The scrolling element is <html>, not <body>, so a rule on the body
    // alone leaves the page free to move — measured, after trying exactly
    // that. The guard is for the stub DOM, which has a body and no root.
    const root = document.documentElement;
    if (root && root.classList) root.classList.toggle("dialog-open", open);
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
      tag: activeTag,
      favoritesOnly,
      // The chip and what it needs to answer: which recipes were planned
      // when (J14.9). The index goes with it rather than being fetched
      // inside search.js, which knows about recipes and not about where
      // a book keeps its plans.
      notPlannedLately,
      plannedIndex: notPlannedLately ? planningIndex() : null,
      prefs: store.prefs,
    };
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
  function renderTagFilters() {
    const tags = store.allTags();
    if (activeTag && !tags.includes(activeTag)) activeTag = null;
    tagFiltersEl.innerHTML = tags
      .map(
        (tag) => `
        <button class="chip ${tag === activeTag ? "chip-active" : ""}"
                data-tag="${escapeHTML(tag)}"
                aria-pressed="${tag === activeTag}">${escapeHTML(tag)}</button>`
      )
      .join("");
  }

  function recipeCard(recipe, index) {
    const time = totalTime(recipe);
    const count = recipe.ingredients.length;
    const meta = [
      recipe.servings ? `Serves ${recipe.servings}` : null,
      time,
      `${count} ${count === 1 ? "ingredient" : "ingredients"}`,
    ]
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
    const visible = RecipeSearch.visibleRecipes(store.recipes, criteria());
    listEl.innerHTML = visible.map((r, i) => recipeCard(r, i)).join("");

    const hasAny = store.recipes.length > 0;
    emptyStateEl.hidden = hasAny;
    listEl.hidden = !hasAny;

    if (hasAny && visible.length === 0) {
      listEl.hidden = false;
      listEl.innerHTML = `<p class="no-results">No recipes match your search.</p>`;
    }

    announceCount(hasAny ? visible.length : null);
    favoritesBtn.classList.toggle("chip-active", favoritesOnly);
    favoritesBtn.setAttribute("aria-pressed", String(favoritesOnly));
    if (notPlannedBtn) {
      // Offered wherever there is a plan to have a history: a book you
      // may only read has one too, it is only adding to it that is a
      // write (J12.10).
      notPlannedBtn.hidden = !planStore;
      notPlannedBtn.classList.toggle("chip-active", notPlannedLately);
      notPlannedBtn.setAttribute("aria-pressed", String(notPlannedLately));
    }
    renderTagFilters();
    syncPlanUI();
    // The plan is read from the same store, so a redraw it did not cause
    // — a sync landing somebody else's meal — still reaches it.
    if (planDialog.open) renderPlan();
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
          ? "No recipes match your search."
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
  function openRecipeDialog(recipe, review, { restoring = false } = {}) {
    editingId = recipe && !review ? recipe.id : null;
    incomingId = review && recipe ? recipe.id : null;
    dialogTitle.textContent = review ? "Review recipe" : recipe ? "Edit recipe" : "New recipe";
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
    const wasOpen = recipeDialog.open;
    recipeDialog.showModal();
    if (!wasOpen && !restoring) pushRoute(editorHash());
    syncScrollLock();
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
    if (quiet) closeQuietly(recipeDialog);
    else recipeDialog.close();
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
          if (detailDialog.open && detailId) {
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
    recipeDialog.close();
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
    $("#detail-kicker").textContent = "From your recipe box";
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
      if (planDialog.open) planDialog.close();
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
  function openDetailDialog(recipe, { restoring = false } = {}) {
    const wasOpen = detailDialog.open;
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
      detailDialog.showModal();
      // showModal() takes the first focusable thing it finds, which is
      // whichever control happens to be first in the markup — the star,
      // today; the portions stepper before that. Neither says what has
      // just opened. The heading does (J4.22).
      const heading = $("#detail-heading");
      if (heading && heading.focus) heading.focus();
      syncScrollLock();
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

  function pushRoute(hash) {
    try {
      history.pushState({ hash }, "", hash);
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

  function closeQuietly(dialog) {
    suppressUnwind += 1;
    try {
      dialog.close();
    } finally {
      suppressUnwind -= 1;
    }
  }

  function unwind(mine) {
    if (suppressUnwind) return;
    if (!mine) return;
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
    if (planDialog.open) closeQuietly(planDialog);
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
      if (detailDialog.open && detailId === route.id) return true;
      const recipe = store.getById(route.id);
      if (!recipe) return false;
      if (recipeDialog.open) closeQuietly(recipeDialog);
      leavePlanReadout();
      openDetailDialog(recipe, { restoring: true });
      return true;
    }
    if (route.name === "edit") {
      if (recipeDialog.open && editingId === route.id) return true;
      const recipe = store.getById(route.id);
      if (!recipe) return false;
      if (detailDialog.open) closeQuietly(detailDialog);
      leavePlanReadout();
      openRecipeDialog(recipe, false, { restoring: true });
      return true;
    }
    if (route.name === "new") {
      if (recipeDialog.open) return true;
      if (detailDialog.open) closeQuietly(detailDialog);
      leavePlanReadout();
      openRecipeDialog(null, false, { restoring: true });
      return true;
    }
    if (route.name === "plan") {
      if (planDialog.open) return true;
      // A viewer has no planner to come back to (J12.10).
      if (!canPlan()) return false;
      if (detailDialog.open) closeQuietly(detailDialog);
      if (recipeDialog.open) closeQuietly(recipeDialog);
      openPlanDialog({ restoring: true });
      return true;
    }
    // A review holds a recipe that is not in the box yet, so there is
    // nothing to rebuild it from once it has gone.
    if (route.name === "review") return recipeDialog.open;
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
  function openPlanDialog({ restoring = false } = {}) {
    if (!planStore) return false;
    const wasOpen = planDialog.open;
    renderPlan();
    if (!wasOpen) {
      if (!restoring) pushRoute("#plan");
      planDialog.showModal();
      // The heading, not the first control — which is a portions stepper
      // and does not say what has just filled the screen (J4.21).
      const heading = $("#plan-heading");
      if (heading && heading.focus) heading.focus();
      syncScrollLock();
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
    if (planDialog.open) planDialog.close();
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
    if (planDialog.open) planDialog.close();
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
    if (canPlan()) openPlanDialog();
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

  $("#plan-close-btn").addEventListener("click", () => planDialog.close());

  planDialog.addEventListener("close", () => {
    syncScrollLock();
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
  $("#add-recipe-btn").addEventListener("click", () => openRecipeDialog(null));
  $("#empty-add-btn").addEventListener("click", () => openRecipeDialog(null));
  $("#cancel-dialog-btn").addEventListener("click", () => recipeDialog.close());

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
    if (detailDialog.open && detailId) {
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

  if (notPlannedBtn) {
    notPlannedBtn.addEventListener("click", () => {
      notPlannedLately = !notPlannedLately;
      render();
    });
  }

  tagFiltersEl.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-tag]");
    if (!btn) return;
    activeTag = activeTag === btn.dataset.tag ? null : btn.dataset.tag;
    render();
  });

  listEl.addEventListener("click", (event) => {
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
      if (recipe) openDetailDialog(recipe);
    }
  });

  listEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest(".recipe-card");
    if (!card) return;
    event.preventDefault();
    const recipe = store.getById(card.dataset.id);
    if (recipe) openDetailDialog(recipe);
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
    openRecipeDialog(preview, true);
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
    detailDialog.close();
    cloud.books.openMove(detailId, verb);
  };
  $("#detail-copy-btn").addEventListener("click", openTransfer("copy"));
  $("#detail-move-btn").addEventListener("click", openTransfer("move"));

  $("#detail-close-btn").addEventListener("click", () => detailDialog.close());

  // Escape and the backdrop close a <dialog> without going through any
  // button, so the lock is let go here rather than at each call site (J4.10).
  //
  // Every one of those exits also has to unwind the history entry the open
  // pushed, or the entry outlives the recipe and Back re-opens something
  // the person has already closed. `poppingBack` marks the close that Back
  // itself caused — that entry is already gone.
  detailDialog.addEventListener("close", () => {
    // Before the history guard: the lock goes whichever way the recipe
    // closed, a handover to the editor included (J4.10).
    cookMode.leave();
    syncCookButton();
    syncScrollLock();
    unwind(currentRoute().name === "recipe");
  });

  recipeDialog.addEventListener("close", () => {
    syncScrollLock();
    unwind(isEditorRoute(currentRoute().name));
  });

  /**
   * Back, Forward, or a hash the app did not set: make the screen match
   * the address (J4.17, J2.11).
   */
  window.addEventListener("popstate", async () => {
    const route = currentRoute();

    // Leaving the editor by Back is still leaving the editor, so typed
    // work gets the question it gets from Escape (J2.9). "Keep editing"
    // puts the entry back, so Back still means Back next time.
    if (recipeDialog.open && !isEditorRoute(route.name)) {
      const hash = editorHash();
      if (!(await tryCloseEditor({ quiet: true }))) {
        pushRoute(hash);
        return;
      }
    }

    if (openFromHash()) return;

    if (detailDialog.open) closeQuietly(detailDialog);
    if (recipeDialog.open) closeQuietly(recipeDialog);
    if (planDialog.open) closeQuietly(planDialog);
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
    openDetailDialog(recipe); // re-render the open dialog with the new state
    render();
  });

  $("#detail-edit-btn").addEventListener("click", () => {
    const recipe = store.getById(detailId);
    if (!recipe) {
      detailDialog.close();
      return;
    }
    // A handover, not an exit: the recipe's entry stays underneath so
    // Back from the editor returns to the recipe you were reading.
    closeQuietly(detailDialog);
    openRecipeDialog(recipe);
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
    recipeDialog.close();
    toast("Recipe deleted.");
    render();
  });

  // Close dialogs when clicking the backdrop. These hold nothing that
  // isn't already saved, so they go without asking.
  for (const dialog of [detailDialog, planDialog, prefsDialog, aiHelpDialog, pasteDialog]) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  // The editor holds typed work, so both its accidental exits are guarded.
  recipeDialog.addEventListener("click", (event) => {
    if (event.target !== recipeDialog) return undefined;
    return tryCloseEditor(); // returned so a test can await the answer
  });
  recipeDialog.addEventListener("cancel", (event) => {
    event.preventDefault(); // Escape: decide for ourselves whether this closes
    return tryCloseEditor();
  });

  // --- Overflow menu ---
  // <details> doesn't close on outside clicks or after choosing an item.
  const moreMenu = $("#more-menu");
  if (moreMenu) {
    moreMenu.addEventListener("click", (event) => {
      if (event.target.closest(".more-item")) moreMenu.open = false;
    });
    document.addEventListener("click", (event) => {
      if (moreMenu.open && !moreMenu.contains(event.target)) moreMenu.open = false;
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && moreMenu.open) moreMenu.open = false;
    });
  }

  // Handle for the sync layer (account.js/sync.js): shared store plus a
  // way to redraw once remote changes land.
  // planStore goes out with it: account.js adopts this one rather than
  // making a second, so the screen and the sync layer read one plan.
  window.RecipeApp = { store, planStore, render, toast, showPendingShare, openFromHash, setCanEdit };

  render();
  handleIncomingShare();
  // Signed out, or before the book has synced, there is nothing to open
  // yet; account.js calls this again once there is.
  openFromHash();
  // A share link opened in an already-loaded tab only changes the fragment.
  window.addEventListener("hashchange", handleIncomingShare);
})();
