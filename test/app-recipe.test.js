/**
 * J2 photos, J4 cooking, J6 sharing — driven through the app itself.
 *
 * These go in the front door: pick a photo, save the form, open a recipe,
 * press the Portions stepper, click Share. The interesting one is J2.8's
 * failure path — a photo whose upload does not land has to survive on the
 * recipe as data, because the alternative is losing someone's picture in
 * silence.
 *
 * The browser bits the app leans on that the stub DOM has not got — a
 * canvas, an Image, object URLs, a clock — are stood up here rather than in
 * the shared helpers, since nothing else needs them.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadUI, aRecipe } = require("./helpers/load.js");
const { makeElement } = require("./helpers/dom.js");

// A book id and photo path in the shape Storage uses, "<book>/<recipe>.jpg".
// The store rejects anything else, so a mis-built path shows up as a
// recipe with no photo rather than as a passing test.
const BOOK = "11111111-1111-4111-8111-111111111111";
const RECIPE_UUID = "22222222-2222-4222-8222-222222222222";
const STORED_PATH = `${BOOK}/${RECIPE_UUID}.jpg`;

const PHOTO_BYTES = Buffer.from("jpeg-bytes-pretend-this-is-a-photo");
const PHOTO_DATA_URI = "data:image/jpeg;base64," + PHOTO_BYTES.toString("base64");

/** Let every queued promise callback run. setTimeout is a no-op in the stub. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The browser surface `compressImageFile` needs: an Image that loads, an
 * object URL, and a canvas that records what it was asked to draw. The
 * resampling itself is the browser's; what is checked here is the size and
 * quality the app asks for.
 */
function installImageStubs(ui, dataUri, dims) {
  const record = { canvas: null, drew: null, toDataURL: null, revoked: 0 };
  const savedImage = globalThis.Image;
  const savedCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const savedRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const savedCreateElement = ui.win.document.createElement;

  globalThis.Image = class FakeImage {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this.width = dims.width;
      this.height = dims.height;
    }
    set src(value) {
      this._src = value;
      queueMicrotask(() => this.onload && this.onload());
    }
    get src() {
      return this._src;
    }
  };
  URL.createObjectURL = () => "blob:fake";
  URL.revokeObjectURL = () => {
    record.revoked += 1;
  };
  ui.win.document.createElement = (tag) => {
    const el = savedCreateElement.call(ui.win.document, tag);
    if (tag !== "canvas") return el;
    el.getContext = () => ({
      drawImage: (img, x, y, w, h) => {
        record.drew = { x, y, w, h };
      },
    });
    el.toDataURL = (type, quality) => {
      record.toDataURL = { type, quality, width: el.width, height: el.height };
      return dataUri;
    };
    record.canvas = el;
    return el;
  };

  record.restore = () => {
    if (savedImage === undefined) delete globalThis.Image;
    else globalThis.Image = savedImage;
    if (savedCreate) Object.defineProperty(URL, "createObjectURL", savedCreate);
    else delete URL.createObjectURL;
    if (savedRevoke) Object.defineProperty(URL, "revokeObjectURL", savedRevoke);
    else delete URL.revokeObjectURL;
    ui.win.document.createElement = savedCreateElement;
  };
  return record;
}

/** Choose a photo from the device, the way the file input does. */
async function pickPhoto(ui, dataUri = PHOTO_DATA_URI, dims = { width: 2400, height: 1200 }) {
  const stubs = installImageStubs(ui, dataUri, dims);
  try {
    await ui.el("photo-file").fire("change", {
      target: { files: [{ name: "photo.jpg" }], value: "unchanged" },
    });
    await flush();
  } finally {
    stubs.restore();
  }
  return stubs;
}

/**
 * The ingredient editor builds real DOM rows, which the stub has not got.
 * Stand in the rows the person typed so the form can be read back.
 */
function setIngredientRows(ui, ingredients) {
  const rows = ingredients.map((ing) => {
    const row = makeElement("ing-row");
    const fields = {
      ".ing-amount": Object.assign(makeElement("a"), { value: ing.amount }),
      ".ing-unit": Object.assign(makeElement("u"), { value: ing.unit }),
      ".ing-item": Object.assign(makeElement("i"), { value: ing.item }),
    };
    row.querySelector = (sel) => fields[sel];
    return row;
  });
  ui.el("ingredient-rows").querySelectorAll = () => rows;
}

/** Open the empty new-recipe form. Opening it clears any photo held over. */
function openNewRecipeForm(ui) {
  ui.el("add-recipe-btn").fire("click");
}

