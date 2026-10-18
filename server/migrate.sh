#!/bin/sh
# Applies supabase/schema.sql and then supabase/migrations/*.sql, in order,
# each one once. What has been applied is recorded in
# recipe_friend.schema_migrations, so running this again applies only what
# is new, and running it on an up-to-date database does nothing.
#
#   server/migrate.sh             apply whatever has not been applied
#   server/migrate.sh --baseline  record every file as applied WITHOUT
#                                 running it — for a database that already
#                                 has the schema, such as one restored from
#                                 the hosted project's dump
#
# It talks to Postgres through `docker compose exec` on this directory's
# stack, so no port needs publishing. To aim it at another stack, set
# MIGRATE_COMPOSE to the compose command that reaches it (for example
# "docker compose -p recipe-friend"); to aim it at a database directly, set
# DATABASE_URL and have psql installed.
#
# It connects as `postgres`, the role the Supabase dashboard's SQL editor
# runs as, so what it creates is owned by the same role it is on the
# hosted project.
#
# Each file runs in one transaction with its own record, so a file that
# fails leaves nothing behind and is tried again next time.

set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
compose=${MIGRATE_COMPOSE:-"docker compose -f $here/compose.yaml"}
wait_seconds=${MIGRATE_WAIT:-180}

psql_run() {
  if [ -n "${DATABASE_URL:-}" ]; then
    psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"
  else
    # shellcheck disable=SC2086 # $compose is a command line on purpose
    $compose exec -T db psql -X -q -v ON_ERROR_STOP=1 -h localhost -U postgres -d postgres "$@"
  fi
}

# stdin is closed on purpose: `docker compose exec -T` would otherwise
# swallow whatever the caller is reading from.
query() {
  psql_run -tA -c "$1" </dev/null
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# ---------------------------------------------------------------------
# Wait for GoTrue and Storage to have built their own schemas
#
# The app's SQL triggers on auth.users, reads auth.users.is_anonymous, and
# writes policies on storage.objects and a row into storage.buckets. Those
# belong to GoTrue's and Storage's migrations, which they run when they
# start, so the app's SQL has to come after them. `docker compose up
# --wait` already waits for both to be healthy; this is the check that
# does not depend on how the stack was started.
# ---------------------------------------------------------------------

ready_sql="select
  exists (select 1 from pg_attribute
          where attrelid = to_regclass('auth.users') and attname = 'is_anonymous')
  and exists (select 1 from pg_attribute
          where attrelid = to_regclass('storage.buckets') and attname = 'allowed_mime_types')
  and to_regclass('storage.objects') is not null
  and to_regprocedure('storage.foldername(text)') is not null"

waited=0
until [ "$(query "$ready_sql" 2>/dev/null || true)" = "t" ]; do
  if [ "$waited" -ge "$wait_seconds" ]; then
    echo "migrate: gave up after ${wait_seconds}s waiting for auth.users and storage.objects." >&2
    echo "migrate: is the stack up, and are the auth and storage containers healthy?" >&2
    exit 1
  fi
  [ "$waited" -eq 0 ] && echo "migrate: waiting for GoTrue and Storage to finish their migrations..."
  sleep 2
  waited=$((waited + 2))
done

query "set client_min_messages = warning;
create schema if not exists recipe_friend;
create table if not exists recipe_friend.schema_migrations (
  version text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);" >/dev/null

# ---------------------------------------------------------------------
# The files, in the order they have always been run in by hand
# ---------------------------------------------------------------------

files="$repo/supabase/schema.sql
$(ls "$repo"/supabase/migrations/[0-9]*.sql | sort)"

baseline=false
[ "${1:-}" = "--baseline" ] && baseline=true

if $baseline && [ "$(query "select to_regclass('public.books') is not null")" != "t" ]; then
  echo "migrate: --baseline is for a database that already has the schema, and this one has no public.books." >&2
  exit 1
fi

old_ifs=$IFS
IFS='
'
for file in $files; do
  IFS=$old_ifs
  name=$(basename "$file" .sql)
  [ "$name" = "schema" ] && name="001_schema"
  sum=$(sha256 "$file")
  recorded=$(query "select checksum from recipe_friend.schema_migrations where version = '$name'")

  if [ -n "$recorded" ]; then
    if [ "$recorded" != "$sum" ]; then
      echo "migrate: $name was applied, but the file has changed since. Not re-running it;" >&2
      echo "         a change to the schema belongs in a new migration." >&2
    fi
    continue
  fi

  if $baseline; then
    query "insert into recipe_friend.schema_migrations (version, checksum) values ('$name', '$sum')" >/dev/null
    echo "migrate: $name recorded as applied (baseline)"
    continue
  fi

  echo "migrate: applying $name"
  if ! {
    printf 'set client_min_messages = warning;\nbegin;\n'
    cat "$file"
    printf "\n;\ninsert into recipe_friend.schema_migrations (version, checksum) values ('%s', '%s');\ncommit;\n" "$name" "$sum"
  } | psql_run; then
    echo "migrate: $name failed and was rolled back; nothing after it was tried." >&2
    exit 1
  fi
done

echo "migrate: up to date ($(query "select count(*) from recipe_friend.schema_migrations") applied)"
