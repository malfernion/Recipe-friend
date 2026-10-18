-- Migration 010 — agents get keys, and stop being GoTrue sign-ins (J16, J17)
--
-- Run after 009, by server/migrate.sh.
--
-- Until now an agent was an anonymous GoTrue user: the owner's browser
-- signed one in (behind Turnstile), placed it with `add_agent`, and handed
-- its refresh token over inside an `rfa1.` credential. The MCP server then
-- had to keep that refresh token alive across GoTrue's rotation rules,
-- which is the most fragile thing in the project (J16.9, as it was).
--
-- From here the MCP server is a hosted service (`mcp/http.js`) and an agent
-- is reached with an **agent key**: `rfk_` and 256 random bits, shown to
-- the owner once. Only its SHA-256 is kept. The service looks the key up
-- with `resolve_agent_key`, gets back the agent's user id and its one
-- book, and calls PostgREST with a short-lived token for that user — so
-- every policy from 008 and 009 still decides what the agent may do.
--
-- What changes here:
--
--   1. `create_agent(book, name)` makes the agent's principal, places it
--      and returns the key, all in one definer call checked against the
--      caller's ownership of the book. There is no anonymous sign-in and
--      no captcha any more, and GoTrue's anonymous sign-ins can be off.
--   2. `agent_keys` holds the hash, a display prefix and when the key was
--      made and last used. Nobody but the definer functions reads it.
--   3. `list_agents(book)` is the owner's view of the keys.
--   4. Removing an agent's membership row — the owner's ×, the book being
--      deleted, anything — deletes its key and its principal in the same
--      statement, so revocation is immediate.
--   5. `resolve_agent_key(key)` is callable only by `recipe_friend_mcp`, a
--      NOLOGIN role PostgREST switches to when the MCP service presents a
--      token carrying that role. Never by anon or authenticated.
--   6. `add_agent` refuses, for everybody; agents made the old way are
--      deleted (they hold GoTrue refresh tokens this release no longer
--      honours, and have no key). Production had none.
--
-- The principal is still a row in auth.users, because book_members,
-- profiles and agent_accounts all reference it and `auth.uid()` is what
-- every policy reads. It has no email, no phone, no password and no
-- identity, so nothing can sign in as it through GoTrue; the only way to
-- act as it is a token minted by the MCP service. Its GoTrue text columns
-- are '' rather than NULL, because GoTrue v2.197.0 scans them into plain
-- strings and answers 500 for the whole users list when one is NULL.

-- ---------------------------------------------------------------------
-- 0. Agents made the old way
-- ---------------------------------------------------------------------
--
-- Before the trigger below exists, so this is a plain delete. The
-- membership rows, profiles and agent_accounts rows cascade with it, and so
-- do the GoTrue sessions and refresh tokens that were the old credential.

delete from auth.users u
where exists (select 1 from public.agent_accounts a where a.user_id = u.id)
   or exists (select 1 from public.book_members m where m.user_id = u.id and m.role = 'agent');

-- ---------------------------------------------------------------------
-- 1. The keys
-- ---------------------------------------------------------------------
--
-- One key per agent: a lost key is replaced by removing the agent and
-- adding another (J16.6), which keeps "remove" and "revoke" one act.

create table if not exists public.agent_keys (
  agent_id uuid primary key references public.agent_accounts (user_id) on delete cascade,
  key_hash bytea not null unique,
  key_prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

-- In public, so PostgREST would serve it: RLS on, no policy, no grants.
alter table public.agent_keys enable row level security;
revoke all on public.agent_keys from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. The role the MCP service acts as
-- ---------------------------------------------------------------------
--
-- NOLOGIN: nothing connects as it. PostgREST's `authenticator` switches to
-- it for a request whose token says `role: recipe_friend_mcp`, which only
-- a holder of the JWT secret can sign. It can do one thing: call
-- `resolve_agent_key`.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'recipe_friend_mcp') then
    create role recipe_friend_mcp nologin noinherit;
  end if;
end;
$$;

grant recipe_friend_mcp to authenticator;
grant usage on schema public to recipe_friend_mcp;

-- ---------------------------------------------------------------------
-- 3. Making one
-- ---------------------------------------------------------------------

create or replace function public.create_agent(book uuid, name text)
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  label text := left(btrim(coalesce(name, '')), 80);
  agent uuid := gen_random_uuid();
  key text;
  prefix text;