/** Fill the open form in and press Save. */
function submitRecipe(ui, { name = "Soup", ingredients, steps = ["Heat it."], servings = "" } = {}) {
  const f = ui.el("recipe-form").elements;
  f.name.value = name;
  f.steps.value = steps.join("\n");
  f.servings.value = String(servings);
  setIngredientRows(ui, ingredients || [{ amount: "1", unit: "l", item: "stock" }]);
  ui.el("recipe-form").fire("submit");
}

/** A signed-in app with a fake cloud whose photo calls are recorded. */
function signedInApp({ uploadPhoto, signedPhotoUrl } = {}) {
  const ui = loadUI();
  const calls = { uploads: [], signed: [] };
  // Photos are the api's business; the book they belong to is sync's.
  ui.win.RecipeCloud = {
    sync: { bookId: BOOK },
    api: {
      userId: "user-1",
      uploadPhoto: async (bookId, recipeId, blob) => {
        calls.uploads.push({ bookId, recipeId, blob });
        if (uploadPhoto) return uploadPhoto(bookId, recipeId, blob);
        return `${bookId}/${recipeId}.jpg`;
      },
      signedPhotoUrl: async (path) => {
        calls.signed.push(path);
        return signedPhotoUrl ? signedPhotoUrl(path) : `https://signed.example/${path}?token=1`;
      },
      deletePhoto: async () => {},
    },
  };
  return { ...ui, calls };
}

/** Open a recipe the way clicking its card does. */
function openDetail(ui, id) {
  ui.el("recipe-list").fire("click", {
    target: { closest: (sel) => (sel === ".recipe-card" ? { dataset: { id } } : null) },
  });
}

/** Press the Portions stepper: "up", "down" or "reset". */
function pressScale(ui, action) {
  ui.el("detail-content").fire("click", {
    target: { closest: (sel) => (sel === "[data-scale]" ? { dataset: { scale: action } } : null) },
  });
}

/** The <li> texts of a named list in the detail view, in the order shown. */
function listItems(html, className) {
  const block = new RegExp(`<(ul|ol) class="${className}">([\\s\\S]*?)</\\1>`).exec(html);
  if (!block) return null;
  return [...block[2].matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => m[1].trim());
}

function scaleValue(html) {
  const m = /<span class="scale-value">([^<]*)<\/span>/.exec(html);
  return m ? m[1] : null;
}

function imgSrc(html) {
  const m = /<img class="(?:card-img|detail-img)" src="([^"]*)"/.exec(html);
  return m ? m[1] : null;
}

// --- J2.7 · downscaling before it goes anywhere -------------------------

test("J2.7 · a device photo is downscaled to 1200px at quality 0.78 before it goes anywhere", async () => {
  const ui = loadUI();
  openNewRecipeForm(ui);
  const picked = await pickPhoto(ui, PHOTO_DATA_URI, { width: 2400, height: 1200 });

  assert.deepEqual(
    { width: picked.toDataURL.width, height: picked.toDataURL.height },
    { width: 1200, height: 600 },
    "the longest side is capped at 1200px and the aspect ratio is kept"
  );
  assert.equal(picked.toDataURL.type, "image/jpeg");
  assert.equal(picked.toDataURL.quality, 0.78);
  assert.deepEqual(picked.drew, { x: 0, y: 0, w: 1200, h: 600 }, "drawn at the reduced size");
  // And the downscaled result is what the form now holds.
  assert.equal(ui.el("photo-preview").src, PHOTO_DATA_URI);
});

test("J2.7 · a photo already under the cap is not enlarged", async () => {
  const ui = loadUI();
  openNewRecipeForm(ui);
  const picked = await pickPhoto(ui, PHOTO_DATA_URI, { width: 640, height: 480 });
  assert.deepEqual(
    { width: picked.toDataURL.width, height: picked.toDataURL.height },
    { width: 640, height: 480 }
  );
});

// --- J2.8 · uploaded to private storage, or kept as data ----------------

