/**
 * js/cookmode.js — keeping the screen awake while cooking (J4.9–J4.14).
 *
 * The sharp edge this file exists to pin: a browser drops a wake lock
 * whenever the page is hidden and never hands it back. A test that only
 * checks "toggle on, lock taken" would pass while the real failure — the
 * screen quietly sleeping again after you glance at a message — went
 * unnoticed.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/load.js");

const { CookMode, PREF_KEY } = loadApp("cookmode.js").RecipeCookMode;

/** A navigator whose wake lock behaves however the test needs. */
function fakeNavigator({ supported = true, refuse = false } = {}) {
  const calls = { requested: 0, released: 0 };
  const listeners = [];
  const nav = supported
    ? {
        wakeLock: {
          request: async (type) => {
            calls.requested++;
            calls.lastType = type;
            if (refuse) throw new Error("refused");
            return {
              released: false,
              addEventListener: (_e, fn) => listeners.push(fn),
              release: async () => { calls.released++; },
            };
          },
        },
      }
    : {};
  /** What the browser does on its own when the page is hidden. */
  nav.dropLock = () => listeners.forEach((fn) => fn());
  return { nav, calls };
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

const make = (opts = {}, store = fakeStorage()) => {
  const { nav, calls } = fakeNavigator(opts);
  return { cook: new CookMode({ navigator: nav, storage: store }), nav, calls, store };
};

test("J4.9 · cook mode is off until it is asked for", async () => {
  const { cook, calls } = make();
  await cook.enter();
  assert.equal(cook.active, false, "opening a recipe does not take the screen");
  assert.equal(calls.requested, 0);
});

test("J4.9 · asking for it takes the screen lock", async () => {
  const { cook, calls } = make();
  await cook.enter();
  await cook.toggle();
  assert.equal(cook.active, true);
  assert.equal(calls.requested, 1);
  assert.equal(calls.lastType, "screen", "a screen lock, not some other kind");
});

test("J4.9 · asking again gives it back", async () => {
  const { cook, calls } = make();
  await cook.enter();
  await cook.toggle();
  await cook.toggle();
  assert.equal(cook.active, false);
  assert.equal(calls.released, 1);
});

test("J4.10 · closing the recipe lets the screen go", async () => {
  const { cook, calls } = make();
  await cook.enter();
  await cook.enable();
  await cook.leave();
  assert.equal(cook.active, false, "a phone back in a pocket is not still awake");
  assert.equal(calls.released, 1);
});

test("J4.10 · closing keeps the preference, it just drops the lock", async () => {
  const { cook } = make();
  await cook.enter();
  await cook.enable();
  await cook.leave();
  assert.equal(cook.wanted, true, "you should not have to ask again for the next recipe");
});

test("J4.11 · a glance away does not end it for the rest of the cook", async () => {
  const { cook, nav, calls } = make();
  await cook.enter();
  await cook.enable();
  assert.equal(cook.active, true);

  // What a browser does on its own when the page is hidden.
  nav.dropLock();
  assert.equal(cook.active, false, "the browser took it away");

  await cook.resume();
  assert.equal(cook.active, true, "and it is taken again on the way back");
  assert.equal(calls.requested, 2);
});

test("J4.11 · coming back to a closed recipe takes nothing", async () => {
  const { cook, calls } = make();
  await cook.enter();
  await cook.enable();
  await cook.leave();
  await cook.resume();
  assert.equal(cook.active, false, "no recipe is open, so nothing to keep awake");
  assert.equal(calls.requested, 1);
});

test("J4.11 · coming back when it was never wanted takes nothing", async () => {
  const { cook, calls } = make();
  await cook.enter();
  await cook.resume();
  assert.equal(calls.requested, 0);
});

test("J4.11 · returning twice does not stack locks", async () => {
  const { cook, calls } = make();
  await cook.enter();
  await cook.enable();
  await cook.resume();
  await cook.resume();
  assert.equal(calls.requested, 1, "it is already held; asking again would leak");
});

test("asking for it twice holds one lock, not two", async () => {
  // Two guards prevent this — one in resume(), one in acquire(). The
  // resume() test above only exercises the first, and a lock acquired
  // twice is a lock released once: the screen would stay awake after the
  // recipe closed.
  const { cook, calls } = make();
  await cook.enter();
  await cook.enable();
  await cook.enable();
  assert.equal(calls.requested, 1);

  await cook.leave();
  assert.equal(cook.active, false, "and one release is enough to let it go");
});

test("J4.12 · the choice is remembered on this device", async () => {
  const store = fakeStorage();
  const { cook } = make({}, store);
  await cook.enter();
  await cook.enable();
  assert.equal(store.getItem(PREF_KEY), "on");

  // A later visit on the same device: opening a recipe takes it straight back.
  const second = make({}, store);
  assert.equal(second.cook.wanted, true);
  await second.cook.enter();
  assert.equal(second.cook.active, true);
  assert.equal(second.calls.requested, 1);
});

test("J4.12 · turning it off is remembered too", async () => {
  const store = fakeStorage({ [PREF_KEY]: "on" });
  const { cook } = make({}, store);
  await cook.enter();
  await cook.disable();
  assert.equal(store.getItem(PREF_KEY), null);
  assert.equal(make({}, store).cook.wanted, false);
});

test("J4.12 · a device that refuses storage still works, just forgets", async () => {
  const hostile = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  const { nav } = fakeNavigator();
  const cook = new CookMode({ navigator: nav, storage: hostile });
  assert.equal(cook.wanted, false);
  await cook.enter();
  await cook.enable();
  assert.equal(cook.active, true, "private browsing does not break cooking");
});

test("J4.13 · where the browser cannot do it, it is not offered", async () => {
  const { cook } = make({ supported: false });
  assert.equal(cook.supported, false);
  await cook.enter();
  await cook.enable();
  assert.equal(cook.active, false);
});

test("J4.14 · a refused lock never breaks the recipe", async () => {
  const { cook } = make({ refuse: true });
  await cook.enter();
  const ok = await cook.enable();
  assert.equal(ok, false, "it reports the failure");
  assert.equal(cook.active, false);
  assert.equal(cook.wanted, false, "and does not leave a toggle claiming to be on");
});

test("the control is told whenever the answer changes", async () => {
  const { nav } = fakeNavigator();
  let changes = 0;
  const cook = new CookMode({ navigator: nav, storage: fakeStorage(), onChange: () => changes++ });
  await cook.enter();
  await cook.enable();
  const afterEnable = changes;
  assert.ok(afterEnable > 0, "turning it on says so");

  nav.dropLock();
  assert.ok(changes > afterEnable, "and so does the browser taking it away");
});