begin
  if me is null then
    raise exception 'sign in first';
  end if;
  -- An agent cannot make another agent, even in a book it somehow owned.
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) or is_agent_user(me) then
    raise exception 'an agent cannot add an agent';
  end if;
  if not is_book_owner(book) then
    raise exception 'only the owner of a book may add an agent to it';
  end if;
  if label = '' then
    raise exception 'an agent needs a name';
  end if;
  if (select count(*) from book_members m where m.book_id = book and m.role = 'agent') >= 20 then
    raise exception 'a book can have at most 20 agents';
  end if;

  -- handle_new_user gives it a profile with this name and, because it is
  -- anonymous, no book.
  insert into auth.users (
    instance_id, id, aud, role, email, phone, encrypted_password,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token,
    reauthentication_token, raw_app_meta_data, raw_user_meta_data,
    is_super_admin, is_sso_user, is_anonymous, created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', agent, 'authenticated', 'authenticated',
    null, null, '',
    '', '', '', '',
    '', '', '',
    '', '{"provider":"recipe_friend_agent","providers":["recipe_friend_agent"]}'::jsonb,
    jsonb_build_object('name', label),
    false, false, true, now(), now()
  );

  insert into agent_accounts (user_id) values (agent);
  insert into book_members (book_id, user_id, role) values (book, agent, 'agent');

  -- 32 random bytes, base64url without padding: 43 characters after the prefix.
  key := 'rfk_' || translate(encode(extensions.gen_random_bytes(32), 'base64'), E'+/=\n', '-_');
  prefix := left(key, 12);
  insert into agent_keys (agent_id, key_hash, key_prefix)
    values (agent, sha256(convert_to(key, 'UTF8')), prefix);

  return json_build_object(
    'agent_id', agent,
    'name', label,
    'key', key,
    'key_prefix', prefix,
    'created_at', now()
  );
end;
$$;

revoke execute on function public.create_agent(uuid, text) from public, anon;
grant execute on function public.create_agent(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Listing them, for the owner
-- ---------------------------------------------------------------------
--
-- The roster (book_members + profiles) already shows an agent by name to
-- every member (J16.7). This adds what only the owner needs: which key,
-- when it was made, when it was last used.

create or replace function public.list_agents(book uuid)
returns table (
  agent_id uuid,
  name text,
  key_prefix text,
  created_at timestamptz,
  last_used_at timestamptz
)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if not is_book_owner(book) then
    raise exception 'only the owner of a book may list its agents';
  end if;
  return query
    select m.user_id, coalesce(p.display_name, ''), k.key_prefix,
           coalesce(k.created_at, m.created_at), k.last_used_at
    from book_members m
    left join profiles p on p.user_id = m.user_id
    left join agent_keys k on k.agent_id = m.user_id
    where m.book_id = book and m.role = 'agent'
    order by m.created_at;
end;
$$;

revoke execute on function public.list_agents(uuid) from public, anon;
grant execute on function public.list_agents(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Removing one takes its key and its principal (J16.7)
-- ---------------------------------------------------------------------
--
-- Whatever deletes the membership row — the owner's ×, the book being
-- deleted, the owner's account being deleted — deletes the key first and
-- then the principal, in the same statement. The key going is what stops
-- the MCP service; its cache of resolved keys is bounded (see mcp/http.js),
-- and the token it mints for the agent lasts minutes and names a user
-- that no longer holds a membership row, so every policy refuses it.

create or replace function public.agent_membership_gone()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  delete from agent_keys where agent_id = old.user_id;
  delete from auth.users where id = old.user_id;
  return null;
end;
$$;

revoke execute on function public.agent_membership_gone() from public, anon, authenticated;

drop trigger if exists agent_membership_gone on public.book_members;
create trigger agent_membership_gone
  after delete on public.book_members
  for each row when (old.role = 'agent')
  execute function public.agent_membership_gone();

-- ---------------------------------------------------------------------
-- 6. Resolving a key, for the MCP service only
-- ---------------------------------------------------------------------
--
-- Hashed here so there is one definition of the hash. Returns null for
-- anything that is not a live key — malformed, unknown, revoked, or an
-- agent that has somehow lost its book — and never says which.
-- last_used_at is written at most once a minute per key.

create or replace function public.resolve_agent_key(key text)
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  found_agent uuid;
  found_book uuid;
  used timestamptz;
begin
  if key is null or key not like 'rfk\_%' or length(key) > 128 then
    return null;
  end if;

  select k.agent_id, m.book_id, k.last_used_at
    into found_agent, found_book, used
  from agent_keys k
  join book_members m on m.user_id = k.agent_id and m.role = 'agent'
  where k.key_hash = sha256(convert_to(key, 'UTF8'));

  if found_agent is null then
    return null;
  end if;

  if used is null or used < now() - interval '1 minute' then
    update agent_keys set last_used_at = now() where agent_id = found_agent;
  end if;

  return json_build_object('agent_id', found_agent, 'book_id', found_book);
end;
$$;

revoke execute on function public.resolve_agent_key(text) from public, anon, authenticated, service_role;
grant execute on function public.resolve_agent_key(text) to recipe_friend_mcp;

-- ---------------------------------------------------------------------
-- 7. The old way in is closed
-- ---------------------------------------------------------------------
--
-- Kept as a function so that anything still calling it gets a sentence
-- rather than "function does not exist", and so the grants stay explicit.

create or replace function public.add_agent(book uuid, agent_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'agents are added with create_agent now';
end;
$$;

revoke execute on function public.add_agent(uuid, uuid) from public, anon, authenticated;