test("J2.8 · signed in, a device photo is uploaded and the recipe keeps only its path", async () => {
  const ui = signedInApp();
  openNewRecipeForm(ui);
  await pickPhoto(ui);
  submitRecipe(ui, { name: "Photographed Soup" });
  await flush();

  const saved = ui.store.recipes.find((r) => r.name === "Photographed Soup");
  assert.equal(ui.calls.uploads.length, 1, "the photo was uploaded once");
  const [upload] = ui.calls.uploads;
  assert.equal(upload.bookId, BOOK);
  assert.equal(upload.recipeId, saved.id, "filed under the recipe it belongs to");
  assert.equal(upload.blob.type, "image/jpeg");
  assert.equal(upload.blob.size, PHOTO_BYTES.length, "the downscaled bytes, not the original file");

  assert.equal(saved.imagePath, `${BOOK}/${saved.id}.jpg`, "the recipe keeps the path");
  assert.equal(saved.image, "", "and not the data URI");
});

test("J2.8 · a photo is never silently lost when the upload fails", async () => {
  const ui = signedInApp({
    uploadPhoto: async () => {
      throw new Error("bucket unreachable");
    },
  });
  openNewRecipeForm(ui);
  await pickPhoto(ui);
  submitRecipe(ui, { name: "Photographed Soup" });
  await flush();

  const saved = ui.store.recipes.find((r) => r.name === "Photographed Soup");
  assert.ok(saved, "the recipe itself still saved");
  assert.equal(ui.calls.uploads.length, 1, "the upload was attempted");
  assert.equal(saved.image, PHOTO_DATA_URI, "the photo stays on the recipe as data");
  assert.equal(saved.imagePath, "", "and no path was invented for a photo that isn't there");
});

test("J2.8 · with nowhere to upload to, the photo stays on the recipe as data", async () => {
  const ui = loadUI(); // no RecipeCloud: signed out
  openNewRecipeForm(ui);
  await pickPhoto(ui);
  submitRecipe(ui, { name: "Photographed Soup" });
  await flush();

  const saved = ui.store.recipes.find((r) => r.name === "Photographed Soup");
  assert.equal(saved.image, PHOTO_DATA_URI);
  assert.equal(saved.imagePath, "");
});

test("J2.8 · a stored photo is shown through a signed URL, fetched once and reused", async () => {
  const ui = signedInApp();
  const recipe = ui.store.add(aRecipe({ name: "Stored Photo", imagePath: STORED_PATH }));
  const SIGNED = `https://signed.example/${STORED_PATH}?token=1`;

  ui.app.render();
  assert.equal(imgSrc(ui.el("recipe-list").innerHTML), null, "nothing is shown until a URL is signed");
  assert.deepEqual(ui.calls.signed, [STORED_PATH], "the path was sent for signing");

  // A second draw while the first request is still out must not start
  // another one — a grid of photos would otherwise sign each one twice.
  ui.app.render();
  assert.equal(ui.calls.signed.length, 1, "a request already in flight is not repeated");

  await flush();
  ui.app.render();
  assert.equal(imgSrc(ui.el("recipe-list").innerHTML), SIGNED, "the card shows the signed URL");

  openDetail(ui, recipe.id);
  assert.equal(imgSrc(ui.el("detail-content").innerHTML), SIGNED, "and so does the open recipe");

  ui.app.render();
  assert.equal(ui.calls.signed.length, 1, "a URL still in date is reused, not re-signed");
});

test("J2.8 · a signed URL that has expired is asked for again", async () => {
  const ui = signedInApp();
  ui.store.add(aRecipe({ name: "Stored Photo", imagePath: STORED_PATH }));

  const realNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    ui.app.render();
    await flush();
    ui.app.render();
    assert.equal(ui.calls.signed.length, 1);
    assert.ok(imgSrc(ui.el("recipe-list").innerHTML), "shown while the URL is in date");

    now += 56 * 60 * 1000; // past the 55-minute refresh window
    ui.app.render();
    assert.equal(imgSrc(ui.el("recipe-list").innerHTML), null, "an expired URL is not shown");
    assert.equal(ui.calls.signed.length, 2, "a fresh one is requested");
  } finally {
    Date.now = realNow;
  }
});

// --- J4 · Cooking from a recipe -----------------------------------------

const DINNER = aRecipe({
  name: "Dinner",
  servings: 4,
  ingredients: [
    { amount: 1.5, unit: "tbsp", item: "olive oil" },
    { amount: 400, unit: "g", item: "tomatoes" },
    { amount: null, unit: "", item: "salt, to taste" },
  ],
  steps: ["Chop the tomatoes.", "Warm the oil.", "Simmer for twenty minutes."],
});

function openedDinner() {
  const ui = loadUI();
  const recipe = ui.store.add(DINNER);
  ui.app.render();
  openDetail(ui, recipe.id);
  return { ...ui, recipe, html: () => ui.el("detail-content").innerHTML };
}

