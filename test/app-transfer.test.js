/**
 * J10 · Keeping your own copy, and J5 · a share link arriving — both
 * driven through the app the way a person meets them: press Export, pick a
 * file to import, open a link someone sent.
 *
 * The merge rules underneath Import are already pinned down at the store
 * level in storage.test.js. What is tested here is the layer above them —
 * the buttons, the counts, the messages, and the promise in J10.5 that the
 * app says a photo is being left behind rather than leaving it to be
 * discovered.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadUI, loadApp, aRecipe } = require("./helpers/load.js");
const dom = require("./helpers/dom.js");

// A stored photo: private to its book, and named as storage.js requires.
const PHOTO_PATH =
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg";
// The id a sender's link carries, so a second opening is recognisably the
// same recipe rather than a new one.
const SHARED_ID = "77777777-7777-4777-8777-777777777777";

// --- The browser bits Import and Export use that the stub DOM has not ---
// Kept local to this file rather than added to the shared stub: node runs
// each test file in its own process, so nothing here leaks sideways.

/** Blobs handed to the browser to download, newest last. */
const objectUrls = [];
URL.createObjectURL = (blob) => {
  objectUrls.push(blob);
  return `blob:test/${objectUrls.length}`;
};
URL.revokeObjectURL = () => {};

/** A file the picker handed back: {text} reads, anything else fails. */
globalThis.FileReader = class {
  readAsText(file) {
    Promise.resolve().then(() => {
      if (file && typeof file.text === "string") {
        this.result = file.text;
        if (this.onload) this.onload();
      } else if (this.onerror) {
        this.onerror(new Error("unreadable"));
      }
    });
  }
};

/**
 * Give the app a chance to do something it should NOT do.
 *
 * Only for asserting a negative — that nothing was reviewed, that nothing
 * was saved. A fixed number of turns is honest here because there is no
 * condition to wait for; the point is to let any pending work run first.
 */
async function settle(turns = 50) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Wait for the app to actually do something, and fail loudly if it never
 * does. Decoding a link goes through zlib, which takes as long as it takes
 * — a fixed number of turns is a race, and this suite lost it about one run
 * in three under load. Worse, a budget that quietly ran out left the test
 * asserting against a half-finished app, so the failure pointed at the
 * assertion rather than at the wait.
 */
async function until(condition, what = "the app to respond", ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

/**
 * The ingredient rows, which live as real DOM in the browser and as
 * nothing at all in the stub. Rows go in as the HTML app.js writes and
 * come back out through the same three fields it reads, so a recipe still
 * makes the round trip through the form rather than around it.
 */
function wireIngredientRows(ui) {
  const host = ui.el("ingredient-rows");
  let rows = [];
  const unescape = (s) =>
    s
      .replaceAll("&quot;", '"')
      .replaceAll("&#39;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");

  Object.defineProperty(host, "innerHTML", {
    configurable: true,
    get: () => rows.map((r) => r.html).join(""),
    set: (value) => {
      if (!value) rows = [];
    },
  });
  Object.defineProperty(host, "children", { configurable: true, get: () => rows });
  host.appendChild = (row) => {
    const values = [...String(row.innerHTML).matchAll(/value="([^"]*)"/g)].map((m) =>
      unescape(m[1])
    );
    const [amount = "", unit = "", item = ""] = values;
    const fields = {
      ".ing-amount": { value: amount },
      ".ing-unit": { value: unit },
      ".ing-item": { value: item },
    };
    row.querySelector = (sel) => fields[sel] || null;
    row.html = row.innerHTML;
    rows.push(row);
  };
  host.querySelectorAll = (sel) => (sel === ".ing-row" ? rows.slice() : []);
}

/**
 * Load the app with a fragment already in the address bar — that is how a
 * share link arrives — and with the sign-in gate up or down. The stub
 * window is built inside loadUI, so it is arranged on the way past.
 */
