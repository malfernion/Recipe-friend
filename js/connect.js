/**
 * connect.js — an app asking to sign in: the consent screen (J16.15).
 *
 * Claude.ai, ChatGPT, Claude Code and other MCP clients reach the hosted
 * server (/mcp) by signing in rather than with a key. GoTrue is the
 * OAuth server; when an app asks it to sign somebody in, it sends the
 * browser here, to `/?authorization_id=…`, and waits for the answer.
 *
 * The answer is the owner's, and it is a book: the app joins one book they
 * own as an agent (J16.1, J16.3), exactly as an agent with a key does, and
 * never acts as the person. So the screen
 *
 *   - needs the person signed in (the usual Google sign-in; the request is
 *     held in sessionStorage across that round trip, as an invite is),
 *   - names the app and the host it will send them back to, because the
 *     name is whatever the app chose to call itself and the host is not,
 *   - offers only books they own, and says why when there are none,
 *   - on Allow, has the database make the agent (connect_app) and only
 *     then approves the request in GoTrue, so the token GoTrue issues has
 *     an agent to name; on Deny, tells GoTrue no.
 *
 * Either way GoTrue answers with where to send the browser — back to the
 * app — and this goes there.
 */
(function (global) {
  "use strict";

  const PENDING_KEY = "recipe-friend:pending-authorization";
  // GoTrue's ids are 32 lowercase letters and digits; anything far from
  // that is not one, and is not carried around.
  const ID = /^[A-Za-z0-9_-]{8,128}$/;

  /**
   * Take an authorization id off the address, if one is there, and hold it
   * for this tab. Taken off so a reload or a shared link does not replay
   * it, and held so a sign-in in between does not lose it.
   */
  function captureAuthorization(loc, hist, storage) {
    let id = null;
    try {
      id = new URLSearchParams(loc.search || "").get("authorization_id");
    } catch {
      id = null;
    }
    if (id && ID.test(id)) {
      try {
        storage.setItem(PENDING_KEY, id);
      } catch {
        /* held only for this page load */
      }
      const rest = new URLSearchParams(loc.search);
      rest.delete("authorization_id");
      const query = rest.toString();
      hist.replaceState(null, "", loc.pathname + (query ? `?${query}` : "") + (loc.hash || ""));
      return id;
    }
    try {
      const held = storage.getItem(PENDING_KEY);
      return held && ID.test(held) ? held : null;
    } catch {
      return null;
    }
  }

  function forgetAuthorization(storage) {
    try {
      storage.removeItem(PENDING_KEY);
    } catch {
      /* best effort */
    }
  }

  /** "claude.ai", "localhost:33418": where the app sends the person back. */
  function hostOf(uri) {
    try {
      return new URL(uri).host;
    } catch {
      return "";
    }
  }

  class ConnectUI {
    /**
     * `client` is the site's supabase-js client, `makeApi(session)` a
     * RecipeApi for the signed-in person, `go(url)` leaves for the app.
     * `doc`, `storage` and `signIn` are seams for the tests.
     */
    constructor({ id, client, makeApi, go, signIn, doc, storage }) {
      this.id = id;
      this.client = client;
      this.makeApi = makeApi;
      this.go = go;
      this.signIn = signIn;
      this.doc = doc;
      this.storage = storage;
      this.session = null;
      this.details = null;
      this.busy = false;
      this.finished = false;
    }

    $(id) {
      return this.doc.getElementById(id);
    }

    say(text) {
      const status = this.$("connect-status");
      if (status) status.textContent = text || "";
    }

    show(parts) {
      for (const [id, on] of Object.entries(parts)) {
        const el = this.$(id);
        if (el) el.hidden = !on;
      }
    }

    wire() {
      const allow = this.$("connect-allow-btn");
      const deny = this.$("connect-deny-btn");
      const signIn = this.$("connect-signin-btn");
      const dialog = this.$("connect-dialog");
      if (allow) allow.addEventListener("click", () => this.answer(true));
      if (deny) deny.addEventListener("click", () => this.answer(false));
      if (signIn) signIn.addEventListener("click", () => this.signIn && this.signIn());
      // Escape closes a dialog without a word to GoTrue. The request is
      // dropped here too, so it is not offered again on the next visit;
      // the app is left to time out and can ask again.
      if (dialog) {
        dialog.addEventListener("close", () => {
          if (!this.finished) forgetAuthorization(this.storage);
        });
      }
    }

    open() {
      const dialog = this.$("connect-dialog");
      if (dialog && !dialog.open) dialog.showModal();
    }

    /** Signed out: nothing about the app can be read yet, so say what is known. */
    signedOut() {
      this.session = null;
      const intro = this.$("connect-intro");
      if (intro) {
        intro.textContent =
          "An app is asking to use your recipes. Sign in to see which app it is and choose a book for it.";
      }
      this.show({
        "connect-host-line": false,
        "connect-choose": false,
        "connect-owners": false,
        "connect-allow-btn": false,
        "connect-signin-btn": true,
      });
      const deny = this.$("connect-deny-btn");
      if (deny) deny.textContent = "Cancel";
      this.say("");
      this.open();
      const btn = this.$("connect-signin-btn");
      if (btn) btn.focus();
    }

    /** Signed in: ask GoTrue what is being asked, and by whom. */
    async signedIn(session) {
      // getSession and the auth listener can both say so; ask GoTrue once.
      if (this.finished || this.loading || this.details) return;
      this.loading = true;
      try {
        await this.load(session);
      } finally {
        this.loading = false;
      }
    }

    async load(session) {
      this.session = session;
      this.show({ "connect-signin-btn": false });
      const deny = this.$("connect-deny-btn");
      if (deny) deny.textContent = "Deny";
      this.open();
      this.say("Checking the request…");

      const { data, error } = await this.client.auth.oauth.getAuthorizationDetails(this.id);
      if (error || !data) {
        console.warn("Recipe Friend: could not read the sign-in request.", error);
        forgetAuthorization(this.storage);
        this.finished = true;
        this.show({ "connect-allow-btn": false, "connect-choose": false });
        if (deny) deny.textContent = "Close";
        this.say("This sign-in request has expired or has already been answered. Start again from the app.");
        return;
      }
      // Already allowed for this person, and still connected: GoTrue has
      // approved it itself and says where to go.
      if (data.redirect_url) {
        this.leave(data.redirect_url, "Already connected. Taking you back to the app…");
        return;
      }

      this.details = data;
      const name = (data.client && data.client.name) || "An app";
      const host = hostOf(data.redirect_uri);
      const intro = this.$("connect-intro");
      if (intro) intro.textContent = `${name} wants to use your recipes.`;
      const hostEl = this.$("connect-host");
      if (hostEl) hostEl.textContent = host || "an address it did not give";
      this.show({ "connect-host-line": true });

      let owned = [];
      try {
        const books = await this.makeApi(session).listBooks();
        owned = books.filter((b) => b.isOwner && b.role !== "agent");
      } catch (err) {
        console.warn("Recipe Friend: could not load books.", err);
        this.say("Couldn’t load your books. Check your connection and reload this page.");
        return;
      }

      const pick = this.$("connect-book");
      if (pick) {
        const esc = global.RecipeHTML.escapeHTML;
        pick.innerHTML = owned.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("");
        if (owned[0]) pick.value = owned[0].id;
      }
      this.show({
        "connect-choose": owned.length > 0,
        "connect-owners": owned.length === 0,
        "connect-allow-btn": owned.length > 0,
      });
      this.say("");
      const focus = this.$(owned.length ? "connect-book" : "connect-deny-btn");
      if (focus) focus.focus();
    }

    /** Allow or Deny. Once: the buttons are dead while it is in flight. */
    async answer(allow) {
      if (this.busy || this.finished) return;
      if (!this.session) {
        // Cancel, signed out: there is nobody to answer for.
        forgetAuthorization(this.storage);
        this.finished = true;
        const dialog = this.$("connect-dialog");
        if (dialog) dialog.close();
        return;
      }
      if (!this.details) {
        const dialog = this.$("connect-dialog");
        if (dialog) dialog.close();
        return;
      }
      this.busy = true;
      this.setButtons(false);
      try {
        if (allow) {
          const pick = this.$("connect-book");
          const book = pick && pick.value;
          if (!book) throw new Error("choose a book first");
          this.say("Connecting…");
          await this.makeApi(this.session).connectApp(this.id, book);
          const { data, error } = await this.client.auth.oauth.approveAuthorization(this.id, {
            skipBrowserRedirect: true,
          });
          if (error || !data || !data.redirect_url) throw error || new Error("no answer from sign-in");
          this.leave(data.redirect_url, "Connected. Taking you back to the app…");
        } else {
          const { data, error } = await this.client.auth.oauth.denyAuthorization(this.id, {
            skipBrowserRedirect: true,
          });
          if (error || !data || !data.redirect_url) throw error || new Error("no answer from sign-in");
          this.leave(data.redirect_url, "Denied. Taking you back to the app…");
        }
      } catch (err) {
        console.warn("Recipe Friend: could not answer the sign-in request.", err);
        const said = err && err.message ? ` (${err.message})` : "";
        this.say(`That didn’t go through${said}. Try again, or start again from the app.`);
        this.setButtons(true);
      } finally {
        this.busy = false;
      }
    }

    setButtons(on) {
      for (const id of ["connect-allow-btn", "connect-deny-btn"]) {
        const el = this.$(id);
        if (el) el.disabled = !on;
      }
    }

    leave(url, words) {
      this.finished = true;
      forgetAuthorization(this.storage);
      this.setButtons(false);
      this.say(words);
      this.go(url);
    }
  }

  global.RecipeConnect = { ConnectUI, captureAuthorization, forgetAuthorization, hostOf, PENDING_KEY };

  // In the page: after account.js, which made the client.
  const cloud = global.RecipeCloud;
  const doc = global.document;
  if (!cloud || !cloud.client || !doc || !doc.getElementById("connect-dialog")) return;
  let storage = null;
  try {
    storage = global.sessionStorage;
  } catch {
    storage = null;
  }
  const id = captureAuthorization(global.location, global.history, storage || {
    getItem: () => null, setItem() {}, removeItem() {},
  });
  if (!id) return;

  const ui = new ConnectUI({
    id,
    client: cloud.client,
    makeApi: (session) => {
      const api = new global.RecipeApi(cloud.client);
      api.userId = session.user.id;
      return api;
    },
    go: (url) => global.location.assign(url),
    signIn: () => {
      const btn = doc.getElementById("account-btn");
      if (btn) btn.click();
    },
    doc,
    storage,
  });
  ui.wire();
  const settle = (session) => (session ? ui.signedIn(session) : ui.signedOut());
  cloud.client.auth.getSession().then(({ data }) => settle(data.session));
  cloud.client.auth.onAuthStateChange((_event, session) => {
    if (session) ui.signedIn(session);
  });
})(window);
