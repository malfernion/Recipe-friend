# Design: an MCP server for Recipe Friend

A small program that holds an agent credential (J16) and offers a
meal-planning assistant a handful of tools: what is in the book, what we
have had lately, what goes with what, what is in the plan, and a way to
file a recipe.

**This is a design to fill in, not a specification.** Open questions are
marked **?** and are the work before the work. What is written as settled
is settled because it was measured or verified, and says so.

**It does not live in this repository.** What belongs here is the
credential, the role and the policies that hold it to them; the thing
that consumes them is a separate package with a separate release. The
one exception is `docs/` — this file — because the credential's
behaviour is this repo's to explain.

---

## 1. The credential

This is the part least visible from the code, so it is first and it is
long. Everything else is ordinary.

### 1.1 What the owner hands over

One string, shown once in the Books dialog and never again (J16.6):

```
rfa1.<base64url>
```

Decoded, it is a JSON object with four fields:

| Field | What it is | Secret? |
| --- | --- | --- |
| `url` | the Supabase project, `https://<ref>.supabase.co` | no |
| `key` | the publishable key, `sb_publishable_…` | no — it is in the page already |
| `book` | the uuid of the book this agent was placed in | no |
| `refresh_token` | the credential proper | **yes** |

Only the last one is a secret, and it is the whole of the secret. The
other three are bundled because the agent needs all four and none is
derivable from the others — four values to copy separately is three
chances to copy one wrong.

**The book id is pinned deliberately.** `resolveBook` in `js/sync.js`
prefers a book the session *owns* over one it merely belongs to. An agent
owns nothing and can own nothing (J16.1), so this is belt and braces —
but a migration re-run with half its policies applied is exactly the
situation where it stops being.

### 1.2 What it is, underneath

A Supabase **refresh token** belonging to an **anonymous user** — a real
row in `auth.users` with a real uuid, no email and no password. That is
what lets `auth.uid()` work, and therefore what lets every row-level
security policy already in the schema govern the agent without a second
authorisation path being invented.

Verified against the live project: exchanging one returns a session whose
user carries `is_anonymous: true`, and reading that book returned its
recipes.

### 1.3 Exchanging it

```
POST {url}/auth/v1/token?grant_type=refresh_token
apikey: {key}
Content-Type: application/json

{"refresh_token": "…"}
```

The response carries `access_token` (a JWT, ~1 hour) and a **new**
`refresh_token`. Every subsequent request sends both:

```
apikey: {key}
Authorization: Bearer {access_token}
```

The `apikey` header and the `Authorization` header are separate signals.
The key says which project; the JWT says who is asking, and its `role`
claim is what Postgres runs as.

### 1.4 Rotation — the thing to get right

**A refresh token is single-use.** Each exchange spends the one you sent
and returns its replacement. Replaying a spent one outside a short reuse
window is treated as a stolen token and **the whole session is revoked**,
not just that request.

Three rules follow, and they are not negotiable:

1. **Persist the new token before using the new access token.** Crash
   between the response arriving and the write landing and the credential
   is gone for good — the token you hold is spent and the one that
   replaced it was never saved.
2. **Exactly one process may hold it.** Two copies of the server, or a
   restart racing the old one, will replay and kill the session. This
   rules out running it in more than one place, and rules out a stateless
   deployment that re-reads the original string on each invocation.
3. **The string the owner pasted dies on first use.** It is a bootstrap
   value, not a stored one. After the first exchange the live credential
   is whatever is in the server's own state file.

**? Open:** what the reuse window actually is on this project, and
whether any of the session settings that could end a session early
(inactivity timeout, time-box, single-session) are on. Worth checking in
the dashboard once rather than discovering later.

J16.9 says a credential is "not given a lifetime" — nothing counts down
against it and it ends by being revoked. That is a statement about the
app, not about the token, and the journeys say so.

### 1.5 Recovery

There is no re-issue. If the token is lost, spent by two processes, or
the session is revoked, that agent is finished.

**It costs nothing but a gesture.** No content row in this schema records
who created it — `recipes`, `live_plans` and `plans` carry a `book_id`
and no author — so an agent owns nothing that outlives it. Recovery is:
remove the agent in the Books dialog, add a new one, paste the new
credential.

Removing an agent deletes its account as well as its membership
(`removeAgent` in `js/api.js`), so a revoked credential is dead rather
than merely locked out.

