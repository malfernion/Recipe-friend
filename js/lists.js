/**
 * lists.js — a book's lists and what can be done to them (J18).
 *
 * Pure functions over plain objects, like plan.js: no DOM, no storage, no
 * network. liststore.js keeps lists between taps and sync.js reconciles
 * them; both hand these functions the data.
 *
 * List shape:
 *   { id, name, nameAt, kind: "checklist"|"stock", createdAt, items: [item] }
 *
 * Item shape — every fact carries its own stamp and merges on it (J18.23):
 *   {
 *     id, addedAt,
 *     parentId, order, posAt,     // where it is: null = top level; `order`
 *                                 // is a fractional key among its siblings
 *     text, textAt,               // what it says
 *     ticked, tickAt,             // checklists (J18.11)
 *     gone, goneAt,               // deleted: a tombstone, so an older copy
 *                                 // cannot bring it back (J9.4)
 *     tally: [[device, plus, minus]]  // stock lists: a PN-counter (J18.17)
 *   }
 *
 * `items` holds tombstones too. Everything that reads a list for a person
 * goes through `rows`, `children` or `liveItems`, which leave them out.
 */
(function (global) {
  "use strict";

  const KINDS = ["checklist", "stock"];
  const MAX_NAME_CHARS = 80;
  const MAX_TEXT_CHARS = 200;
  // How many items a person (or the agent) may have on one list.
  const MAX_LIVE = 300;
  // How many a list holds, tombstones included. The difference is room
  // for deletions to be remembered; past it the oldest tombstones go
  // first, which only matters to a device offline since before them.
  const MAX_ITEMS = 400;
  // Devices with a tally on one counter. A household has a handful.
  const MAX_DEVICES = 8;
  const MAX_TALLY = 99999;
  const MAX_KEY_CHARS = 128;
  // The server's own limit (migration 012), restated for the test that
  // checks a list at every cap still fits under it.
  const SERVER_MAX_BYTES = 1000000;
  // A stamp past this is a broken clock; capped so `+ 1` always works.
  const MAX_STAMP = Date.UTC(2200, 0, 1);

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const DEVICE_RE = /^[A-Za-z0-9]{8,24}$/;
  const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function newId() {
    const c = global.crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    return uuidFromBytes(b);
  }

  function uuidFromBytes(b) {
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  /**
   * A uuid that is a function of its parts. Moving a book's plan into a
   * list is done by whichever device opens the book first, and two doing
   * it at once must make one list, not two — so the list's id comes from
   * the book's, and its items' from the plan's (build step 1). cyrb128: a
   * small, well-mixed 128-bit hash; this is naming, not security.
   */
  function derivedId(...parts) {
    const str = parts.map(String).join("|");
    let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
    for (let i = 0; i < str.length; i++) {
      const k = str.charCodeAt(i);
      h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
      h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
      h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
      h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
    }
    h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
    h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
    h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
    h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
    h1 ^= h2 ^ h3 ^ h4;
    h2 ^= h1;
    h3 ^= h1;
    h4 ^= h1;
    const b = new Uint8Array(16);
    [h1, h2, h3, h4].forEach((h, i) => {
      for (let j = 0; j < 4; j++) b[i * 4 + j] = (h >>> (24 - j * 8)) & 0xff;
    });
    b[6] = (b[6] & 0x0f) | 0x80; // version 8: "made by this app's own rule"
    b[8] = (b[8] & 0x3f) | 0x80;
    return uuidFromBytes(b);
  }

  /** A stamp: a finite moment, capped, or null. */
  function stamp(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.min(Math.round(n), MAX_STAMP);
  }

  /**
   * The stamp for a change to a fact: now, but never at or before what it
   * replaces — so one hand cannot tie with itself, and a phone whose clock
   * is behind can still change what another phone said (as plan.js does).
   */
  function after(previous, now) {
    const n = stamp(now) ?? 0;
    const p = stamp(previous);
    return p === null ? n : Math.min(MAX_STAMP, Math.max(n, p + 1));
  }

  /**
   * One line of text: whitespace runs (line breaks among them, J18.6)
   * become one space, and it is cut to `max` UTF-16 units without leaving
   * half a character — a lone surrogate is JSON Postgres refuses.
   */
  function cleanText(text, max = MAX_TEXT_CHARS) {
    let s = String(text == null ? "" : text)
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (s.length > max) {
      const code = s.charCodeAt(max - 1);
      s = s.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max).trim();
    }
    return s;
  }

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // ---------------------------------------------------------------------
  // Fractional order keys
  //
  // An item's place among its siblings is a string, and siblings sort by
  // it. A new place is a new string between two others, so moving one
  // item writes one item, and two phones inserting in the same gap make
  // two items rather than a clash (ties sort by id). Base 62, never
  // ending in the lowest digit, so there is always room between two keys.
  // ---------------------------------------------------------------------

  const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const KEY_RE = new RegExp(`^[0-9A-Za-z]{0,${MAX_KEY_CHARS - 1}}[1-9A-Za-z]$`);
  const isKey = (k) => typeof k === "string" && KEY_RE.test(k);

  function keyMid(a, b) {
    if (b !== null) {
      let n = 0;
      while ((a[n] || "0") === b[n]) n++;
      if (n > 0) return b.slice(0, n) + keyMid(a.slice(n), b.slice(n));
    }
    const da = a ? DIGITS.indexOf(a[0]) : 0;
    const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
    if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
    if (b !== null && b.length > 1) return b.slice(0, 1);
    return DIGITS[da] + keyMid(a.slice(1), null);
  }

  /** A key after `a`, growing as slowly as it can (typing a list out). */
  function keyAfter(a) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== "z") return a.slice(0, i) + DIGITS[DIGITS.indexOf(a[i]) + 1];
    }
    return a + "V";
  }

  /** A key before `b` (a recipe goes on at the top, J18.18). */
  function keyBefore(b) {
    for (let i = 0; i < b.length; i++) {
      const d = DIGITS.indexOf(b[i]);
      if (d > 1) return b.slice(0, i) + DIGITS[d - 1];
    }
    return keyMid("", b);
  }

  /** A key strictly between `a` and `b`; either may be null (an end). */
  function keyBetween(a, b) {
    const lo = isKey(a) ? a : null;
    const hi = isKey(b) ? b : null;
    if (lo === null && hi === null) return "V";
    if (hi === null) return keyAfter(lo);
    if (lo === null) return keyBefore(hi);
    // Equal neighbours — two phones chose the same key — have nothing
    // between them; just after the first is the nearest honest place.
    if (lo >= hi) return keyAfter(lo);
    return keyMid(lo, hi);
  }

  // ---------------------------------------------------------------------
  // Coercion: everything read from storage or the server comes through
  // ---------------------------------------------------------------------

  /** A counter's tallies, one per device, in a canonical order. */
  function sanitizeTally(raw) {
    if (!Array.isArray(raw)) return [];
    const byDevice = new Map();
    for (const entry of raw) {
      if (!Array.isArray(entry) || !DEVICE_RE.test(entry[0])) continue;
      const count = (v) => {
        const n = Math.floor(Number(v));
        return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TALLY) : 0;
      };
      const held = byDevice.get(entry[0]);
      const plus = count(entry[1]);
      const minus = count(entry[2]);
      byDevice.set(entry[0], held ? [entry[0], Math.max(held[1], plus), Math.max(held[2], minus)] : [entry[0], plus, minus]);
    }
    let all = [...byDevice.values()];
    if (all.length > MAX_DEVICES) {
      // The busiest devices stay; chosen the same way on every copy.
      all = all.sort((x, y) => y[1] + y[2] - (x[1] + x[2]) || cmp(x[0], y[0])).slice(0, MAX_DEVICES);
    }
    return all.sort((x, y) => cmp(x[0], y[0]));
  }

  function sanitizeItem(raw) {
    if (!raw || typeof raw !== "object" || !isUuid(raw.id)) return null;
    const id = raw.id.toLowerCase();
    const parent = isUuid(raw.parentId) ? raw.parentId.toLowerCase() : null;
    const addedAt = stamp(raw.addedAt) ?? 0;
    return {
      id,
      addedAt,
      parentId: parent === id ? null : parent,
      order: isKey(raw.order) ? raw.order : "V",
      posAt: stamp(raw.posAt) ?? addedAt,
      text: cleanText(raw.text),
      textAt: stamp(raw.textAt) ?? addedAt,
      ticked: raw.ticked === true,
      tickAt: stamp(raw.tickAt) ?? 0,
      gone: raw.gone === true,
      goneAt: stamp(raw.goneAt) ?? 0,
      tally: sanitizeTally(raw.tally),
    };
  }

  /**
   * The items, deduplicated (two copies of an id merge) and sorted by id,
   * so that two lists holding the same facts are the same JSON. Over
   * MAX_ITEMS the oldest tombstones go first; then, if live items alone
   * are over (two phones each filling a list offline), the newest stay.
   */
  function sanitizeItems(raw) {
    if (!Array.isArray(raw)) return [];
    const byId = new Map();
    for (const one of raw) {
      const item = sanitizeItem(one);
      if (!item) continue;
      const held = byId.get(item.id);
      byId.set(item.id, held ? mergeItem(held, item) : item);
    }
    let all = [...byId.values()];
    if (all.length > MAX_ITEMS) {
      const live = all.filter((i) => !i.gone).sort((a, b) => b.addedAt - a.addedAt || cmp(a.id, b.id)).slice(0, MAX_ITEMS);
      const gone = all
        .filter((i) => i.gone)
        .sort((a, b) => b.goneAt - a.goneAt || cmp(a.id, b.id))
        .slice(0, MAX_ITEMS - live.length);
      all = [...live, ...gone];
    }
    return all.sort((a, b) => cmp(a.id, b.id));
  }

  /** Coerce an untrusted object into a list, or null. */
  function sanitizeList(raw) {
    if (!raw || typeof raw !== "object" || !isUuid(raw.id)) return null;
    const kind = KINDS.includes(raw.kind) ? raw.kind : null;
    if (!kind) return null;
    return {
      id: raw.id.toLowerCase(),
      name: cleanText(raw.name, MAX_NAME_CHARS) || "List",
      nameAt: stamp(raw.nameAt) ?? 0,
      kind,
      createdAt: stamp(raw.createdAt) ?? 0,
      items: sanitizeItems(raw.items),
    };
  }

  // ---------------------------------------------------------------------
  // Merging two copies (J18.22, J18.23)
  //
  // Per item, and per fact within it: where it is, what it says, its
  // tick, whether it is deleted, and its counter each merge on their own,
  // so an edit on one phone and a tick on the other both survive. Every
  // tie is broken on the values, so merging is commutative, associative
  // and idempotent and two phones reach the same list in any order.
  // ---------------------------------------------------------------------

  function later(a, b, at, tie) {
    if (a[at] !== b[at]) return a[at] > b[at] ? a : b;
    return tie(a) >= tie(b) ? a : b;
  }

  function mergeTally(a, b) {
    return sanitizeTally([...a, ...b]);
  }

  function mergeItem(a, b) {
    const pos = later(a, b, "posAt", (i) => `${i.parentId || ""}/${i.order}`);
    const words = later(a, b, "textAt", (i) => i.text);
    const tick = later(a, b, "tickAt", (i) => (i.ticked ? 1 : 0));
    const gone = later(a, b, "goneAt", (i) => (i.gone ? 1 : 0));
    return {
      id: a.id,
      addedAt: Math.min(a.addedAt, b.addedAt),
      parentId: pos.parentId,
      order: pos.order,
      posAt: pos.posAt,
      text: words.text,
      textAt: words.textAt,
      ticked: tick.ticked,
      tickAt: tick.tickAt,
      gone: gone.gone,
      goneAt: gone.goneAt,
      tally: mergeTally(a.tally, b.tally),
    };
  }

  /** Two copies of one list. Either may be null. */
  function mergeLists(a, b) {
    if (!a) return b ? sanitizeList(b) : null;
    if (!b) return sanitizeList(a);
    const x = sanitizeList(a);
    const y = sanitizeList(b);
    if (!x || !y) return x || y;
    const named = later(x, y, "nameAt", (l) => l.name);
    return {
      id: x.id,
      name: named.name,
      nameAt: named.nameAt,
      // The kind never changes (J18.2); two that disagree are corrupt,
      // and settle the same way on every device.
      kind: x.kind === y.kind ? x.kind : [x.kind, y.kind].sort()[0],
      createdAt: Math.min(x.createdAt, y.createdAt),
      items: sanitizeItems([...x.items, ...y.items]),
    };
  }

  /** The same list, fact for fact? (What sync asks before pushing.) */
  function sameItems(a, b) {
    return JSON.stringify(sanitizeItems(a && a.items)) === JSON.stringify(sanitizeItems(b && b.items));
  }

  // ---------------------------------------------------------------------
  // Reading the tree
  // ---------------------------------------------------------------------

  /** Items that have not been deleted. */
  function liveItems(list) {
    return ((list && list.items) || []).filter((i) => !i.gone);
  }

  /**
   * Where each live item really sits. Its `parentId`, unless that parent
   * is deleted or missing (it was deleted on another phone while this one
   * nested something under it), or two phones' moves made a loop — then
   * at the top level. A loop is broken at its smallest id, so every
   * device draws the same list.
   */
  function tree(list) {
    const live = liveItems(list);
    const byId = new Map(live.map((i) => [i.id, i]));
    const parent = new Map();
    for (const i of live) parent.set(i.id, i.parentId && byId.has(i.parentId) ? i.parentId : null);
    const state = new Map();
    for (const start of live) {
      const path = [];
      let at = start.id;
      while (at !== null && !state.has(at)) {
        state.set(at, "walking");
        path.push(at);
        at = parent.get(at);
      }
      if (at !== null && state.get(at) === "walking") {
        const loop = path.slice(path.indexOf(at));
        parent.set(loop.reduce((m, id) => (id < m ? id : m)), null);
      }
      for (const id of path) state.set(id, "done");
    }
    const kids = new Map();
    for (const i of live) {
      const p = parent.get(i.id);
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(i);
    }
    for (const group of kids.values()) group.sort((a, b) => cmp(a.order, b.order) || cmp(a.id, b.id));
    return { byId, parent, kids };
  }

  /** The live children of `parentId` (null: the top level), in key order. */
  function children(list, parentId = null) {
    return tree(list).kids.get(parentId || null) || [];
  }

  /** An item and everything nested under it, live only. */
  function subtree(list, id, t = tree(list)) {
    if (!t.byId.has(id)) return [];
    const out = [id];
    for (let i = 0; i < out.length; i++) {
      for (const k of t.kids.get(out[i]) || []) out.push(k.id);
    }
    return out;
  }

  /** A counter's raw value: 1, plus every +, less every − (J18.14). */
  function rawCount(item) {
    let n = 1;
    for (const [, plus, minus] of (item && item.tally) || []) n += plus - minus;
    return n;
  }

  /** What the counter shows: never below 0 (J18.15). */
  function count(item) {
    return Math.max(0, rawCount(item));
  }

  /** Has something nested under it — on a stock list, a heading (J18.16). */
  function isHeading(list, id, t = tree(list)) {
    return (t.kids.get(id) || []).length > 0;
  }

  /**
   * The list as it is drawn, top to bottom.
   *
   *   { type: "item", id, item, depth, parentId, hasChildren,
   *     counter: number|null, faded }      // counter/faded: stock lists
   *   { type: "ticked", parentId, depth, count, open }   // checklists
   *
   * On a checklist the ticked children of each item — and of the list —
   * fold into one "Ticked (n)" row after the unticked ones (J18.12).
   * `open` is a Set of the parentIds whose group is open, "" for the top
   * level. Inside an open group everything is drawn as it stands.
   */
  function rows(list, open = new Set()) {
    if (!list) return [];
    const t = tree(list);
    const stock = list.kind === "stock";
    const out = [];
    const itemRow = (item, depth) => {
      const hasChildren = (t.kids.get(item.id) || []).length > 0;
      const counter = stock && !hasChildren ? count(item) : null;
      out.push({
        type: "item",
        id: item.id,
        item,
        depth,
        parentId: t.parent.get(item.id),
        hasChildren,
        counter,
        faded: counter === 0,
      });
    };
    const walk = (parentId, depth, plain) => {
      const kids = t.kids.get(parentId) || [];
      if (stock || plain) {
        for (const k of kids) {
          itemRow(k, depth);
          walk(k.id, depth + 1, plain);
        }
        return;
      }
      const ticked = [];
      for (const k of kids) {
        if (k.ticked) {
          ticked.push(k);
          continue;
        }
        itemRow(k, depth);
        walk(k.id, depth + 1, false);
      }
      if (ticked.length === 0) return;
      const isOpen = open.has(parentId || "");
      out.push({ type: "ticked", parentId, depth, count: ticked.length, open: isOpen });
      if (!isOpen) return;
      for (const k of ticked) {
        itemRow(k, depth);
        walk(k.id, depth + 1, true);
      }
    };
    walk(null, 0, false);
    return out;
  }

  /** Ticked items and what is nested under them: what Clear ticked takes (J18.13). */
  function tickedIds(list) {
    const t = tree(list);
    const out = new Set();
    for (const item of t.byId.values()) {
      if (item.ticked) for (const id of subtree(list, item.id, t)) out.add(id);
    }
    return [...out];
  }

  // ---------------------------------------------------------------------
  // Changing a list. Each returns a new list, or the same one if nothing
  // changed — so a caller can tell a no-op by identity.
  // ---------------------------------------------------------------------

  function createList({ name, kind, id, now = Date.now() } = {}) {
    if (!KINDS.includes(kind)) throw new Error(`a list is a checklist or a stock list, not ${kind}`);
    return {
      id: id || newId(),
      name: cleanText(name, MAX_NAME_CHARS) || "List",
      nameAt: stamp(now) ?? 0,
      kind,
      createdAt: stamp(now) ?? 0,
      items: [],
    };
  }

  function rename(list, name, now = Date.now()) {
    const words = cleanText(name, MAX_NAME_CHARS);
    if (!words || words === list.name) return list;
    return { ...list, name: words, nameAt: after(list.nameAt, now) };
  }

  function withItems(list, changed) {
    const map = new Map(list.items.map((i) => [i.id, i]));
    for (const i of changed) map.set(i.id, i);
    return { ...list, items: [...map.values()].sort((a, b) => cmp(a.id, b.id)) };
  }

  /**
   * The order key for a place among `parentId`'s children. `place` is
   * one of { afterId }, { beforeId }, { atTop: true }, or nothing (the
   * end). On a checklist the neighbours are taken from the moving item's
   * own side of the fold, so a key is never squeezed between an unticked
   * item and a ticked one that sort the other way round.
   */
  function placeKey(list, parentId, place = {}, { exclude = null, ticked = false } = {}, t = tree(list)) {
    let sibs = (t.kids.get(parentId || null) || []).filter((i) => i.id !== exclude);
    if (list.kind === "checklist") sibs = sibs.filter((i) => i.ticked === ticked);
    if (place.afterId) {
      const at = sibs.findIndex((i) => i.id === place.afterId);
      if (at >= 0) return keyBetween(sibs[at].order, sibs[at + 1] ? sibs[at + 1].order : null);
    }
    if (place.beforeId) {
      const at = sibs.findIndex((i) => i.id === place.beforeId);
      if (at >= 0) return keyBetween(at > 0 ? sibs[at - 1].order : null, sibs[at].order);
    }
    if (place.atTop) return keyBetween(null, sibs[0] ? sibs[0].order : null);
    return keyBetween(sibs.length ? sibs[sibs.length - 1].order : null, null);
  }

  function freshItem({ id, text, parentId, order, now }) {
    const at = stamp(now) ?? 0;
    return {
      id: id || newId(),
      addedAt: at,
      parentId: parentId || null,
      order,
      posAt: at,
      text: cleanText(text),
      textAt: at,
      ticked: false,
      tickAt: 0,
      gone: false,
      goneAt: 0,
      tally: [],
    };
  }

  /**
   * Add one item. With `afterId` it goes directly below that item at the
   * same depth (J18.7: Enter); with `atTop`, first under its parent;
   * otherwise last. Text may be empty — Enter makes the line before
   * anything is typed in it, and leaving it empty deletes it (J18.10),
   * which is the caller's to do. Refused (same list back) when the list
   * is full.
   */
  function addItem(list, { text = "", parentId = null, afterId, beforeId, atTop, id, now = Date.now() } = {}) {
    const t = tree(list);
    if (t.byId.size >= MAX_LIVE) return list;
    let parent = parentId;
    if (afterId && t.byId.has(afterId)) parent = t.parent.get(afterId);
    if (parent && !t.byId.has(parent)) parent = null;
    const order = placeKey(list, parent, { afterId, beforeId, atTop }, {}, t);
    return withItems(list, [freshItem({ id, text, parentId: parent, order, now })]);
  }

  /**
   * Add a tree — `{ text, children: [{ text, children }] }`, as
   * `recipeItems` makes — under `parentId`, at the top or the end.
   * `makeId(node, path)` names each item; it defaults to a fresh uuid.
   * Refused whole when it would not fit.
   */
  function addTree(list, node, { parentId = null, atTop = false, now = Date.now(), makeId } = {}) {
    const flat = [];
    const visit = (n, path) => {
      flat.push([n, path]);
      (n.children || []).forEach((c, i) => visit(c, [...path, i]));
    };
    visit(node, []);
    const t = tree(list);
    if (t.byId.size + flat.length > MAX_LIVE) return list;
    const ids = new Map();
    const made = [];
    const lastKey = [];
    for (const [n, path] of flat) {
      const id = makeId ? makeId(n, path) : newId();
      ids.set(path.join("."), id);
      let order;
      let parent;
      if (path.length === 0) {
        parent = parentId && t.byId.has(parentId) ? parentId : null;
        order = placeKey(list, parent, atTop ? { atTop: true } : {}, {}, t);
      } else {
        parent = ids.get(path.slice(0, -1).join("."));
        // Siblings of a new item are new too: number them in turn.
        order = path[path.length - 1] === 0 ? "V" : keyAfter(lastKey[path.length]);
      }
      lastKey[path.length] = order;
      made.push(freshItem({ id, text: n.text, parentId: parent, order, now }));
    }
    return withItems(list, made);
  }

  /** Change what an item says (J18.6). Empty or unchanged text is no change. */
  function editText(list, id, text, now = Date.now()) {
    const item = list.items.find((i) => i.id === id && !i.gone);
    const words = cleanText(text);
    if (!item || !words || words === item.text) return list;
    return withItems(list, [{ ...item, text: words, textAt: after(item.textAt, now) }]);
  }

  /** Put an item somewhere else: `{ parentId, afterId | beforeId | atTop }` (J18.9). */
  function move(list, id, { parentId = null, afterId, beforeId, atTop } = {}, now = Date.now()) {
    const t = tree(list);
    const item = t.byId.get(id);
    if (!item) return list;
    let parent = parentId && t.byId.has(parentId) ? parentId : null;
    if (afterId && t.byId.has(afterId)) parent = t.parent.get(afterId);
    if (beforeId && t.byId.has(beforeId)) parent = t.parent.get(beforeId);
    // Not under itself, nor under anything nested in it.
    if (parent && subtree(list, id, t).includes(parent)) return list;
    if (afterId === id || beforeId === id) return list;
    const order = placeKey(list, parent, { afterId, beforeId, atTop }, { exclude: id, ticked: item.ticked }, t);
    if (parent === item.parentId && order === item.order) return list;
    return withItems(list, [{ ...item, parentId: parent, order, posAt: after(item.posAt, now) }]);
  }

  /**
   * Nest an item under the one above it at its depth, as that item's last
   * child (J18.8). Nothing above it at its depth: no change.
   */
  function indent(list, id, now = Date.now()) {
    const t = tree(list);
    const item = t.byId.get(id);
    if (!item) return list;
    let sibs = t.kids.get(t.parent.get(id)) || [];
    // The one above as drawn: on a checklist, from the same side of the fold.
    if (list.kind === "checklist") sibs = sibs.filter((i) => i.ticked === item.ticked);
    const at = sibs.findIndex((i) => i.id === id);
    if (at <= 0) return list;
    const above = sibs[at - 1];
    const last = (t.kids.get(above.id) || []).filter((i) => i.id !== id);
    const order = keyBetween(last.length ? last.map((i) => i.order).sort().pop() : null, null);
    return withItems(list, [{ ...item, parentId: above.id, order, posAt: after(item.posAt, now) }]);
  }

  /**
   * Bring an item out one level, to just after the item it was under
   * (J18.8). What was nested under it comes with it; its siblings below it
   * stay where they are. At the top level already: no change.
   */
  function outdent(list, id, now = Date.now()) {
    const t = tree(list);
    const item = t.byId.get(id);
    const parent = item && t.parent.get(id);
    if (!parent) return list;
    const grand = t.parent.get(parent);
    const sibs = t.kids.get(grand) || [];
    const at = sibs.findIndex((i) => i.id === parent);
    const order = keyBetween(sibs[at].order, sibs[at + 1] ? sibs[at + 1].order : null);
    return withItems(list, [{ ...item, parentId: grand, order, posAt: after(item.posAt, now) }]);
  }

  /**
   * Tick or untick an item and everything nested under it (J18.11).
   * Unticking also unticks the items it is nested in — only those, not
   * their other children — so that it comes back where it was (J18.12)
   * rather than staying folded away inside a ticked parent.
   */
  function setTicked(list, id, ticked, now = Date.now()) {
    if (list.kind !== "checklist") return list;
    const t = tree(list);
    if (!t.byId.has(id)) return list;
    const ids = subtree(list, id, t);
    if (!ticked) {
      for (let p = t.parent.get(id); p; p = t.parent.get(p)) ids.push(p);
    }
    const changed = ids
      .map((i) => t.byId.get(i))
      .filter((i) => i.ticked !== Boolean(ticked))
      .map((i) => ({ ...i, ticked: Boolean(ticked), tickAt: after(i.tickAt, now) }));
    return changed.length ? withItems(list, changed) : list;
  }

  /**
   * Delete items. Pass what `subtree` or `tickedIds` returns: deleting an
   * item takes what is nested under it, and keeping the ids is what makes
   * Undo possible (J18.10, J18.13).
   */
  function deleteItems(list, ids, now = Date.now()) {
    const want = new Set(ids);
    const changed = list.items
      .filter((i) => want.has(i.id) && !i.gone)
      .map((i) => ({ ...i, gone: true, goneAt: after(i.goneAt, now) }));
    return changed.length ? withItems(list, changed) : list;
  }

  /** Undo a delete: the same ids back, with everything they had. */
  function restoreItems(list, ids, now = Date.now()) {
    const want = new Set(ids);
    const changed = list.items
      .filter((i) => want.has(i.id) && i.gone)
      .map((i) => ({ ...i, gone: false, goneAt: after(i.goneAt, now) }));
    return changed.length ? withItems(list, changed) : list;
  }

  /**
   * One tap on + or − (J18.14). Each device counts its own taps, and the
   * value is 1 plus all the +s less all the −s, so two phones each taking
   * one off "Bolognese 4" leave 2 (J18.17).
   *
   * Nothing goes below 0 (J18.15): − at 0 does nothing. Two phones each
   * taking the last one off leave the sum at −1, which shows as 0; + from
   * there adds what it takes to show 1, so the tap still means "one more".
   * A heading has no counter (J18.16).
   */
  function bump(list, id, delta, deviceId) {
    if (list.kind !== "stock" || !DEVICE_RE.test(deviceId || "")) return list;
    const t = tree(list);
    const item = t.byId.get(id);
    if (!item || isHeading(list, id, t)) return list;
    const raw = rawCount(item);
    let plus = 0;
    let minus = 0;
    if (delta > 0) plus = raw < 0 ? 1 - raw : 1;
    else if (delta < 0 && raw > 0) minus = 1;
    if (!plus && !minus) return list;
    const tally = item.tally.map((e) => [...e]);
    const mine = tally.find((e) => e[0] === deviceId);
    if (mine) {
      mine[1] = Math.min(MAX_TALLY, mine[1] + plus);
      mine[2] = Math.min(MAX_TALLY, mine[2] + minus);
    } else {
      tally.push([deviceId, plus, minus]);
    }
    return withItems(list, [{ ...item, tally: sanitizeTally(tally) }]);
  }

  // ---------------------------------------------------------------------
  // A recipe as items (J18.18)
  // ---------------------------------------------------------------------

  /**
   * A recipe as a tree for `addTree`: its name, with each ingredient
   * under it, scaled to `portions` and in the reader's units (J8). The
   * same reading the recipe view gives: scaled first, then converted.
   *
   * `portions` is servings where the recipe says how many it serves; where
   * it does not, it is the multiplier the J4.2 stepper shows (× 1, × 1½).
   */
  function recipeItems(recipe, portions, prefs) {
    const servings = Number(recipe && recipe.servings) > 0 ? Number(recipe.servings) : 0;
    const wanted = Number(portions) > 0 ? Number(portions) : 0;
    const factor = wanted ? (servings ? wanted / servings : wanted) : 1;
    const children = [];
    for (const ing of (recipe && recipe.ingredients) || []) {
      if (!ing) continue;
      const hasAmount = ing.amount !== null && ing.amount !== undefined && Number(ing.amount) > 0;
      const scaled = hasAmount ? { ...ing, amount: Number(ing.amount) * factor } : ing;
      const shown = global.RecipeUnits ? global.RecipeUnits.convertIngredient(scaled, prefs || {}) : scaled;
      const text = cleanText(global.RecipeScale.ingredientText(shown, 1));
      if (text) children.push({ text, children: [] });
    }
    return { text: cleanText(recipe && recipe.name) || "Recipe", children };
  }

  // ---------------------------------------------------------------------
  // The plan becomes a list (build step 1)
  // ---------------------------------------------------------------------

  /** The id of the "Shopping" list a book's plan moves into. */
  function shoppingListId(bookId) {
    return derivedId("recipe-friend:shopping", String(bookId).toLowerCase());
  }

  /**
   * A book's live plan as the "Shopping" checklist. Every id and stamp
   * here is a function of the plan, so two devices doing this at once
   * write the same list: each planned recipe becomes a recipe item at its
   * planned portions (its id is the meal's), each line typed by hand an
   * item with its tick (✓ and ✗ both read as ticked — either way it is
   * not to buy), in the order the plan held them. Lines taken off are
   * left behind, as are settled amounts.
   */
  function fromPlan(plan, recipes, bookId, prefs) {
    const p = plan || {};
    const byId = new Map(((recipes || []).filter(Boolean)).map((r) => [r.id, r]));
    let list = {
      id: shoppingListId(bookId),
      name: "Shopping",
      // Zero, so any rename made since wins on every device.
      nameAt: 0,
      kind: "checklist",
      createdAt: stamp(p.createdAt) ?? 0,
      items: [],
    };
    for (const meal of Array.isArray(p.meals) ? p.meals : []) {
      if (!meal || !isUuid(meal.id)) continue;
      const recipe = byId.get(meal.recipeId);
      const servings = Number(recipe && recipe.servings) > 0;
      const portions = servings && Number(meal.portions) > 0 ? Number(meal.portions) : Number(meal.multiplier) || 1;
      const node = recipe
        ? recipeItems(recipe, portions, prefs)
        : { text: cleanText(meal.name) || "Recipe", children: [] };
      list = addTree(list, node, {
        now: stamp(meal.addedAt) ?? 0,
        makeId: (_, path) => (path.length === 0 ? meal.id.toLowerCase() : derivedId("recipe-friend:plan", meal.id, ...path)),
      });
    }
    for (const line of Array.isArray(p.items) ? p.items : []) {
      if (!line || !isUuid(line.id) || line.state === "removed" || !cleanText(line.text)) continue;
      const addedAt = stamp(line.addedAt) ?? 0;
      list = addItem(list, { text: line.text, id: line.id.toLowerCase(), now: addedAt });
      const item = list.items.find((i) => i.id === line.id.toLowerCase());
      if (!item) continue; // full
      const ticked = line.state === "got" || line.state === "have";
      list = withItems(list, [
        { ...item, textAt: stamp(line.textAt) ?? addedAt, ticked, tickAt: ticked ? stamp(line.at) ?? addedAt : 0 },
      ]);
    }
    return sanitizeList(list);
  }

  global.RecipeLists = {
    KINDS,
    limits: { MAX_NAME_CHARS, MAX_TEXT_CHARS, MAX_LIVE, MAX_ITEMS, MAX_DEVICES, MAX_TALLY, MAX_KEY_CHARS, SERVER_MAX_BYTES },
    newId,
    derivedId,
    cleanText,
    keyBetween,
    sanitizeList,
    sanitizeItem,
    mergeItem,
    mergeLists,
    sameItems,
    liveItems,
    children,
    subtree,
    tickedIds,
    rows,
    count,
    isHeading,
    createList,
    rename,
    addItem,
    addTree,
    editText,
    move,
    indent,
    outdent,
    setTicked,
    deleteItems,
    restoreItems,
    bump,
    recipeItems,
    shoppingListId,
    fromPlan,
  };
})(window);
