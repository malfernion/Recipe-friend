/**
 * html.js — escaping, in one place.
 *
 * The app builds its markup with template strings, so this function is
 * what stands between a recipe name and the page. It had two identical
 * copies, in app.js and books.js, which is one more than a thing like this
 * should ever have: a fix or a hardening applied to one would silently
 * leave the other behind.
 *
 * Covers the five characters that matter for text and for quoted attribute
 * values. Every attribute in this app is quoted; an unquoted one would not
 * be safe with this or any other escaper.
 */
(function (global) {
  "use strict";

  function escapeHTML(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  global.RecipeHTML = { escapeHTML };
})(window);
