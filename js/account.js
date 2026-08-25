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
  // Shared handle for later milestones (sync, books, profiles) and tests.
  window.RecipeCloud = { client, session: null };

  function displayName(session) {
    const meta = (session.user && session.user.user_metadata) || {};
    return meta.name || meta.full_name || session.user.email || "Signed in";
  }

  function render(session) {
    window.RecipeCloud.session = session;
    if (session) {
      signInBtn.textContent = "Sign out";
      nameEl.textContent = displayName(session);
      nameEl.hidden = false;
    } else {
      signInBtn.textContent = "Sign in";
      signInBtn.title = "Sign in with Google";
      nameEl.hidden = true;
      nameEl.textContent = "";
    }
  }

  client.auth.getSession().then(({ data }) => render(data.session));
  client.auth.onAuthStateChange((_event, session) => render(session));

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
