# 🍲 Recipe Friend

A personal recipe box that syncs across the devices you cook from. Sign in
with Google, and your recipes follow you; the browser keeps a local copy so
the app stays instant and works offline. The site is plain HTML/CSS/JS with
no build step, deployed to GitHub Pages, with Supabase behind it for
accounts and sync.

## Features

- **Recipes** — name, description, servings, prep/cook times, structured
  ingredients (amount · unit · item), steps, tags, and a photo. Device
  photos are downscaled in the browser and kept in private storage; nothing
  in the bucket is publicly readable.
- **Search and filter** — across names, ingredients and tags, plus tag chips
  and favourites.
- **"What can I cook?"** — list what you have and matching recipes rise to
  the top.
- **Portion scaling and measurement preferences** — amounts rescale on the
  fly and appear in your own units, without ever editing the stored recipe.
- **Shared recipe books** — invite a household into a book; everyone can add
  and edit, while each person keeps their own units. Invite links are
  single-use, expire in 48 hours, can be revoked, and never join anyone to
  anything without their say-so.
- **Sync across devices, offline-first** — the browser copy is the working
  copy, so the app is instant and keeps working without a network.
- **Share links** — **Share** copies a link carrying one recipe in the URL
  fragment, so no server sees it. The recipient reviews it in the edit form
  before saving, and is told by name if it would replace a recipe they
  already have.
- **AI assistance** — a prompt for the chatbot of your choice, and a paste
  box that takes its answer back.
- **Export / import** — your recipes as JSON, merging by id so nothing
  duplicates.
- **Dark mode** — follows your system preference.

**What the app should do, in detail, is written down in
[`docs/journeys.md`](docs/journeys.md)** — user journeys with numbered
acceptance criteria, including the limits that are deliberate. That document
is the reference for what counts as correct; this README is how to run and
deploy it.

## Running locally

No tooling required — it's a static site:

```bash
# from the repo root, any static file server works, e.g.:
python3 -m http.server 8000
# then open http://localhost:8000
```

Or just open `index.html` directly in a browser.

## Tests

```bash
node --test test/*.test.js
```

No dependencies and no build step — the tests load the app's own modules
into a fake `window` and call them directly, and the `app-*` files go
further and drive `app.js`, `books.js` and `account.js` through a stub DOM:
type in the search box, pick a photo, click Export, open an invite link.

Every test name quotes a criterion from [`docs/journeys.md`](docs/journeys.md),
so a failure points at behaviour that was agreed rather than at an
implementation detail. **76 of the 81 criteria have a test naming them**;
the five that do not are listed at the end of the journeys, along with the
database, which is deliberately outside the net. Each test name quotes a criterion
from [`docs/journeys.md`](docs/journeys.md), so a failure points at the
behaviour that was agreed rather than at an implementation detail.

The database is deliberately not covered — see the note at the end of the
journeys. Row-level security is verified by hand when a migration is run.

## Backend (Supabase) setup

Signing in is required: the app shows a sign-in screen until you do, and
recipes live with your account. Sync uses Supabase
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

### Recipe books and sync

Your first book is created on sign-in and named after you. There is no
separate "personal" tier — that book can be shared exactly like any other.
From **Books** in the header you can create more, rename ones you own,
switch between them, and invite others.

An invite link is a key, not an announcement: whoever opens it can join. So
each link is good for **one** person, expires after **48 hours**, and can be
revoked from the Books dialog. Opening an invite never joins you to anything
on its own — the app names the book and its owner, spells out that everyone
in a book can edit and delete its recipes, and waits for you to accept.

Signed in, recipes sync in the background and the most recently edited
version of a recipe wins. Deletes travel as tombstones so a recipe deleted
on one device doesn't reappear from another's cache. A status line under the
header shows Saving… / Syncing… / Synced.

Ownership, invites, leaving, deleting and moving recipes between books are
specified in [`docs/journeys.md`](docs/journeys.md) (J7), along with the
sync guarantees (J9).

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
docs/journeys.md               What the app should do: journeys + criteria
index.html                     App shell, sign-in gate, and dialogs
privacy.html, terms.html       Legal pages linked from the app and Google
assets/                        Logo and favicons
css/styles.css                 Styling (light + dark themes)
js/storage.js                  RecipeStore — local persistence and sanitisation
js/app.js                      UI: rendering, search/filter, dialogs, import/export
js/scale.js                    Quantity parsing, formatting, portion scaling
js/units.js                    Measurement preferences and unit conversion
js/search.js                   Search, filters, and "what can I cook?" ranking
js/share.js                    Encode/decode single-recipe share links
js/account.js                  Google sign-in, session, sync bootstrap
js/sync.js                     Two-way sync with Supabase (last-write-wins)
js/books.js                    Recipe books, members, and invite links
js/config.js                   Supabase project URL and publishable key
supabase/schema.sql            Tables, RLS policies, triggers, functions
supabase/migrations/           Additive schema changes, run in order
                               (004 creates the private photo bucket;
                                005 tightens membership and invites)
docs/journeys.md               What the app is meant to do, as criteria
test/                          Tests, named for the criteria they check
.github/workflows/deploy-pages.yml   GitHub Pages deployment
.github/workflows/test.yml           Tests on every pull request
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

Your recipes live in your account and sync between devices; the browser copy
is a cache, so clearing site data is harmless. **Export** gives you a
portable JSON copy at any time, and **Import** merges a file back in without
creating duplicates.

One limit worth knowing: **an export carries recipes, not photos.** A photo
taken in the app lives in private storage and the recipe holds only a
reference that members of its book can read, so a recipe imported into a
different account or book arrives without its picture. Photos that live on
the recipe itself — one linked by URL, or one attached while signed out —
travel with the export.
