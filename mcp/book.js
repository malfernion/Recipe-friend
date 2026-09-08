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

/**
 * What being removed looks like from out here (J16.7). Said in one place
 * because it is said from two: when the book is first opened, and when a
 * sync that used to work stops.
 */
const REMOVED =
  "That agent is not in that book any more. Somebody removed it, which takes its " +
  "account with it — add a new agent in the Books dialog and paste the new credential.";

class BookError extends Error {
  constructor(message) {
    super(message);
    this.name = "BookError";
  }
}

/**
 * Open the book the credential names.
 *
 * Opening is the credential and the membership row, not the contents:
 * the first pull happens on the first tool call, along with every pull
 * after it. That way there is one rule about how fresh the answers are
 * rather than one for the first question and another for the rest.
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
  if (!book) throw new BookError(REMOVED);
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

  return new Book(win, api, store, planStore, sync, book);
}

class Book {
  constructor(win, api, store, planStore, sync, book) {
    this.writes = Promise.resolve();
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
   * Called before every tool call, read or write, because a stdio server
   * is long-lived and the household is editing the same book from a
   * phone while it runs. An answer from a snapshot taken an hour ago is
   * the same wrong shopping list as one computed by the wrong code.
   *
   * **One at a time.** A model turn commonly carries two tool calls, and
   * `syncNow` answers a re-entrant call by returning undefined and doing
   * nothing — which this layer cannot tell from a failure. So callers
   * queue on the same promise and every one of them gets the same
   * answer, rather than one of them being told the network is down.
   */
  /**
   * One write at a time, whatever the host asks for at once.
   *
   * A write here is read-modify-write against a plan that is one row for
   * the whole book, and its undo is the plan as it was before. Both of
   * those are only true if nothing else changed the plan in between —
   * so two writes overlapping would take each other's work as their own
   * starting point, and the second one's undo would put the first one
   * back after it had been rolled back and reported as failed. A meal
   * nobody asked for, arriving on the next call that syncs.
   *
   * Reads do not queue here: they share the sync above, which is enough
   * for them.
   */
  write(task) {
    const attempt = this.writes.then(task, task);
    // The lane must not stay broken because one write failed.
    this.writes = attempt.then(() => {}, () => {});
    return attempt;
  }

  refresh() {
    if (!this.syncing) {
      this.syncing = this.syncOnce().finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  async syncOnce() {
    // `syncNow` reports a failure by returning null and setting its
    // status rather than by throwing — right for a status line that will
    // retry, wrong for a tool answering a question now.
    const result = await this.sync.syncNow();
    if (result) return result;
    throw await this.whyNot();
  }

  /**
   * Which kind of failure that was.
   *
   * A removed agent and an unreachable project look identical from
   * inside `syncNow`, and J17.5 says telling them apart is the point of
   * writing the two messages separately: one sends somebody to the Books
   * dialog, the other says to wait. So on the failure path only — never
   * on the ordinary one — ask the roster which it was.
   */
  async whyNot() {
    let books;
    try {
      books = await this.api.listBooks();
    } catch {
      // The roster could not be read either, so the network is the
      // simplest explanation and the honest one.
      return new BookError("Could not reach the book just now. Ask again in a moment.");
    }
    if (!books.some((b) => b.id === this.id && b.role === "agent")) return new BookError(REMOVED);
    return new BookError("Could not reach the book just now. Ask again in a moment.");
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

module.exports = { openBook, Book, BookError, MODULES, REMOVED };
