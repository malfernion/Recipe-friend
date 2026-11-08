/**
 * A book as the MCP server sees it: the app's modules, an in-memory
 * cache, and a stub for the eight calls `RecipeSync` makes.
 *
 * Stubbing the api rather than the whole of PostgREST keeps these tests
 * about what an agent is allowed to do — which calls its sync reaches
 * for, and which it must never reach for (J16.3, J16.4).
 */
"use strict";

const { loadApp } = require("./load.js");
const { openBook } = require("../../mcp/book.js");

const BOOK = "11111111-1111-4111-8111-111111111111";

/**
 * `archive` is a function rather than a list because an archived plan
 * names recipe ids, and those are not known until the rows are made.
 */
async function agentBook({ recipes = [], archive = () => [], role = "agent", lists = [] } = {}) {
  const win = loadApp("units.js", "scale.js", "storage.js", "plan.js", "planstore.js", "search.js");
  const rows = recipes.map((raw, i) => {
    const recipe = win.RecipeStore.sanitizeRecipe(raw);
    return { id: recipe.id, data: recipe, updated_at: new Date(1000 + i).toISOString(), deleted_at: null };
  });
  const idFor = (name) => rows.find((r) => r.data.name === name).id;
  const plans = () => archive(idFor, win);

  const sent = { recipes: [], livePlans: [], archived: [], listUpdates: [], listRefusals: [] };
  const L = loadApp("units.js", "scale.js", "lists.js").RecipeLists;
  let listClock = 10000;
  const listRow = (list) => ({
    id: list.id,
    book_id: BOOK,
    name: list.name,
    name_at: list.nameAt,
    kind: list.kind,
    items: list.items,
    pruned_to: list.prunedTo || 0,
    deleted_at: null,
    created_at: new Date(list.createdAt || 1).toISOString(),
    updated_at: new Date(++listClock).toISOString(),
  });
  const listRows = lists.map((l) => listRow(L.sanitizeList(l)));
  let brokenListPush = null;
  let pulls = 0;
  let live = null;
  let broken = null;
  let brokenPlans = null;
  let brokenRecipePush = null;
  let brokenPlanPush = null;

  const api = {
    userId: null,
    async listBooks() {
      return role ? [{ id: BOOK, role, name: "Ours", isOwner: false }] : [];
    },
    async fetchRecipes() {
      if (broken) throw new Error(broken);
      pulls++;
      return rows;
    },
    async pushRecipes(list) {
      if (broken || brokenRecipePush) throw new Error(broken || brokenRecipePush);
      sent.recipes.push(...list);
      // A pushed row is a row the server holds from now on, which is
      // what makes the addOnly filter mean anything in a test.
      rows.push(...list.map((r) => ({ id: r.id, data: r.data, updated_at: r.updated_at, deleted_at: null })));
    },
    async fetchLivePlan() {
      if (brokenPlans) throw new Error(brokenPlans);
      return live;
    },
    async pushLivePlan(bookId, plan) {
      if (broken || brokenPlans || brokenPlanPush) throw new Error(broken || brokenPlans || brokenPlanPush);
      sent.livePlans.push(plan);
      // What the book holds now, so the next pull sees what went up —
      // without this no test ever meets its own write coming back.
      live = { book_id: BOOK, data: plan, updated_at: new Date(Date.now()).toISOString() };
    },
    async fetchArchivedPlanIds() {
      return plans().map((p) => p.id);
    },
    async fetchArchivedPlans() {
      return plans().map((p) => ({ id: p.id, data: p, completed_at: new Date(p.completedAt).toISOString() }));
    },
    async insertArchivedPlan(bookId, plan) {
      sent.archived.push(plan);
      return true;
    },
    // Lists (J18): one row each, written back compare-and-set on
    // updated_at, refusing what the database refuses an agent (012).
    async fetchLists() {
      if (broken) throw new Error(broken);
      return listRows.map((r) => ({ ...r }));
    },
    async fetchList(bookId, id) {
      if (broken) throw new Error(broken);
      const row = listRows.find((r) => r.id === id);
      return row ? { ...row } : null;
    },
    async insertList() {
      sent.listRefusals.push("insert");
      throw new Error("new row violates row-level security policy for table \"lists\"");
    },
    async deleteList() {
      sent.listRefusals.push("delete");
      throw new Error("an agent may change a list's items, not the list");
    },
    async updateList(bookId, id, fields, seenAt) {
      if (broken || brokenListPush) throw new Error(broken || brokenListPush);
      const row = listRows.find((r) => r.id === id);
      if (!row || row.updated_at !== seenAt) return false;
      if ("name" in fields || "name_at" in fields || "deleted_at" in fields) {
        sent.listRefusals.push("rename");
        throw new Error("an agent may change a list's items, not the list");
      }
      Object.assign(row, fields, { updated_at: new Date(++listClock).toISOString() });
      sent.listUpdates.push({ id, fields });
      return true;
    },
  };

  const session = { bookId: BOOK, open: async () => ({ client: {}, userId: "agent-1" }) };
  const book = await openBook(session, { api });
  // Opening is the credential and the membership row; the contents
  // arrive on the first tool call, which the server makes happen for
  // every call after it too.
  await book.refresh();

  return {
    book,
    /**
     * Call a tool the way the server calls it: pull first, then run. Any
     * test that goes straight to `tool.run` is testing a path no host
     * takes.
     */
    call: async (tool, args = {}) => {
      await book.refresh();
      return tool.run(book, args);
    },
    win,
    api,
    sent,
    idOf: (name) => book.recipes.find((r) => r.name === name).id,
    /** Somebody else adds a recipe to the book while the server runs. */
    addRemoteRecipe: (raw) => {
      const recipe = win.RecipeStore.sanitizeRecipe(raw);
      rows.push({
        id: recipe.id,
        data: recipe,
        updated_at: new Date(Date.now()).toISOString(),
        deleted_at: null,
      });
      return recipe;
    },
    /** How many times the book has been read. */
    pulls: () => pulls,
    /** What the server holds as the live plan, for a test about merging. */
    setRemotePlan: (plan) => {
      live = plan && { book_id: BOOK, data: plan, updated_at: new Date(5000).toISOString() };
    },
    /** Take the network away, the way a train tunnel does. */
    breakNetwork: (why = "network") => {
      broken = why;
    },
    /** Give all of it back. */
    mendNetwork: () => {
      broken = brokenPlans = brokenRecipePush = brokenPlanPush = brokenListPush = null;
    },
    /** Only writing a list back fails. */
    breakListPush: (why = "network") => {
      brokenListPush = why;
    },
    /** The lists as the server holds them. */
    listRow: (id) => listRows.find((r) => r.id === id),
    serverList: (id) => {
      const r = listRows.find((x) => x.id === id);
      return r && L.sanitizeList({ id: r.id, name: r.name, nameAt: r.name_at, kind: r.kind, prunedTo: r.pruned_to, items: r.items });
    },
    /** Somebody changes a list from a phone: `fn` is a RecipeLists op. */
    phone: (id, fn) => {
      const r = listRows.find((x) => x.id === id);
      const now = L.sanitizeList({ id: r.id, name: r.name, nameAt: r.name_at, kind: r.kind, prunedTo: r.pruned_to, items: r.items });
      const next = fn(now, L);
      Object.assign(r, { items: next.items, name: next.name, name_at: next.nameAt, updated_at: new Date(++listClock).toISOString() });
      return next;
    },
    /** Somebody makes a list from a phone. */
    addRemoteList: (list) => {
      listRows.push(listRow(L.sanitizeList(list)));
    },
    L,
    /**
     * Break only the plan half of a sync, which is the shape that made
     * `add_recipe` lie: the recipes go up first and succeed, and the
     * trip fails afterwards.
     */
    breakPlanHalf: (why = "network") => {
      brokenPlans = why;
    },
    /** Only the recipe push fails: the book stays readable, so a tool
     *  asking what became of a recipe gets a straight answer. */
    breakRecipePush: (why = "network") => {
      brokenRecipePush = why;
    },
    /** Only the plan push fails, the same way. */
    breakPlanPush: (why = "network") => {
      brokenPlanPush = why;
    },
  };
}

module.exports = { agentBook, BOOK };