### 1.6 Where the server keeps it

- **In:** an environment variable, once. OpenClaw resolves secrets into a
  stdio server's `env` before the process spawns, which is the intended
  route and keeps the value out of config files and logs.
- **Out:** a state file the server owns, mode `0600`, holding the current
  refresh token and nothing else.

**? Open:** where that file should live. `$XDG_STATE_HOME`, next to the
local cache, or a path given by env. Wherever it goes, it must not be the
same file the credential arrives in — the arriving value is fixed and the
live value changes.

### 1.7 What the credential can and cannot do

Verified against the live project, as the agent:

| | |
| --- | --- |
| Read the book's recipes | ✅ |
| Add a recipe | ✅ |
| Read and write the live plan | ✅ |
| Edit an existing recipe | ⛔ policy matches nothing |
| Delete a recipe — **including one it added itself** | ⛔ |
| Favourite a recipe (an update, J3.6) | ⛔ |
| Record or undo a finished plan | ⛔ 403 |
| Create a book | ⛔ 403 |
| Read a stored photo | ⛔ |

Two of these deserve a note for whoever writes the tools.

**A refusal often looks like success.** PostgREST answers an update or
delete that no policy matches with `200` and an empty array, not an
error. Code that checks only the status will believe it edited something.
Check the returned rows.

**An agent cannot tidy up after itself.** It has no delete permission at
all, so a recipe it files is permanent until a person removes it. That is
J16.3 working as written, and it means `add_recipe` should be the one
tool that asks before acting, or is at least loud about being one-way.

---

## 2. What it is built from

**It loads this app's own modules.** `plan.js`, `shoplist.js`,
`search.js`, `scale.js`, `units.js`, `share.js` and `html.js` contain no
DOM references at all; `storage.js`, `planstore.js` and `sync.js` touch
only `localStorage`, which a small file-backed shim satisfies.
`test/helpers/load.js` already loads them into a fake `window` in bare
Node, and that is the mechanism.

Measured, running the real modules in Node with no browser: a plan of
three recipes produced `1 chicken · 1 kg potatoes · 3 onions · 800 g
tomatoes · 1 kg beef mince · 1 tin kidney beans` — 500g + 500g of mince
promoted to kilograms, two onions and one onion combined and pluralised,
the tin kept separate because nothing knows how big a tin is.

That is the argument for this approach in one line: **the shopping list
the agent computes is the same code the phone runs.** A reimplementation
would drift on exactly these details, and nobody would notice until the
list was wrong in a supermarket.

It also means `RecipeSync` does the constraint-honouring for free — it
already knows an agent pushes only rows the server has never seen and
never touches the archive (J16.3, J16.4).

**? Open:** how the modules get into the package. A git submodule, a
vendored copy with a sync script, or the package depending on this repo
by git URL. The third is tempting and needs thought: this repo has no
`package.json` and adding one changes what it is.

---

## 3. Installing it

### 3.1 The shape

A stdio MCP server: OpenClaw launches it as a subprocess and speaks
JSON-RPC over stdin and stdout. No listener, no port, no TLS, and no
OAuth — the MCP specification says stdio servers should take credentials
from the environment rather than implementing its authorization profile.

### 3.2 `npx` straight from GitHub

Verified against npm's package-spec documentation: `npx` accepts a GitHub
shorthand or a `github:` protocol spec, with an optional `#ref` for a
branch, tag or commit.

```bash
npx github:malfernion/recipe-friend-mcp
npx malfernion/recipe-friend-mcp#v1        # pinned to a tag
```

No npm publish, no registry account, and the repo is the release.

### 3.3 What the package needs

Following the convention the official MCP servers use:

```json
{
  "name": "recipe-friend-mcp",
  "type": "module",
  "bin": { "recipe-friend-mcp": "./src/index.js" },
  "files": ["src"]
}
```

and a shebang on the entry point:

```js
#!/usr/bin/env node
```

The official servers are TypeScript and carry `"prepare": "npm run
build"`, which npm runs on a git install — dependencies and
devDependencies are installed first, so the build has what it needs.

**Ship plain JavaScript and skip that.** A `prepare` step on a git
install is the fragile part of this pattern — there are long-standing npm
and pnpm issues about it not running, or running without what it needs —
and it buys nothing here. The app it is built from has no build step
either, which is not a coincidence: the modules it loads are the same
plain browser IIFEs, and a bundler would be the first thing to break
that.