test("J4.1 · opening a recipe shows ingredients and steps in reading order", () => {
  const ui = openedDinner();
  assert.equal(ui.el("detail-view").open, true, "the recipe opened");
  assert.deepEqual(listItems(ui.html(), "detail-ingredients"), [
    "1½ tbsp olive oil",
    "400 g tomatoes",
    "salt, to taste",
  ]);
  assert.deepEqual(listItems(ui.html(), "detail-steps"), [
    "Chop the tomatoes.",
    "Warm the oil.",
    "Simmer for twenty minutes.",
  ]);
});

test("J4.2 · the Portions stepper rescales amounts using kitchen fractions", () => {
  const ui = openedDinner();
  assert.equal(scaleValue(ui.html()), "Serves 4");

  pressScale(ui, "down");
  pressScale(ui, "down"); // 4 servings down to 2: halved
  assert.equal(scaleValue(ui.html()), "Serves 2");
  assert.deepEqual(listItems(ui.html(), "detail-ingredients"), [
    "¾ tbsp olive oil",
    "200 g tomatoes",
    "salt, to taste",
  ]);

  pressScale(ui, "up");
  pressScale(ui, "up");
  pressScale(ui, "up");
  pressScale(ui, "up"); // back up to 6
  assert.equal(scaleValue(ui.html()), "Serves 6");
  assert.deepEqual(listItems(ui.html(), "detail-ingredients"), [
    "2¼ tbsp olive oil",
    "600 g tomatoes",
    "salt, to taste",
  ]);
});

test("J2.3, J4.2 · an ingredient with no amount is not scaled", () => {
  const ui = openedDinner();
  pressScale(ui, "up");
  const shown = listItems(ui.html(), "detail-ingredients");
  assert.equal(shown[2], "salt, to taste", "a 'to taste' line is kept as it is");
});

test("J4.3 · scaling is display-only — the saved recipe never changes", () => {
  const ui = openedDinner();
  const before = JSON.parse(JSON.stringify(ui.store.getById(ui.recipe.id)));

  pressScale(ui, "up");
  pressScale(ui, "up");
  assert.equal(scaleValue(ui.html()), "Serves 6", "the display did change");

  assert.deepEqual(
    ui.store.getById(ui.recipe.id),
    before,
    "the stored recipe is byte-for-byte what it was"
  );
});

test("J4.3 · closing the recipe forgets the scale", () => {
  const ui = openedDinner();
  pressScale(ui, "up");
  pressScale(ui, "up");
  assert.equal(scaleValue(ui.html()), "Serves 6");

  ui.el("detail-close-btn").fire("click");
  assert.equal(ui.el("detail-view").open, false);
  openDetail(ui, ui.recipe.id);

  assert.equal(scaleValue(ui.html()), "Serves 4", "reopening starts at the recipe as written");
  assert.deepEqual(listItems(ui.html(), "detail-ingredients"), [
    "1½ tbsp olive oil",
    "400 g tomatoes",
    "salt, to taste",
  ]);
});

test("J4.3 · opening a different recipe does not inherit the last one's scale", () => {
  const ui = loadUI();
  const dinner = ui.store.add(DINNER);
  const other = ui.store.add(aRecipe({ name: "Other", servings: 4 }));
  ui.app.render();

  openDetail(ui, dinner.id);
  pressScale(ui, "up");
  assert.equal(scaleValue(ui.el("detail-content").innerHTML), "Serves 5");

  openDetail(ui, other.id);
  assert.equal(scaleValue(ui.el("detail-content").innerHTML), "Serves 4");
});

test("J4.8 · the recipe as written is always one tap away at full portions", () => {
  const ui = openedDinner();
  assert.doesNotMatch(ui.html(), /data-scale="reset"/, "nothing to reset at full portions");

  pressScale(ui, "down");
  pressScale(ui, "down");
  assert.match(ui.html(), /data-scale="reset"/, "a way back is offered once scaled");

  pressScale(ui, "reset"); // one tap
  assert.equal(scaleValue(ui.html()), "Serves 4");
  assert.deepEqual(listItems(ui.html(), "detail-ingredients"), [
    "1½ tbsp olive oil",
    "400 g tomatoes",
    "salt, to taste",
  ]);
});

// --- J6 · Sharing a recipe out ------------------------------------------

/** Click Share and hand back what reached the clipboard. */
async function share(ui) {
  let copied = null;
  ui.win.navigator.clipboard.writeText = async (text) => {
    copied = text;
  };
  await ui.el("detail-share-btn").fire("click");
  return { copied, toast: ui.el("toast").textContent };
}

