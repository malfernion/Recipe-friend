/**
 * scale.js — portion scaling for free-text ingredient lines.
 *
 * Only the leading quantity of a line is scaled ("200g spaghetti",
 * "1½ tbsp oil", "2-3 carrots"); lines with no leading number ("flaked sea
 * salt") pass through unchanged. Scaled values render as kitchen-friendly
 * fractions where they land near one, decimals otherwise.
 */
(function (global) {
  "use strict";

  const UNICODE_FRACTIONS = {
    "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4,
    "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5, "⅘": 4 / 5,
    "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8,
  };
  const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join("");

  // One quantity: "1 1/2", "1½", "1/2", "½", "1.5", "200"
  const QTY = `(?:\\d+(?:\\.\\d+)?(?:\\s*(?:\\d+\\s*\\/\\s*\\d+|[${FRACTION_CHARS}]))?|\\d+\\s*\\/\\s*\\d+|[${FRACTION_CHARS}])`;
  // Leading quantity, optionally a range ("2-3", "2 – 3")
  const LEADING = new RegExp(`^(\\s*)(${QTY})(\\s*[-–]\\s*(${QTY}))?`);

  function quantityToNumber(text) {
    let s = text.trim();
    let total = 0;
    const mixed = s.match(new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(\\d+\\s*\\/\\s*\\d+|[${FRACTION_CHARS}])$`));
    if (mixed) {
      total += Number(mixed[1]);
      s = mixed[2];
    }
    const slash = s.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (slash) return total + Number(slash[1]) / Number(slash[2]);
    if (s in UNICODE_FRACTIONS) return total + UNICODE_FRACTIONS[s];
    return total + Number(s);
  }

  // Fractions people actually measure with — fifths and sixths parse fine
  // but never render ("⅘ litres" helps nobody; that shows as 0.8).
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
    const rounded = Math.round(value * 10) / 10;
    return String(rounded);
  }

  /** Scale the leading quantity of one ingredient line. */
  function scaleIngredient(line, factor) {
    if (factor === 1) return line;
    const match = line.match(LEADING);
    if (!match) return line;
    const [full, lead, first, , second] = match;
    const scaledFirst = formatQuantity(quantityToNumber(first) * factor);
    let replacement = lead + scaledFirst;
    if (second) replacement += "–" + formatQuantity(quantityToNumber(second) * factor);
    return replacement + line.slice(full.length);
  }

  global.RecipeScale = { scaleIngredient, formatQuantity, quantityToNumber };
})(window);
