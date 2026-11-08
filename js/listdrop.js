/**
 * listdrop.js — where a dragged item lands (J18.9).
 *
 * Pure, like lists.js: the screen works out which row the item was let go
 * after and how far left or right it was carried, and this turns that into
 * a place RecipeLists.move understands. Kept apart from app.js so the one
 * part of dragging that is arithmetic can be tested without a finger.
 */
(function (global) {
  "use strict";

  /**
   * The depths an item may land at between two rows. No deeper than one
   * under the row above, and no shallower than the row below — dropped
   * shallower, the row below would stay nested where it was and draw
   * above the item, which is not where it was let go.
   */
  function depthRange(prev, next) {
    const max = prev ? prev.depth + 1 : 0;
    const min = Math.min(next ? next.depth : 0, max);
    return { min, max };
  }

  /**
   * `rows` are the item rows as drawn (RecipeLists.rows, items only),
   * without the dragged item and what is nested under it. `prevIndex` is
   * the row it was let go after (-1: the top), and `depth` the depth it
   * was carried to. Returns `{ depth, parentId, afterId }` or
   * `{ depth, parentId, atTop: true }`.
   */
  function place(rows, prevIndex, depth) {
    const prev = prevIndex >= 0 ? rows[prevIndex] || null : null;
    const next = rows[prevIndex + 1] || null;
    const { min, max } = depthRange(prev, next);
    const d = Math.max(min, Math.min(max, Math.round(Number(depth) || 0)));
    if (!prev) return { depth: 0, parentId: null, atTop: true };
    if (d === prev.depth + 1) return { depth: d, parentId: prev.id, atTop: true };
    // The row above at this depth is the one it goes after: the nearest
    // row up the list at that depth or shallower, which is prev's own
    // ancestor at that depth (or prev itself).
    for (let i = prevIndex; i >= 0; i--) {
      if (rows[i].depth <= d) return { depth: d, parentId: rows[i].parentId || null, afterId: rows[i].id };
    }
    return { depth: 0, parentId: null, atTop: true };
  }

  global.RecipeListDrop = { depthRange, place };
})(window);
