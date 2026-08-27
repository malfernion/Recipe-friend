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

  // html.js is a leaf everything that renders depends on, so it always
  // goes in first rather than being repeated in every caller's list.
  for (const name of ["html.js", ...modules.filter((m) => m !== "html.js")]) {
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

/**
 * Load js/app.js on top of a stub DOM and hand back the handles a test
 * needs to drive it. app.js reaches for RecipeStore and friends as bare
 * globals — that is what a browser gives it — so they go on globalThis.
 */
function loadUI(options = {}) {
  const { makeWindow } = require("./dom.js");
  const win = makeWindow();
  // A link or a deep link is in the address bar before the app loads, and
  // the sign-in gate is up or down before it loads too. Both have to be
  // set here rather than after, because app.js reads them on the way in.
  if (options.hash) win.location.hash = options.hash;
  if (options.gated) win.document.body.classList.add("gated");
  const base = loadApp("units.js", "scale.js", "storage.js", "share.js");

  for (const key of ["RecipeHTML", "RecipeUnits", "RecipeScale", "RecipeStore", "RecipeShare"]) {
    win[key] = base[key];
    globalThis[key] = base[key];
  }
  win.localStorage = base.localStorage;
  win.crypto = base.crypto;

  const restore = swapGlobals({
    document: win.document,
    window: win,
    CSS: win.CSS,
    location: win.location,
    history: win.history,
    sessionStorage: win.sessionStorage,
    navigator: win.navigator,
    confirm: win.confirm,
    alert: win.alert,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
  });

  // search.js is optional so this helper works either side of the
  // extraction — the characterisation tests must not have to change.
  const withSearch = fs.existsSync(path.join(SRC, "search.js"))
    ? ["search.js", "app.js"]
    : ["app.js"];
  for (const name of withSearch) {
    const src = fs.readFileSync(path.join(SRC, name), "utf8");
    new Function("window", src)(win);
    if (name === "search.js") globalThis.RecipeSearch = win.RecipeSearch;
  }

  return { win, el: win.document.el, app: win.RecipeApp, store: win.RecipeApp.store, restore };
}

function swapGlobals(values) {
  const saved = new Map();
  for (const [k, v] of Object.entries(values)) {
    saved.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  return () => {
    for (const [k, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, k, desc);
      else delete globalThis[k];
    }
  };
}

module.exports = { loadApp, loadUI, makeStorage, aRecipe };
