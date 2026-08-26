# 🍲 Recipe Friend

A personal recipe box that syncs across the devices you cook from. Sign in
with Google, and your recipes follow you; the browser keeps a local copy so
the app stays instant and works offline. The site is plain HTML/CSS/JS with
no build step, deployed to GitHub Pages, with Supabase behind it for
accounts and sync.

## Features

- **Add, edit, and delete recipes** — name, description, servings, prep/cook
  times, ingredients, steps, and tags.
- **Photos** — attach an image from your device (downscaled in the browser
  to around 150KB) or link one by URL. Signed in, photos go to a **private**
  Supabase Storage bucket and the recipe stores only their path, which keeps
  the database small. Nothing in the bucket is publicly readable: the app
  mints a short-lived signed link, and only members of the owning book can
  do so. Signed out, or if an upload fails, the image stays on the device
  instead — a photo is never silently lost.
- **Search and filter** — full-text search across names, ingredients, and
  tags; filter by tag or favorites.
- **Structured ingredients** — each ingredient is entered as amount · unit ·
  item (leave the amount empty for "to taste" lines), so scaling is exact
  arithmetic rather than text parsing.
- **Measurement preferences** — pick your units (grams/kilograms vs
  ounces/pounds, millilitres/litres vs cups/fluid ounces) and amounts are
  shown that way wherever you read a recipe. Recipes are stored exactly as
  entered and converted only for display, so two people sharing a book can
  each keep their own setting without rewriting each other's data.
  Preferences live on your profile and follow you between devices.
  Teaspoons and tablespoons are left alone, and unrecognised units
  ("cloves", "pinch", "can") are never converted.
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
- **Share links** — **Share** in the recipe view copies a link to the
  clipboard: the recipe travels compressed inside the link's `#` fragment,
  so no server ever sees it. The recipient reviews it in the normal edit
  form before saving, and opening the same link twice updates their copy
  rather than adding a second — if it would replace a recipe they already
  have, the form says which one by name. Photos are deliberately left out:
  stored photos are private to their book, and a link can't carry that.
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
link. A recipe can be moved to another book from its **Move** button.
Anyone in a book can add and edit its recipes; owners can remove members,
and members can leave. Recipes belong to the book, so leaving one takes
nothing away from it.

An invite link is a key, not an announcement: whoever opens it can join.
So each link is good for **one** person and expires after **48 hours**, and
the Books dialog lists the links that are still live so you can revoke one
that went astray. Opening an invite never joins you to anything on its own
— the app names the book and its owner, spells out that everyone in a book
can edit and delete its recipes, and waits for you to accept.

An owner can also delete a book outright, which permanently removes its
recipes for every member — the app says how many recipes and how many
other people will be affected before you confirm. You cannot delete your
last remaining book, and **Export** is the way to keep a copy first.

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
elsewhere applies the same units — and because conversion happens when a
recipe is displayed rather than when it is saved, changing your units
never edits the book.

The `service_role` key is never used by the app and must never be
committed.

## Keeping the free project awake

Free Supabase projects pause after 7 days without API activity, and a
project left paused for 90 days is deleted.
`.github/workflows/supabase-keepalive.yml` sends one request a day to keep
that clock reset. It reads the project URL and publishable key straight out
of `js/config.js` — both are public by design, so no repository secret is
involved.

Two things worth knowing: GitHub disables scheduled workflows on a
repository with no activity for 60 days (a push or a manual run re-enables
them), and the job fails loudly if Supabase does not answer with 200, which
doubles as a cheap uptime check. There is deliberately no automated backup
job — that would need a key that bypasses row-level security, so **Export**
remains the way to keep your own copy.

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
                               (004 creates the private photo bucket;
                                005 tightens membership and invites)
.github/workflows/deploy-pages.yml   GitHub Pages deployment
.claude/skills/recipe-share-link/     Agent skill: recipe -> share link
```

## Getting a recipe in with AI's help

**Get help from AI** in the ··· menu hands you a prompt to paste into
ChatGPT, Gemini, Claude or similar. Send that assistant a recipe — a URL, a
photo of a cookbook page, or typed-out text — and it replies with a block of
JSON and a link back to `#paste`, which opens the box that JSON goes into.
**Paste a recipe**, in the same menu or straight from the AI dialog, does
the same job by hand and takes code fences and surrounding chatter in its
stride. A share link can be pasted there too.

Nothing arrives unseen: a pasted recipe and an opened share link both land
in the normal edit form first, titled **Review recipe**, so you can rename
or fix anything before saving. The recipe keeps its identity through that
edit, so opening the same share link twice updates your copy rather than
adding a second.

The prompt asks only for JSON because most chatbots have no code execution
and so cannot build a share link — asked for one, they produce a
plausible-looking link that opens nothing. Encoding stays in the app, where
it is code rather than prediction.

For an agent working in this repo,
`.claude/skills/recipe-share-link/` covers the same ground and does produce
links, with a Python encoder that validates the recipe and round-trips the
link before printing it:

```bash
python3 .claude/skills/recipe-share-link/scripts/recipe_link.py recipe.json
```

## Notes on storage

Signed in, your recipes live in your account and sync between devices; the
browser copy is a cache, so clearing site data is harmless. **Export** still
gives you your own portable JSON copy at any time, and **Import** merges a
file back in without creating duplicates.
