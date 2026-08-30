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
  const PREFS_KEY = "recipe-friend:prefs:v1";

  /** Shape persisted to localStorage. */
  const EMPTY_STATE = Object.freeze({ version: 1, recipes: [], tombstones: [] });

  // Deleted-recipe markers are kept this long so a delete syncs to other
  // devices instead of the recipe resurrecting from their cache.
  const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

  /** Always a real UUID: recipe ids are uuid primary keys in Postgres. */
  function uid() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // A recipe arrives from a share link, a pasted blob, or an imported file,
  // and none of those are limited to what a person would type. Caps are set
  // far above any real recipe — the biggest thing in here is a step, and a
  // long one is a couple of hundred characters — so that a hostile payload
  // is bounded rather than rendered.
  const MAX_STEPS = 200;
  const MAX_STEP_CHARS = 2000;
  const MAX_INGREDIENTS = 200;
  const MAX_TAGS = 50;

  function normalizeStringList(value, maxItems, maxChars) {
    if (!Array.isArray(value)) return [];
    return value
      .slice(0, maxItems)
      .map((s) => String(s).trim().slice(0, maxChars))
      .filter(Boolean);
  }

  /**
   * A recipe's tags: free text, lowercased (J2.6) — and each of them kept
   * once. The lowercasing is what makes the duplicates: "Vegan, vegan" is
   * one word typed twice, and so is a paste or an import that spells it
   * both ways. A tag is something a recipe carries or does not, and one
   * carried twice was counted twice in the filter menu, where the number
   * beside a tag is a number of recipes (J15.4) — so the menu promised
   * two and the tap gave you one.
   */
  function normalizeTags(value) {
    return [...new Set(normalizeStringList(value, MAX_TAGS, 40).map((t) => t.toLowerCase()))];
  }

  /** Ingredients are structured: {amount: number|null, unit, item}. */
  function sanitizeIngredient(raw) {
    if (!raw || typeof raw !== "object") return null;
    const amountNum = Number(raw.amount);
    const amount = Number.isFinite(amountNum) && amountNum > 0 ? amountNum : null;
    // Recognized unit aliases collapse to short labels ("Grams" -> "g").
    const unit = global.RecipeUnits.normalizeLabel(String(raw.unit || "").slice(0, 24));
    const item = String(raw.item || "").trim().slice(0, 200);
    if (!item && !unit) return null;
    return { amount, unit, item };
  }

  function normalizeIngredients(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_INGREDIENTS).map(sanitizeIngredient).filter(Boolean);
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
   * A photo in Storage, referenced as "<book id>/<recipe id>.jpg". Stored
   * as a path rather than a URL because the bucket is private — readable
   * links are signed on demand and expire.
   */
  function sanitizePhotoPath(value) {
    const s = String(value || "").trim();
    return /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/i.test(s) ? s : "";
  }

  /**
   * Coerce an untrusted object (from storage or an imported file) into a
   * well-formed recipe, or return null if it is unusable.
   */
  function sanitizeRecipe(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = String(raw.name || "").trim();
    const ingredients = normalizeIngredients(raw.ingredients);
    const steps = normalizeStringList(raw.steps, MAX_STEPS, MAX_STEP_CHARS);
    if (!name || ingredients.length === 0 || steps.length === 0) return null;

    const num = (v) => {
      if (v === null || v === undefined || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
    };

    return {
      id: typeof raw.id === "string" && UUID_RE.test(raw.id) ? raw.id : uid(),
      name: name.slice(0, 120),
      description: String(raw.description || "").trim().slice(0, 500),
      servings: num(raw.servings),
      prepMinutes: num(raw.prepMinutes),
      cookMinutes: num(raw.cookMinutes),
      ingredients,
      steps,
      image: sanitizeImage(raw.image),
      imagePath: sanitizePhotoPath(raw.imagePath),
      // Which recipe this one arrived from, when it came from a link or a
      // paste (J5.2). Not the same as its id — see findIncoming.
      sharedFrom:
        typeof raw.sharedFrom === "string" && UUID_RE.test(raw.sharedFrom) ? raw.sharedFrom : "",
      tags: normalizeTags(raw.tags),
      favorite: Boolean(raw.favorite),
      createdAt: num(raw.createdAt) || Date.now(),
      updatedAt: num(raw.updatedAt) || Date.now(),
    };
  }

  function load(key) {
    let parsed;
    try {
      parsed = JSON.parse(global.localStorage.getItem(key || STORAGE_KEY));
    } catch (err) {
      // Private browsing, disabled storage, or corrupted JSON — start fresh
      // in memory rather than crashing the app.
      console.warn("Recipe Friend: could not read saved recipes.", err);
      return { ...EMPTY_STATE, recipes: [], tombstones: [] };
    }
    if (!parsed || !Array.isArray(parsed.recipes)) {
      return { ...EMPTY_STATE, recipes: [], tombstones: [] };
    }
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    return {
      version: 1,
      recipes: parsed.recipes.map(sanitizeRecipe).filter(Boolean),
      tombstones: (Array.isArray(parsed.tombstones) ? parsed.tombstones : [])
        .filter((t) => t && UUID_RE.test(t.id) && Number(t.deletedAt) > cutoff)
        .map((t) => ({ id: t.id, deletedAt: Number(t.deletedAt) })),
    };
  }

  function persist(state, key) {
    try {
      global.localStorage.setItem(key || STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (err) {
      console.warn("Recipe Friend: could not save recipes.", err);
      return false;
    }
  }

  function loadPrefs() {
    let parsed;
    try {
      parsed = JSON.parse(global.localStorage.getItem(PREFS_KEY));
    } catch {
      parsed = null;
    }
    const pick = (v, allowed) => (allowed.includes(v) ? v : "");
    return {
      mass: pick(parsed && parsed.mass, ["metric", "imperial"]),
      volume: pick(parsed && parsed.volume, ["metric", "us"]),
    };
  }

  class RecipeStore {
    constructor() {
      // Signed out (or before a book is known) the cache is unnamespaced;
      // each book then gets its own key so switching never mixes books.
      this.key = STORAGE_KEY;
      this.state = load(this.key);
      this.prefs = loadPrefs();
      // False when the latest write failed (storage full or blocked), so the
      // UI can warn that changes are in memory only.
      this.persistOk = true;
    }

    _persist() {
      this.persistOk = persist(this.state, this.key);
      // Sync listens here to push local edits. Suppressed while applying
      // remote data so merges don't echo straight back to the server.
      if (this.onChange && !this._applying) this.onChange();
      return this.persistOk;
    }

    get tombstones() {
      return this.state.tombstones;
    }

    /**
     * Point the local cache at a book. Each book keeps its own cache, so
     * switching books never pushes one book's recipes into another. The
     * very first switch adopts anything sitting in the pre-account cache,
     * so a box built before signing in isn't stranded.
     */
    useBook(bookId) {
      const nextKey = bookId ? `${STORAGE_KEY}:book:${bookId}` : STORAGE_KEY;
      if (nextKey === this.key) return;
      let stored = null;
      try {
        stored = global.localStorage.getItem(nextKey);
      } catch {
        stored = null;
      }
      if (stored === null && this.key === STORAGE_KEY && this.state.recipes.length > 0) {
        // Adopt the pre-account box into this book, then retire the old key.
        this.key = nextKey;
        this._persist();
        try {
          global.localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* leaving it behind is harmless */
        }
        return;
      }
      this.key = nextKey;
      this.state = load(this.key);
      // A different book is a different list, and what the toolbar was
      // doing belonged to the one you left (J15.8). Announced rather than
      // reached for, the way a forgotten book is: this file goes on
      // knowing about recipes and nothing about a screen.
      if (this.onUseBook) this.onUseBook(bookId);
    }

    /** Drop a book's local cache — used when the book itself is deleted. */
    forgetBook(bookId) {
      try {
        global.localStorage.removeItem(`${STORAGE_KEY}:book:${bookId}`);
      } catch {
        /* nothing to clear */
      }
      // A book that has gone takes everything of its own with it (J7.13),
      // and its recipes are not all of that any more: its plan is the
      // book's too (J12.2). Announced rather than reached for, so this
      // file goes on knowing about recipes and nothing else.
      if (this.onForgetBook) this.onForgetBook(bookId);
    }

    /**
     * Forget a recipe locally without tombstoning it. Used when a recipe
     * moves to another book: the row still exists, so marking it deleted
     * would destroy it in its new home.
     */
    removeLocal(id) {
      const before = this.state.recipes.length;
      this.state.recipes = this.state.recipes.filter((r) => r.id !== id);
      if (this.state.recipes.length < before) {
        this._applying = true; // not a local edit to push
        this._persist();
        this._applying = false;
        return true;
      }
      return false;
    }

    /** Drop any delete marker for an id being (re-)added. */
    _untomb(id) {
      this.state.tombstones = this.state.tombstones.filter((t) => t.id !== id);
    }

    /**
     * Replace the local collection with the merged result of a sync.
     * Does not notify onChange — the caller already knows.
     */
    applyMerge(recipes, tombstones) {
      this._applying = true;
      this.state.recipes = recipes;
      this.state.tombstones = tombstones;
      this._persist();
      this._applying = false;
    }

    /**
     * Save measurement preferences. Recipes are stored as entered and
     * converted when displayed, so nothing stored changes here — which is
     * what lets two people share a book with different preferences.
     */
    setPrefs(prefs) {
      this.prefs = {
        mass: prefs.mass === "metric" || prefs.mass === "imperial" ? prefs.mass : "",
        volume: prefs.volume === "metric" || prefs.volume === "us" ? prefs.volume : "",
      };
      try {
        global.localStorage.setItem(PREFS_KEY, JSON.stringify(this.prefs));
      } catch (err) {
        console.warn("Recipe Friend: could not save preferences.", err);
      }
      return this.prefs;
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
      this._untomb(recipe.id);
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
      if (removed) {
        // Tombstone, so the delete travels to other devices rather than
        // the recipe coming back on their next sync.
        this.state.tombstones = this.state.tombstones
          .filter((t) => t.id !== id)
          .concat({ id, deletedAt: Date.now() });
        this._persist();
      }
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
    /**
     * The recipe in this book that a given incoming id refers to, if any
     * (J5.2, J5.3).
     *
     * An incoming recipe is stored under an id of our own, because
     * `recipes.id` is a primary key across every book on the server: two
     * books cannot hold the same id, and a copy that borrowed the
     * sender's would collide with theirs. So the sender's id is kept
     * beside ours as `sharedFrom`, and that is what a second opening of
     * the same link matches on.
     *
     * The id is still checked first, for recipes saved before this was
     * true — their own id is the only record of where they came from.
     */
    findIncoming(incomingId) {
      if (!incomingId) return null;
      return (
        this.getById(incomingId) ||
        this.recipes.find((r) => r.sharedFrom && r.sharedFrom === incomingId) ||
        null
      );
    }

    addShared(raw) {
      const recipe = sanitizeRecipe(raw);
      if (!recipe) return null;
      const existing = this.getById(recipe.id);
      if (existing) return { recipe: existing, existed: true };
      this._untomb(recipe.id);
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
     *
     * Matching is by id, so re-importing never duplicates (J10.2). Where
     * both sides hold the same id the more recently edited one wins, the
     * same rule two devices use to reconcile (J10.3, J9.3) — an old backup
     * cannot undo newer work, and a newer one restores it.
     *
     * Returns {imported, updated, skipped}, or null on bad input.
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

      const byId = new Map(this.state.recipes.map((r) => [r.id, r]));
      let imported = 0;
      let updated = 0;
      let skipped = 0;
      for (const raw of incoming) {
        const recipe = sanitizeRecipe(raw);
        if (!recipe) {
          skipped++;
          continue;
        }
        const existing = byId.get(recipe.id);
        if (existing) {
          // Same recipe, two versions: newest edit wins. Equal timestamps
          // keep what is already here rather than churning the collection.
          if (recipe.updatedAt > existing.updatedAt) {
            Object.assign(existing, recipe);
            updated++;
          } else {
            skipped++;
          }
          continue;
        }
        byId.set(recipe.id, recipe);
        this._untomb(recipe.id);
        this.state.recipes.push(recipe);
        imported++;
      }
      if (imported > 0 || updated > 0) this._persist();
      return { imported, updated, skipped };
    }

  }

  // Exposed so the UI can sanitize a shared payload for preview before saving.
  RecipeStore.sanitizeRecipe = sanitizeRecipe;
  // A copy needs an id of its own before it has a recipe to hang it on.
  RecipeStore.newId = uid;

  global.RecipeStore = RecipeStore;
})(window);
