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
  let activeTag = null;
  let editingId = null; // recipe id being edited, or null when adding
  let incomingId = null; // id of a shared/pasted recipe being reviewed before saving
  let detailId = null; // recipe id shown in the detail dialog
  let pendingImage = ""; // data URI chosen via the file picker, pre-save
  let existingPhotoPath = ""; // photo already in Storage for the recipe being edited
  let formBaseline = ""; // the editor's contents as it opened, to spot unsaved work
  let detailScale = 1; // display-only scaling factor for the open detail view

  // --- Elements ---
  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#recipe-list");
  const emptyStateEl = $("#empty-state");
  const resultCountEl = $("#result-count");
  const searchInput = $("#search-input");
  const favoritesBtn = $("#favorites-filter");
  const tagFiltersEl = $("#tag-filters");
  const recipeDialog = $("#recipe-dialog");
  const recipeForm = $("#recipe-form");
  const dialogTitle = $("#dialog-title");
  const detailDialog = $("#detail-dialog");
  const detailContent = $("#detail-content");
  const toastEl = $("#toast");

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
    const open = detailDialog.open || recipeDialog.open;
    document.body.classList.toggle("dialog-open", open);
    // The scrolling element is <html>, not <body>, so a rule on the body
    // alone leaves the page free to move — measured, after trying exactly
    // that. The guard is for the stub DOM, which has a body and no root.
    const root = document.documentElement;
    if (root && root.classList) root.classList.toggle("dialog-open", open);
  }

  let toastTimer = null;
  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 2600);
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
      prefs: store.prefs,
    };
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
        <p class="card-meta">${escapeHTML(meta)}</p>
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
      </article>`;
  }

  function render() {
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
    renderTagFilters();
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
      ${metaBits.length ? `<p class="card-meta">${escapeHTML(metaBits.join(" · "))}</p>` : ""}
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
      openDetailDialog(recipe, { restoring: true });
      return true;
    }
    if (route.name === "edit") {
      if (recipeDialog.open && editingId === route.id) return true;
      const recipe = store.getById(route.id);
      if (!recipe) return false;
      if (detailDialog.open) closeQuietly(detailDialog);
      openRecipeDialog(recipe, false, { restoring: true });
      return true;
    }
    if (route.name === "new") {
      if (recipeDialog.open) return true;
      if (detailDialog.open) closeQuietly(detailDialog);
      openRecipeDialog(null, false, { restoring: true });
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

  tagFiltersEl.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-tag]");
    if (!btn) return;
    activeTag = activeTag === btn.dataset.tag ? null : btn.dataset.tag;
    render();
  });

  listEl.addEventListener("click", (event) => {
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
  for (const dialog of [detailDialog, prefsDialog, aiHelpDialog, pasteDialog]) {
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
  window.RecipeApp = { store, render, toast, showPendingShare, openFromHash, setCanEdit };

  render();
  handleIncomingShare();
  // Signed out, or before the book has synced, there is nothing to open
  // yet; account.js calls this again once there is.
  openFromHash();
  // A share link opened in an already-loaded tab only changes the fragment.
  window.addEventListener("hashchange", handleIncomingShare);
})();
