-- Run once by the Postgres image when its data directory is first
-- created. The image makes these roles with no usable password; GoTrue,
-- Storage and PostgREST each log in as one of them, with the password in
-- server/.env. Taken from Supabase's docker/volumes/db/roles.sql, less the
-- roles for services this stack does not run.
\set pgpass `echo "$POSTGRES_PASSWORD"`

alter user authenticator with password :'pgpass';
alter user supabase_auth_admin with password :'pgpass';
alter user supabase_storage_admin with password :'pgpass';
