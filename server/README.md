# The server, run locally

Recipe Friend's backend is four open-source Supabase components and its
own MCP server, and this directory runs them on your own machine: Postgres, GoTrue (sign-in),
PostgREST (the REST API the app talks to) and Storage (photos, kept on
disk). Caddy stands in front of them where Supabase's gateway would, mounts
them at `/auth/v1`, `/rest/v1` and `/storage/v1`, and serves the site from
the same address, so `supabase-js` cannot tell it from the hosted project.

It exists so the database can be tested. The row-level security policies,
the definer functions and the triggers in `supabase/` are the app's whole
security model, and until now nothing ran them except the hosted project.
It is also the stack the homelab runs in production, slimmed of the
production settings (Google sign-in, real secrets).

## The versions live here

`compose.yaml` is the **source of truth for which version of each
component Recipe Friend runs on**. The homelab's production stack pins the
same tags, because a test run against Postgres 17.6 says nothing about a
server running something else. To move a version: change it here, bring
the stack up from nothing, run the migrations and the tests, and only then
copy the tag across.

The tags were taken from Supabase's own self-hosting compose
(`docker/docker-compose.yml` in `supabase/supabase`) on 2026-10-18.

## Bringing it up

Docker with Compose is all it needs.

```bash
cp server/.env.example server/.env
docker compose -f server/compose.yaml up -d --wait
server/migrate.sh
```

then open `http://localhost:8080`. The values in `.env.example` are
**fakes for local development**, committed on purpose so that copy is the
whole setup; none of them may be used anywhere anybody else can reach.
The two API keys in it are tokens signed with the JWT secret beside them,
for the `anon` and `service_role` roles.

Two ports are published, both on `127.0.0.1` only: Caddy's (8080) and
Postgres's (54322), the second for the database tests. Everything else is
reached through Caddy, or with `docker compose exec`.

## Testing against it

```bash
DATABASE_URL=postgres://postgres:local-dev-only-postgres-password@127.0.0.1:54322/postgres \
  node --test test/db-*.test.js
```

The policy tests connect straight to Postgres; the end-to-end ones in
`db-e2e.test.js` go through Caddy on the port in `server/.env` (or
`STACK_URL`). CI's `db` job does exactly this.

`down` keeps the data; `down -v` throws it away and the next `up` starts
from an empty database.

## Migrating

`server/migrate.sh` applies `supabase/schema.sql` and then each file in
`supabase/migrations/` in order, and records each in
`recipe_friend.schema_migrations`. Run it as often as you like: a file
that has been applied is skipped, and a file that fails is rolled back
whole and nothing after it is tried. It is in a schema of its own because
anything in `public` is served by PostgREST.

Before it applies anything it waits for GoTrue and Storage to have run
their own migrations, because the app's SQL hangs a trigger on
`auth.users` and writes policies on `storage.objects`, and both tables
belong to those services.

It connects as `postgres`, the same role the Supabase dashboard's SQL
editor uses, so ownership matches the hosted project's. It reaches the
database through `docker compose exec`; set `MIGRATE_COMPOSE` to aim it at
a different stack, or `DATABASE_URL` to use a local `psql` instead.

`server/migrate.sh --baseline` records every file as applied without
running any of them. It is for a database that already has the schema —
one restored from the hosted project, which never had this table.

A migration that has been applied is never re-run, even if the file
changes; the script says so if it notices. A change to the schema is a new
numbered file.

## What differs from the hosted project

- **Email sign-up is on** and confirms itself, so tests can make a person
  without Google. Production turns it off and turns Google on.
- **Anonymous sign-ins are off here too**, as in production. Agents are
  made by `create_agent` (migration 010) and never sign in through GoTrue,
  so nothing needs them, and there is no captcha.
- **No gateway key check.** Supabase's gateway refuses a request without
  an `apikey` header; Caddy does not ask. Nothing depends on that check —
  the key is public, PostgREST treats a request with no token as `anon`,
  and GoTrue's admin endpoints check the token themselves.
