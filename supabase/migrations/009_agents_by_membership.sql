-- Migration 009 — an agent is an agent for life, not for as long as it
-- stays anonymous (J16.1, J7.5, J16.7)
--
-- Run after 008, by server/migrate.sh.
--
-- 008 decided "is this caller an agent?" in three places by asking
-- whether the account is anonymous: the guard on creating a book read the
-- token's `is_anonymous` claim, `redeem_invite` read
-- `auth.users.is_anonymous`, and `discard_orphan_agent` would only delete
-- an account that was still anonymous. That was true on the day 008 was
-- written and is not a fact the schema controls. GoTrue lets an
-- anonymous user become a permanent one — by adding an email address
-- where email sign-in is on, or linking an identity where manual linking
-- is on — and the agent's own credential is all it takes. The database
-- tests proved it on the development stack, which has email on: the next
-- token says `is_anonymous: false`.
--
-- From then on 008's answers were all wrong at once. The credential could
-- make itself a book (J16.1 undone), redeem any invite link it was handed
-- (J7.5 undone), and, removed from its book by its owner, it would no
-- longer be discarded (J16.7's "immediate and entire" undone), leaving a
-- permanent account behind that nobody meant to exist. Its membership row
-- still said 'agent', so the book it was placed in stayed as narrow as it
-- was — the escape was always sideways, into everything else.
--
-- Production has email sign-in, phone sign-in and manual linking off, and
-- the homelab stack now pins them off. That is why this was a gap and not
-- a breach. But a security rule that holds only while a setting in a
-- different system stays put is a rule about that setting, and the
-- schema is supposed to be the gate (J7.17).
--
-- So the question changes from "is this account anonymous" to "has this
-- account ever been placed as an agent", and the answer is written down
-- where conversion cannot touch it: a row in `agent_accounts`, made by
-- `add_agent` in the same step that places the agent, and gone only when
-- the account is.
--
-- Two of 008's checks keep asking about anonymity, on purpose:
--
--   * `add_agent` still requires the account it places to be anonymous.
--     That is the check that keeps a person from being conscripted
--     (J16.1, J7.5), and anonymity is exactly the right question there:
--     a converted agent fails it, which is a refusal, which is safe. It
--     additionally refuses anything that has ever been an agent and is not
--     already one in this book, so an agent belongs to one book for life
--     rather than to one book at a time.
--   * The create-book guard keeps its token check alongside the new one,
--     because an anonymous user that has not been placed yet — an agent
--     half made, or anybody calling signInAnonymously — is not an agent by
--     the new definition and must not get a book either.
--
-- handle_new_user's `if new.is_anonymous` is left alone: it runs once,
-- at signup, when the claim is still true.

-- ---------------------------------------------------------------------
-- 1. The record
-- ---------------------------------------------------------------------
--
-- In public because that is where every other table is, which means
-- PostgREST serves it: so RLS is on and there is no policy at all, and
-- the grants are taken away as well. Only the definer functions below
-- read or write it.

create table if not exists public.agent_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.agent_accounts enable row level security;
revoke all on public.agent_accounts from anon, authenticated;

-- Every agent placed before this file ran.
insert into public.agent_accounts (user_id)
  select distinct user_id from public.book_members where role = 'agent'
  on conflict do nothing;

-- ---------------------------------------------------------------------
-- 2. The question, asked one way everywhere
-- ---------------------------------------------------------------------
--
-- Definer, like is_book_agent beside it: authenticated cannot read
-- agent_accounts, and a policy body runs as the caller. The membership
-- clause is belt and braces — add_agent is the only way an agent row is
-- made and it writes both — so that an agent row put there by any other
-- route still counts.

create or replace function public.is_agent_user(uid uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from agent_accounts where user_id = uid)
      or exists (select 1 from book_members where user_id = uid and role = 'agent');
$$;

revoke execute on function public.is_agent_user(uuid) from anon, public;
grant execute on function public.is_agent_user(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3. No book of its own (008 §5), whatever its token says now
-- ---------------------------------------------------------------------

drop policy if exists "create own book" on public.books;
create policy "create own book" on public.books
  for insert to authenticated
  with check (
    owner = auth.uid()
    and not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
    and not public.is_agent_user(auth.uid())
  );

-- ---------------------------------------------------------------------
-- 4. Placing one: a person never, and an agent only once (008 §6)
-- ---------------------------------------------------------------------

create or replace function public.add_agent(book uuid, agent_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not is_book_owner(book) then
    raise exception 'only the owner of a book may add an agent to it';
  end if;

  -- A retried create, answered first: already here as an agent is the
  -- result this call wanted.
  if exists (
    select 1 from book_members
    where book_id = book and user_id = agent_id and role = 'agent'
  ) then
    return;
  end if;

  -- The conscription check, unchanged in meaning: only an anonymous
  -- account is nobody's. A converted agent fails it too, and is refused.
  if not exists (
    select 1 from auth.users where id = agent_id and is_anonymous is true
  ) then
    raise exception 'an agent is not a person''s account';
  end if;

  -- One book, for life. In a book now, or ever placed in one.
  if exists (select 1 from book_members where user_id = agent_id)
     or exists (select 1 from agent_accounts where user_id = agent_id) then
    raise exception 'that agent already belongs to a book';
  end if;

  insert into book_members (book_id, user_id, role)
    values (book, agent_id, 'agent')
    on conflict do nothing;
  insert into agent_accounts (user_id) values (agent_id)
    on conflict do nothing;
end;
$$;

revoke execute on function public.add_agent(uuid, uuid) from anon, public;
grant execute on function public.add_agent(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Removed is gone, converted or not (008 §6b, J16.7)
-- ---------------------------------------------------------------------
--
-- Still scoped to an account in no book at all, which is what makes it
-- safe for any signed-in caller to ask. A person was never anonymous and
-- was never placed as an agent, so neither clause can reach one; a
-- converted agent is in agent_accounts, so removing it still takes its
-- account with it.

create or replace function public.discard_orphan_agent(agent_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  delete from auth.users u
  where u.id = agent_id
    and (u.is_anonymous is true
         or exists (select 1 from agent_accounts a where a.user_id = u.id))
    and not exists (select 1 from book_members m where m.user_id = u.id);
end;
$$;

revoke execute on function public.discard_orphan_agent(uuid) from anon, public;
grant execute on function public.discard_orphan_agent(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. An invite is for a person, and an agent is not one (008 §6d, J7.5)
-- ---------------------------------------------------------------------
--
-- 008's body with one line changed: the anonymous check also refuses an
-- account that has ever been an agent.

create or replace function public.redeem_invite(invite_code text)
returns table (book_id uuid, book_name text)
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  inv record;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;

  -- An invite is something a person accepts (J7.5). A program is placed
  -- in a book by its owner and never arrives holding a link — including
  -- one whose account has since stopped being anonymous.
  if exists (
    select 1 from auth.users where id = auth.uid() and is_anonymous is true
  ) or is_agent_user(auth.uid()) then
    raise exception 'sign in first';
  end if;

  -- Lock the row: two people opening the last use of a link at the same
  -- moment must not both get in.
  select * into inv from invites
    where code = invite_code and expires_at > now()
    for update;
  if not found then
    raise exception 'invalid or expired invite';
  end if;

  -- Already a member — re-opening your own link, or a second device.
  -- Hand back the book without spending a use.
  if exists (
    select 1 from book_members m
    where m.book_id = inv.book_id and m.user_id = auth.uid()
  ) then
    return query select b.id, b.name from books b where b.id = inv.book_id;
    return;
  end if;

  if inv.used_count >= inv.max_uses then
    raise exception 'this invite has already been used';
  end if;

  insert into book_members (book_id, user_id, role)
    values (inv.book_id, auth.uid(), inv.role);
  update invites set used_count = used_count + 1 where code = inv.code;

  return query select b.id, b.name from books b where b.id = inv.book_id;
end;
$$;

revoke execute on function public.redeem_invite(text) from anon, public;
grant execute on function public.redeem_invite(text) to authenticated;