test("J6.1 · Share copies a link carrying the recipe in the URL fragment", async () => {
  const ui = openedDinner();
  const { copied } = await share(ui);

  assert.ok(copied, "something reached the clipboard");
  const prefix = `${ui.win.location.origin}${ui.win.location.pathname}#add=`;
  assert.ok(copied.startsWith(prefix), `link points at this app's own origin: ${copied}`);

  const payload = copied.slice(prefix.length);
  assert.ok(payload.length > 0, "the fragment carries the recipe, not just a marker");
  const decoded = await ui.win.RecipeShare.decodeRecipeShare(payload);
  assert.ok(decoded, "the link decodes back to a recipe");
  assert.equal(decoded.name, "Dinner");
  assert.deepEqual(decoded.steps, ui.recipe.steps);
  assert.deepEqual(decoded.ingredients, ui.recipe.ingredients);
  assert.equal(decoded.servings, 4);
});

test("J6.1 · the link is copied, and the app says so", async () => {
  const ui = openedDinner();
  const { toast } = await share(ui);
  assert.match(toast, /copied/i);
});

test("J6.2 · a stored photo stays behind, and the person is told", async () => {
  const ui = signedInApp();
  const recipe = ui.store.add(aRecipe({ name: "Stored Photo", imagePath: STORED_PATH }));
  ui.app.render();
  openDetail(ui, recipe.id);

  const { copied, toast } = await share(ui);
  assert.match(toast, /photo stays behind/i, "the loss is said out loud, not left to be found");

  const decoded = await ui.win.RecipeShare.decodeRecipeShare(copied.split("#add=")[1]);
  assert.equal(decoded.name, "Stored Photo");
  assert.ok(!decoded.imagePath, "the private path does not travel");
  assert.equal(decoded.image || "", "", "and neither does any photo data");
});

test("J6.1 · with no clipboard to write to, the link is offered rather than dropped", async () => {
  const ui = openedDinner();
  ui.win.navigator.clipboard.writeText = async () => {
    throw new Error("blocked");
  };
  let offered = null;
  ui.win.prompt = (_message, value) => {
    offered = value;
    return value;
  };
  await ui.el("detail-share-btn").fire("click");
  assert.ok(offered && offered.includes("#add="), "the link is put somewhere it can be copied by hand");
});

// --- J2.9 · not throwing typed work away ---------------------------------

/**
 * Drive the editor's two accidental exits, reading what the confirm
 * dialog was asked and answering for it.
 */
function editorWith(ui) {
  const asked = [];
  const dialog = ui.el("confirm-dialog");
  const message = ui.el("confirm-message");
  const show = dialog.showModal;
  dialog.showModal = () => {
    asked.push(message.textContent);
    show();
  };
  return {
    asked,
    answers: (yes) => { dialog.answer = yes ? "yes" : ""; },
    open: () => ui.el("editor-view").open,
    tapOutside: () => ui.el("editor-view").fire("click"),
    pressEscape: () => {
      const prevented = { yes: false };
      const settled = ui.el("editor-view").fire("cancel", {
        preventDefault: () => { prevented.yes = true; },
      });
      return Promise.resolve(settled).then(() => prevented.yes);
    },
    type: (name) => { ui.el("recipe-form").elements.name.value = name; },
  };
}

test("J2.9 · leaving an untouched form alone closes it without asking", async () => {
  const ui = loadUI();
  const editor = editorWith(ui);
  openNewRecipeForm(ui);
  assert.equal(editor.open(), true);

  await editor.tapOutside();
  assert.equal(editor.open(), false, "nothing was typed, so nothing is at risk");
  assert.deepEqual(editor.asked, [], "and open-look-leave stays a single tap");
});

test("J2.9 · a tap outside a half-typed recipe asks before discarding it", async () => {
  const ui = loadUI();
  const editor = editorWith(ui);
  openNewRecipeForm(ui);
  editor.type("Grandmother's pie");

  editor.answers(false);
  await editor.tapOutside();
  assert.equal(editor.open(), true, "answering no leaves the recipe where it was");
  assert.equal(editor.asked.length, 1);
  assert.match(editor.asked[0], /Discard this recipe\?/);

  editor.answers(true);
  await editor.tapOutside();
  assert.equal(editor.open(), false, "answering yes still lets it go");
});

