-- Migration 011 — assistants that sign in: connected apps (J16, J17)
--
-- Run after 010, by server/migrate.sh.
--
-- Claude.ai, ChatGPT and the other apps that add an MCP server as a
-- "connector" cannot be given an `rfk_` key; they sign in with OAuth.
-- GoTrue (v2.197.0) is the OAuth 2.1 server: it registers the app
-- (dynamic client registration), sends the person to the consent screen
-- at the site's `/?authorization_id=…`, and issues the app its tokens.
--
-- What it would issue on its own is the person's session: `sub` the
-- person, role `authenticated`, good at PostgREST, Storage and GoTrue's
-- /user. That is exactly what Recipe Friend never hands to a program, so
-- this migration makes an app's sign-in end in the same place an agent
-- key does — an agent principal in one book — and makes its token unable
-- to be anything else:
--
--   1. `agent_apps` binds (the person, the app's OAuth client) to an agent
--      principal placed in one book, like a key does. Nobody but the
--      definer functions reads it.
--   2. `connect_app(authorization_id, book)` is what the consent screen's
--      Allow calls, before it approves the request in GoTrue. Owners only,
--      for a book they own, and only for an authorization request that is
--      the caller's own and still pending.
--   3. `custom_access_token_hook` is GoTrue's custom access token hook
--      (GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_*). For a token issued to an OAuth
--      client it rewrites the claims: `sub` becomes the bound agent, role
--      `recipe_friend_app` (a role nothing may switch to, so PostgREST and
--      Storage refuse the token outright), audience `recipe-friend-mcp`,
--      and none of the person's email or metadata. With no bound agent it
--      refuses to issue the token at all. Every other token passes through
--      untouched. The token is then good only at the MCP service, which
--      checks it and calls `resolve_agent_app`.
--   4. `resolve_agent_app(agent, client)` is the MCP service's lookup, for
--      `recipe_friend_mcp` only, as `resolve_agent_key` is.
--   5. `list_agents` says which of a book's agents are keys and which are
--      connected apps.
--   6. Removing an app's agent — the owner's ×, the book going, anything
--      that deletes the membership row — also deletes the person's consent
--      for that app and every GoTrue session it holds, so its refresh
--      token is dead in the same statement. Its last access token names an
--      agent that no longer exists, so the MCP service refuses it.

-- ---------------------------------------------------------------------
-- 1. The bindings
-- ---------------------------------------------------------------------
--
-- One agent per person per app: connecting the same app again reuses it,
-- or moves it to the book chosen this time. client_id has no foreign key:
-- auth.oauth_clients is GoTrue's, and an app whose registration is gone
-- simply never signs in again; its agent stays until it is removed.

create table if not exists public.agent_apps (
  agent_id uuid primary key references public.agent_accounts (user_id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  client_id uuid not null,
  redirect_host text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (user_id, client_id)
);

alter table public.agent_apps enable row level security;
revoke all on public.agent_apps from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. The role a connected app's token names
-- ---------------------------------------------------------------------
--
-- NOLOGIN and granted to nobody — in particular not to `authenticator`,
-- so PostgREST answers a request carrying it with an error before any
-- policy is asked, and so does Storage. Only the MCP service accepts it.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'recipe_friend_app') then
    create role recipe_friend_app nologin noinherit;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. One way to make an agent principal
-- ---------------------------------------------------------------------
--
-- create_agent (010) made the principal inline. A connected app needs the
-- same principal without a key, so it moves here and create_agent calls
-- it. The checks that differ — who is asking, which book — stay with the
-- callers; this is never callable on its own.

create or replace function public.new_agent_principal(book uuid, label text)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  agent uuid := gen_random_uuid();
begin
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
  return agent;
end;
$$;

revoke execute on function public.new_agent_principal(uuid, text) from public, anon, authenticated, service_role;

create or replace function public.create_agent(book uuid, name text)
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  label text := left(btrim(coalesce(name, '')), 80);
  agent uuid;
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

  agent := new_agent_principal(book, label);

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
-- 4. Connecting an app, from the consent screen
-- ---------------------------------------------------------------------
--
-- Called with the person's own session, after the screen has fetched the
-- authorization request from GoTrue (which is what records whose request
-- it is) and before it approves it. The request is looked up here rather
-- than trusted from the page: the app's client id, its name and where it
-- will send the person back all come from GoTrue's own rows.
--
-- If this person already connected this app, the same agent is reused —
-- moved to the chosen book if it is a different one, which takes it out
-- of the old book and revokes what it held there first.

create or replace function public.connect_app(authorization_id text, book uuid)
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  req record;
  label text;
  host text;
  agent uuid;
  current_book uuid;
begin
  if me is null then
    raise exception 'sign in first';
  end if;
  if coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
     or coalesce(auth.jwt() ->> 'client_id', '') <> ''
     or is_agent_user(me) then
    raise exception 'an agent cannot connect an app';
  end if;
  if not is_book_owner(book) then
    raise exception 'only the owner of a book may connect an app to it';
  end if;

  select a.client_id, a.redirect_uri, c.client_name
    into req
  from auth.oauth_authorizations a
  join auth.oauth_clients c on c.id = a.client_id and c.deleted_at is null
  where a.authorization_id = connect_app.authorization_id
    and a.user_id = me
    and a.status = 'pending'
    and a.expires_at > now();
  if not found then
    raise exception 'that sign-in request has expired or is not yours; start again from the app';
  end if;

  label := coalesce(nullif(left(btrim(coalesce(req.client_name, '')), 80), ''), 'Connected app');
  host := coalesce(substring(req.redirect_uri from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]*)'), '');

  select x.agent_id, m.book_id into agent, current_book
  from agent_apps x
  left join book_members m on m.user_id = x.agent_id and m.role = 'agent'
  where x.user_id = me and x.client_id = req.client_id;

  if agent is not null and current_book = book then
    update agent_apps set redirect_host = host where agent_id = agent;
    return json_build_object('agent_id', agent, 'name', label, 'book_id', book, 'reused', true);
  end if;
  if agent is not null then
    -- Removing the membership revokes the app and deletes the principal
    -- (section 7); a new one is made in the chosen book below.
    delete from book_members where user_id = agent and role = 'agent';
  end if;

  agent := new_agent_principal(book, label);
  insert into agent_apps (agent_id, user_id, client_id, redirect_host)
    values (agent, me, req.client_id, host);

  return json_build_object('agent_id', agent, 'name', label, 'book_id', book, 'reused', false);
end;
$$;

revoke execute on function public.connect_app(text, uuid) from public, anon;
grant execute on function public.connect_app(text, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. What an app's token says (GoTrue's custom access token hook)
-- ---------------------------------------------------------------------
--
-- GoTrue calls this for every access token it issues, as
-- supabase_auth_admin, inside the transaction that issues it. A token for
-- a person signing in to the site has no client_id and is returned
-- exactly as it came — so a mistake here would break every sign-in, and
-- the branch that does anything is kept small. A token for an OAuth
-- client is rewritten to name the agent the person connected it to, or
-- refused if there is none.
--
-- The claims GoTrue insists on (aud, exp, iat, sub, email, phone, role,
-- aal, session_id, is_anonymous) are all still there. session_id is the
-- person's OAuth session, which is what refreshing and revoking go by.

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  claims jsonb := event -> 'claims';
  client text := claims ->> 'client_id';
  agent uuid;
begin
  if client is null or client = '' then
    return event;
  end if;

  select x.agent_id into agent
  from agent_apps x
  join book_members m on m.user_id = x.agent_id and m.role = 'agent'
  where x.user_id = (event ->> 'user_id')::uuid
    and x.client_id = client::uuid;

  if agent is null then
    return jsonb_build_object('error', jsonb_build_object(
      'http_code', 403,
      'message', 'This app is not connected to a Recipe Friend book. Connect it again from the app.'));
  end if;

  claims := claims
    || jsonb_build_object(
      'sub', agent,
      'role', 'recipe_friend_app',
      'aud', 'recipe-friend-mcp',
      'email', '',
      'phone', '',
      'app_metadata', '{}'::jsonb,
      'user_metadata', '{}'::jsonb,
      'is_anonymous', true);

  return jsonb_build_object('claims', claims);
end;
$$;

revoke execute on function public.custom_access_token_hook(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------
-- 6. Resolving an app's agent, for the MCP service only
-- ---------------------------------------------------------------------
--
-- The service has already checked the token's signature, expiry, issuer,
-- audience and role; this says whether the agent it names is still bound
-- to that app and still in its book. Null otherwise, and never why.

create or replace function public.resolve_agent_app(agent uuid, client uuid)
returns json
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  found_book uuid;
  used timestamptz;
begin
  if agent is null or client is null then
    return null;
  end if;

  select m.book_id, x.last_used_at into found_book, used
  from agent_apps x
  join book_members m on m.user_id = x.agent_id and m.role = 'agent'
  where x.agent_id = agent and x.client_id = client;

  if found_book is null then
    return null;
  end if;

  if used is null or used < now() - interval '1 minute' then
    update agent_apps set last_used_at = now() where agent_id = agent;
  end if;

  return json_build_object('agent_id', agent, 'book_id', found_book);
end;
$$;

revoke execute on function public.resolve_agent_app(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.resolve_agent_app(uuid, uuid) to recipe_friend_mcp;

-- ---------------------------------------------------------------------
-- 7. Removing one revokes it in GoTrue too (J16.7)
-- ---------------------------------------------------------------------
--
-- As in 010, plus: for a connected app, the person's consent for it and
-- every session GoTrue issued it (their refresh tokens go with them, by
-- GoTrue's own foreign key) are deleted before the principal is. That is
-- what GoTrue's own "revoke grant" does.

create or replace function public.agent_membership_gone()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  app record;
begin
  select user_id, client_id into app from agent_apps where agent_id = old.user_id;
  if found then
    delete from auth.oauth_consents where user_id = app.user_id and client_id = app.client_id;
    delete from auth.sessions where user_id = app.user_id and oauth_client_id = app.client_id;
    delete from agent_apps where agent_id = old.user_id;
  end if;
  delete from agent_keys where agent_id = old.user_id;
  delete from auth.users where id = old.user_id;
  return null;
end;
$$;

revoke execute on function public.agent_membership_gone() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 8. The owner's list says which is which
-- ---------------------------------------------------------------------
--
-- `kind` is 'key' or 'app'. An app has no key prefix and a redirect host
-- (where it sends the person back to: claude.ai, localhost, …); a key
-- has the reverse. The return type changes, so it is dropped first.

drop function if exists public.list_agents(uuid);

create function public.list_agents(book uuid)
returns table (
  agent_id uuid,
  name text,
  kind text,
  key_prefix text,
  redirect_host text,
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
    select m.user_id, coalesce(p.display_name, ''),
           case when x.agent_id is not null then 'app' else 'key' end,
           k.key_prefix, x.redirect_host,
           coalesce(k.created_at, x.created_at, m.created_at),
           coalesce(k.last_used_at, x.last_used_at)
    from book_members m
    left join profiles p on p.user_id = m.user_id
    left join agent_keys k on k.agent_id = m.user_id
    left join agent_apps x on x.agent_id = m.user_id
    where m.book_id = book and m.role = 'agent'
    order by m.created_at;
end;
$$;

revoke execute on function public.list_agents(uuid) from public, anon;
grant execute on function public.list_agents(uuid) to authenticated;
