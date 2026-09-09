/**
 * mcp/args.js — reading arguments that nothing has checked.
 *
 * A tool publishes the shape of what it takes and the protocol holds
 * nobody to it: `additionalProperties`, `type`, `minItems`, `maxItems`
 * and `minimum` are all advertised and unenforced. So a wrong type is
 * not a client bug that cannot happen here — it is Tuesday, and it
 * arrives from the same places a recipe does.
 *
 * The bar is not to be clever about what somebody meant. It is that a
 * tool answers, or says why it cannot, rather than handing a model a
 * JavaScript type error — and above all that it never answers *wrongly*,
 * which is what an unchecked `minimum` did: `length >= "two"` is false
 * for every recipe in the book, and the answer was an empty list rather
 * than a complaint.
 */
"use strict";

/**
 * A list, from whatever arrived. A bare value is a list of one, which is
 * what somebody sending `tags: "quick"` plainly meant; anything empty is
 * an empty list. Members that are not usable are the caller's business,
 * not this function's.
 */
function asList(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

/** The strings in a list, trimmed, with the blanks dropped. */
function asStrings(value) {
  return asList(value)
    .map((one) => (typeof one === "string" ? one.trim() : ""))
    .filter(Boolean);
}

/**
 * A whole number of at least `min`, or the fallback. Anything that is
 * not a number is the fallback rather than a silent comparison against
 * a string.
 */
function asCount(value, fallback, min = 1) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

/**
 * One of a known set, the fallback for nothing at all, or null for
 * something that is not on the list.
 *
 * Null rather than the fallback, because `applySort` quietly returns the
 * list untouched for an order it does not recognise: asking for
 * "Quickest" and getting the book's own order is a plausible answer to a
 * different question, and nothing in the reply says which question.
 */
function asChoice(value, allowed, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  return allowed.includes(value) ? value : null;
}

/**
 * Refuse a list longer than the schema said, rather than doing the work.
 * `add_to_plan` holds the write lane while it runs and the plan copies
 * itself per meal, so twenty thousand of them is minutes of a book
 * nobody else can touch.
 */
function tooMany(list, max, what) {
  if (list.length <= max) return null;
  return { error: `That is ${list.length} ${what}; this tool takes at most ${max} at a time.` };
}

module.exports = { asList, asStrings, asCount, asChoice, tooMany };
