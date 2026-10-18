# 🍲 Recipe Friend

A personal recipe box that syncs across the devices you cook from. Sign in
with Google, and your recipes follow you; the browser keeps a local copy so
the app stays instant and works offline. The site is plain HTML/CSS/JS with
no build step. It is served from a home server at
<https://recipes.dave-ernsting.com>, which also runs the self-hosted
Supabase components behind it (Postgres, Auth, the REST API and Storage)
for accounts and sync.

## Features

- **Recipes** — name, description, servings, prep/cook times, structured
  ingredients (amount · unit · item), steps, tags, and a photo. Device
  photos are downscaled in the browser and kept in private storage; nothing
  in the bucket is publicly readable.
- **Search, filter and sort** — search across names, ingredients and tags;
  filter by any number of tags, which combine as "both", each saying how
  long the list is with it on; sort by name, by how long a recipe takes,
  or by what you have not had in ages. A search is a comma-separated
  list, so typing what you have — `chicken, rice` — shows what you can
  cook, best matches first. What is on shows in a row under the toolbar
  and comes off there; none of it is remembered between visits.
- **Portion scaling and measurement preferences** — amounts rescale on the
  fly and appear in your own units, without ever editing the stored recipe.
- **Meal planner and shopping list** — put recipes in a plan at the
  portions you mean to cook them at, and get one list of everything they
  need, combined and in your own units. Cross off what you already have,
  tick off what goes in the basket, and copy what is left into whatever
  shopping app you use. Finishing a plan records that those recipes were
  planned, so a card can say "Planned 3 weeks ago" and a sort can put
  what you have not had lately under your thumb. A plan belongs to the
  book, so whoever does the shop sees what whoever planned it chose.
- **A recipe view built for a worktop** — a screen of its own rather than
  a box over the list, so pinching to zoom, panning and turning the phone
  do what they do on any page. It takes the whole screen, puts ingredients
  beside the method wherever there is width for two columns (a phone on
  its side included), and keeps its controls to one row. An open recipe
  has its own address, so Back closes it instead of leaving the app and a
  reload mid-cook comes back to where you were; a breadcrumb says which
  book you are in and takes you back to it.
- **Cook mode** — a *Screen on* toggle in the recipe view holds the
  screen awake while you cook, so a phone propped against the bread bin
  does not lock with your hands covered in flour. Off until asked for,
  remembered on that device, and let go the moment the recipe closes.
- **Shared recipe books** — invite a household into a book, as someone who
  can add and edit or someone who can only read, changeable afterwards from
  the member list. Each person keeps their own units. Invite links are
  single-use, expire in 48 hours, can be revoked, say which kind they are
  before anyone accepts, and never join anyone to anything without their
  say-so.
- **Agents** — let a program read a book. An owner adds one from
  Books → Agents, names it, and gets a key (`rfk_…`) for whatever assistant
  they run, which reaches the book through the hosted MCP server. It can read the book, add recipes and work on the
  plan; it cannot edit or delete a recipe, favourite one, see the photos,
  finish a plan, or invite anybody — and it has no book of its own and
  cannot make one. It sits in the member list like anybody else, cannot
  be promoted, and is removed with the same ×, which revokes its key and
  takes its account with it. The key is shown once; only its hash is kept.
