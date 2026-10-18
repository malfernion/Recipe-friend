# Moving off hosted Supabase

Three scripts that move Recipe Friend's data from the hosted Supabase project into the
self-hosted stack on the lab (homelab `stacks/recipe-friend/`). They are Workstream E of
the self-host project (homelab `projects/recipe-friend-self-host/workstreams/E-migration.md`),
and this file is the runbook for its rehearsal (E1–E3) and cutover (E4–E8).

| Script | Does | Writes to |
|---|---|---|
| `copy-data.js` | users, Google identities and every app table, in one transaction | the target database only |
| `copy-photos.js` | every object in the `recipe-photos` bucket, same path, same type | the target Storage only |
| `verify.js` | compares the two and exits non-zero on any difference | nothing |

Nothing is ever written to the hosted project. `copy-data` reads it inside a read-only
transaction (`default_transaction_read_only = on`, one repeatable-read snapshot), and
the Storage calls to it are lists and downloads.

## What moves, and what does not

| | Moves | Left behind, on purpose |
|---|---|---|
| `auth.users` | people: `id`, `instance_id`, `aud`, `role`, `email`, `email_confirmed_at`, `raw_app_meta_data`, `raw_user_meta_data`, `is_anonymous`, `created_at`, `updated_at` (those both sides have) | agents and other anonymous accounts; passwords, sessions, refresh tokens, MFA, one-time tokens |
| `auth.identities` | `provider = 'google'`: `id`, `provider_id` (Google's `sub`), `user_id`, `identity_data`, timestamps | anything not Google, and agents' |
| `profiles` | people's | agents' |
| `books` | all | — (a book owned by an agent stops the copy; the schema has not allowed one since 008) |
| `book_members` | owners, editors, viewers | `role = 'agent'`, and any row for an agent account |
| `recipes`, `live_plans`, `plans` | all, tombstones included, timestamps to the microsecond | — |
| `invites` | live ones | expired ones; any made by an agent account |
| `agent_accounts` | — | stays empty: agents are **re-issued** after cutover (E7), because their credentials carry the old URL |
| photos | every object in `recipe-photos` | — |

An **agent account** is one that is anonymous, or holds an `agent` membership, or is in
`agent_accounts` (once hosted has migration 009) — the last two catch an agent whose
account stopped being anonymous. The scripts print each one left behind, by id and reason.

How the copy keeps the target honest:

- **Triggers are off for the import** (`set local session_replication_role = replica`).
  Otherwise the new-user trigger would give every imported person a second book,
  `live_plans_touched` would overwrite `updated_at`, and the quota triggers would count rows
  as they land. It is `local` to the copy's transaction, so it ends with it.
- **Foreign keys are triggers too**, so they are off as well — and checked by hand, table
  by table, before the transaction commits. A broken reference rolls the whole copy back.
- **GoTrue's token columns are written as `''`, never NULL.** GoTrue reads
  `confirmation_token` and friends into plain strings and answers *"Database error loading
  user"* for a row with a NULL there (seen on v2.197.0 in the lab test). The hosted values
  are one-time tokens for the old project and are not copied.
- **Values go across as text.** Nothing passes through a JavaScript `Date` or number, so a
  timestamp keeps its microseconds and `jsonb` its exact value.
- **The target must be migrated (009) and empty**, or `copy-data` refuses before writing.

## What Dave sets

Secrets come **only from environment variables**. Nothing is written to disk, and every
message the scripts print is passed through a redactor that removes the values of the
variables below, any `user:password@` in a `postgres://` URL, and anything shaped like a
JWT or an `sb_secret_` key. Set `MIGRATE_DEBUG=1` for stack traces (also redacted).

| Variable | Secret | Value |
|---|---|---|
| `HOSTED_DB_URL` | **yes** | Dashboard → **Connect** → *Session pooler* (IPv4) connection string, with the database password filled in: `postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres` |
| `HOSTED_URL` | no | `https://<ref>.supabase.co` |
| `HOSTED_SERVICE_KEY` | **yes** | Dashboard → Settings → API Keys: the **secret** key (`sb_secret_…`), or the legacy `service_role` key. Either works. |
| `HOSTED_DB_CA_FILE` | no | path (as the script sees it) to Supabase's CA: Dashboard → Database → Settings → *SSL configuration* → **Download certificate**. Without it the pooler's certificate is checked against the system CAs, which may not include Supabase's. |
| `HOSTED_DB_SSL_NO_VERIFY` | no | `1` to skip checking the hosted certificate. Last resort only; it warns. |
| `TARGET_DB_URL` | **yes** | `postgres://postgres:<POSTGRES_PASSWORD>@recipe-friend-db-1:5432/postgres` — the password from the stack's `.env` on the box |
| `TARGET_URL` | no | the stack's Caddy: `http://recipe-friend-caddy-1:80` from the container below; `http://127.0.0.1:8090` on the box itself or through an SSH tunnel |
| `TARGET_SERVICE_KEY` | **yes** | `SERVICE_ROLE_KEY` from the stack's `.env` on the box |

The hosted values are typed into the shell with `read -s` (so they are in neither the
shell history nor the screen) and passed to the container as `-e NAME` (name only, so
not on any command line). Paste them; never put them in a file, a commit or a chat.

## Where it runs: on the box, beside the stack

The production database has **no published port**, by design (homelab
`stacks/recipe-friend/README.md`). So the scripts run on the box in a throwaway Node
container joined to two of the stack's networks:

- `recipe-friend_db` — reaches Postgres (internal, no internet);
- `recipe-friend_edge` — reaches Caddy, and the internet, for hosted Supabase.

The containers are named in full (`recipe-friend-db-1`, `recipe-friend-caddy-1`) rather than
by service name: a short name like `db` means whichever stack's `db` the container
resolves first if it ever sits on two stacks' networks — found the hard way in the lab test.
Both scripts also refuse outright if the two database URLs reach the same database.

Docker gives such a container its default route through the non-internal network, so both
work at once (checked on the lab's Docker 29.8).

**Photos only, from the Mac instead:** `copy-photos.js` needs no database, so it can run on
the Mac through an SSH tunnel to Caddy — `ssh -N -L 8090:127.0.0.1:8090 homelab` in one
terminal, then `TARGET_URL=http://127.0.0.1:8090` and the two Storage keys in the other.
That means copying `TARGET_SERVICE_KEY` to the Mac's shell; the box route below avoids it,
and is the one these steps use.

### One-time preparation on the box

```bash
# The scripts, at the commit the stack runs (x-recipe-friend-ref in compose.yaml), or
# the migrate branch's head until it merges. This is a scratch copy: removed at the end.
git clone https://github.com/malfernion/Recipe-friend.git ~/scratch/rf-migrate
git -C ~/scratch/rf-migrate checkout <commit>
# As you, not root, so the rm -rf at the end works:
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v ~/scratch/rf-migrate:/app -w /app \
  node:22.20.0-alpine npm ci --no-audit --no-fund

# Supabase's CA certificate (public; downloaded on the Mac, see the table above):
scp ~/Downloads/prod-ca-2021.crt homelab:scratch/rf-migrate/supabase-ca.crt   # from the Mac
```

### Each session: the variables and a helper

In an SSH session on the box, in **bash**:

```bash
read -rsp 'Hosted session-pooler URL: ' HOSTED_DB_URL; echo; export HOSTED_DB_URL
read -rsp 'Hosted service/secret key: ' HOSTED_SERVICE_KEY; echo; export HOSTED_SERVICE_KEY
export HOSTED_URL=https://<ref>.supabase.co
export HOSTED_DB_CA_FILE=/app/supabase-ca.crt     # the path inside the container

stack_env=~/workspace/homelab/stacks/recipe-friend/.env
export TARGET_DB_URL="postgres://postgres:$(sed -n 's/^POSTGRES_PASSWORD=//p' "$stack_env")@recipe-friend-db-1:5432/postgres"
export TARGET_SERVICE_KEY="$(sed -n 's/^SERVICE_ROLE_KEY=//p' "$stack_env")"
export TARGET_URL=http://recipe-friend-caddy-1:80

rfm() {
  docker run --rm -t \
    --network recipe-friend_edge --network recipe-friend_db \
    -v ~/scratch/rf-migrate:/app:ro -w /app \
    -e HOSTED_DB_URL -e HOSTED_URL -e HOSTED_SERVICE_KEY -e HOSTED_DB_CA_FILE \
    -e TARGET_DB_URL -e TARGET_URL -e TARGET_SERVICE_KEY \
    node:22.20.0-alpine node "server/migrate-from-supabase/$1" "${@:2}"
}
```

(Every `.env` value from `gen-keys.sh` is hex, so no quoting surprises in those `sed`s.)
The values are visible to anyone who can run `docker inspect` on the box while a script
runs — that is Dave, and nobody else.

## E1–E3: rehearsal

Before the first one: the stack is deployed and healthy, `docker compose ps -a` shows
`migrate` *Exited (0)*, and `docker compose logs migrate` shows 009 applied.

1. **E1. Copy.**
   ```bash
   rfm copy-data.js
   rfm copy-photos.js
   ```
   `copy-data` prints both Postgres versions, refuses unless the target is migrated to 009
   and empty, lists every account it leaves behind and why, and ends with a count per
   table and per exclusion. `copy-photos` ends with uploaded / skipped / failed counts and
   bytes, and exits non-zero if anything failed.
2. **E2. Verify.**
   ```bash
   rfm verify.js
   ```
   Per table: rows on hosted, rows expected after the exclusions, rows on the target — and
   every missing, extra or changed row by key. Then the recipes checksum (over `id`,
   `book_id`, `data`, `updated_at`, `deleted_at`), every person's Google identity
   (same `provider_id`, same user), **GoTrue loading every imported user** through its
   admin API, and photo counts, bytes, paths and sizes. `OK` and exit 0, or `FAIL` with the
   list and exit 1. Run it before using the new site: an edit there is a difference, and it
   says so. (Signing in is not: it changes no compared column.)
3. **E3.** The checks on a phone and the Mac, as the plan lists them.

**Again, from clean.** The light way, which keeps photos already copied:

```bash
rfm copy-data.js --wipe-target --yes-delete-everything-on-target
rfm copy-photos.js      # same-size objects are skipped
rfm verify.js
```

`--wipe-target` truncates `auth.users` (cascading to sessions and identities) and every
app table, inside the same transaction as the copy. It does nothing without the second
flag. Photos uploaded *during* a rehearsal stay in Storage and `verify` lists them as
extras; for those, or to start truly from nothing, reset the stack's state instead:

```bash
cd ~/workspace/homelab/stacks/recipe-friend
docker compose down
sudo rm -rf ~/data/recipe-friend/db/* ~/data/recipe-friend/photos/*   # REHEARSAL ONLY
docker compose up -d --build          # db re-initialises; migrate rebuilds the schema
```

## E4–E8: cutover

1. **E4.** Every device shows *Synced* on the old site.
2. **E5. Final copy.** Reset the stack's state as above (so no rehearsal row or photo
   survives), wait for `migrate` to exit 0, then:
   ```bash
   rfm copy-data.js
   rfm copy-photos.js
   rfm verify.js           # must say OK; if not, stop — the old site is untouched
   ```
   From here, stop using the old site.
3. **Straight after:**
   ```bash
   unset HOSTED_DB_URL HOSTED_SERVICE_KEY TARGET_DB_URL TARGET_SERVICE_KEY
   rm -rf ~/scratch/rf-migrate
   ```
   and **rotate the hosted secrets** that were in the shell: in the Supabase dashboard,
   roll the secret API key (or, for the legacy `service_role` key, the JWT secret) and
   reset the database password. Neither is needed for the 30-day way back — the old site
   uses only the publishable key.
4. **E6–E8** as the plan says: retire the old site, re-issue the agents (none were
   copied — the books simply have no agent members until they are added again), keep the
   hosted project 30 days, then a final `pg_dump` off the box and delete it.

## Testing

`test/migrate-from-supabase.test.js` runs all three scripts for real between two of the
`server/` dev stacks: one plays hosted, seeded as production was (three people signing in,
a shared book with an editor and a viewer, an agent placed in it, a stray anonymous
account, live and expired invites, recipes with a tombstone, a live and a finished plan,
two photos), and one plays the lab. It checks that people keep their ids and Google
identities, agents and their rows stay behind, no trigger made an extra book, every
timestamp survives to the microsecond, photos arrive with the same bytes and type, a
re-run skips them, `verify` passes on the copy and fails — naming the row — on a tampered
one, `--wipe-target` re-runs cleanly, and no password reaches the output.

It **deletes every row and photo in both stacks** at the start, and skips unless all four
variables are set:

```bash
cp server/.env.example server/.env
for p in a:18181:54381 b:18182:54382; do
  IFS=: read name http db <<<"$p"
  HTTP_PORT=$http DB_PORT=$db PUBLIC_URL=http://localhost:$http \
    docker compose -p rfmig-$name -f server/compose.yaml up -d --wait
  MIGRATE_COMPOSE="docker compose -p rfmig-$name -f server/compose.yaml" server/migrate.sh
done

MIGRATE_TEST_SOURCE_DB=postgres://postgres:local-dev-only-postgres-password@127.0.0.1:54381/postgres \
MIGRATE_TEST_TARGET_DB=postgres://postgres:local-dev-only-postgres-password@127.0.0.1:54382/postgres \
MIGRATE_TEST_SOURCE_URL=http://127.0.0.1:18181 \
MIGRATE_TEST_TARGET_URL=http://127.0.0.1:18182 \
  node --test test/migrate-from-supabase.test.js

for p in a b; do docker compose -p rfmig-$p -f server/compose.yaml down -v; done
```

CI's `migrate` job does exactly this.