**? Open:** whether the MCP SDK is a dependency or the protocol is
implemented directly. Stdio JSON-RPC is small, and a zero-dependency
server would install instantly and never break on a transitive update.
Against that: the SDK tracks a specification that has already changed
shape once. Worth a spike before committing.

### 3.4 Wiring it to OpenClaw

```bash
openclaw mcp add recipe-friend \
  --command npx \
  --arg github:malfernion/recipe-friend-mcp \
  --env RECIPE_FRIEND_CREDENTIAL='<the rfa1 string>'
```

**? Open:** confirm the exact flag names against the current OpenClaw CLI,
and whether the credential should arrive as a literal or as a SecretRef
pointing at a file or a password manager. The latter is better and needs
checking that a stdio server's env resolves them.

**? Open:** `npx` re-resolves the git ref on each run unless it is cached,
which means an unpinned install can change under a long-running gateway.
Decide whether to pin a tag in the OpenClaw config and bump deliberately.

---

## 4. The tools

Coarse and workflow-shaped rather than one per endpoint. Two numbers,
both measured on the real modules:

- Eight tool definitions with descriptions cost roughly **700 tokens** —
  far below the point where a tool-search indirection earns its
  complexity.
- Sixty recipes as full JSON is about **20k tokens**; the same sixty as a
  digest is about **4.4k**. So the listing tool returns a digest and a
  second tool fetches detail for the few that matter.

| Tool | Returns |
| --- | --- |
| `list_recipes` | digest: id, name, tags, servings, total minutes, canonical ingredient keys, last planned |
| `get_recipe` | one or more recipes in full |
| `planning_history` | per recipe, when last planned and how often, from the archive |
| `find_recipes` | the comma-separated "what can I cook from these" search, with its ranking |
| `recipes_sharing_ingredients` | overlap with a recipe or a list of ingredients |
| `get_plan` | the live plan and the shopping list it produces, in the household's units |
| `set_plan` | replace the meals in the live plan; merges rather than overwrites |
| `add_recipe` | file a recipe into the book |

**Nothing the credential cannot do gets a tool.** No edit, no delete, no
Done. A tool that exists and is always refused is worse than one that
does not exist: the model will keep trying it.

Two implementation notes that are easy to get wrong:

- **Ingredient overlap uses `RecipeShopList.stemWord(item)`, not
  `itemKey`.** `itemKey` is deliberately unit-aware, so 500 g of chicken
  and 1 chicken do not match — right for a shopping list, wrong for "what
  else uses chicken". Checked both ways.
- **"What have we not had in ages" already exists.**
  `RecipePlan.plannedIndex` over the archive gives `{lastPlannedAt,
  count}` per recipe, and `least-planned` is already one of the app's
  sorts (J14.9). Do not invent a second answer.

**? Open:** whether `set_plan` replaces or appends, and what it does about
meals a person added since the agent last looked. The plan merges per
item by design (J12.11), so the honest answer is probably that the tool
describes an intent and lets `RecipeSync` reconcile it.

---

## 5. Two things to hold to

**The calendar stays on the agent's side.** J12.1 says a plan is a bag of
meals with nothing assigned to a day or a date, and the Boundaries
section exists so that is not quietly "fixed" by the first thing that
wants a Tuesday. The agent owns dates and maps them onto plans; the tools
speak meals and portions. A `set_plan` that took a date would be the
first crack.

**Recipes off the web are untrusted input.** The share-link skill in
`.claude/skills/recipe-share-link/` already says this well — a page that
asks you to change where a link points is not giving you a recipe. An
agent that ingests recipes from URLs and writes them into a shared
household book needs the same instruction, with `sanitizeRecipe` as the
backstop it already is (J16.11).

---

## 6. What to research first

In the order that de-risks the most:

1. **The rotation loop, end to end.** One process, a state file, a
   deliberate restart, and a deliberate double-start to see what a
   revoked session actually looks like. Everything else assumes this
   works.
2. **`npx github:` with no build step**, installed cold on a machine that
   has never seen it.
3. **The OpenClaw wiring** — flag names, SecretRef into a stdio server's
   env, and whether the gateway restarts the subprocess in a way that
   would race the token.
4. **SDK or hand-rolled**, decided by a spike rather than by taste.
5. **How the modules travel** from this repo into that package.