test("J2.9 · Escape asks too, and keeps the form open when the answer is no", async () => {
  const ui = loadUI();
  const editor = editorWith(ui);
  openNewRecipeForm(ui);
  editor.type("Grandmother's pie");

  editor.answers(false);
  // The app takes the decision off the browser, which would otherwise
  // have closed the dialog before anyone was asked.
  assert.equal(await editor.pressEscape(), true, "the browser's own close is stopped first");
  assert.equal(editor.open(), true);
  assert.equal(editor.asked.length, 1);
});

test("J2.9 · Cancel is an explicit choice, so it does not ask", () => {
  const ui = loadUI();
  const editor = editorWith(ui);
  openNewRecipeForm(ui);
  editor.type("Grandmother's pie");

  ui.el("cancel-edit-btn").fire("click");
  assert.equal(editor.open(), false);
  assert.deepEqual(editor.asked, [], "the button says what it does; asking twice is nagging");
});

test("J2.10 · deleting a recipe asks first, and no means no", async () => {
  const ui = openedDinner();
  ui.el("detail-edit-btn").fire("click"); // deleting lives in the editor (J4.20)
  const dialog = ui.el("confirm-dialog");
  const asked = [];
  const show = dialog.showModal;
  dialog.showModal = () => {
    asked.push(ui.el("confirm-message").textContent);
    show();
  };

  dialog.answer = "";
  await ui.el("edit-delete-btn").fire("click");
  assert.equal(ui.store.recipes.length, 1, "answering no leaves the recipe where it was");
  assert.equal(ui.el("editor-view").open, true, "and does not close the editor either");
  assert.match(asked[0], /Dinner/, "the recipe is named rather than described as 'this recipe'");
  assert.match(asked[0], /can't be undone/);

  dialog.answer = "yes";
  await ui.el("edit-delete-btn").fire("click");
  assert.deepEqual(ui.store.recipes, [], "and yes still deletes it");
  assert.equal(ui.el("editor-view").open, false);
});

test("J4.20 · there is nothing to delete until there is something saved", () => {
  const ui = loadUI();

  ui.el("add-recipe-btn").fire("click");
  assert.equal(ui.el("edit-delete-btn").hidden, true, "a recipe not yet written has nothing to delete");

  const saved = ui.store.add(DINNER);
  ui.app.render();
  openDetail(ui, saved.id);
  ui.el("detail-edit-btn").fire("click");
  assert.equal(ui.el("edit-delete-btn").hidden, false, "editing one that exists does");
});

test("J4.20 · a recipe arriving from a link cannot be deleted before it is yours", async () => {
  const ui = loadUI();
  ui.el("paste-input").value = JSON.stringify({
    name: "Someone Else's Stew",
    ingredients: [{ amount: 1, unit: "kg", item: "beef" }],
    steps: ["Braise it."],
  });
  await ui.el("paste-save-btn").fire("click");

  assert.equal(ui.el("editor-title").textContent, "Review recipe", "the review form is open");
  assert.equal(ui.el("edit-delete-btn").hidden, true,
    "there is nothing of yours to delete — it is not in the box until you save it");
});

// ---------------------------------------------------------------------
// J4.9–J4.14 · Cook mode, driven through the recipe view
// ---------------------------------------------------------------------

/** A recipe open in the app, with a wake lock we can watch. */
function cooking({ supported = true } = {}) {
  const ui = loadUI();
  const calls = { requested: 0, released: 0 };
  const listeners = [];
  if (supported) {
    ui.win.navigator.wakeLock = {
      request: async () => {
        calls.requested++;
        return {
          addEventListener: (_e, fn) => listeners.push(fn),
          release: async () => { calls.released++; },
        };
      },
    };
  } else {
    delete ui.win.navigator.wakeLock;
  }
  return { ui, calls, dropLock: () => listeners.forEach((fn) => fn()) };
}

test("J4.9 · the recipe view offers to keep the screen on, and does not by itself", async () => {
  const { ui, calls } = cooking();
  const saved = ui.store.add(aRecipe({ name: "Slow Braise" }));
  ui.app.render();
  openDetail(ui, saved.id);
  await new Promise((r) => setImmediate(r));

  assert.equal(ui.el("detail-cook-btn").hidden, false, "the control is there");
  assert.equal(calls.requested, 0, "but the screen is not held until asked");
  assert.match(ui.el("detail-cook-btn").textContent, /Screen on/);
});

test("J4.9 · pressing it holds the screen and says so", async () => {
  const { ui, calls } = cooking();
  const saved = ui.store.add(aRecipe({ name: "Slow Braise" }));
  ui.app.render();
  openDetail(ui, saved.id);
  await ui.el("detail-cook-btn").fire("click");
  await new Promise((r) => setImmediate(r));

  assert.equal(calls.requested, 1);
  assert.match(ui.el("detail-cook-btn").textContent, /Staying on/,
    "invisible state that costs battery has to be visible");
});

test("J4.10 · closing the recipe any way at all lets the screen go", async () => {
  const { ui, calls } = cooking();
  const saved = ui.store.add(aRecipe({ name: "Slow Braise" }));
  ui.app.render();
  openDetail(ui, saved.id);
  await ui.el("detail-cook-btn").fire("click");
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.requested, 1);

  // Escape and the backdrop both fire `close` without touching a button.
  ui.el("detail-view").fire("close");
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.released, 1, "a phone in a pocket is not still awake");
});