function openApp({ hash = "", gated = false, seed = null } = {}) {
  const realMakeWindow = dom.makeWindow;
  const sessionWrites = [];
  const sessionRemovals = [];
  let win = null;

  dom.makeWindow = () => {
    win = realMakeWindow();
    win.location.hash = hash;
    if (gated) win.document.body.classList.add("gated");
    if (seed) win.sessionStorage.setItem(seed.key, seed.value);
    const realSet = win.sessionStorage.setItem;
    const realRemove = win.sessionStorage.removeItem;
    win.sessionStorage.setItem = (k, v) => {
      sessionWrites.push({ key: k, value: v });
      return realSet(k, v);
    };
    win.sessionStorage.removeItem = (k) => {
      sessionRemovals.push(k);
      return realRemove(k);
    };
    // The stub swallows window listeners; keep hashchange so a link can
    // arrive in a tab that is already open.
    const listeners = new Map();
    win.addEventListener = (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    };
    win.fireWindow = (type) => {
      for (const fn of listeners.get(type) || []) fn({ type });
    };
    return win;
  };

  let ui;
  try {
    ui = loadUI();
  } finally {
    dom.makeWindow = realMakeWindow;
  }
  wireIngredientRows(ui);

  return {
    ...ui,
    sessionWrites,
    sessionRemovals,
    toast: () => ui.el("toast").textContent,
    reviewing: () => ui.el("recipe-dialog").open,
    title: () => ui.el("dialog-title").textContent,
    field: (name) => ui.el("recipe-form").elements[name].value,
    warning: () => ui.el("review-warning"),
    saveButton: () => ui.el("save-recipe-btn").textContent,
    /** Confirm what is on the form — the Save button in the dialog. */
    confirm: () => ui.el("recipe-form").fire("submit"),
    /** Settle: a link either opens the review, says something, or is held. */
    handled: () =>
      until(
        () =>
          ui.el("recipe-dialog").open ||
          ui.el("toast").textContent !== "" ||
          sessionWrites.length > 0,
        "the incoming link to be reviewed, refused, or held for sign-in"
      ),
    /** A link opened in a tab that is already loaded. */
    arrive: async (h) => {
      ui.el("toast").textContent = "";
      ui.win.location.hash = h;
      ui.win.fireWindow("hashchange");
      await until(
        () => ui.el("recipe-dialog").open || ui.el("toast").textContent !== "",
        "the link arriving in an open tab to be reviewed or refused"
      );
    },
  };
}

/** Press Export, and read back the file the browser was handed. */
async function exportBook(ui) {
  const realCreate = ui.win.document.createElement;
  const anchors = [];
  const clicked = [];
  ui.win.document.createElement = (tag) => {
    const node = realCreate(tag);
    if (tag === "a") {
      anchors.push(node);
      node.addEventListener("click", () => clicked.push(node));
    }
    return node;
  };
  objectUrls.length = 0;
  try {
    ui.el("export-btn").fire("click");
  } finally {
    ui.win.document.createElement = realCreate;
  }
  const blob = objectUrls[objectUrls.length - 1];
  const text = blob ? await blob.text() : "";
  return {
    file: text ? JSON.parse(text) : null,
    type: blob ? blob.type : "",
    anchor: anchors[0],
    downloaded: clicked.length,
    toast: ui.el("toast").textContent,
  };
}

/** Choose a file in the Import picker, and read back what the app said. */
async function importFile(ui, file) {
  ui.el("toast").textContent = "";
  ui.el("import-file").fire("change", { target: { files: [file], value: "chosen.json" } });
  await until(() => ui.el("toast").textContent !== "", "the import to report what it did");
  return ui.el("toast").textContent;
}

/** A file holding the given recipes, as an export writes them. */
function exportFileOf(recipes) {
  return { text: JSON.stringify({ version: 1, recipes, tombstones: [] }) };
}

// A separate load of the plain modules, used to build the links a sender
// would send — real ones, encoded by the same code that decodes them.
const sender = loadApp("units.js", "scale.js", "storage.js", "share.js");

async function shareLink(over = {}) {
  const recipe = sender.RecipeStore.sanitizeRecipe(aRecipe(over));
  return `#add=${await sender.RecipeShare.encodeRecipeShare(recipe)}`;
}

// --- J10 · Keeping your own copy ---

test("J10.1 · Export downloads the whole current book as JSON", async () => {
  const ui = openApp();
  ui.store.add(aRecipe({ name: "Soup", tags: ["winter"] }));
  ui.store.add(aRecipe({ name: "Stew" }));

  const out = await exportBook(ui);

  assert.deepEqual(
    out.file.recipes.map((r) => r.name).sort(),
    ["Soup", "Stew"],
    "the file carries the book's recipes"
  );
  assert.deepEqual(out.file.recipes.find((r) => r.name === "Soup").tags, ["winter"]);
  assert.equal(out.type, "application/json");
  assert.equal(out.downloaded, 1, "the file is actually handed to the browser");
  assert.match(out.anchor.download, /^recipe-friend-export-\d{4}-\d{2}-\d{2}\.json$/);
  assert.match(out.toast, /Exported 2 recipes/);
});

