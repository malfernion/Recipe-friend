/**
 * liststore.js — where a book's lists are kept between taps (J18.22).
 *
 * The same shape as planstore.js: localStorage is the working copy, so a
 * list draws at once and works with no network (the supermarket), and
 * each book has its own key, so switching books switches lists (J18.1).
 * Everything read back is coerced by `RecipeLists.sanitizeList`.
 *
 * State:
 *   { version: 1,
 *     lists:  [<list>],            // live lists only
 *     known:  [<id>],              // lists the server is known to hold
 *     owed:   [<id>],              // lists deleted here, not yet on the server
 *     seeded: bool }               // the plan has been moved in (build step 1)
 *
 * Edits go through `change(id, fn)`, where `fn` is one of RecipeLists'
 * operations; sync reads the result, merges it with the server's and
 * writes back with the quiet methods at the bottom.
 */
(function (global) {
  "use strict";

  const LISTS_KEY = "recipe-friend:lists:v1";
  const DEVICE_KEY = "recipe-friend:device:v1";
  const MAX_LISTS = 200; // the server's own quota (012)
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const ids = (raw) =>
    (Array.isArray(raw) ? raw : []).filter((v) => typeof v === "string" && UUID_RE.test(v)).map((v) => v.toLowerCase()).slice(0, MAX_LISTS * 2);

  function load(key) {
    let parsed = null;
    try {
      parsed = JSON.parse(global.localStorage.getItem(key));
    } catch (err) {
      console.warn("Recipe Friend: could not read the saved lists.", err);
    }
    const p = parsed && typeof parsed === "object" ? parsed : {};
    const byId = new Map();
    for (const raw of Array.isArray(p.lists) ? p.lists.slice(0, MAX_LISTS) : []) {
      const list = global.RecipeLists.sanitizeList(raw);
      if (list) byId.set(list.id, byId.has(list.id) ? global.RecipeLists.mergeLists(byId.get(list.id), list) : list);
    }
    return {
      version: 1,
      lists: [...byId.values()],
      known: ids(p.known),
      owed: ids(p.owed),
      seeded: p.seeded === true,
    };
  }

  /**
   * This device's id for counters (J18.17): stable, random, and shared by
   * every book on the device. A device without storage gets one for the
   * session, which only costs a counter's taps their author.
   */
  function deviceId() {
    const ok = (v) => typeof v === "string" && /^[A-Za-z0-9]{8,24}$/.test(v);
    try {
      const held = global.localStorage.getItem(DEVICE_KEY);
      if (ok(held)) return held;
    } catch {
      /* fall through */
    }
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = new Uint8Array(16);
    global.crypto.getRandomValues(bytes);
    const made = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
    try {
      global.localStorage.setItem(DEVICE_KEY, made);
    } catch {
      /* in memory only */
    }
    return made;
  }

  /** Lists in the order they are shown: oldest first, so Shopping leads. */
  const ordered = (lists) => [...lists].sort((a, b) => a.createdAt - b.createdAt || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1));

  class RecipeListStore {
    constructor() {
      this.key = LISTS_KEY;
      this.bookId = null;
      this.state = load(this.key);
      this.persistOk = true;
      // Sync listens here to push, as on the other stores.
      this.onChange = null;
      // The UI listens here to redraw after a pull changed something:
      // called with the ids of the lists that changed or went.
      this.onRemote = null;
      this._device = null;
    }

    get deviceId() {
      if (!this._device) this._device = deviceId();
      return this._device;
    }

    _persist(notify) {
      try {
        global.localStorage.setItem(this.key, JSON.stringify(this.state));
        this.persistOk = true;
      } catch (err) {
        console.warn("Recipe Friend: could not save the lists.", err);
        this.persistOk = false;
      }
      if (notify && this.onChange) this.onChange();
      return this.persistOk;
    }

    /** Point at a book's lists (J18.1). */
    useBook(bookId) {
      const next = bookId ? `${LISTS_KEY}:book:${bookId}` : LISTS_KEY;
      this.bookId = bookId || null;
      if (next === this.key) return;
      this.key = next;
      this.state = load(this.key);
    }

    /** Drop a book's lists: the book went, or you left it. */
    forgetBook(bookId) {
      try {
        global.localStorage.removeItem(`${LISTS_KEY}:book:${bookId}`);
      } catch {
        /* nothing to clear */
      }
    }

    /** Every list in the book, in order. */
    get lists() {
      return ordered(this.state.lists);
    }

    get(id) {
      return this.state.lists.find((l) => l.id === id) || null;
    }

    // --- local edits: persisted, and pushed on the usual debounce -------

    /** Make a list (J18.1, J18.2). Null when the book is full. */
    create(name, kind, now = Date.now()) {
      if (this.state.lists.length >= MAX_LISTS) return null;
      const list = global.RecipeLists.createList({ name, kind, now });
      this.state.lists.push(list);
      this._persist(true);
      return list;
    }

    rename(id, name, now = Date.now()) {
      return this.change(id, (l) => global.RecipeLists.rename(l, name, now));
    }

    /**
     * Delete a list (J18.3; asking first is the UI's). One the server has
     * never seen just goes; one it has is owed as a tombstone.
     */
    remove(id) {
      if (!this.get(id)) return false;
      this.state.lists = this.state.lists.filter((l) => l.id !== id);
      if (this.state.known.includes(id) && !this.state.owed.includes(id)) this.state.owed.push(id);
      this._persist(true);
      return true;
    }

    /**
     * Apply an operation to one list: `store.change(id, (l) =>
     * RecipeLists.addItem(l, {...}))`. Returns the list as it now is, or
     * null if there is no such list. An operation that changed nothing
     * (it returned its input) writes nothing.
     */
    change(id, fn) {
      const at = this.state.lists.findIndex((l) => l.id === id);
      if (at < 0) return null;
      const before = this.state.lists[at];
      const after = fn(before);
      if (!after || after === before) return before;
      const clean = global.RecipeLists.sanitizeList({ ...after, id: before.id, kind: before.kind });
      if (!clean) return before;
      this.state.lists[at] = clean;
      this._persist(true);
      return clean;
    }

    // --- sync's bookkeeping: persisted, never echoed to onChange --------

    get seeded() {
      return this.state.seeded;
    }

    markSeeded() {
      if (this.state.seeded) return;
      this.state.seeded = true;
      this._persist(false);
    }

    /**
     * Move the book's live plan into a "Shopping" checklist (build step
     * 1), once. Deterministic ids (RecipeLists.fromPlan) are what make
     * two devices doing this at once one list. Returns the list, or null
     * if this book was already seeded.
     */
    seedFromPlan(bookId, plan, recipes, prefs) {
      if (this.state.seeded) return null;
      const list = global.RecipeLists.fromPlan(plan, recipes, bookId, prefs);
      const held = this.get(list.id);
      const merged = held ? global.RecipeLists.mergeLists(held, list) : list;
      this.state.lists = [...this.state.lists.filter((l) => l.id !== list.id), merged];
      this.state.seeded = true;
      this._persist(false);
      return merged;
    }

    isKnown(id) {
      return this.state.known.includes(id);
    }

    markKnown(id) {
      if (this.state.known.includes(id)) return;
      this.state.known.push(id);
      this._persist(false);
    }

    /** Lists deleted here that the server has not been told about. */
    get owed() {
      return [...this.state.owed];
    }

    settleOwed(id) {
      this.state.owed = this.state.owed.filter((x) => x !== id);
      this.state.known = this.state.known.filter((x) => x !== id);
      this._persist(false);
    }

    /** Put a merged list in place. True when that changed what is held. */
    applyRemote(list) {
      const clean = global.RecipeLists.sanitizeList(list);
      if (!clean || this.state.owed.includes(clean.id)) return false;
      const held = this.get(clean.id);
      if (held && JSON.stringify(held) === JSON.stringify(clean)) return false;
      this.state.lists = held ? this.state.lists.map((l) => (l.id === clean.id ? clean : l)) : [...this.state.lists, clean];
      this._persist(false);
      return true;
    }

    /** A list deleted elsewhere. True when this device still had it. */
    drop(id) {
      const had = Boolean(this.get(id));
      this.state.lists = this.state.lists.filter((l) => l.id !== id);
      this.state.known = this.state.known.filter((x) => x !== id);
      this.state.owed = this.state.owed.filter((x) => x !== id);
      this._persist(false);
      return had;
    }

    /** Tell the UI what a pull changed. */
    announce(changed) {
      if (changed.length && this.onRemote) this.onRemote(changed);
    }
  }

  RecipeListStore.limits = { MAX_LISTS };
  global.RecipeListStore = RecipeListStore;
})(window);