test("J4.13 · a browser that cannot keep the screen awake is not offered the choice", async () => {
  const { ui } = cooking({ supported: false });
  const saved = ui.store.add(aRecipe({ name: "Slow Braise" }));
  ui.app.render();
  openDetail(ui, saved.id);
  await new Promise((r) => setImmediate(r));
  assert.equal(ui.el("detail-cook-btn").hidden, true);
});

test("J4.14 · cook mode is never a reason a recipe fails to open", async () => {
  const ui = loadUI();
  ui.win.navigator.wakeLock = { request: async () => { throw new Error("refused"); } };
  const saved = ui.store.add(aRecipe({ name: "Slow Braise" }));
  ui.app.render();
  openDetail(ui, saved.id);
  await ui.el("detail-cook-btn").fire("click");
  await new Promise((r) => setImmediate(r));

  assert.equal(ui.el("detail-view").open, true, "the recipe is still on screen");
  assert.equal(ui.el("detail-title-text").textContent, "Slow Braise");
});

// ---------------------------------------------------------------------
// J4.17 · An open recipe is a place, not a state
//
// Full-screen on a phone, the recipe view reads as a page, and a page is
// left with the Back button. On a bare <dialog> that walks out of the app
// — mid-cook, taking your place and the wake lock with it. These hold the
// address that makes Back mean "close the recipe" instead.
// ---------------------------------------------------------------------

test("J4.17 · opening a recipe gives it an address", () => {
  const ui = openedDinner();
  assert.equal(ui.win.location.hash, `#recipe=${ui.recipe.id}`,
    "the address bar says which recipe is open");
});

test("J4.17 · Back closes the recipe rather than leaving the app", () => {
  const ui = openedDinner();
  ui.win.history.back();

  assert.equal(ui.el("detail-view").open, false, "the recipe closed");
  assert.notEqual(ui.win.leftTheApp, true,
    "and Back was spent on the recipe, not on walking out of the app");
  assert.equal(ui.win.location.hash, "", "the address is back to the list");
});

test("J4.17 · closing the recipe takes its history entry with it", () => {
  const ui = openedDinner();
  const before = ui.win.history.length;
  ui.el("detail-close-btn").fire("click");

  assert.equal(ui.el("detail-view").open, false);
  assert.equal(ui.win.history.length, before - 1,
    "an entry left behind would let Back re-open a recipe already closed");
  assert.equal(ui.win.location.hash, "");
});

test("J4.17 · a recipe reopened from its address is the one named", () => {
  const ui = loadUI();
  const other = ui.store.add(aRecipe({ name: "Something Else" }));
  const wanted = ui.store.add(DINNER);
  ui.app.render();

  // What a reload leaves behind: the box is there and the address names
  // one of them, with nothing yet open.
  ui.win.location.hash = `#recipe=${wanted.id}`;
  assert.equal(ui.app.openFromHash(), true);

  assert.equal(ui.el("detail-view").open, true, "the recipe came back");
  assert.equal(ui.el("detail-title-text").textContent, "Dinner");
  assert.doesNotMatch(ui.el("detail-content").innerHTML, /Something Else/,
    `and it is the recipe the address named, not merely ${other.name}`);
});

test("J4.17 · an address naming a recipe we do not hold opens nothing", () => {
  const ui = loadUI({ hash: "#recipe=22222222-2222-4222-8222-222222222222" });
  assert.equal(ui.app.openFromHash(), false);
  assert.equal(ui.el("detail-view").open, false, "and nothing is invented to fill it");
  assert.equal(ui.win.location.hash, "#recipe=22222222-2222-4222-8222-222222222222",
    "the fragment survives, so a later sync can still honour it");
});

