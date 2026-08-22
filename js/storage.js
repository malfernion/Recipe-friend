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
   * Coerce an untrusted object (from storage or an imported file) into a
   * well-formed recipe, or return null if it is unusable.
   */
  function sanitizeRecipe(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = String(raw.name || "").trim();
    const ingredients = normalizeStringList(raw.ingredients);
    const steps = normalizeStringList(raw.steps);
    if (!name || ingredients.length === 0 || steps.length === 0) return null;

    const num = (v) => {
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
      persist(this.state);
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
      persist(this.state);
      return existing;
    }

    remove(id) {
      const before = this.state.recipes.length;
      this.state.recipes = this.state.recipes.filter((r) => r.id !== id);
      const removed = this.state.recipes.length < before;
      if (removed) persist(this.state);
      return removed;
    }

    toggleFavorite(id) {
      const recipe = this.getById(id);
      if (!recipe) return null;
      recipe.favorite = !recipe.favorite;
      recipe.updatedAt = Date.now();
      persist(this.state);
      return recipe;
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
      if (imported > 0) persist(this.state);
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
            "200g spaghetti",
            "2 tbsp olive oil",
            "3 cloves garlic, sliced",
            "1 can (400g) crushed tomatoes",
            "Pinch of chili flakes",
            "Salt, pepper, and grated parmesan",
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
            "50g rolled oats",
            "120ml milk (any kind)",
            "1 tbsp yogurt",
            "1 tsp honey or maple syrup",
            "Berries or banana to top",
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

  global.RecipeStore = RecipeStore;
})(window);
