-- Migration 005 — consent to join, self-service membership, single-use invites
--
-- Run in the Supabase dashboard SQL Editor after 004.
--
-- Three problems, one file.
--
-- 1. Membership could be forced on someone. "owner adds members"
--    constrained only *which book* a row landed in — not whose user_id was
--    in it, nor what role it claimed. Any signed-in user could create a
--    book and insert someone else's id into it as 'owner'. The victim woke
--    up in a book they never joined and could not leave (the app hides
--    Leave from owners), and the attacker gained a permanent read on their
--    profile, because 002 grants profile visibility to anyone who shares a
--    book with you — an ex-member's way back in. Membership is now
--    self-service: you may insert a row for yourself, as owner, in a book
--    you already own. That covers creating a book. Every other way in goes
--    through redeem_invite(), which is where consent is established.
--
-- 2. Invites were unlimited-use bearer tokens. redeem_invite() checked only
--    expiry: no use count, never consumed, and the app never read or
--    deleted the row, so there was no way to revoke one. A link forwarded
--    in a group chat handed full editor rights to whoever read it, for the
--    whole 7 days. Invites now carry max_uses (default 1) and used_count,
--    and the app can list and revoke them.
--
-- 3. search_path was pinned to "public" but did not exclude pg_temp, which
--    Postgres searches first for table lookups. check_book_quota() pinned
--    nothing at all. Not reachable through PostgREST — no endpoint here
--    creates temp tables — but it is what Supabase's own linter flags, and
--    it costs one line each.

-- ---------------------------------------------------------------------
-- 1. Membership is self-service
-- ---------------------------------------------------------------------

drop policy if exists "owner adds members" on public.book_members;

-- You may add exactly one person to a book: yourself, as its owner, and
-- only if you already own it. Joining someone else's book is redeem_invite's
-- job, and it is SECURITY DEFINER so it is not bound by this.
create policy "join a book you own" on public.book_members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and role = 'owner'
    and is_book_owner(book_id)
  );

-- ---------------------------------------------------------------------
-- 2. Invites are countable and revocable
-- ---------------------------------------------------------------------

alter table public.invites
  add column if not exists max_uses integer not null default 1
    check (max_uses between 1 and 50),
  add column if not exists used_count integer not null default 0
    check (used_count >= 0),
  add column if not exists created_at timestamptz not null default now();

-- Every invite that exists right now was minted under the old rules:
-- unlimited uses, no revoke path, seven days to run. Grandfathering those
-- in would leave the exact tokens this migration exists to stop. They are
-- cheap to replace — an owner mints a new one in two clicks — so they go.
-- Any outstanding invite link stops working the moment this file is run.
delete from public.invites;

-- 7 days is a long time for a bearer token that grants write access.
alter table public.invites alter column expires_at set default now() + interval '48 hours';

-- ---------------------------------------------------------------------
-- 3. What an invite says about itself, before you accept it
--
-- Definer, because the whole point is that a code alone is enough — the
-- holder has no read access to the book or its owner's profile yet. It
-- reveals only what someone needs in order to decide: which book, whose,
-- and whether they are already in it.
-- ---------------------------------------------------------------------

create or replace function public.preview_invite(invite_code text)
returns table (book_name text, owner_name text, already_member boolean)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  inv record;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  select i.book_id, i.used_count, i.max_uses into inv
    from invites i
    where i.code = invite_code and i.expires_at > now();
  if not found then
    raise exception 'invalid or expired invite';
  end if;
  if inv.used_count >= inv.max_uses then
    raise exception 'this invite has already been used';
  end if;
  return query
    select b.name,
           coalesce(nullif(p.display_name, ''), 'Someone'),
           exists (
             select 1 from book_members m
             where m.book_id = b.id and m.user_id = auth.uid()
           )
    from books b
    left join profiles p on p.user_id = b.owner
    where b.id = inv.book_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Redemption, now that a use is a finite thing to spend
-- ---------------------------------------------------------------------

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
    values (inv.book_id, auth.uid(), 'editor');
  update invites set used_count = used_count + 1 where code = inv.code;

  return query select b.id, b.name from books b where b.id = inv.book_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. search_path hardening
--
-- "public, pg_temp" forces the temp schema to be searched last, so a temp
-- table cannot shadow a real one inside a definer function.
-- ---------------------------------------------------------------------

alter function public.is_book_member(uuid) set search_path = public, pg_temp;
alter function public.is_book_owner(uuid) set search_path = public, pg_temp;
alter function public.shares_book_with(uuid) set search_path = public, pg_temp;
alter function public.handle_new_user() set search_path = public, pg_temp;
alter function public.check_book_quota() set search_path = public, pg_temp;

-- ---------------------------------------------------------------------
-- 6. Nothing here is for signed-out callers
--
-- Every function in "public" is exposed as a PostgREST RPC. The policy
-- helpers are evaluated as the querying role, so authenticated needs
-- EXECUTE on those; anon needs nothing at all.
-- ---------------------------------------------------------------------

revoke execute on function public.is_book_member(uuid) from anon;
revoke execute on function public.is_book_owner(uuid) from anon;
revoke execute on function public.shares_book_with(uuid) from anon;
revoke execute on function public.redeem_invite(text) from anon, public;
revoke execute on function public.preview_invite(text) from anon, public;
grant execute on function public.redeem_invite(text) to authenticated;
grant execute on function public.preview_invite(text) to authenticated;
