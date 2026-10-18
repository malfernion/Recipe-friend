/**
 * J16.15 · an app asking to sign in: the consent screen (js/connect.js).
 *
 * Driven the way somebody answers it: the app sends them to
 * /?authorization_id=…, they sign in if they have to, read which app it
 * is and where it will send them back to, pick one of their own books,
 * and press Allow or Deny. GoTrue and the database are fakes that record
 * what they were asked; db-oauth.test.js does the same against the real
 * ones.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadApp } = require("./helpers/load.js");
const { makeElement } = require("./helpers/dom.js");

const ID = "mquwkfe3wvxxzswjpemofrlpvfzvl2fi";
const MINE = "11111111-1111-4111-8111-111111111111";
const SECOND = "33333333-3333-4333-8333-333333333333";
const SHARED = "22222222-2222-4222-8222-222222222222";
const BACK = "https://claude.ai/api/mcp/auth_callback?code=abc&state=s";

function makeDoc() {
  const byId = new Map();
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, makeElement(id));
    return byId.get(id);
  };
  return { el: get, getElementById: get };
}

function storage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const flush = () => new Promise((r) => setImmediate(r));

/**
 * The screen, with GoTrue answering `details` for the request and the
 * person owning `books`.
 */
function harness({ details, books, fail = {} } = {}) {
  const win = loadApp("connect.js");
  const doc = makeDoc();
  const store = storage();
  store.setItem(win.RecipeConnect.PENDING_KEY, ID);
  const asked = [];
  const went = [];
  const session = { user: { id: "u-me" }, access_token: "t" };
  const answer = (redirect) => ({ data: { redirect_url: redirect }, error: null });
  const client = {
    auth: {
      oauth: {
        async getAuthorizationDetails(id) {
          asked.push(["details", id]);
          if (fail.details) return { data: null, error: new Error("authorization not found") };
          return {
            data: details || {
              authorization_id: id,
              redirect_uri: "https://claude.ai/api/mcp/auth_callback",
              client: { id: "c1", name: "Claude" },
              user: { id: "u-me", email: "me@example.test" },
              scope: "email",
            },
            error: null,
          };
        },
        async approveAuthorization(id, opts) {
          asked.push(["approve", id, opts]);
          if (fail.approve) return { data: null, error: new Error("authorization request is no longer pending") };
          return answer(BACK);
        },
        async denyAuthorization(id, opts) {
          asked.push(["deny", id, opts]);
          return answer("https://claude.ai/api/mcp/auth_callback?error=access_denied");
        },
      },
    },
  };
  const api = {
    async listBooks() {
      asked.push(["listBooks"]);
      return books || [
        { id: MINE, name: "Dave's recipes", role: "owner", isOwner: true },
        { id: SECOND, name: "Weeknights <b>", role: "owner", isOwner: true },
        { id: SHARED, name: "Household", role: "editor", isOwner: false },
      ];
    },
    async connectApp(id, book) {
      asked.push(["connect", id, book]);
      if (fail.connect) throw new Error("only the owner of a book may connect an app to it");
      return { userId: "agent-1", name: "Claude", bookId: book };
    },
  };
  let signIns = 0;
  const ui = new win.RecipeConnect.ConnectUI({
    id: ID, client, makeApi: () => api, go: (url) => went.push(url),
    signIn: () => { signIns += 1; }, doc, storage: store,
  });
  ui.wire();
  return { win, ui, doc, el: doc.el, store, asked, went, session, signIns: () => signIns,
    pending: () => store.getItem(win.RecipeConnect.PENDING_KEY) };
}

const options = (html) => [...html.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);

test("J16.15 · the request is taken off the address and held across the sign-in", () => {
  const { RecipeConnect } = loadApp("connect.js");
  const store = storage();
  let replaced = null;
  const hist = { replaceState: (_s, _t, url) => { replaced = url; } };

  const id = RecipeConnect.captureAuthorization({ search: `?authorization_id=${ID}&x=1`, pathname: "/", hash: "" }, hist, store);
  assert.equal(id, ID);
  assert.equal(replaced, "/?x=1", "so a reload or a copied link does not replay it");
  assert.equal(store.getItem(RecipeConnect.PENDING_KEY), ID);

  // Back from Google, the address has a sign-in code instead; the request is still held.
  assert.equal(RecipeConnect.captureAuthorization({ search: "?code=g", pathname: "/" }, hist, store), ID);

  const other = storage();
  assert.equal(RecipeConnect.captureAuthorization({ search: "?authorization_id=<script>", pathname: "/" }, hist, other), null,
    "something that is not an id is not carried around");
  assert.equal(RecipeConnect.captureAuthorization({ search: "", pathname: "/" }, hist, other), null);
});

test("J16.15 · signed out, it asks for sign-in first and names nothing it cannot know", async () => {
  const h = harness();
  h.ui.signedOut();

  assert.equal(h.el("connect-dialog").open, true);
  assert.match(h.el("connect-intro").textContent, /Sign in to see which app/);
  assert.equal(h.el("connect-signin-btn").hidden, false);
  assert.equal(h.el("connect-signin-btn").focused, true);
  assert.equal(h.el("connect-allow-btn").hidden, true, "nothing to allow before anyone is signed in");
  assert.equal(h.el("connect-deny-btn").textContent, "Cancel");

  await h.el("connect-signin-btn").fire("click");
  assert.equal(h.signIns(), 1, "the usual Google sign-in");
  assert.deepEqual(h.asked, [], "GoTrue is asked nothing without a session");
});

