/**
 * units.js — measurement preferences and unit conversion.
 *
 * Two convertible families: mass (g/kg/oz/lb) and volume (ml/l/cup/fl oz).
 * Spoons (tsp/tbsp) are universal and never converted. Any unrecognized
 * unit ("cloves", "pinch", "can") is family "other" and passes through
 * untouched. Conversion happens once, when a recipe is stored, so the
 * collection is always in the user's preferred units.
 *
 * prefs shape: { mass: ""|"metric"|"imperial", volume: ""|"metric"|"us" }
 * ("" = keep units as entered)
 */
(function (global) {
  "use strict";

  // canonical short label -> { family, toBase } (base: g for mass, ml for volume)
  const UNITS = {
    g: { family: "mass", toBase: 1 },
    kg: { family: "mass", toBase: 1000 },
    oz: { family: "mass", toBase: 28.35 },
    lb: { family: "mass", toBase: 453.59 },
    ml: { family: "volume", toBase: 1 },
    l: { family: "volume", toBase: 1000 },
    cup: { family: "volume", toBase: 240 },
    "fl oz": { family: "volume", toBase: 29.57 },
    tsp: { family: "spoon", toBase: 5 },
    tbsp: { family: "spoon", toBase: 15 },
  };

  const ALIASES = {
    g: "g", gram: "g", grams: "g",
    kg: "kg", kilogram: "kg", kilograms: "kg", kilo: "kg", kilos: "kg",
    oz: "oz", ounce: "oz", ounces: "oz",
    lb: "lb", lbs: "lb", pound: "lb", pounds: "lb",
    ml: "ml", millilitre: "ml", millilitres: "ml", milliliter: "ml", milliliters: "ml",
    l: "l", litre: "l", litres: "l", liter: "l", liters: "l",
    cup: "cup", cups: "cup",
    "fl oz": "fl oz", floz: "fl oz", "fl. oz": "fl oz", "fluid ounce": "fl oz", "fluid ounces": "fl oz",
    tsp: "tsp", teaspoon: "tsp", teaspoons: "tsp",
    tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  };

  /** Canonical short label for a recognized unit, or the input as typed. */
  function normalizeLabel(unit) {
    const key = String(unit || "").trim().toLowerCase().replace(/\.$/, "");
    return ALIASES[key] || String(unit || "").trim();
  }

  function familyOf(unit) {
    const canonical = ALIASES[String(unit || "").trim().toLowerCase().replace(/\.$/, "")];
    return canonical ? UNITS[canonical].family : "other";
  }

  // Which unit system a canonical unit belongs to, per family.
  const SYSTEM = {
    g: "metric", kg: "metric", oz: "imperial", lb: "imperial",
    ml: "metric", l: "metric", cup: "us", "fl oz": "us",
  };

  const round = (v, dp) => Math.round(v * 10 ** dp) / 10 ** dp;

  /** Pick the display unit and rounding for a base amount in a target system. */
  function fromBase(family, system, base) {
    if (family === "mass") {
      if (system === "metric") {
        return base >= 1000 ? { amount: round(base / 1000, 2), unit: "kg" } : { amount: Math.round(base), unit: "g" };
      }
      const oz = base / UNITS.oz.toBase;
      return oz >= 16
        ? { amount: round(base / UNITS.lb.toBase, 2), unit: "lb" }
        : { amount: round(oz, 1), unit: "oz" };
    }
    if (system === "metric") {
      return base >= 1000 ? { amount: round(base / 1000, 2), unit: "l" } : { amount: Math.round(base), unit: "ml" };
    }
    return base >= 120
      ? { amount: round(base / UNITS.cup.toBase, 2), unit: "cup" }
      : { amount: round(base / UNITS["fl oz"].toBase, 1), unit: "fl oz" };
  }

  /**
   * Convert one ingredient to the preferred system. Returns a new
   * ingredient object, or the input unchanged when no conversion applies.
   */
  function convertIngredient(ing, prefs) {
    const label = normalizeLabel(ing.unit);
    const changedLabel = label !== ing.unit;
    const canonical = ALIASES[label.toLowerCase()] || null;
    if (!canonical || ing.amount === null || ing.amount === undefined) {
      return changedLabel ? { ...ing, unit: label } : ing;
    }
    const family = UNITS[canonical].family;
    const target = family === "mass" ? prefs && prefs.mass : family === "volume" ? prefs && prefs.volume : null;
    if (!target || SYSTEM[canonical] === target) {
      return changedLabel ? { ...ing, unit: label } : ing;
    }
    const base = ing.amount * UNITS[canonical].toBase;
    const converted = fromBase(family, target, base);
    if (converted.amount <= 0) return changedLabel ? { ...ing, unit: label } : ing;
    return { ...ing, amount: converted.amount, unit: converted.unit };
  }

  /** Convert a recipe's ingredients in place. Returns how many changed. */
  function applyPrefs(recipe, prefs) {
    let changed = 0;
    recipe.ingredients = recipe.ingredients.map((ing) => {
      const out = convertIngredient(ing, prefs);
      if (out !== ing && (out.amount !== ing.amount || out.unit !== ing.unit)) changed++;
      return out;
    });
    return changed;
  }

  global.RecipeUnits = { normalizeLabel, familyOf, convertIngredient, applyPrefs };
})(window);
