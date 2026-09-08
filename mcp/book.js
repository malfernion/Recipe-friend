/**
 * mcp/book.js — the app's own modules, running against the one book.
 *
 * This is the reason the server lives in this repository. The shopping
 * list an agent computes has to be the list the phone computes — the
 * same promotion to kilograms, the same tolerance of plurals, the same
 * refusal to guess how big a tin is — and the only way to be sure of
 * that is to run the same code. A reimplementation would drift on
 * exactly those, and nobody would notice until the list was wrong in a
 * supermarket.
 *
 * So the modules are loaded, not copied. `test/helpers/load.js` already
 * puts the app's browser IIFEs into a fake `window` in bare Node with a
 * `Map` for `localStorage`, which is every dependency they have; this is
 * the one file outside `test/` that reaches for it, deliberately, rather
 * than a second loader drifting alongside the first.
 *
 * The cache is memory and goes with the process. A cold start is a full
 * pull, which is the path a new device takes on its first sign-in.
 */
"use strict";

const { loadApp } = require("../test/helpers/load.js");

/** Everything the planner needs, and nothing that wants a browser. */
const MODULES = [
  "units.js", "scale.js", "storage.js",
  "plan.js", "planstore.js", "shoplist.js",
  "search.js", "sync.js",
];

class BookError extends Error {
  constructor(message) {
    super(message);
    this.name = "BookError";
  }
}

/**
 * Open the book the credential names, and sync it once.
 *
 * `api` is a seam for the tests, which stub the eight calls sync makes
 * rather than a whole PostgREST.
 */
async function openBook(session, { api: injected } = {}) {
  const { client, userId } = await session.open();
  const win = loadApp(...MODULES);

  const api = injected || new win.RecipeApi(client);
  api.userId = userId;

  const bookId = session.credential.book;
  const books = await api.listBooks();
  const book = books.find((b) => b.id === bookId);

  // The membership row is the whole of an agent's access, so its absence
  // is what being removed looks like from here (J16.7). Said plainly,
  // because the alternative is a server that reads an empty book and
  // reports a household with no recipes.
  if (!book) {
    throw new BookError(
      "That agent is not in that book any more. Somebody removed it, which takes " +
      "its account with it — add a new agent in the Books dialog and paste the new credential."
    );
  }
  // A credential is minted for an agent and an agent's role cannot be
  // changed (J16.8), so anything else here means a credential this
  // server was not written for.
  if (book.role !== "agent") {
    throw new BookError(`That credential is a ${book.role}'s, not an agent's.`);
  }

  const store = new win.RecipeStore();
  const planStore = new win.RecipePlanStore();
  const sync = new win.RecipeSync(store, api, () => {}, planStore);
  sync.userId = userId;
  // Three answers to "may this device write", not two (J16.3). `addOnly`
  // is what stops an upsert going up against a row the server already
  // has — an UPDATE no policy matches, and one refusal fails the whole
  // batch — and what keeps this away from finishing a plan (J16.4).
  sync.setBook(bookId, { readOnly: false, addOnly: true });
  store.useBook(bookId);

  const opened = new Book(win, api, store, planStore, sync, book);
  await opened.refresh();
  return opened;
}

class Book {
  constructor(win, api, store, planStore, sync, book) {
    this.win = win;
    this.api = api;
    this.store = store;
    this.planStore = planStore;
    this.sync = sync;
    this.id = book.id;
    this.name = book.name;
  }

  /**
   * Bring this process level with the book.
   *
   * Called before anything is read or written, because a stdio server is
   * long-lived and the household is editing the same book from a phone
   * while it runs. `syncNow` reports a failure by returning null and
   * setting its status rather than by throwing — right for a status line
   * that will retry, wrong for a tool answering a question now.
   */
  async refresh() {
    const result = await this.sync.syncNow();
    if (!result) {
      throw new BookError("Could not reach the book just now. Ask again in a moment.");
    }
    return result;
  }

  /** The recipes, newest first, as the app holds them. */
  get recipes() {
    return this.store.recipes;
  }

  /**
   * An agent has no unit preferences, because preferences belong to a
   * person and this is not one (J8, J16.1). So amounts come back as they
   * were written down, which is what somebody who has never opened the
   * preferences dialog sees (J8.1).
   */
  get prefs() {
    return this.store.prefs;
  }

  get plan() {
    return this.planStore.plan;
  }
}

module.exports = { openBook, Book, BookError, MODULES };
