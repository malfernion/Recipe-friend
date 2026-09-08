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
async function agentBook({ recipes = [], archive = () => [], role = "agent" } = {}) {
  const win = loadApp("units.js", "scale.js", "storage.js", "plan.js", "planstore.js", "shoplist.js", "search.js");
  const rows = recipes.map((raw, i) => {
    const recipe = win.RecipeStore.sanitizeRecipe(raw);
    return { id: recipe.id, data: recipe, updated_at: new Date(1000 + i).toISOString(), deleted_at: null };
  });
  const idFor = (name) => rows.find((r) => r.data.name === name).id;
  const plans = () => archive(idFor, win);

  const sent = { recipes: [], livePlans: [], archived: [] };
  let live = null;
  let broken = null;

  const api = {
    userId: null,
    async listBooks() {
      return role ? [{ id: BOOK, role, name: "Ours", isOwner: false }] : [];
    },
    async fetchRecipes() {
      if (broken) throw new Error(broken);
      return rows;
    },
    async pushRecipes(list) {
      if (broken) throw new Error(broken);
      sent.recipes.push(...list);
    },
    async fetchLivePlan() {
      return live;
    },
    async pushLivePlan(bookId, plan) {
      if (broken) throw new Error(broken);
      sent.livePlans.push(plan);
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
  };

  const session = { credential: { book: BOOK }, open: async () => ({ client: {}, userId: "agent-1" }) };
  const book = await openBook(session, { api });

  return {
    book,
    win,
    api,
    sent,
    idOf: (name) => book.recipes.find((r) => r.name === name).id,
    /** What the server holds as the live plan, for a test about merging. */
    setRemotePlan: (plan) => {
      live = plan && { book_id: BOOK, data: plan, updated_at: new Date(5000).toISOString() };
    },
    /** Take the network away, the way a train tunnel does. */
    breakNetwork: (why = "network") => {
      broken = why;
    },
  };
}

module.exports = { agentBook, BOOK };
