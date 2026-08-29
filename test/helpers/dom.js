/**
 * A DOM small enough to load js/app.js and drive it.
 *
 * Not a browser: just enough of the surface app.js touches to load it,
 * fire its listeners, and read back what it rendered. Tests written against
 * this exercise the app the way a person does — type in the search box,
 * read the list — so they keep meaning the same thing when the code behind
 * them is rearranged.
 */
"use strict";

function makeElement(id) {
  const listeners = new Map();
  const el = {
    id,
    innerHTML: "",
    textContent: "",
    value: "",
    hidden: false,
    disabled: false,
    open: false,
    checked: false,
    dataset: {},
    style: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, on) { on === undefined ? (this._set.has(c) ? this._set.delete(c) : this._set.add(c)) : on ? this._set.add(c) : this._set.delete(c); },
    },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    // Recorded rather than ignored: where focus lands when a screen opens
    // is the first thing a screen reader says about it.
    focus() { el.focused = true; },
    select() {},
    click() { el.fire("click", {}); },
    showModal() { el.open = true; },
    /*
      A real <dialog> fires `close` whenever it closes, however it closes.
      The stub used not to, so every side effect hung on that event —
      letting go of the wake lock, unwinding a history entry — was invisible
      to any test that closed a dialog through a button rather than firing
      `close` by hand. Closing an already-closed dialog is a no-op, as in
      the browser.
    */
    close(returnValue) {
      if (!el.open) return;
      if (returnValue !== undefined) el.returnValue = returnValue;
      el.open = false;
      el.fire("close");
    },
    reset() {},
    reportValidity() { return true; },
    replaceWith() {},
    contains() { return false; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    /**
     * Drive a listener the way a browser would.
     *
     * A browser ignores what a listener returns, but an async one hands
     * back a promise, and a test that does not await it reads the DOM
     * before the handler has finished. So it is returned here — `await
     * el.fire("click")` settles the handler, and a synchronous listener
     * returns undefined as before.
     */
    fire(type, event = {}) {
      const results = [];
      for (const fn of listeners.get(type) || []) {
        results.push(fn({ target: el, preventDefault() {}, stopPropagation() {}, ...event }));
      }
      return results.some((r) => r && typeof r.then === "function")
        ? Promise.all(results)
        : undefined;
    },
  };
  return el;
}

/** Named form fields, created on demand. */
function makeForm(id) {
  const form = makeElement(id);
  const fields = {};
  form.elements = new Proxy(fields, {
    get(target, name) {
      if (typeof name !== "string") return target[name];
      if (!target[name]) target[name] = makeElement(name);
      return target[name];
    },
  });
  return form;
}

/**
 * The dialog ask.js opens, answering itself.
 *
 * ask() resolves on the dialog's close event, which in a browser waits
 * for a person. Nothing here is a person, so showModal answers straight
 * away and the promise settles in the same turn. The default is yes,
 * which is what the window.confirm stub did before this was a dialog;
 * a test says otherwise with `el("confirm-dialog").answer = ""`.
 */
function makeConfirmDialog(id) {
  const el = makeElement(id);
  el.answer = "yes";
  el.showModal = () => {
    el.returnValue = el.answer;
    el.open = false;
    el.fire("close");
  };
  return el;
}

function makeDocument() {
  const byId = new Map();
  const get = (id) => {
    if (!byId.has(id)) {
      byId.set(
        id,
        id === "recipe-form" ? makeForm(id) : id === "confirm-dialog" ? makeConfirmDialog(id) : makeElement(id)
      );
    }
    return byId.get(id);
  };
  const doc = {
    body: { classList: makeElement("body").classList, contains: () => false },
    el: get, // test-side access
    querySelector(sel) {
      const m = /^#([\w-]+)$/.exec(sel);
      return m ? get(m[1]) : null;
    },
    querySelectorAll() { return []; },
    getElementById(id) { return get(id); },
    createElement(tag) { return makeElement(tag); },
    addEventListener() {},
  };
  return doc;
}

/** A window with a document, ready for app.js to be loaded into it. */
function makeWindow() {
  const document = makeDocument();
  const win = {
    document,
    location: { hash: "", origin: "https://test.local", pathname: "/", search: "" },
    navigator: { clipboard: { writeText: async () => {} } },
    sessionStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
      };
    })(),
    CSS: { escape: (s) => s },
    // Window-level listeners, so a test can drive popstate the way the
    // Back button does. addEventListener is replaced below, once the
    // stack it writes into exists.
    _events: new Map(),
    setTimeout: (fn) => { void fn; return 0; }, // toasts and coalesced redraws: don't run
    clearTimeout() {},
    confirm: () => true,
    alert() {},
    prompt: () => "",
    requestAnimationFrame: (fn) => { void fn; return 0; },
  };

  win.addEventListener = (type, fn) => {
    if (!win._events.has(type)) win._events.set(type, []);
    win._events.get(type).push(fn);
  };
  /** Drive a window-level listener, the way a test drives an element's. */
  win.fire = (type, event = {}) => {
    const out = (win._events.get(type) || []).map((fn) => fn(event));
    return out.length === 1 ? out[0] : Promise.all(out);
  };

  /*
    A history stack real enough to answer the question the app asks it:
    does going back close the recipe, or leave the app? Entries hold the
    hash they were pushed with; back() pops one, restores the hash of
    whatever is underneath, and fires popstate — which is exactly the
    sequence a phone's Back button produces.
  */
  const stack = [{ hash: "" }];
  win.history = {
    get length() { return stack.length; },
    pushState(state, _title, url) {
      stack.push({ hash: String(url || "").replace(/^[^#]*/, "") });
      win.location.hash = stack[stack.length - 1].hash;
    },
    replaceState(state, _title, url) {
      const hash = String(url || "").replace(/^[^#]*/, "");
      stack[stack.length - 1] = { hash };
      win.location.hash = hash;
    },
    /*
      Returns whatever the popstate listeners return, so a test can await
      the navigation. Deciding whether to close the editor means asking
      about unsaved work, which is a promise; without this a test reads
      the DOM a turn before the answer lands.
    */
    back() {
      if (stack.length <= 1) {
        win.leftTheApp = true; // what a bare <dialog> does without an address
        return undefined;
      }
      stack.pop();
      win.location.hash = stack[stack.length - 1].hash;
      return win.fire("popstate", { state: null });
    },
  };

  win.window = win;
  return win;
}

module.exports = { makeWindow, makeElement };
