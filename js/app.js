/**
 * app.js — UI layer for Recipe Friend.
 * Renders the recipe grid, search/filter toolbar, and the add/edit and
 * detail dialogs. All persistence goes through RecipeStore (storage.js).
 */
(function () {
  "use strict";

  const store = new RecipeStore();

  // --- UI state (not persisted) ---
  let searchQuery = "";
  let favoritesOnly = false;
  let activeTag = null;
  let editingId = null; // recipe id being edited, or null when adding
  let incomingId = null; // id of a shared/pasted recipe being reviewed before saving
  let detailId = null; // recipe id shown in the detail dialog
  let pendingImage = ""; // data URI chosen via the file picker, pre-save
  let existingPhotoPath = ""; // photo already in Storage for the recipe being edited
  let pantryOn = false;
  let pantryTerms = []; // normalized "what can I cook?" ingredients
  let detailScale = 1; // display-only scaling factor for the open detail view

  // --- Elements ---
  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#recipe-list");
  const emptyStateEl = $("#empty-state");
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
  function escapeHTML(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
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

  function matchesFilters(recipe) {
    if (favoritesOnly && !recipe.favorite) return false;
    if (activeTag && !recipe.tags.includes(activeTag)) return false;
    if (searchQuery) {
      const haystack = [
        recipe.name,
        recipe.description,
        ...recipe.ingredients.map((i) => RecipeScale.ingredientText(i)),
        ...recipe.ingredients.map((i) => displayIngredient(i, 1)),
        ...recipe.tags,
      ]
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(searchQuery)) return false;
    }
    if (pantryOn && pantryTerms.length > 0 && pantryMatches(recipe).length === 0) return false;
    return true;
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
    return RecipeScale.ingredientText(RecipeUnits.convertIngredient(scaled, store.prefs));
  }

  /** Which of the user's pantry terms this recipe's ingredients mention. */
  function pantryMatches(recipe) {
    const lines = recipe.ingredients.map((i) => `${i.item} ${i.unit}`.toLowerCase());
    return pantryTerms.filter((term) => {
      // Also try a crude singular so "tomatoes" finds "tomato purée" and vice versa.
      const singular = term.replace(/(es|s)$/, "");
      return lines.some((l) => l.includes(term) || (singular.length >= 3 && l.includes(singular)));
    });
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
    const meta = [
      recipe.servings ? `Serves ${recipe.servings}` : null,
      time,
      `${recipe.ingredients.length} ingredients`,
    ]
      .filter(Boolean)
      .join(" · ");

    const matched = pantryOn && pantryTerms.length > 0 ? pantryMatches(recipe) : [];
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
            ? `<p class="card-matches">Has ${matched.map((t) => escapeHTML(t)).join(" · ")}</p>`
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
    let visible = store.recipes.filter(matchesFilters);
    if (pantryOn && pantryTerms.length > 0) {
      // Best matches first; stable within equal counts.
      visible = visible
        .map((r, i) => ({ r, i, n: pantryMatches(r).length }))
        .sort((a, b) => b.n - a.n || a.i - b.i)
        .map((x) => x.r);
    }
    listEl.innerHTML = visible.map((r, i) => recipeCard(r, i)).join("");

    const hasAny = store.recipes.length > 0;
    emptyStateEl.hidden = hasAny;
    listEl.hidden = !hasAny;

    if (hasAny && visible.length === 0) {
      listEl.hidden = false;
      listEl.innerHTML = `<p class="no-results">No recipes match your search.</p>`;
    }

    favoritesBtn.classList.toggle("chip-active", favoritesOnly);
    favoritesBtn.setAttribute("aria-pressed", String(favoritesOnly));
    renderTagFilters();
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
  function openRecipeDialog(recipe, review) {
    editingId = recipe && !review ? recipe.id : null;
    incomingId = review && recipe ? recipe.id : null;
    dialogTitle.textContent = review ? "Review recipe" : recipe ? "Edit recipe" : "New recipe";
    // Re-opening a link you already saved shows the sender's version again,
    // so say that saving replaces your copy rather than adding a second.
    // An incoming recipe carries its own id, and the sender chose it. If it
    // matches something already here, saving replaces that recipe with what
    // is on screen — so name the one at stake rather than saying "my copy"
    // and leaving the person to guess which.
    const existing = review && recipe ? store.getById(recipe.id) : null;
    const warning = $("#review-warning");
    if (warning) {
      warning.hidden = !existing;
      if (existing) {
        warning.textContent =
          `This will replace “${existing.name}” in your recipe box. ` +
          "Everything below is the version you were sent.";
      }
    }
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
    recipeDialog.showModal();
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
    if (photoPending.has(path) || !cloud || !cloud.sync || !cloud.sync.userId) return;
    photoPending.add(path);
    cloud.sync
      .signedPhotoUrl(path)
      .then((url) => {
        photoUrls.set(path, { url, expiresAt: Date.now() + SIGNED_TTL_MS });
        // Coalesce: a grid of photos would otherwise redraw once each.
        clearTimeout(photoRerender);
        photoRerender = setTimeout(() => {
          render();
          if (detailDialog.open && detailId) {
            const recipe = store.getById(detailId);
            if (recipe) detailContent.innerHTML = recipeDetailHTML(recipe, "From your recipe box", true);
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
    if (!image.startsWith("data:") || !cloud || !cloud.sync || !cloud.sync.bookId) return "";
    try {
      return await cloud.sync.uploadPhoto(cloud.sync.bookId, recipeId, dataUrlToBlob(image));
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
      const result = store.getById(incomingId)
        ? { recipe: store.update(incomingId, input) }
        : store.addShared({ ...input, id: incomingId });
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
  /** scalable: render the portion-scaling controls and apply detailScale. */
  function recipeDetailHTML(recipe, kicker, scalable) {
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
      <p class="detail-kicker">${escapeHTML(kicker)}</p>
      <h2 class="detail-title">${escapeHTML(recipe.name)}
        ${recipe.favorite ? '<span class="detail-fav" title="Favourite">★</span>' : ""}
      </h2>
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
      ${scaleControls}
      <h3>Ingredients</h3>
      <ul class="detail-ingredients">
        ${recipe.ingredients
          .map((i) => `<li>${escapeHTML(displayIngredient(i, factor))}</li>`)
          .join("")}
      </ul>
      <h3>Steps</h3>
      <ol class="detail-steps">
        ${recipe.steps.map((s) => `<li>${escapeHTML(s)}</li>`).join("")}
      </ol>`;
  }

  /** Only offer Move when the signed-in user has more than one book. */
  function syncMoveButton() {
    const btn = $("#detail-move-btn");
    const cloud = window.RecipeCloud;
    btn.hidden = !(cloud && cloud.books && cloud.books.books.length > 1);
  }

  function openDetailDialog(recipe) {
    // Keep the scale when re-rendering the same open recipe (e.g. after a
    // favourite toggle); reset it when a different recipe opens.
    if (detailId !== recipe.id || !detailDialog.open) detailScale = 1;
    detailId = recipe.id;
    detailContent.innerHTML = recipeDetailHTML(recipe, "From your recipe box", true);
    syncDetailFavButton(recipe);
    syncMoveButton();
    if (!detailDialog.open) detailDialog.showModal();
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
    detailContent.innerHTML = recipeDetailHTML(recipe, "From your recipe box", true);
  });

  function syncDetailFavButton(recipe) {
    const btn = $("#detail-fav-btn");
    btn.textContent = recipe.favorite ? "★ Favourited" : "☆ Favourite";
    btn.setAttribute("aria-pressed", String(recipe.favorite));
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
    // an export of them is a file of broken references (J10.3). Say so
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
      toast(`Imported ${result.imported} recipe${result.imported === 1 ? "" : "s"}` +
            (result.skipped ? ` (${result.skipped} skipped)` : "") + ".");
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
    if (cloud && cloud.sync && cloud.sync.userId) {
      cloud.sync.pushPrefs(store.prefs).catch((err) => {
        console.warn("Recipe Friend: could not save preferences to your account.", err);
      });
    }
    prefsDialog.close();
    toast("Preferences saved.");
    // Nothing stored changed — only how amounts are shown.
    if (detailDialog.open && detailId) {
      const recipe = store.getById(detailId);
      if (recipe) detailContent.innerHTML = recipeDetailHTML(recipe, "From your recipe box", true);
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
    searchQuery = searchInput.value.trim().toLowerCase();
    render();
  });

  favoritesBtn.addEventListener("click", () => {
    favoritesOnly = !favoritesOnly;
    render();
  });

  // --- "What can I cook?" pantry mode ---
  const pantryToggle = $("#pantry-toggle");
  const pantryPanel = $("#pantry-panel");
  const pantryInput = $("#pantry-input");

  pantryToggle.addEventListener("click", () => {
    pantryOn = !pantryOn;
    pantryPanel.hidden = !pantryOn;
    pantryToggle.classList.toggle("chip-active", pantryOn);
    pantryToggle.setAttribute("aria-pressed", String(pantryOn));
    if (pantryOn) pantryInput.focus();
    render();
  });

  pantryInput.addEventListener("input", () => {
    pantryTerms = pantryInput.value
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 2);
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

  // Moving lives with books, so hand off to that layer. The button only
  // appears once there is somewhere else to move to.
  $("#detail-move-btn").addEventListener("click", () => {
    const cloud = window.RecipeCloud;
    if (!cloud || !cloud.books || !detailId) return;
    detailDialog.close();
    cloud.books.openMove(detailId);
  });

  $("#detail-close-btn").addEventListener("click", () => detailDialog.close());

  $("#detail-fav-btn").addEventListener("click", () => {
    const recipe = store.toggleFavorite(detailId);
    if (!recipe) return;
    openDetailDialog(recipe); // re-render the open dialog with the new state
    render();
  });

  $("#detail-edit-btn").addEventListener("click", () => {
    const recipe = store.getById(detailId);
    detailDialog.close();
    if (recipe) openRecipeDialog(recipe);
  });

  $("#detail-delete-btn").addEventListener("click", () => {
    const recipe = store.getById(detailId);
    if (!recipe) return;
    if (!confirm(`Delete “${recipe.name}”? This can't be undone.`)) return;
    // Take the stored photo with it. Best effort — an orphaned file costs
    // a little quota, a failed delete shouldn't block removing the recipe.
    const cloud = window.RecipeCloud;
    if (recipe.imagePath && cloud && cloud.sync && cloud.sync.bookId) {
      cloud.sync
        .deletePhoto(cloud.sync.bookId, recipe.id)
        .catch((err) => console.warn("Recipe Friend: could not remove the photo.", err));
    }
    store.remove(detailId);
    detailDialog.close();
    toast("Recipe deleted.");
    render();
  });

  // Close dialogs when clicking the backdrop.
  for (const dialog of [recipeDialog, detailDialog, prefsDialog, aiHelpDialog, pasteDialog]) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

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
  window.RecipeApp = { store, render, toast, showPendingShare };

  render();
  handleIncomingShare();
  // A share link opened in an already-loaded tab only changes the fragment.
  window.addEventListener("hashchange", handleIncomingShare);
})();
