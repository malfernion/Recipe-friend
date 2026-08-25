/**
 * app.js — UI layer for Recipe Friend.
 * Renders the recipe grid, search/filter toolbar, and the add/edit and
 * detail dialogs. All persistence goes through RecipeStore (storage.js).
 */
(function () {
  "use strict";

  const store = new RecipeStore();
  store.seedIfEmpty();

  // --- UI state (not persisted) ---
  let searchQuery = "";
  let favoritesOnly = false;
  let activeTag = null;
  let editingId = null; // recipe id being edited, or null when adding
  let detailId = null; // recipe id shown in the detail dialog
  let pendingImage = ""; // data URI chosen via the file picker, pre-save
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
      const haystack = [recipe.name, recipe.description, ...recipe.ingredients, ...recipe.tags]
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(searchQuery)) return false;
    }
    if (pantryOn && pantryTerms.length > 0 && pantryMatches(recipe).length === 0) return false;
    return true;
  }

  /** Which of the user's pantry terms this recipe's ingredients mention. */
  function pantryMatches(recipe) {
    const lines = recipe.ingredients.map((i) => i.toLowerCase());
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
        ${recipe.image ? `<img class="card-img" src="${escapeHTML(recipe.image)}" alt="" loading="lazy">` : ""}
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

  // --- Add / edit dialog ---
  function openRecipeDialog(recipe) {
    editingId = recipe ? recipe.id : null;
    dialogTitle.textContent = recipe ? "Edit recipe" : "New recipe";
    $("#save-recipe-btn").textContent = recipe ? "Save changes" : "Save recipe";
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
      f.ingredients.value = recipe.ingredients.join("\n");
      f.steps.value = recipe.steps.join("\n");
      f.tags.value = recipe.tags.join(", ");
    }
    // Restore photo state: URLs go back into the text field, data URIs into
    // the pending slot.
    const image = recipe ? recipe.image : "";
    pendingImage = image.startsWith("data:") ? image : "";
    recipeForm.elements.imageUrl.value = image.startsWith("http") ? image : "";
    updatePhotoPreview();
    recipeDialog.showModal();
  }

  function currentFormImage() {
    return pendingImage || recipeForm.elements.imageUrl.value.trim();
  }

  function updatePhotoPreview() {
    const preview = $("#photo-preview");
    const image = currentFormImage();
    preview.src = image || "";
    preview.hidden = !image;
    $("#photo-remove-btn").hidden = !image;
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

  function readRecipeForm() {
    const f = recipeForm.elements;
    const lines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);
    return {
      name: f.name.value,
      description: f.description.value,
      servings: f.servings.value || null,
      prepMinutes: f.prepMinutes.value || null,
      cookMinutes: f.cookMinutes.value || null,
      ingredients: lines(f.ingredients.value),
      steps: lines(f.steps.value),
      tags: f.tags.value.split(",").map((s) => s.trim()).filter(Boolean),
      image: currentFormImage(),
    };
  }

  recipeForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!recipeForm.reportValidity()) return;
    const input = readRecipeForm();
    if (input.ingredients.length === 0 || input.steps.length === 0) {
      toast("A recipe needs at least one ingredient and one step.");
      return;
    }
    const saved = editingId ? store.update(editingId, input) : store.add(input);
    if (!saved) {
      toast("Could not save that recipe — check the name, ingredients, and steps.");
      return;
    }
    recipeDialog.close();
    if (!store.persistOk) {
      toast("Saved for this visit, but browser storage is full — try a smaller photo or export a backup.");
    } else {
      toast(editingId ? "Recipe updated." : `Added “${saved.name}”.`);
    }
    editingId = null;
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
      ${recipe.image ? `<img class="detail-img" src="${escapeHTML(recipe.image)}" alt="Photo of ${escapeHTML(recipe.name)}">` : ""}
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
          .map((i) => `<li>${escapeHTML(RecipeScale.scaleIngredient(i, factor))}</li>`)
          .join("")}
      </ul>
      <h3>Steps</h3>
      <ol class="detail-steps">
        ${recipe.steps.map((s) => `<li>${escapeHTML(s)}</li>`).join("")}
      </ol>`;
  }

  function openDetailDialog(recipe) {
    // Keep the scale when re-rendering the same open recipe (e.g. after a
    // favourite toggle); reset it when a different recipe opens.
    if (detailId !== recipe.id || !detailDialog.open) detailScale = 1;
    detailId = recipe.id;
    detailContent.innerHTML = recipeDetailHTML(recipe, "From your recipe box", true);
    syncDetailFavButton(recipe);
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
    toast(`Exported ${store.recipes.length} recipe${store.recipes.length === 1 ? "" : "s"}.`);
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
  const shareDialog = $("#share-dialog");
  let incomingShare = null; // raw payload awaiting the user's decision

  $("#detail-share-btn").addEventListener("click", async () => {
    const recipe = store.getById(detailId);
    if (!recipe) return;
    const encoded = await RecipeShare.encodeRecipeShare(recipe);
    const url = `${location.origin}${location.pathname}#add=${encoded}`;
    const note = recipe.image.startsWith("data:") ? " Photo not included — photos are too big for links." : "";
    try {
      await navigator.clipboard.writeText(url);
      toast(`Share link copied.${note}`);
    } catch {
      window.prompt("Copy this share link:", url);
    }
  });

  async function handleIncomingShare() {
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
    $("#share-content").innerHTML = recipeDetailHTML(preview, "A recipe shared with you");
    shareDialog.showModal();
  }

  $("#share-save-btn").addEventListener("click", () => {
    const result = incomingShare && store.addShared(incomingShare);
    incomingShare = null;
    shareDialog.close();
    if (!result) {
      toast("That share link couldn't be read.");
      return;
    }
    toast(result.existed ? "Already in your recipe box." : `Saved “${result.recipe.name}”.`);
    render();
  });

  $("#share-dismiss-btn").addEventListener("click", () => {
    incomingShare = null;
    shareDialog.close();
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
    store.remove(detailId);
    detailDialog.close();
    toast("Recipe deleted.");
    render();
  });

  // Close dialogs when clicking the backdrop.
  for (const dialog of [recipeDialog, detailDialog, shareDialog]) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  render();
  handleIncomingShare();
  // A share link opened in an already-loaded tab only changes the fragment.
  window.addEventListener("hashchange", handleIncomingShare);
})();