- **The keys are the older JWT kind.** The hosted project's
  `sb_publishable_…` keys are translated into a JWT by Supabase's gateway,
  and Caddy does no such translation, so a client of this stack uses the
  `ANON_KEY` from `.env`.

## The MCP server

The `mcp` service is the hosted MCP server (`mcp/http.js`, J17), built
from this checkout with `mcp/Dockerfile` (`node:22.20.0-alpine`; `up
--build` rebuilds it). Caddy routes `/mcp` to it on port 3100; its
healthcheck is `GET /health` on 127.0.0.1:3100 inside the container.

| Variable | |
|---|---|
| `SUPABASE_URL` | where `/rest/v1` is, from inside the stack: `http://caddy` |
| `JWT_SECRET` | the stack's secret, to resolve keys and sign an agent's 5-minute token |
| `ANON_KEY` | optional, sent as `apikey` |
| `PORT` | 3100 |
| `KEY_CACHE_SECONDS` | how long a resolved key is believed (default 30, clamped to 60) — the bound on how long a removed agent's key still works. Set here from `MCP_KEY_CACHE_SECONDS`, which `.env.example` makes 5 so the tests wait less |
| `PUBLIC_URL` | the site's address as a browser sees it; turns on sign-in for apps (J17.15). The resource is `PUBLIC_URL/mcp` and GoTrue at `PUBLIC_URL/auth/v1` its authorization server. Unset, only keys work |
| `AUTH_ISSUER` | optional; GoTrue's issuer when it is not `PUBLIC_URL/auth/v1` |

It resolves keys by calling `resolve_agent_key` through PostgREST as the
`recipe_friend_mcp` role, which migration 010 creates NOLOGIN and grants
to `authenticator`. `db-mcp-http.test.js` drives it through Caddy.

A production stack needs the same: the service, the same variables, and a
`/mcp` route (`handle /mcp { reverse_proxy mcp:3100 }`) in its Caddyfile,
ahead of the site's catch-all.

## Apps that sign in (OAuth)

GoTrue is also the OAuth 2.1 server that Claude.ai, ChatGPT and Claude
Code sign in through (J16.15, J17.15–J17.17). It takes five settings on
the `auth` service:

| Variable | Value |
|---|---|
| `GOTRUE_OAUTH_SERVER_ENABLED` | `"true"` |
| `GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION` | `"true"` — apps register themselves; one gets nothing until an owner allows it |
| `GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH` | `/` — GoTrue sends the browser to `SITE_URL/?authorization_id=…`, where `js/connect.js` is the consent screen |
| `GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED` | `"true"` |
| `GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI` | `pg-functions://postgres/public/custom_access_token_hook` |

The hook is migration 011's. It rewrites a token issued to an OAuth client
so that it names the app's agent, with a role PostgREST and Storage refuse,
and refuses one for an app nobody connected; every other token passes
through untouched. GoTrue calls it for **every** token it issues, so the
migrations must be applied before GoTrue starts with it on — until the
function exists, every sign-in fails.

Caddy routes the discovery documents (see the Caddyfile): the
protected-resource metadata, `/.well-known/oauth-protected-resource` and
`/.well-known/oauth-protected-resource/mcp`, to the `mcp` service; and
GoTrue's metadata at `/.well-known/oauth-authorization-server[/auth/v1]`
and `/.well-known/openid-configuration[/auth/v1]`, which is where a client
looks given the issuer `…/auth/v1`. It also pins the scope of every
`/auth/v1/oauth/authorize` to `email`: with this stack's HS256 secret
GoTrue cannot sign the ID token `openid` would ask for, and the token
request would fail.

The tokens are signed with the stack's HS256 `JWT_SECRET`, as sessions
are, and last `JWT_EXPIRY`; refresh tokens rotate. Removing the app's agent
deletes its consent and its GoTrue sessions, so the refresh token dies at
once. `db-oauth.test.js` drives the whole flow with the MCP SDK's own
OAuth client.
