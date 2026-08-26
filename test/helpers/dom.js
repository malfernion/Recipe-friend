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
    focus() {},
    select() {},
    click() { el.fire("click", {}); },
    showModal() { el.open = true; },
    close() { el.open = false; },
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
    /** Drive a listener the way a browser would. */
    fire(type, event = {}) {
      for (const fn of listeners.get(type) || []) {
        fn({ target: el, preventDefault() {}, stopPropagation() {}, ...event });
      }
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

function makeDocument() {
  const byId = new Map();
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, id === "recipe-form" ? makeForm(id) : makeElement(id));
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
    history: { replaceState() {} },
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
    setTimeout: (fn) => { void fn; return 0; }, // toasts and coalesced redraws: don't run
    clearTimeout() {},
    confirm: () => true,
    alert() {},
    prompt: () => "",
    addEventListener() {},
    requestAnimationFrame: (fn) => { void fn; return 0; },
  };
  win.window = win;
  return win;
}

module.exports = { makeWindow, makeElement };
