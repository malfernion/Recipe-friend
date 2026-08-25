/**
 * storage.js — localStorage persistence layer for Recipe Friend.
 *
 * All recipes live under a single versioned key so future schema changes
 * can migrate old data instead of breaking it. The rest of the app talks
 * to RecipeStore and never touches localStorage directly.
 */
(function (global) {
  "use strict";

  const STORAGE_KEY = "recipe-friend:v1";

  /** Shape persisted to localStorage. */
  const EMPTY_STATE = Object.freeze({ version: 1, recipes: [] });

  function uid() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return "r-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function normalizeStringList(value) {
    if (!Array.isArray(value)) return [];
    return value.map((s) => String(s).trim()).filter(Boolean);
  }

  /**
   * Ingredients are structured: {amount: number|null, unit, item}.
   * Legacy free-text lines (old stored data, exports, share links) are
   * migrated via a one-time best-effort split; whatever it can't place
   * lands whole in `item` for hand-tidying in the editor.
   */
  function sanitizeIngredient(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "string") return global.RecipeScale.parseLegacyIngredient(raw);
    if (typeof raw !== "object") return null;
    const amountNum = Number(raw.amount);
    const amount = Number.isFinite(amountNum) && amountNum > 0 ? amountNum : null;
    const unit = String(raw.unit || "").trim().slice(0, 24);
    const item = String(raw.item || "").trim().slice(0, 200);
    if (!item && !unit) return null;
    return { amount, unit, item };
  }

  function normalizeIngredients(value) {
    if (!Array.isArray(value)) return [];
    return value.map(sanitizeIngredient).filter(Boolean);
  }

  /**
   * A recipe image is either a browser-generated data URI (bounded so a
   * single photo can't eat the whole localStorage quota) or an http(s) URL.
   */
  function sanitizeImage(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    if (/^data:image\/(png|jpe?g|webp|gif|avif);base64,/i.test(s)) {
      return s.length <= 900000 ? s : "";
    }
    if (/^https?:\/\//i.test(s)) return s.slice(0, 2048);
    return "";
  }

  /**
   * Coerce an untrusted object (from storage or an imported file) into a
   * well-formed recipe, or return null if it is unusable.
   */
  function sanitizeRecipe(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = String(raw.name || "").trim();
    const ingredients = normalizeIngredients(raw.ingredients);
    const steps = normalizeStringList(raw.steps);
    if (!name || ingredients.length === 0 || steps.length === 0) return null;

    const num = (v) => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    };

    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : uid(),
      name: name.slice(0, 120),
      description: String(raw.description || "").trim().slice(0, 500),
      servings: num(raw.servings),
      prepMinutes: num(raw.prepMinutes),
      cookMinutes: num(raw.cookMinutes),
      ingredients,
      steps,
      image: sanitizeImage(raw.image),
      tags: normalizeStringList(raw.tags).map((t) => t.toLowerCase().slice(0, 40)),
      favorite: Boolean(raw.favorite),
      createdAt: num(raw.createdAt) || Date.now(),
      updatedAt: num(raw.updatedAt) || Date.now(),
    };
  }

  function load() {
    let parsed;
    try {
      parsed = JSON.parse(global.localStorage.getItem(STORAGE_KEY));
    } catch (err) {
      // Private browsing, disabled storage, or corrupted JSON — start fresh
      // in memory rather than crashing the app.
      console.warn("Recipe Friend: could not read saved recipes.", err);
      return { ...EMPTY_STATE, recipes: [] };
    }
    if (!parsed || !Array.isArray(parsed.recipes)) {
      return { ...EMPTY_STATE, recipes: [] };
    }
    return {
      version: 1,
      recipes: parsed.recipes.map(sanitizeRecipe).filter(Boolean),
    };
  }

  function persist(state) {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (err) {
      console.warn("Recipe Friend: could not save recipes.", err);
      return false;
    }
  }

  class RecipeStore {
    constructor() {
      this.state = load();
      // False when the latest write failed (storage full or blocked), so the
      // UI can warn that changes are in memory only.
      this.persistOk = true;
    }

    _persist() {
      this.persistOk = persist(this.state);
      return this.persistOk;
    }

    get recipes() {
      return this.state.recipes;
    }

    getById(id) {
      return this.state.recipes.find((r) => r.id === id) || null;
    }

    /** Add a recipe from form input. Returns the stored recipe or null. */
    add(input) {
      const recipe = sanitizeRecipe({ ...input, id: null, createdAt: Date.now() });
      if (!recipe) return null;
      this.state.recipes.unshift(recipe);
      this._persist();
      return recipe;
    }

    /** Update an existing recipe in place. Returns the updated recipe or null. */
    update(id, input) {
      const existing = this.getById(id);
      if (!existing) return null;
      const merged = sanitizeRecipe({
        ...existing,
        ...input,
        id: existing.id,
        createdAt: existing.createdAt,
        favorite: existing.favorite,
        updatedAt: Date.now(),
      });
      if (!merged) return null;
      Object.assign(existing, merged);
      this._persist();
      return existing;
    }

    remove(id) {
      const before = this.state.recipes.length;
      this.state.recipes = this.state.recipes.filter((r) => r.id !== id);
      const removed = this.state.recipes.length < before;
      if (removed) this._persist();
      return removed;
    }

    toggleFavorite(id) {
      const recipe = this.getById(id);
      if (!recipe) return null;
      recipe.favorite = !recipe.favorite;
      recipe.updatedAt = Date.now();
      this._persist();
      return recipe;
    }

    /**
     * Add a recipe received via a share link. The sender's id is kept, so
     * opening the same link twice never duplicates.
     * Returns {recipe, existed} or null for an unusable payload.
     */
    addShared(raw) {
      const recipe = sanitizeRecipe(raw);
      if (!recipe) return null;
      const existing = this.getById(recipe.id);
      if (existing) return { recipe: existing, existed: true };
      this.state.recipes.unshift(recipe);
      this._persist();
      return { recipe, existed: false };
    }

    /** All distinct tags across recipes, sorted alphabetically. */
    allTags() {
      const tags = new Set();
      for (const r of this.state.recipes) for (const t of r.tags) tags.add(t);
      return [...tags].sort();
    }

    /** Serialize everything for the Export button. */
    exportJSON() {
      return JSON.stringify(this.state, null, 2);
    }

    /**
     * Merge recipes from an exported file into the current collection.
     * Recipes whose id already exists are skipped so a re-import never
     * duplicates. Returns {imported, skipped} counts, or null on bad input.
     */
    importJSON(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return null;
      }
      const incoming = Array.isArray(parsed) ? parsed : parsed && parsed.recipes;
      if (!Array.isArray(incoming)) return null;

      const existingIds = new Set(this.state.recipes.map((r) => r.id));
      let imported = 0;
      let skipped = 0;
      for (const raw of incoming) {
        const recipe = sanitizeRecipe(raw);
        if (!recipe) {
          skipped++;
          continue;
        }
        if (existingIds.has(recipe.id)) {
          skipped++;
          continue;
        }
        existingIds.add(recipe.id);
        this.state.recipes.push(recipe);
        imported++;
      }
      if (imported > 0) this._persist();
      return { imported, skipped };
    }

    /** Seed a couple of starter recipes on first ever visit. */
    seedIfEmpty() {
      if (this.state.recipes.length > 0) return;
      if (global.localStorage.getItem(STORAGE_KEY) !== null) return; // user deleted everything on purpose
      const samples = [
        {
          name: "Weeknight tomato pasta",
          description: "Fast, pantry-friendly, and better than it has any right to be.",
          servings: 2,
          prepMinutes: 5,
          cookMinutes: 15,
          ingredients: [
            { amount: 200, unit: "g", item: "spaghetti" },
            { amount: 2, unit: "tbsp", item: "olive oil" },
            { amount: 3, unit: "cloves", item: "garlic, sliced" },
            { amount: 1, unit: "can", item: "crushed tomatoes (400g)" },
            { amount: null, unit: "", item: "pinch of chili flakes" },
            { amount: null, unit: "", item: "salt, pepper, and grated parmesan" },
          ],
          steps: [
            "Cook the spaghetti in well-salted water until just shy of al dente.",
            "Meanwhile, warm the olive oil and gently fry the garlic and chili flakes.",
            "Add the tomatoes, season, and simmer 8–10 minutes.",
            "Toss the pasta through the sauce with a splash of pasta water.",
            "Serve with parmesan.",
          ],
          tags: ["dinner", "quick", "vegetarian"],
        },
        {
          name: "Overnight oats",
          description: "Assemble tonight, breakfast appears tomorrow.",
          servings: 1,
          prepMinutes: 5,
          cookMinutes: 0,
          ingredients: [
            { amount: 50, unit: "g", item: "rolled oats" },
            { amount: 120, unit: "ml", item: "milk (any kind)" },
            { amount: 1, unit: "tbsp", item: "yogurt" },
            { amount: 1, unit: "tsp", item: "honey or maple syrup" },
            { amount: null, unit: "", item: "berries or banana to top" },
          ],
          steps: [
            "Stir the oats, milk, yogurt, and honey together in a jar.",
            "Cover and refrigerate overnight.",
            "Top with fruit and eat straight from the jar.",
          ],
          tags: ["breakfast", "no-cook"],
        },
      ];
      for (const s of samples) this.add(s);
    }
  }

  // Exposed so the UI can sanitize a shared payload for preview before saving.
  RecipeStore.sanitizeRecipe = sanitizeRecipe;

  global.RecipeStore = RecipeStore;
})(window);
