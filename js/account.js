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
    // No backend configured (or vendor script missing): stay local-only.
    signInBtn.hidden = true;
    return;
  }

  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
  // Shared handle for later milestones (books, profiles) and tests.
  window.RecipeCloud = { client, session: null, sync: null };

  const statusEl = document.getElementById("sync-status");

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
  }

  async function startSync(session) {
    const app = window.RecipeApp;
    if (!app || !window.RecipeSync) return;
    const sync = new window.RecipeSync(app.store, client, showStatus);
    window.RecipeCloud.sync = sync;
    // Local edits from here on push automatically (debounced).
    app.store.onChange = () => sync.schedulePush();
    try {
      await sync.resolveBook(session.user.id);
      await sync.syncNow();
      app.render();
    } catch (err) {
      console.warn("Recipe Friend: could not start sync.", err);
      showStatus("error", err && err.message);
    }
  }

  function stopSync() {
    const app = window.RecipeApp;
    if (app) app.store.onChange = null;
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
