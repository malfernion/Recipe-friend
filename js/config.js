/**
 * config.js — where the backend is, and the public key to talk to it with.
 *
 * **This file is the development default.** Every real deployment answers
 * `/js/config.js` itself, from `server/config.js.tmpl` filled in with that
 * stack's own anon key (see `server/Caddyfile`), so
 * no deployment's key is ever pasted into a commit and the same checkout
 * serves the dev stack and production. What is below is only what a
 * browser gets from something that serves the repository without that
 * template — a plain static server in front of the dev stack, say.
 *
 * The site and the API share an origin (Caddy serves both), so the
 * project URL is wherever this page came from. Opened as a file there is
 * no origin and no backend, and the app falls back to local-only (J1.6).
 *
 * The key is the dev stack's `anon` token from `server/.env.example`: a
 * labelled fake, for a stack on 127.0.0.1 that holds nothing. An anon key
 * is public by design — it can only do what row-level security allows,
 * which for a signed-out visitor is nothing. The `service_role` key must
 * NEVER appear in this repo, here or in the template.
 */
window.RECIPE_FRIEND_CONFIG = {
  supabaseUrl: /^https?:$/.test((window.location && window.location.protocol) || "")
    ? window.location.origin
    : "",
  supabaseKey:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzkyMjgxNjAwLCJleHAiOjQxMDI0NDQ4MDB9.eFkUpKSXGHT_K3a7_0Snj3iYPNI0PMVX114f7YmtjT8",
};
