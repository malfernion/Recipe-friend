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
    return true;
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

    return `
      <article class="recipe-card" data-id="${escapeHTML(recipe.id)}" tabindex="0"
               role="button" aria-label="Open ${escapeHTML(recipe.name)}">
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
          recipe.tags.length
            ? `<div class="card-tags">${recipe.tags
                .map((t) => `<span class="tag">${escapeHTML(t)}</span>`)
                .join("")}</div>`
            : ""
        }
      </article>`;
  }

  function render() {
    const visible = store.recipes.filter(matchesFilters);
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
      f.servings.value = recipe.servings ?? "";
      f.prepMinutes.value = recipe.prepMinutes ?? "";
      f.cookMinutes.value = recipe.cookMinutes ?? "";
      f.ingredients.value = recipe.ingredients.join("\n");
      f.steps.value = recipe.steps.join("\n");
      f.tags.value = recipe.tags.join(", ");
    }
    recipeDialog.showModal();
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
    toast(editingId ? "Recipe updated." : `Added “${saved.name}”.`);
    editingId = null;
    render();
  });

  // --- Detail dialog ---
  function openDetailDialog(recipe) {
    detailId = recipe.id;
    const time = totalTime(recipe);
    const metaBits = [
      recipe.servings ? `Serves ${recipe.servings}` : null,
      recipe.prepMinutes ? `Prep ${recipe.prepMinutes} min` : null,
      recipe.cookMinutes ? `Cook ${recipe.cookMinutes} min` : null,
      time && recipe.prepMinutes && recipe.cookMinutes ? `Total ${time}` : null,
    ].filter(Boolean);

    detailContent.innerHTML = `
      <p class="detail-kicker">From your recipe box</p>
      <h2 class="detail-title">${escapeHTML(recipe.name)}
        ${recipe.favorite ? '<span class="detail-fav" title="Favourite">★</span>' : ""}
      </h2>
      ${recipe.description ? `<p class="detail-desc">${escapeHTML(recipe.description)}</p>` : ""}
      ${metaBits.length ? `<p class="card-meta">${escapeHTML(metaBits.join(" · "))}</p>` : ""}
      ${
        recipe.tags.length
          ? `<div class="card-tags">${recipe.tags
              .map((t) => `<span class="tag">${escapeHTML(t)}</span>`)
              .join("")}</div>`
          : ""
      }
      <h3>Ingredients</h3>
      <ul class="detail-ingredients">
        ${recipe.ingredients.map((i) => `<li>${escapeHTML(i)}</li>`).join("")}
      </ul>
      <h3>Steps</h3>
      <ol class="detail-steps">
        ${recipe.steps.map((s) => `<li>${escapeHTML(s)}</li>`).join("")}
      </ol>`;
    syncDetailFavButton(recipe);
    if (!detailDialog.open) detailDialog.showModal();
  }

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
  for (const dialog of [recipeDialog, detailDialog]) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  render();
})();
