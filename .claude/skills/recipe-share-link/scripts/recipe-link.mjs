#!/usr/bin/env node
/**
 * recipe-link.mjs — build (and read back) a Recipe Friend share link.
 *
 * Mirrors js/share.js exactly: the payload is JSON, deflate-raw compressed,
 * base64url encoded, and carried in the URL fragment so no server ever sees
 * the recipe.
 *
 *   node recipe-link.mjs recipe.json          # print the share link
 *   node recipe-link.mjs --decode "<link>"    # print the recipe back out
 *   node recipe-link.mjs recipe.json --base https://example.com/app/
 *
 * Validation is deliberately loud: the app silently drops a malformed
 * recipe, so anything the app would reject or quietly rewrite is an error
 * here instead.
 */
import { readFileSync } from "node:fs";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { randomUUID } from "node:crypto";

const DEFAULT_BASE = "https://malfernion.github.io/Recipe-friend/";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Canonical unit labels from js/units.js. Anything else is a free-text unit
// ("clove", "pinch", "can") — allowed, but never scaled or converted.
const KNOWN_UNITS = new Set([
  "g", "kg", "oz", "lb", "ml", "l", "cup", "fl oz", "tsp", "tbsp",
]);

const b64url = (buf) =>
  buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const unb64url = (text) =>
  Buffer.from(text.replaceAll("-", "+").replaceAll("_", "/"), "base64");

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Reject anything the app would refuse or silently rewrite. */
function validate(recipe) {
  const problems = [];
  const str = (v) => (typeof v === "string" ? v.trim() : "");

  if (!str(recipe.name)) problems.push("name is required");
  if (str(recipe.name).length > 120) problems.push("name exceeds 120 characters");
  if (str(recipe.description).length > 500) problems.push("description exceeds 500 characters");

  if (!Array.isArray(recipe.ingredients) || recipe.ingredients.length === 0) {
    problems.push("at least one ingredient is required");
  } else {
    recipe.ingredients.forEach((ing, i) => {
      const at = `ingredients[${i}]`;
      if (!ing || typeof ing !== "object") return problems.push(`${at} must be an object`);
      if (!("amount" in ing)) problems.push(`${at}.amount is missing (use null for "to taste")`);
      if (ing.amount !== null && !(Number.isFinite(ing.amount) && ing.amount > 0)) {
        problems.push(`${at}.amount must be a positive number or null`);
      }
      if (typeof ing.unit !== "string") problems.push(`${at}.unit must be a string ("" for none)`);
      else if (ing.unit.length > 24) problems.push(`${at}.unit exceeds 24 characters`);
      if (!str(ing.item)) problems.push(`${at}.item is required`);
      if (str(ing.item).length > 200) problems.push(`${at}.item exceeds 200 characters`);
    });
  }

  if (!Array.isArray(recipe.steps) || recipe.steps.filter((s) => str(s)).length === 0) {
    problems.push("at least one step is required");
  }

  for (const key of ["servings", "prepMinutes", "cookMinutes"]) {
    const v = recipe[key];
    if (v === null || v === undefined) continue;
    if (!Number.isFinite(v) || v < 0) problems.push(`${key} must be a non-negative number or null`);
  }

  if (recipe.tags !== undefined) {
    if (!Array.isArray(recipe.tags)) problems.push("tags must be an array of strings");
    else if (recipe.tags.some((t) => str(t).length > 40)) problems.push("a tag exceeds 40 characters");
  }

  const image = str(recipe.image);
  if (image && !/^https?:\/\//i.test(image)) {
    problems.push("image must be an http(s) URL — data: URIs are stripped by the app");
  }
  if (recipe.imagePath) {
    problems.push("imagePath cannot travel in a share link (stored photos are private)");
  }

  if (recipe.id !== undefined && !UUID_RE.test(String(recipe.id))) {
    problems.push("id must be a lowercase UUID (or omitted so one is generated)");
  }

  if (problems.length) fail(`this recipe would not import:\n  - ${problems.join("\n  - ")}`);
}

/** Warn about things that import fine but read badly in the app. */
function warn(recipe) {
  for (const [i, ing] of recipe.ingredients.entries()) {
    const unit = String(ing.unit || "").trim();
    if (unit && !KNOWN_UNITS.has(unit.toLowerCase())) {
      console.error(
        `note: ingredients[${i}].unit "${unit}" is not a convertible unit — ` +
          `it scales with portions but is never converted between metric and imperial.`
      );
    }
  }
}

function encode(recipe, base) {
  const payload = {
    v: 1,
    r: {
      id: recipe.id || randomUUID(),
      name: recipe.name.trim(),
      description: (recipe.description || "").trim(),
      servings: recipe.servings ?? null,
      prepMinutes: recipe.prepMinutes ?? null,
      cookMinutes: recipe.cookMinutes ?? null,
      ingredients: recipe.ingredients.map((i) => ({
        amount: i.amount ?? null,
        unit: (i.unit || "").trim(),
        item: i.item.trim(),
      })),
      steps: recipe.steps.map((s) => String(s).trim()).filter(Boolean),
      tags: (recipe.tags || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean),
      image: /^https?:\/\//i.test(recipe.image || "") ? recipe.image.trim() : "",
    },
  };
  const json = JSON.stringify(payload);
  const blob = "1." + b64url(deflateRawSync(Buffer.from(json, "utf8"), { level: 9 }));
  return { url: `${base}#add=${blob}`, id: payload.r.id, bytes: json.length };
}

function decode(input) {
  const blob = input.includes("#add=") ? input.split("#add=")[1] : input;
  const mark = blob.slice(0, 2);
  if (mark !== "1." && mark !== "0.") {
    fail(`unknown payload marker "${mark}" — expected "1." or "0."`);
  }
  let json;
  try {
    const bytes = unb64url(blob.slice(2));
    json = mark === "1." ? inflateRawSync(bytes).toString("utf8") : bytes.toString("utf8");
  } catch (err) {
    // Almost always a link damaged in transit: a truncated copy, a line
    // break inserted by a chat client, or a hand-retyped character.
    fail(`could not decode this link (${err.message}) — it is corrupt or incomplete`);
  }
  const payload = JSON.parse(json);
  if (!payload || payload.v !== 1 || typeof payload.r !== "object") {
    fail("payload is not a v1 recipe share");
  }
  return payload.r;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: recipe-link.mjs <recipe.json> [--base URL] | --decode <link>");
  process.exit(2);
}

if (args[0] === "--decode") {
  if (!args[1]) fail("--decode needs a link or payload");
  console.log(JSON.stringify(decode(args[1]), null, 2));
  process.exit(0);
}

const baseIndex = args.indexOf("--base");
const base = baseIndex === -1 ? DEFAULT_BASE : args[baseIndex + 1];
if (!base) fail("--base needs a URL");

let recipe;
try {
  recipe = JSON.parse(readFileSync(args[0], "utf8"));
} catch (err) {
  fail(`could not read ${args[0]}: ${err.message}`);
}

validate(recipe);
warn(recipe);
const { url, id, bytes } = encode(recipe, base);

// Round-trip before handing the link over: a link that cannot be decoded
// here will not open in the app either.
const back = decode(url);
if (back.name !== recipe.name.trim() || back.ingredients.length !== recipe.ingredients.length) {
  fail("round-trip check failed — the encoded link does not decode back to this recipe");
}

console.error(`ok: ${bytes} bytes of JSON, ${url.length}-character link, recipe id ${id}`);
console.log(url);