test("J4.10, J4.17 · closing with Back lets the screen lock go too", async () => {
  const { ui, calls } = cooking();
  const saved = ui.store.add(aRecipe({ name: "Slow Braise" }));
  ui.app.render();
  openDetail(ui, saved.id);
  await ui.el("detail-cook-btn").fire("click");
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.released, 0);

  ui.win.history.back();
  await new Promise((r) => setImmediate(r));

  assert.equal(calls.released, 1,
    "a phone going back in a pocket must not still be awake, whichever exit was used");
});

test("J4.18 · the Portions stepper sits with the ingredients it changes", () => {
  const ui = openedDinner();
  const html = ui.html();
  const heading = html.indexOf("<h3>Ingredients</h3>");
  const stepper = html.indexOf('class="scale-row"');
  const list = html.indexOf('class="detail-ingredients"');

  assert.ok(heading !== -1 && stepper !== -1 && list !== -1, "all three are on screen");
  assert.ok(heading < stepper && stepper < list,
    "above the heading it read as being about the recipe; the only thing it changes is the list below it");
});

// ---------------------------------------------------------------------
// J2.11, J4.21, J4.22 · Finishing the full-screen recipe view
//
// The view was made to fill the screen and given an address before the
// editor had either, which left Back meaning "close this" on one screen
// and "leave the app" on the next — and the second one could take typed
// work with it.
// ---------------------------------------------------------------------

test("J2.11 · the editor has an address, so Back closes it rather than the app", () => {
  const ui = loadUI();
  ui.el("add-recipe-btn").fire("click");
  assert.equal(ui.win.location.hash, "#new", "a new recipe is somewhere you can be");

  ui.win.history.back();
  assert.equal(ui.el("editor-view").open, false, "the editor closed");
  assert.notEqual(ui.win.leftTheApp, true, "and Back was spent on it, not on walking out");
  assert.equal(ui.win.location.hash, "");
});

test("J2.11 · editing from a recipe stacks, so Back returns to the recipe", async () => {
  const ui = openedDinner();
  const recipeHash = ui.win.location.hash;

  ui.el("detail-edit-btn").fire("click");
  assert.equal(ui.el("editor-view").open, true);
  assert.equal(ui.win.location.hash, `#edit=${ui.recipe.id}`);

  await ui.win.history.back();
  assert.equal(ui.el("editor-view").open, false, "the editor closed");
  assert.equal(ui.el("detail-view").open, true, "and the recipe you were reading came back");
  assert.equal(ui.win.location.hash, recipeHash);
});

test("J2.9, J2.11 · Back out of the editor asks before it drops typed work", async () => {
  const ui = openedDinner();
  ui.el("detail-edit-btn").fire("click");
  const editorHash = ui.win.location.hash;
  ui.el("recipe-form").elements.name.value = "Dinner, but better";

  ui.el("confirm-dialog").answer = ""; // keep editing
  await ui.win.history.back();
  assert.equal(ui.el("editor-view").open, true, "typed work is not dropped by a stray Back");
  assert.equal(ui.win.location.hash, editorHash,
    "and the entry goes back, so Back still means Back next time");

  ui.el("confirm-dialog").answer = "yes"; // discard
  await ui.win.history.back();
  assert.equal(ui.el("editor-view").open, false, "answering yes lets it go");
  assert.equal(ui.el("detail-view").open, true, "onto the recipe it was opened from");
});

test("J4.21 · opening a recipe says which recipe opened", () => {
  const ui = openedDinner();
  assert.equal(ui.el("detail-heading").focused, true,
    "focus lands on the recipe's name, not on whichever control is first in the markup");
});

test("J4.22 · the page behind is held still while a recipe is open", () => {
  const ui = openedDinner();
  assert.equal(ui.win.document.body.classList.contains("dialog-open"), true);
  ui.el("detail-close-btn").fire("click");
  assert.equal(ui.win.document.body.classList.contains("dialog-open"), false,
    "and released again, or the list could never be scrolled");
});

test("J4.17 · Back into a recipe that has been deleted does not name it any more", async () => {
  const ui = openedDinner();
  ui.el("detail-edit-btn").fire("click");
  ui.el("confirm-dialog").answer = "yes";
  await ui.el("edit-delete-btn").fire("click");
  assert.deepEqual(ui.store.recipes, [], "the recipe is gone");

  await ui.win.history.back();
  assert.equal(ui.el("detail-view").open, false, "nothing is resurrected");
  assert.equal(ui.win.location.hash, "", "and the address stops pointing at it");
});
