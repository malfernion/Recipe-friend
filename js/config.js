/**
 * config.js — Supabase project coordinates.
 *
 * Both values are public by design: the publishable key can only do what
 * row-level security allows, which for a signed-out visitor is nothing.
 * The secret/service_role key must NEVER appear in this repo.
 */
window.RECIPE_FRIEND_CONFIG = {
  supabaseUrl: "https://dveyxesgwohokenoomsf.supabase.co",
  supabaseKey: "sb_publishable_J6rDrCnnu090GUUzmTFB_Q_e9jqUFF_",
  // Cloudflare Turnstile, in front of the one thing that creates an
  // account: adding an agent (J16.2). Public by design, like the key
  // above — the half that verifies is a secret and lives in Supabase.
  //
  // Empty means no challenge is drawn and none is sent, which is the
  // right behaviour both before this is filled in and if Cloudflare is
  // unreachable. Supabase is the one that decides whether a token is
  // required; turn its CAPTCHA setting on only once this is set, or
  // adding an agent starts failing.
  turnstileSiteKey: "",
};
