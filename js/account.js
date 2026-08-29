/**
 * account.js — Sign in with Google via Supabase Auth (M1).
 *
 * Signed out, the app behaves exactly as before — this file only manages
 * the session and the header account controls. Later milestones build
 * sync on top of the client it exposes as window.RecipeCloud.
 */
(function () {
  "use strict";

  const cfg = window.RECIPE_FRIEND_CONFIG;
  const signInBtn = document.getElementById("account-btn");
  const nameEl = document.getElementById("account-name");
  if (!signInBtn) return;

  if (!cfg || !cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase) {
    // No backend configured (or vendor script missing): stay local-only,
    // and never leave the user stranded behind the sign-in gate.
    signInBtn.hidden = true;
    document.body.classList.remove("gated");
    return;
  }

  // PKCE rather than the implicit flow. The implicit flow returns the
  // access *and* refresh token in the URL fragment, which puts long-lived
  // credentials through the address bar and browser history; PKCE returns a
  // short code that is exchanged out of band and never appears in a link
  // anyone could copy or a referrer anyone could log.
  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { flowType: "pkce" },
  });
  // Shared handle for later milestones (books, profiles) and tests.
  window.RecipeCloud = { client, session: null, sync: null };

  const statusEl = document.getElementById("sync-status");
  let books = null;

  // An invite link may arrive before sign-in; hold the code across the
  // round trip so the invite isn't lost at the gate.
  const PENDING_JOIN_KEY = "recipe-friend:pending-join";

  function captureJoinCode() {
    const match = location.hash.match(/^#join=(.+)$/);
    if (!match) return;
    history.replaceState(null, "", location.pathname + location.search);
    try {
      sessionStorage.setItem(PENDING_JOIN_KEY, match[1]);
    } catch {
      /* held only for this page load */
    }
  }

  async function handlePendingJoin() {
    let code = null;
    try {
      code = sessionStorage.getItem(PENDING_JOIN_KEY);
    } catch {
      code = null;
    }
    if (!code || !books) return;
    try {
      sessionStorage.removeItem(PENDING_JOIN_KEY);
    } catch {
      /* best effort */
    }
    await books.join(code);
  }

  captureJoinCode();
  window.addEventListener("hashchange", async () => {
    captureJoinCode();
    if (window.RecipeCloud.session) await handlePendingJoin();
  });

  const STATUS_TEXT = {
    syncing: "Syncing…",
    pending: "Saving…",
    synced: "Synced",
    error: "Sync paused — will retry",
  };

  function showStatus(state, detail) {
    if (!statusEl) return;
    statusEl.hidden = !state;
    statusEl.textContent = STATUS_TEXT[state] || "";
    statusEl.classList.toggle("sync-error", state === "error");
    if (state === "synced" && detail && (detail.pushed || detail.pulled)) {
      window.RecipeApp && window.RecipeApp.render();
    }
    // Sync failing over and over can mean the book itself is gone. Asking
    // for the book list settles it — and if that call fails too, refresh
    // simply rejects and we are none the wiser, which is the right answer
    // for a network that is down.
    if (state === "error" && books) {
      books.refresh().catch((err) => console.warn("Recipe Friend: books unavailable.", err));
    }
  }

  /**
   * Preferences belong to the person, so they follow them between devices:
   * what the profile already holds wins, otherwise this device seeds it.
   */
  async function reconcilePrefs(sync, store) {
    const remote = await sync.api.pullPrefs();
    const local = store.prefs;
    const hasRemote = remote && (remote.mass || remote.volume);
    const hasLocal = Boolean(local.mass || local.volume);
    if (hasRemote) {
      if (remote.mass !== local.mass || remote.volume !== local.volume) {
        store.setPrefs(remote); // display-only: stored recipes are untouched (J8.3)
      }
    } else if (hasLocal) {
      await sync.api.pushPrefs(local);
    }
  }

  async function startSync(session) {
    const app = window.RecipeApp;
    if (!app || !window.RecipeSync) return;
    const api = new window.RecipeApi(client);
    // The book's plan is cached and synced like its recipes (J12.2,
    // J12.3). Adopted from the app if it made one, so the planner is
    // working with the same object the screen is reading.
    const planStore =
      app.planStore || (window.RecipePlanStore ? new window.RecipePlanStore() : null);
    if (planStore) app.planStore = planStore;
    const sync = new window.RecipeSync(app.store, api, showStatus, planStore);
    window.RecipeCloud.api = api;
    window.RecipeCloud.sync = sync;
    window.RecipeCloud.planStore = planStore;
    // Local edits from here on push automatically (debounced) — one
    // debounce and one status line for both, so a plan and the recipes it
    // names never disagree about whether the device is in sync.
    app.store.onChange = () => sync.schedulePush();
    if (planStore) {
      planStore.onChange = () => sync.schedulePush();
      app.store.onForgetBook = (bookId) => planStore.forgetBook(bookId);
    }
    try {
      const remembered =
        window.RecipeBooks && window.RecipeBooks.rememberedSelection(session.user.id);
      await sync.resolveBook(session.user.id, remembered, displayName(session));
      // The local cache is per book, so point it at this one before
      // syncing. `resolveBook` sets the id directly rather than through
      // setBook, so the plan cache is pointed at it here too.
      app.store.useBook(sync.bookId);
      if (planStore) planStore.useBook(sync.bookId);
      if (window.RecipeBooks) {
        window.RecipeBooks.rememberSelection(session.user.id, sync.bookId);
        books = new window.RecipeBooks.BooksUI(sync, api, app);
        window.RecipeCloud.books = books;
        books.wire();
      }
      try {
        await reconcilePrefs(sync, app.store);
      } catch (err) {
        console.warn("Recipe Friend: could not sync preferences.", err);
      }
      await sync.syncNow();
      app.render();
      // A #recipe= link opened cold has been waiting for the book to
      // arrive; now it has (J4.17).
      if (app.openFromHash) app.openFromHash();
      if (books) {
        books.refresh().catch((err) => console.warn("Recipe Friend: books unavailable.", err));
      }
      await handlePendingJoin();
      if (app.showPendingShare) app.showPendingShare();
    } catch (err) {
      console.warn("Recipe Friend: could not start sync.", err);
      showStatus("error", err && err.message);
    }
  }

  function stopSync() {
    const app = window.RecipeApp;
    const booksBtn = document.getElementById("books-btn");
    const bookLabel = document.getElementById("current-book");
    if (booksBtn) booksBtn.hidden = true;
    if (bookLabel) bookLabel.hidden = true;
    books = null;
    window.RecipeCloud.books = null;
    if (app) {
      app.store.onChange = null;
      app.store.onForgetBook = null;
      if (app.planStore) app.planStore.onChange = null;
    }
    window.RecipeCloud.planStore = null;
    if (window.RecipeCloud.sync) window.RecipeCloud.sync.stop();
    window.RecipeCloud.sync = null;
    showStatus(null);
  }

  function displayName(session) {
    const meta = (session.user && session.user.user_metadata) || {};
    return meta.name || meta.full_name || session.user.email || "Signed in";
  }

  function render(session) {
    const had = Boolean(window.RecipeCloud.session);
    window.RecipeCloud.session = session;
    document.body.classList.toggle("gated", !session);
    if (session) {
      signInBtn.textContent = "Sign out";
      nameEl.textContent = displayName(session);
      nameEl.hidden = false;
      if (!had) startSync(session);
    } else {
      signInBtn.textContent = "Sign in";
      signInBtn.title = "Sign in with Google";
      nameEl.hidden = true;
      nameEl.textContent = "";
      if (had) stopSync();
    }
  }

  client.auth.getSession().then(({ data }) => render(data.session));
  client.auth.onAuthStateChange((_event, session) => render(session));

  // Catch up on anything that failed or queued while the tab was hidden.
  document.addEventListener("visibilitychange", () => {
    const sync = window.RecipeCloud.sync;
    if (!document.hidden && sync && sync.bookId) sync.syncNow();
  });
  window.addEventListener("online", () => {
    const sync = window.RecipeCloud.sync;
    if (sync && sync.bookId) sync.syncNow();
  });

  const ctaBtn = document.getElementById("signin-cta");
  if (ctaBtn) ctaBtn.addEventListener("click", () => signInBtn.click());

  signInBtn.addEventListener("click", async () => {
    if (window.RecipeCloud.session) {
      const { error } = await client.auth.signOut();
      if (error) console.warn("Recipe Friend: sign-out failed.", error);
      return;
    }
    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: location.origin + location.pathname },
    });
    if (error) {
      console.warn("Recipe Friend: sign-in failed.", error);
      alert("Sign-in didn't start — check the Supabase auth configuration.");
    }
  });
})();
