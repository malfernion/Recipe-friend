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
production settings (Google sign-in, Turnstile, real secrets).

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
  so nothing needs them, and no captcha is configured.
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

It resolves keys by calling `resolve_agent_key` through PostgREST as the
`recipe_friend_mcp` role, which migration 010 creates NOLOGIN and grants
to `authenticator`. `db-mcp-http.test.js` drives it through Caddy.

A production stack needs the same: the service, the same three
variables, and a `/mcp` route (`handle /mcp { reverse_proxy mcp:3100 }`)
in its Caddyfile, ahead of the site's catch-all.
