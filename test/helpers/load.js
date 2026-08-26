/**
 * The app's modules are browser IIFEs that attach themselves to `window`,
 * with no module system — that is the point of a site with no build step.
 * This gives them a `window` to attach to so tests can call them directly.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

const SRC = path.join(__dirname, "..", "..", "js");

/**
 * Load the named modules into one shared fake window and return it.
 * Order matters exactly as it does in index.html: storage.js reads
 * RecipeUnits while sanitising, so units.js has to be there first.
 */
function loadApp(...modules) {
  const win = {
    crypto: webcrypto,
    localStorage: makeStorage(),
    // Enough of the compression/base64 surface for share.js. Node has all
    // of these; the fallbacks keep this working on older runtimes.
    Blob: globalThis.Blob,
    btoa: (bin) => Buffer.from(bin, "binary").toString("base64"),
    atob: (b64) => Buffer.from(b64, "base64").toString("binary"),
  };
  win.window = win;

  // share.js reaches for these as bare globals rather than off window.
  globalThis.Blob = globalThis.Blob || require("node:buffer").Blob;
  globalThis.btoa = win.btoa;
  globalThis.atob = win.atob;
  const streams = require("node:stream/web");
  globalThis.CompressionStream = globalThis.CompressionStream || streams.CompressionStream;
  globalThis.DecompressionStream = globalThis.DecompressionStream || streams.DecompressionStream;

  for (const name of modules) {
    const src = fs.readFileSync(path.join(SRC, name), "utf8");
    new Function("window", src)(win);
  }
  return win;
}

/** A localStorage that behaves like the real one, per test. */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

/** A minimal valid recipe — J2.1's floor — with overrides applied. */
function aRecipe(over = {}) {
  return {
    name: "Soup",
    ingredients: [{ amount: 1, unit: "l", item: "stock" }],
    steps: ["Heat it."],
    ...over,
  };
}

module.exports = { loadApp, makeStorage, aRecipe };