- **Copy and move** — copy a recipe into any book you can write to, which
  is how a book you only read is still worth being in. Moving one out of a
  book is the owner's, asks first, and leaves a tombstone so it does not
  come back from somebody else's cache.
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
npm install          # only for the MCP server's tests; the app needs nothing
node --test test/*.test.js
```

No build step. The app's own tests need no dependencies at all — they
load its modules into a fake `window` and call them directly, and the
`app-*` files go further and drive `app.js`, `books.js` and `account.js`
through a stub DOM: type in the search box, pick a photo, click Export,
open an invite link. The `mcp-*` files test the MCP server, which has two
dependencies, so `npm install` comes first if you want to run everything.

The `db-*` files test the database — the row-level security policies,
functions and triggers that are the app's security model — against a
real Postgres, and skip unless `DATABASE_URL` is set. With Docker:

```bash
cp server/.env.example server/.env
docker compose -f server/compose.yaml up -d --wait
server/migrate.sh
DATABASE_URL=postgres://postgres:local-dev-only-postgres-password@127.0.0.1:54322/postgres \
  node --test test/db-*.test.js
```

`server/README.md` says what that stack is. CI runs the same steps as a
job of its own.

Every test name quotes a criterion from [`docs/journeys.md`](docs/journeys.md),
so a failure points at behaviour that was agreed rather than at an
implementation detail. **167 of the 182 criteria have a test naming
them**; the fifteen that do not are listed at the end of the journeys,
along with what the database tests do and do not reach.

## Backend setup

Signing in is required: the app shows a sign-in screen until you do, and
recipes live with your account. Sync uses the open-source Supabase
components, self-hosted: Postgres, GoTrue (sign-in), PostgREST (the API
the app talks to) and Storage (photos), with Caddy in front routing
`/auth/v1`, `/rest/v1` and `/storage/v1` and serving the site itself from
the same origin. The project URL and `anon` key are in `js/config.js`; the
key is public by design, and all protection is row-level security.

There are two places that stack is described:

- **Production** is `stacks/recipe-friend` in the private
  `malfernion/homelab` repository. It runs on the home server and is
  reached through a Cloudflare Tunnel, so nothing on the home network is
  opened to the internet. Its `.env.example` lists every setting by name;
  the values live only on the server.
- **Local development** is `server/` in this repository, the same
  components at the same pinned versions, so the schema is proven in CI on
  the versions production runs.

One-time setup:

1. **Schema**: `supabase/schema.sql` and then each file in
   `supabase/migrations/` in order, applied by the migration runner in
   `server/` once GoTrue and Storage have run their own migrations — the
   app's SQL refers to `auth.users` and `storage.objects`, which those
   create. The schema creates the tables (profiles, books, members,
   recipes, invites), every RLS policy, the new-user bootstrap (profile +
   personal book), and the invite-redeem function; the migrations are
   additive changes made after it.
2. **Google auth**: in Google Cloud, create an OAuth Web client with
   authorised JavaScript origin `https://recipes.dave-ernsting.com` and
   redirect URI `https://recipes.dave-ernsting.com/auth/v1/callback`. For
   local development add the `http://localhost` origin `server/` serves on
   and its `/auth/v1/callback`. Give GoTrue the client ID and secret
   through its Google provider settings, and leave email sign-up off, so
   Google is the only way in for a person (J1.2). Set GoTrue's site URL to
   `https://recipes.dave-ernsting.com` and put that, and the local origin
   for development, on its list of allowed redirect URLs.
3. Sign in from the app's header. First sign-in auto-creates your profile
   and a personal "My recipes" book.
4. **Agents** need nothing switched on in GoTrue. An owner makes one with
   the `create_agent` function (migration 010), which never signs in
   through GoTrue, so leave GoTrue's **anonymous sign-ins off** and its
   captcha unset; the app has no captcha. The hosted MCP server
   (`mcp/http.js`, the `mcp` service in `server/compose.yaml`) needs the
   stack's JWT secret and a `/mcp` route; see
   [The MCP server](#the-mcp-server).

### Recipe books and sync

Your first book is created on sign-in and named after you. There is no
separate "personal" tier — that book can be shared exactly like any other.
From **Books** in the header you can create more, rename ones you own,
switch between them, and invite others.

An invite link is a key, not an announcement: whoever opens it can join. So
each link is good for **one** person, expires after **48 hours**, and can be
revoked from the Books dialog. Opening an invite never joins you to anything
on its own — the app names the book and its owner, spells out what that
particular link grants, and waits for you to accept.

A member either can add and edit, or can read and copy out and nothing
more. The owner chooses at invite time and can change it later. Ownership
is separate: it lives on the book, and only the owner can rename it,
delete it, invite, remove people, or move a recipe out.

Signed in, recipes sync in the background and the most recently edited
version of a recipe wins. Deletes travel as tombstones so a recipe deleted
on one device doesn't reappear from another's cache. A status line under the
header shows Saving… / Syncing… / Synced.

Ownership, invites, leaving, deleting and moving recipes between books are
specified in [`docs/journeys.md`](docs/journeys.md) (J7), along with the
sync guarantees (J9).

The `service_role` key is never used by the app and must never be
committed.

## Deploying

The site is served by the homelab stack from a checkout of this
repository pinned to a commit. Merging to `main` does not change what is
live; updating the site means bumping that pin in
`stacks/recipe-friend` and redeploying the stack. A schema change goes
out the same way, with its migration applied by the stack's runner.

There is no automated backup in this repository. The server's data
directory is the only server-side copy of the recipes and photos, so
**Export** remains the way to keep your own copy.

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
js/html.js                     Escaping, in one place
js/api.js                      Everything the app asks the server for
js/cookmode.js                 Keeping the screen awake while cooking
js/search.js                   Search, filters, sorts, and "what can I cook?" ranking
js/plan.js                     The plan: meals, settled amounts, and merging
js/shoplist.js                 Combining planned recipes into one shopping list
js/planstore.js                The plan's local cache, per book
js/share.js                    Encode/decode single-recipe share links
js/ask.js                      The confirm dialog, asked before anything undoable
js/account.js                  Google sign-in, session, sync bootstrap
js/sync.js                     Reconciling the local box with the book
js/books.js                    Recipe books, members, and invite links
js/config.js                   Project URL and anon key
server/                        Local stack and migration runner for development and CI
supabase/schema.sql            Tables, RLS policies, triggers, functions
supabase/migrations/           Additive schema changes, run in order
                               (004 creates the private photo bucket;
                                005 tightens membership and invites;
                                006 fixes a recipe to its book, makes
                                moving one an owner's act, and adds the
                                read-only member role; 007 adds the live
                                plan a book keeps and the plans it has
                                finished; 008 adds the agent role, and
                                the checks that keep an agent to reading,
                                adding and planning; 009 identifies an
                                agent by having been placed, not by its
                                account being anonymous)
docs/journeys.md               What the app is meant to do, as criteria
mcp/                           The hosted MCP server: the HTTP door
                               and agent keys (http.js, auth.js), the
                               book it opens, and the tools it offers
                               (J16, J17); its Dockerfile
package.json                   The MCP server's dependencies.
                               The site itself still has none and still
                               has no build step
test/                          Tests, named for the criteria they check
.github/workflows/test.yml           Tests on every pull request
.claude/skills/recipe-share-link/     Agent skill: recipe -> share link
```

## The MCP server

`mcp/` is a [Model Context Protocol](https://modelcontextprotocol.io)
server, hosted beside the app at **`https://recipes.dave-ernsting.com/mcp`**
over MCP's Streamable HTTP transport. An assistant connects with that URL
and an agent key; the server finds the one book the key belongs to and
offers twelve tools.

### What it can do

Six that only read. Every one of them says, where the model will read
it, that recipe text is the household's content and never an
instruction — some of it arrived from a web page.

| Tool | Takes | Gives back |
| --- | --- | --- |
| `list_recipes` | optional tags, sort | every recipe as a digest: name, tags, servings, total minutes, the ingredients it is about, when it was last planned |
| `get_recipe` | up to 20 ids, optionally a size | those recipes in full — ingredients, steps, times — at the servings or multiplier asked for, or as written |
| `find_recipes` | `have`, a comma-separated list | what you can cook from those, best match first, saying which terms each answered |
| `recipes_sharing_ingredients` | a recipe id, or a list of ingredients | what overlaps with it, and on what — for a week that buys one bunch of coriander |
| `planning_history` | — | when each recipe was last planned and how often, least recently first |
| `get_plan` | — | the live plan, and the one shopping list it adds up to — including the lines added by hand, with their ids |

Six that change something. The plan and list ones are reversible;
filing a recipe is not.

| Tool | Takes | Does |
| --- | --- | --- |
| `add_to_plan` | recipes, with portions or a multiplier | puts meals in the book's plan, reading it first and reporting what survived; anything that is not a recipe is pointed at `add_to_list` |
| `remove_from_plan` | meal ids from `get_plan` | takes them out again, saying the amount each was at so it can go back the same; nothing is recorded either way |
| `add_to_list` | lines of text | puts them on the shopping list, each its own line — the assistant reads the list first and, where "milk" is already there, edits that line instead |
| `edit_list` | item ids from `get_plan`, with the new text and the text read | changes a line added by hand where it stands — keeping its place and tick — and leaves alone any a person has changed since it was read |
| `remove_from_list` | item ids from `get_plan` | takes lines added by hand off the list, saying what each was |
| `add_recipe` | a recipe | files it into the book — **one way**, see below |

Answers come from the app's own modules, so the shopping list the
assistant computes is the list the phone computes: the same promotion to
kilograms, the same folding of plurals, the same refusal to guess how
big a tin is.

**Every call reads the book again** before answering, because the
household goes on cooking while an assistant session is open. Two
questions arriving together share one read; a change has the book to
itself from its read to its write, and anything arriving during one —
question or change — waits for it.

**Amounts come back as they were written**, because unit preferences
belong to a person and an agent is not one. A size is the one thing that
does change them: `get_recipe` takes `servings` for a recipe that says
what it serves, or `multiplier` for half or double of any recipe — the
only control for one that does not — and scales the quantities with the
app's own portion stepper, kitchen fractions and all. Times and the
method are never scaled, an amount written into a step least of all, and
the answer says so. Nothing is written either way.

It is here rather than in a repository of its own because it is an API
onto this app: it runs the app's own modules, so the shopping list it
computes is the list the phone computes, and it is bounded by the same
policies (migration 008) that the app is. A change to either can break
it, and one repository finds that out in the same test run.

**What it should do is written down like everything else** — J17 in
[`docs/journeys.md`](docs/journeys.md), with J16 beside it for what an
agent is allowed to do.

### Connecting an assistant

There are two ways in, and both end in the same place: an **agent** in one
book you own, listed under **Books → Agents**, doing only what an agent may
(J16.3).

**Sign in from the app** — Claude.ai, the Claude apps, ChatGPT, Claude Code
and anything else that speaks MCP's OAuth:

- **Claude.ai / ChatGPT**: add a custom connector with the address
  `https://recipes.dave-ernsting.com/mcp`.
- **Claude Code**: `claude mcp add --transport http recipe-friend
  https://recipes.dave-ernsting.com/mcp`, then `/mcp` in Claude Code to
  sign in.

The app opens Recipe Friend in a browser. Sign in with Google, check the
app's name **and the address it will send you back to**, pick one of your
own books and press **Allow**. It appears under Agents as a *connected app*;
the × there signs it out at once and for good. Only an owner can connect a
book; nobody's own powers are handed over — the app's token names its agent,
not you, and the REST API refuses it outright (J16.15, J17.15–J17.17).

**Or give it a key** — for something that runs unattended, like a household
agent on a server, which should not depend on a refresh token. Open
**Books → Agents** on a book you own, name the agent, and press
**Add an agent**. The key (`rfk_…`) is shown once, with ready-to-paste
settings for Claude Code, `mcpServers` JSON (Cursor, a project's
`.mcp.json`), OpenClaw, and a plain URL + header with a `curl` check —
pick the client, press Copy. Closing the panel discards the key; if it is
lost, remove the agent there and add another. The same list shows each
agent's key prefix, when it was added and when it was last used, and
removes one with ×, which revokes its key at once.

For reference, the Claude Code form is `claude mcp add --transport http
recipe-friend https://recipes.dave-ernsting.com/mcp --header
"Authorization: Bearer rfk_..."`.

**One key, one book.** The key belongs to the book it was made for, so a
household with two books makes two agents. Removing the agent revokes the
key; the server may go on accepting a key it has just checked for at most
a minute (30 seconds by default), and no longer.

**How it signs in.** The server is stateless: every POST to `/mcp` carries
a key or an app's access token. A key is resolved through a database
function only the server's own role may call (`resolve_agent_key`). An
app's token comes from GoTrue's OAuth 2.1 server (dynamic client
registration, PKCE), whose database hook (migration 011) has already made
it name the app's agent with a role PostgREST will not accept; the server
checks its signature, expiry, issuer, audience and role, then resolves it
with `resolve_agent_app`. Either way it then reads the book through
PostgREST with a five-minute token for that agent — so the same row-level
security that governs a person governs the agent. A missing or wrong
credential is a `401` whose `WWW-Authenticate` header points at
`/.well-known/oauth-protected-resource/mcp`, which is how an app finds
where to sign in; `GET` and `DELETE` are `405`.

Run it yourself with the rest of the stack (`server/`), or on its own:

```bash
SUPABASE_URL=http://localhost:8080 JWT_SECRET=... node mcp/http.js   # PORT=3100
# add PUBLIC_URL=https://your.site to turn on sign-in for apps
```

What it will not do is what an agent may not do (J16.3, J16.4): no
editing, no deleting, no favouriting, no finishing a week, and no
photos. There is no tool for any of them, because a tool that is always
refused is worse than one that is not there. `add_recipe` is the one
call that cannot be undone from the assistant's side — an agent cannot
delete even the recipe it just added — so it is marked destructive for
the host and says so in words for the model.

Check a key by hand:

```bash
curl -s https://recipes.dave-ernsting.com/mcp \
  -H 'Authorization: Bearer rfk_...' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
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