test("J10.1 · Export carries the whole book, not the part on screen", async () => {
  const ui = openApp();
  ui.store.add(aRecipe({ name: "Soup" }));
  ui.store.add(aRecipe({ name: "Stew" }));
  // Searching narrows the list; a backup that only kept what was showing
  // would be a backup of a filter.
  ui.el("search-input").value = "soup";
  ui.el("search-input").fire("input");

  const out = await exportBook(ui);
  assert.deepEqual(out.file.recipes.map((r) => r.name).sort(), ["Soup", "Stew"]);
  assert.match(out.toast, /Exported 2 recipes/);
});

test("J10.5 · exporting a book that holds stored photos says they are not included", async () => {
  const ui = openApp();
  ui.store.add(aRecipe({ name: "Soup", imagePath: PHOTO_PATH }));
  ui.store.add(aRecipe({ name: "Stew" }));

  const out = await exportBook(ui);

  assert.match(out.toast, /Photos aren't included/, "the loss is said, not left to be found");
  // J10.4: the path is all there is, and it is unreadable outside the book.
  assert.equal(out.file.recipes.find((r) => r.name === "Soup").imagePath, PHOTO_PATH);
  assert.equal(out.file.recipes.find((r) => r.name === "Soup").image, "");
});

test("J10.5 · a book with no stored photos exports without the photo warning", async () => {
  const ui = openApp();
  // J10.4: a photo held on the recipe itself does travel, so there is
  // nothing to warn about here.
  ui.store.add(aRecipe({ name: "Soup", image: "https://example.test/soup.jpg" }));

  const out = await exportBook(ui);

  assert.equal(out.toast, "Exported 1 recipe.");
  assert.doesNotMatch(out.toast, /Photos/, "no warning when no photo is left behind");
  assert.equal(out.file.recipes[0].image, "https://example.test/soup.jpg");

  // J10.4: nor is a photo taken on a device while signed out, which is
  // held on the recipe rather than in the book's private storage.
  ui.store.add(aRecipe({ name: "Cake", image: "data:image/jpeg;base64,AAAA" }));
  const withDevicePhoto = await exportBook(ui);
  assert.equal(withDevicePhoto.toast, "Exported 2 recipes.");
  assert.match(withDevicePhoto.file.recipes.find((r) => r.name === "Cake").image, /^data:image/);
});

test("J10.2 · Import merges a file back in, and says what it did", async () => {
  const ui = openApp();
  let pickerOpened = 0;
  ui.el("import-file").addEventListener("click", () => pickerOpened++);
  ui.el("import-btn").fire("click");
  assert.equal(pickerOpened, 1, "the Import button opens the file picker");

  const file = exportFileOf([
    { ...sender.RecipeStore.sanitizeRecipe(aRecipe({ name: "Soup" })) },
    { ...sender.RecipeStore.sanitizeRecipe(aRecipe({ name: "Stew" })) },
  ]);

  assert.match(await importFile(ui, file), /added 2/);
  assert.deepEqual(ui.store.recipes.map((r) => r.name).sort(), ["Soup", "Stew"]);
  assert.match(ui.el("recipe-list").innerHTML, /Soup/, "the list shows what came back");

  // The same file again: no duplicates, and no claim to have added
  // anything — every recipe in it is already here, unchanged.
  const again = await importFile(ui, file);
  assert.match(again, /skipped 2/);
  assert.doesNotMatch(again, /added/);
  assert.equal(ui.store.recipes.length, 2, "re-importing never creates duplicates");

  // An export with nothing in it is not an error either.
  assert.equal(await importFile(ui, exportFileOf([])), "Nothing new in that file.");
  assert.equal(ui.store.recipes.length, 2);
});

test("J10.3 · an import that only updates reports the update, not 'added 0'", async () => {
  const ui = openApp();
  const saved = ui.store.add(aRecipe({ name: "Soup" }));
  const file = exportFileOf([{ ...saved, name: "Better Soup", updatedAt: saved.updatedAt + 1000 }]);

  const said = await importFile(ui, file);

  assert.match(said, /updated 1/);
  assert.doesNotMatch(said, /added/, "nothing was added, so nothing is claimed");
  assert.doesNotMatch(said, /\b0\b/, "a count of nothing is never reported");
  assert.equal(ui.store.recipes.length, 1);
  assert.equal(ui.store.recipes[0].name, "Better Soup");
  assert.match(ui.el("recipe-list").innerHTML, /Better Soup/, "the screen catches up");
});

test("J10.3 · an import an older backup cannot undo says it skipped it", async () => {
  const ui = openApp();
  const saved = ui.store.add(aRecipe({ name: "Soup" }));
  const stale = exportFileOf([{ ...saved, name: "Old Soup", updatedAt: saved.updatedAt - 1000 }]);

  const said = await importFile(ui, stale);

  assert.match(said, /skipped 1/);
  assert.equal(ui.store.recipes[0].name, "Soup", "newer work survives an old backup");
});

test("J10.6 · Import is a bulk operation and does not review each recipe", async () => {
  const ui = openApp();
  const file = exportFileOf([
    sender.RecipeStore.sanitizeRecipe(aRecipe({ name: "Soup" })),
    sender.RecipeStore.sanitizeRecipe(aRecipe({ name: "Stew" })),
  ]);

  await importFile(ui, file);

  assert.equal(ui.reviewing(), false, "no review dialog — it is your own backup coming home");
  assert.notEqual(ui.title(), "Review recipe");
  assert.equal(ui.store.recipes.length, 2, "both arrived without being confirmed one by one");
});

test("a file that isn't a Recipe Friend export says so rather than failing silently", async () => {
  const ui = openApp();
  assert.match(await importFile(ui, { text: "not json at all" }), /doesn't look like a Recipe Friend export/);
  assert.match(await importFile(ui, { text: '{"nope":1}' }), /doesn't look like a Recipe Friend export/);
  assert.equal(ui.store.recipes.length, 0);
});

test("a file that cannot be read at all says so rather than failing silently", async () => {
  const ui = openApp();
  assert.match(await importFile(ui, { name: "broken.json" }), /Could not read that file/);
});

// --- J5 · A share link arriving ---

test("J5.1 · an opened share link is reviewed in the edit form, not saved on the spot", async () => {
  const ui = openApp({ hash: await shareLink({ name: "Shared Soup", tags: ["gift"] }) });
  await ui.handled();

  assert.equal(ui.reviewing(), true);
  assert.equal(ui.title(), "Review recipe");
  assert.equal(ui.field("name"), "Shared Soup");
  assert.equal(ui.field("tags"), "gift");
  assert.equal(ui.store.recipes.length, 0, "nothing is stored until it is confirmed");
  assert.equal(ui.warning().hidden, true, "nothing of yours is at stake yet");
  assert.equal(ui.saveButton(), "Add to my recipes");

  // Backing out leaves the box as it was.
  ui.el("cancel-dialog-btn").fire("click");
  assert.equal(ui.reviewing(), false);
  assert.equal(ui.store.recipes.length, 0);
});

test("J5.1 · a reviewed recipe joins the box once it is confirmed", async () => {
  const ui = openApp({ hash: await shareLink({ name: "Shared Soup" }) });
  await ui.handled();
  // Corrected on the way in, which is what the review is for.
  ui.el("recipe-form").elements.name.value = "Shared Soup (halved)";
  ui.confirm();

  assert.equal(ui.store.recipes.length, 1);
  assert.equal(ui.store.recipes[0].name, "Shared Soup (halved)");
  assert.deepEqual(ui.store.recipes[0].ingredients, [{ amount: 1, unit: "l", item: "stock" }]);
  assert.deepEqual(ui.store.recipes[0].steps, ["Heat it."]);
  assert.match(ui.toast(), /Added “Shared Soup \(halved\)”/);
});

test("J5.2 · opening the same link twice updates the recipe instead of adding a second", async () => {
  const link = await shareLink({ name: "Shared Soup", id: SHARED_ID });
  const ui = openApp({ hash: link });
  await ui.handled();
  ui.confirm();
  assert.equal(ui.store.recipes.length, 1);
  assert.equal(ui.store.recipes[0].id, SHARED_ID, "the recipe keeps the identity it arrived with");

  // The very same link, opened again in the tab that is already there.
  await ui.arrive(link);
  assert.equal(ui.reviewing(), true, "it is reviewed again, not silently merged");
  ui.el("recipe-form").elements.name.value = "Shared Soup, my way";
  ui.confirm();

  assert.equal(ui.store.recipes.length, 1, "one recipe, not two");
  assert.equal(ui.store.recipes[0].id, SHARED_ID);
  assert.equal(ui.store.recipes[0].name, "Shared Soup, my way", "the review wins");
});

test("J5.3 · the form names the recipe saving would replace", async () => {
  const ui = openApp({ hash: await shareLink({ name: "Nana's Broth", id: SHARED_ID }) });
  await ui.handled();
  ui.confirm();
  assert.equal(ui.store.recipes.length, 1);

  // The sender sends a newer version of the same recipe under a new name.
  await ui.arrive(await shareLink({ name: "Broth, improved", id: SHARED_ID }));

  assert.equal(ui.field("name"), "Broth, improved", "the form shows the sender's version");
  const warning = ui.warning();
  assert.equal(warning.hidden, false, "the replacement is not left to be discovered");
  assert.match(
    warning.textContent,
    /Nana's Broth/,
    "it names which recipe is at stake — 'your copy' leaves someone guessing"
  );
  assert.doesNotMatch(warning.textContent, /Broth, improved/, "the one at stake is yours, not theirs");
  assert.match(ui.saveButton(), /Nana's Broth/, "the button that does it names it too");
});

test("J5.3 · a link for a recipe you don't have says nothing about replacing", async () => {
  const ui = openApp({ hash: await shareLink({ name: "Nana's Broth", id: SHARED_ID }) });
  await ui.handled();
  ui.confirm();

  // A different recipe entirely: nothing of yours is being replaced.
  await ui.arrive(await shareLink({ name: "Someone Else's Stew" }));

  assert.equal(ui.warning().hidden, true);
  assert.equal(ui.saveButton(), "Add to my recipes");
  ui.confirm();
  assert.equal(ui.store.recipes.length, 2);
});

test("J5.4 · a link that cannot be decoded says so rather than failing silently", async () => {
  const ui = openApp({ hash: "#add=1.notrealbase64" });
  await ui.handled();

  assert.match(ui.toast(), /couldn't be read/);
  assert.equal(ui.reviewing(), false);
  assert.equal(ui.store.recipes.length, 0);
});

test("J5.4 · a link carrying something that isn't a usable recipe says so too", async () => {
  const payload = await sender.RecipeShare.encodeRecipeShare({
    id: SHARED_ID,
    name: "Soup",
    ingredients: [],
    steps: [],
    tags: [],
  });
  const ui = openApp({ hash: `#add=${payload}` });
  await ui.handled();

  assert.match(ui.toast(), /couldn't be read/);
  assert.equal(ui.reviewing(), false);
  assert.equal(ui.store.recipes.length, 0);
});

test("J5.5 · a link opened while signed out is held rather than lost", async () => {
  const ui = openApp({ hash: await shareLink({ name: "Shared Soup" }), gated: true });
  await ui.handled();

  assert.equal(ui.reviewing(), false, "there is nothing to review into until sign-in finishes");
  assert.equal(ui.store.recipes.length, 0);
  assert.equal(ui.sessionWrites.length, 1, "the recipe is put somewhere the round trip survives");
  assert.equal(JSON.parse(ui.sessionWrites[0].value).name, "Shared Soup");
});

test("J5.5 · a link held across the sign-in round trip is reviewed afterwards", async () => {
  const before = openApp({ hash: await shareLink({ name: "Shared Soup" }), gated: true });
  await before.handled();
  const held = before.sessionWrites[0];
  assert.ok(held, "the signed-out visit held the recipe");

  // Signing in with Google leaves and comes back: a new page, no fragment,
  // and only what was put aside to go on.
  const after = openApp({ seed: held });
  await settle();
  assert.equal(after.reviewing(), false, "not until the app knows who is back");

  after.app.showPendingShare();

  assert.equal(after.reviewing(), true);
  assert.equal(after.title(), "Review recipe");
  assert.equal(after.field("name"), "Shared Soup");
  assert.equal(after.store.recipes.length, 0, "still reviewed, not saved on arrival");
  assert.ok(
    after.sessionRemovals.includes(held.key),
    "and it is let go once reviewed, so it does not come back on the next visit"
  );

  after.confirm();
  assert.deepEqual(after.store.recipes.map((r) => r.name), ["Shared Soup"]);
});