test("J16.15 · signed in, it names the app and the host it sends you back to, and offers only books you own", async () => {
  const h = harness();
  await h.ui.signedIn(h.session);

  assert.deepEqual(h.asked.slice(0, 2), [["details", ID], ["listBooks"]]);
  assert.equal(h.el("connect-intro").textContent, "Claude wants to use your recipes.");
  assert.equal(h.el("connect-host").textContent, "claude.ai", "the part of the request the app cannot choose");
  assert.equal(h.el("connect-host-line").hidden, false);
  assert.deepEqual(options(h.el("connect-book").innerHTML), [
    [MINE, "Dave's recipes".replace("'", "&#39;")],
    [SECOND, "Weeknights &lt;b&gt;"],
  ], "a book someone shared with you is not offered, and names are text");
  assert.equal(h.el("connect-choose").hidden, false);
  assert.equal(h.el("connect-owners").hidden, true);
  assert.equal(h.el("connect-allow-btn").hidden, false);
  assert.equal(h.el("connect-deny-btn").textContent, "Deny");
  assert.equal(h.el("connect-signin-btn").hidden, true);
});

test("J16.15 · Allow connects the chosen book, then approves, then goes back to the app", async () => {
  const h = harness();
  await h.ui.signedIn(h.session);
  h.el("connect-book").value = SECOND;

  await h.el("connect-allow-btn").fire("click");

  const steps = h.asked.slice(2).map((a) => a[0]);
  assert.deepEqual(steps, ["connect", "approve"], "the agent exists before GoTrue issues anything");
  assert.deepEqual(h.asked[2], ["connect", ID, SECOND]);
  assert.deepEqual(h.asked[3][2], { skipBrowserRedirect: true });
  assert.deepEqual(h.went, [BACK]);
  assert.equal(h.pending(), null, "and the request is not held any more");
  assert.equal(h.el("connect-allow-btn").disabled, true, "nor can it be answered twice");
});

test("J16.15 · Deny tells GoTrue no, connects nothing, and goes back to the app", async () => {
  const h = harness();
  await h.ui.signedIn(h.session);

  await h.el("connect-deny-btn").fire("click");

  assert.deepEqual(h.asked.slice(2).map((a) => a[0]), ["deny"]);
  assert.match(h.went[0], /error=access_denied/);
  assert.equal(h.pending(), null);
});

test("J16.15 · an editor or reader with no book of their own is told why, and can only deny", async () => {
  const h = harness({ books: [{ id: SHARED, name: "Household", role: "editor", isOwner: false }] });
  await h.ui.signedIn(h.session);

  assert.equal(h.el("connect-owners").hidden, false);
  assert.equal(h.el("connect-choose").hidden, true);
  assert.equal(h.el("connect-allow-btn").hidden, true);
  assert.equal(h.el("connect-deny-btn").focused, true);
});

test("J16.15 · a refused connect approves nothing and says so", async () => {
  const h = harness({ fail: { connect: true } });
  await h.ui.signedIn(h.session);

  await h.el("connect-allow-btn").fire("click");

  assert.equal(h.asked.some((a) => a[0] === "approve"), false, "GoTrue is not told yes for a book nobody got");
  assert.deepEqual(h.went, []);
  assert.match(h.el("connect-status").textContent, /didn’t go through.*only the owner/);
  assert.equal(h.el("connect-allow-btn").disabled, false, "and it can be tried again");
});

test("J16.15 · a request that has expired or been answered says so, rather than offering a choice", async () => {
  const h = harness({ fail: { details: true } });
  await h.ui.signedIn(h.session);

  assert.match(h.el("connect-status").textContent, /expired or has already been answered/);
  assert.equal(h.el("connect-allow-btn").hidden, true);
  assert.equal(h.pending(), null);
});

test("J16.15 · an app already connected and allowed goes straight back", async () => {
  const h = harness({ details: { redirect_url: BACK } });
  await h.ui.signedIn(h.session);

  assert.deepEqual(h.went, [BACK]);
  assert.deepEqual(h.asked.map((a) => a[0]), ["details"], "no second connect, no second approval");
});

test("J16.15 · signing in fires twice; GoTrue is asked once", async () => {
  const h = harness();
  await Promise.all([h.ui.signedIn(h.session), h.ui.signedIn(h.session)]);
  assert.equal(h.asked.filter((a) => a[0] === "details").length, 1);
});

test("J16.15 · closing the screen drops the request, so it is not offered again", async () => {
  const h = harness();
  await h.ui.signedIn(h.session);
  h.el("connect-dialog").close();
  assert.equal(h.pending(), null);
});

test("J16.15 · the host is read from the address, whatever the app calls itself", () => {
  const { RecipeConnect } = loadApp("connect.js");
  assert.equal(RecipeConnect.hostOf("http://localhost:33418/callback"), "localhost:33418");
  assert.equal(RecipeConnect.hostOf("https://claude.ai/api/mcp/auth_callback"), "claude.ai");
  assert.equal(RecipeConnect.hostOf("not a url"), "");
});
