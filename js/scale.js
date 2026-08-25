/**
 * scale.js — quantity helpers for structured ingredients.
 *
 * An ingredient is {amount: number|null, unit: string, item: string}.
 * Scaling multiplies the amount field — no free-text parsing anywhere.
 */
(function (global) {
  "use strict";

  const UNICODE_FRACTIONS = {
    "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4,
    "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5, "⅘": 4 / 5,
    "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8,
  };
  const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join("");

  /**
   * Parse a quantity string a person would type into the amount field:
   * "200", "1.5", "1/2", "1 1/2", "½", "1½". Returns a number or null.
   */
  function quantityToNumber(text) {
    let s = String(text).trim();
    if (!s) return null;
    let total = 0;
    const mixed = s.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(\\d+\\s*\\/\\s*\\d+|[${FRACTION_CHARS}])$`));
    if (mixed) {
      total += Number(mixed[1]);
      s = mixed[2];
    }
    const slash = s.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (slash && Number(slash[2]) !== 0) return total + Number(slash[1]) / Number(slash[2]);
    if (s in UNICODE_FRACTIONS) return total + UNICODE_FRACTIONS[s];
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? total + n : null;
  }

  // Fractions people actually measure with — others render as decimals.
  const DISPLAY_FRACTIONS = ["½", "⅓", "⅔", "¼", "¾", "⅛", "⅜", "⅝", "⅞"];

  /** Render a number as a kitchen quantity: 0.5 → "½", 1.5 → "1½", 2.67 → "2.7". */
  function formatQuantity(value) {
    if (!Number.isFinite(value) || value <= 0) return String(value);
    const whole = Math.floor(value + 1e-9);
    const frac = value - whole;
    let best = null;
    for (const ch of DISPLAY_FRACTIONS) {
      const v = UNICODE_FRACTIONS[ch];
      if (Math.abs(frac - v) < 0.03 && (!best || Math.abs(frac - v) < best.d)) {
        best = { ch, d: Math.abs(frac - v) };
      }
    }
    if (frac < 0.03) return String(whole);
    if (frac > 0.97) return String(whole + 1);
    if (best) return (whole ? whole : "") + best.ch;
    return String(Math.round(value * 10) / 10);
  }

  /** One display line for an ingredient, scaled by factor. */
  function ingredientText(ing, factor = 1) {
    const parts = [];
    if (ing.amount !== null && ing.amount !== undefined) {
      parts.push(formatQuantity(ing.amount * factor));
    }
    if (ing.unit) parts.push(ing.unit);
    if (ing.item) parts.push(ing.item);
    return parts.join(" ");
  }

  global.RecipeScale = { quantityToNumber, formatQuantity, ingredientText };
})(window);
