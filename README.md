# 🍲 Recipe Friend

A personal recipe box that syncs across the devices you cook from. Sign in
with Google, and your recipes follow you; the browser keeps a local copy so
the app stays instant and works offline. The site is plain HTML/CSS/JS with
no build step, deployed to GitHub Pages, with Supabase behind it for
accounts and sync.

## Features

- **Add, edit, and delete recipes** — name, description, servings, prep/cook
  times, ingredients, steps, and tags.
- **Photos** — attach an image from your device (automatically downscaled to
  fit browser storage) or link one by URL.
- **Search and filter** — full-text search across names, ingredients, and
  tags; filter by tag or favorites.
- **Structured ingredients** — each ingredient is entered as amount · unit ·
  item (leave the amount empty for "to taste" lines), so scaling is exact
  arithmetic rather than text parsing.
- **Measurement preferences** — pick your units (grams/kilograms vs
  ounces/pounds, millilitres/litres vs cups/fluid ounces) and everything you
  add, import, or save from a share link is converted before storing;
  changing preference converts the recipes already in your box. Preferences
  are stored on your profile, so they follow you between devices. Teaspoons
  and tablespoons are left alone, and unrecognised units ("cloves", "pinch",
  "can") are never converted.
- **Portion scaling** — a Portions stepper in the recipe view rescales
  ingredient amounts on the fly with kitchen-friendly fractions ("1½ tbsp"
  halves to "¾ tbsp"). Display-only; the saved recipe is untouched.
- **"What can I cook?"** — list the ingredients you have and recipes using
  them rise to the top, best matches first, with each card showing which of
  your ingredients it uses.
- **Favorites** — star the recipes you keep coming back to.
- **Sync across devices** — recipes live with your account and sync in the
  background; localStorage stays the working copy, so the app renders
  instantly and keeps working offline.
- **Shared recipe books** — every book is the same kind of thing: one you
  own and may invite others into, or one you were invited to. Your first
  book is named after you and can be shared as-is, renamed, or joined by
  others via an invite link. Recipes can be moved between books, and each
  book keeps its own local cache so switching never mixes them.
- **Share links** — share a single recipe as a URL: the recipe travels
  compressed inside the link's `#` fragment, so no server ever sees it. The
  recipient gets a preview and a "Save to my recipe box" button, and opening
  the same link twice never duplicates. Uploaded photos are excluded (too
  large for URLs); linked image URLs are kept.
- **Export / import** — download your whole collection as JSON for backup, or
  import it on another device. Imports merge by recipe id, so re-importing
  never creates duplicates.
- **Dark mode** — follows your system preference.

## Running locally

No tooling required — it's a static site:

```bash
# from the repo root, any static file server works, e.g.:
python3 -m http.server 8000
# then open http://localhost:8000
```

Or just open `index.html` directly in a browser.

## Backend (Supabase) setup

The app works fully signed-out and local-only. Optional sync uses Supabase
(project coordinates in `js/config.js` — the publishable key is public by
design; all protection is row-level security). One-time setup:

1. **Schema**: open the Supabase dashboard → SQL Editor, paste all of
   `supabase/schema.sql`, and run it. This creates the tables (profiles,
   books, members, recipes, invites), every RLS policy, the new-user
   bootstrap (profile + personal book), and the invite-redeem function.
   Then run each file in `supabase/migrations/` in order — these are
   additive changes made after the initial schema.
2. **Google auth**: in Google Cloud, create an OAuth Web client with
   authorized origin `https://malfernion.github.io` and redirect URI
   `https://dveyxesgwohokenoomsf.supabase.co/auth/v1/callback`; paste the
   client ID and secret into Supabase → Authentication → Providers →
   Google. Disable email auth. Add
   `https://malfernion.github.io/Recipe-friend/` (and
   `http://localhost:8000` for local dev) to Authentication → URL
   Configuration → Redirect URLs.
3. Sign in from the app's header. First sign-in auto-creates your profile
   and a personal "My recipes" book.

Signed out, the app shows a sign-in screen; recipes and preferences live
with the account, not the browser.

### Recipe books

Your first book is created on sign-in and named after you (for example
"Dave's recipes"). There is no separate "personal" tier — that book can be
shared exactly like any other, so inviting someone into your existing
collection needs no copying. From **Books** in the header you can create
more, rename ones you own, switch between them, and invite others with a
link that works for 7 days. A recipe can be moved to another book from its
**Move** button. Anyone in a book can add and edit its recipes; owners can
remove members, and members can leave. Recipes belong to the book, so
leaving one takes nothing away from it.

### How sync behaves

Signed in, the app syncs your recipes with your book in the background:
recipes already on the device are pushed up on first sign-in, changes from
other devices are pulled down, and per recipe the most recently edited
version wins. Deletes travel as tombstones so a recipe deleted on one
device doesn't reappear from another device's cache. localStorage remains
the working copy, so the app still renders instantly and keeps working
offline — a failed sync retries on the next change, when the tab regains
focus, or when the network returns. A status line under the header shows
Saving… / Syncing… / Synced. Measurement preferences follow the person
rather than the device: they are stored on your profile, so signing in
elsewhere applies the same units.

The `service_role` key is never used by the app and must never be
committed.

## Deploying to GitHub Pages

The included workflow (`.github/workflows/deploy-pages.yml`) deploys the site
on every push to `main`. One-time setup:

1. In the repository, go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow manually from the Actions tab).

The site will be published at `https://<username>.github.io/Recipe-friend/`.

## Project structure

```
index.html                     App shell, sign-in gate, and dialogs
privacy.html, terms.html       Legal pages linked from the app and Google
assets/                        Logo and favicons
css/styles.css                 Styling (light + dark themes)
js/storage.js                  RecipeStore — local persistence and sanitisation
js/app.js                      UI: rendering, search/filter, dialogs, import/export
js/scale.js                    Quantity parsing, formatting, portion scaling
js/units.js                    Measurement preferences and unit conversion
js/share.js                    Encode/decode single-recipe share links
js/account.js                  Google sign-in, session, sync bootstrap
js/sync.js                     Two-way sync with Supabase (last-write-wins)
js/books.js                    Recipe books, members, and invite links
js/config.js                   Supabase project URL and publishable key
supabase/schema.sql            Tables, RLS policies, triggers, functions
supabase/migrations/           Additive schema changes, run in order
.github/workflows/deploy-pages.yml   GitHub Pages deployment
```

## Notes on storage

Signed in, your recipes live in your account and sync between devices; the
browser copy is a cache, so clearing site data is harmless. **Export** still
gives you your own portable JSON copy at any time, and **Import** merges a
file back in without creating duplicates.
