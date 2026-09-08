-- Migration 008 — a member that is a program, not a person (J16)
--
-- Run in the Supabase dashboard SQL Editor after 007.
--
-- A book owner can place an **agent** in a book: something that reads the
-- recipes, adds recipes, and works on the plan, so an assistant somewhere
-- else can answer "what have we not had in ages" and put next week
-- together. It is not a person, has no Google account and no email, and
-- it is removed from the same list that removes people.
--
-- The identity behind an agent is an **anonymous** Supabase user, created
-- by the app in the owner's browser. That one fact is what makes the rest
-- of this file safe, and it is worth saying why before any of it:
--
--   * It is a real row in auth.users with a real uuid, so `auth.uid()`
--     works and every policy already written governs it. Nothing here
--     invents a second way of deciding who may do what.
--   * It has no email and no password, so there is no fiction in the
--     member list and no account anybody could sign into.
--   * It is nobody's. That is what lets an owner *place* one in a book
--     without asking it first (J7.5 as amended): consent is owed to a
--     person, and there is no person here to owe it to. `add_agent`
--     below refuses anything that is not anonymous, and that single
--     check is what keeps 005's conscription hole shut.
--
-- Reads needed nothing. `is_book_member` reads book_members and
-- auth.uid() and nothing else, so a membership row is the whole of it —
-- which is why this file is mostly about writes. Storage is the one
-- exception, and it is the interesting one.
--
-- ---------------------------------------------------------------------
-- What a reviewer has to check by hand, in the dashboard
-- ---------------------------------------------------------------------
--
-- Row-level security is the security model and none of it is covered by
-- tests — `docs/journeys.md` says so at the end, and this file is inside
-- that gap. So after running this, in the dashboard:
--
--   a. As an **agent**, in its own book: select, insert, update and
--      delete on recipes all succeed, and so do insert, update and delete
--      on live_plans and insert and delete on plans. An agent writes what
--      an editor writes (J16.3) — anything less and its own sync parks,
--      which is what §3 explains.
--   b. As an **agent**, against a book it is not in: every select returns
--      nothing and every write is refused. No error, no rows — what a
--      policy that does not match looks like.
--   c. As an **agent**: selecting storage.objects for its own book
--      returns nothing, and asking for a signed URL on a photo path it
--      has been handed fails (J16.10).
--   d. As an **agent**: `insert into books (name, owner) values (…, auth.uid())`
--      is refused, and selecting books returns only the one it was placed
--      in. The credential cannot make itself a library no member list
--      will ever show.
--   e. As a **person**: creating a book still works. Check this one even
--      though it sounds absurd — the guard in §5 sits on the most
--      ordinary path in the app, and a guard that read auth.users instead
--      of the token would refuse everybody.
--   f. `add_agent` called by a non-owner raises. Called with a *permanent*
--      user's id raises. Called twice with the same agent and book, the
--      second is a quiet no-op. **Called by a second book's owner with an
--      agent that is already somebody's, it raises** — that one is §6's
--      whole point, and the roster hands every member the id it needs to
--      try it.
--   g. **Update an agent's membership row to 'editor'. It must raise.**
--      The policy alone allows this; the trigger in §6c is what refuses
--      it, and without that clause the role is worth nothing (J16.8).
--      Setting a person's role to 'agent' must raise too.
--   h. **Sign in anonymously and redeem a live invite code. It must
--      raise.** Anonymous sign-ins are on for this feature, and §6d is
--      what stops that turning every invite link into a way in for
--      anybody who holds one (J7.4, J7.5). Then redeem the same code as a
--      Google user and confirm it still works.
--   i. Deleting the agent's book_members row stops every read and write
--      in (a) immediately.
--   j. `discard_orphan_agent` on an agent that is still in a book does
--      nothing. On one removed from its book, it deletes the account.
--   k. Signed out (anon): unchanged, nothing.
--
-- ---------------------------------------------------------------------
-- 1. The role
-- ---------------------------------------------------------------------

alter table public.book_members drop constraint if exists book_members_role_check;
alter table public.book_members add constraint book_members_role_check
  check (role in ('owner', 'editor', 'viewer', 'agent'));

-- The predicate every write policy below consults. Definer for the same
-- reason is_book_member is: a policy on book_members must not re-enter
-- row-level security on book_members.
create or replace function public.is_book_agent(b uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from book_members
    where book_id = b and user_id = auth.uid() and role = 'agent'
  );
$$;

revoke execute on function public.is_book_agent(uuid) from anon, public;
grant execute on function public.is_book_agent(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Recipes: an agent may add one, and may not touch one that is there
-- ---------------------------------------------------------------------
--
-- Only the insert policy moves. Update stays editor-only, which is what
-- stops an agent editing a recipe somebody wrote — and, because a
-- favourite is a property of the recipe (J3.6), what stops it starring
-- one. Delete stays editor-only for the obvious reason.
--
-- This is the narrow half of J16.3 and it is the point of the role. It
-- costs something on the client, and the cost is paid there rather than
-- here: `pushRecipes` sends an upsert, which becomes an UPDATE the
-- moment the row exists, so a client syncing as an agent has to push
-- only rows the server has never seen. `js/sync.js` does exactly that,
-- and `docs/journeys.md` J16.3 records why the alternative — widening
-- this policy until nothing has to know — was refused.

drop policy if exists "editor recipes insert" on public.recipes;
create policy "editor recipes insert" on public.recipes
  for insert to authenticated
  with check (is_book_editor(book_id) or is_book_agent(book_id));

-- ---------------------------------------------------------------------
-- 3. The live plan: an agent may work on it
-- ---------------------------------------------------------------------
--
-- Insert and update, because a plan is one row per book and both are
-- needed: an upsert is what PostgREST sends, and 007 already records
-- that a missing one makes the first save work and every save after it
-- fail.
--
-- Update is also Clear (J16.5). Clearing a plan is writing an empty one
-- over the row, so granting the update that lets an agent settle a line
-- grants that too. It is allowed on purpose: Clear records nothing, so
-- the meals can go back and no history is written. If an agent is ever
-- cavalier with it the answer is a trigger refusing an is_book_agent
-- update that empties a plan which was not empty — noted so the door is
-- known to exist, not because it needs closing.
--
-- Delete stays editor-only. Nothing in the app deletes a live plan row.

drop policy if exists "editor live plan insert" on public.live_plans;
create policy "editor live plan insert" on public.live_plans
  for insert to authenticated
  with check (is_book_editor(book_id) or is_book_agent(book_id));

drop policy if exists "editor live plan update" on public.live_plans;
create policy "editor live plan update" on public.live_plans
  for update to authenticated
  using (is_book_editor(book_id) or is_book_agent(book_id))
  with check (is_book_editor(book_id) or is_book_agent(book_id));

-- `live_plans` delete is left editor-only. Nothing in the app deletes
-- that row — clearing a plan writes an empty one over it — so an agent
-- has no use for it.
--
-- `plans` is left alone entirely. An agent does not finish a plan
-- (J16.4) and does not undo one: the archive is the record it reads to
-- decide what to suggest, and a thing that writes its own evidence can
-- talk itself into anything. Both policies stay is_book_editor.
--
-- This one also costs the client something. `syncPlans` archives a
-- finished plan and replaces it in one pass, local half first, so a
-- client syncing as an agent must not take that branch — it would empty
-- its own live plan and then fail the push for ever. `js/sync.js` leaves
-- a finished plan alone for an agent and lets a person's device record
-- it, which is the same thing it already does for a viewer.

-- ---------------------------------------------------------------------
-- 4. Photos: the one read that was not free
-- ---------------------------------------------------------------------
--
-- Everything else in this file is about writes, because a membership row
-- carries every read. Storage is the exception and it is easy to miss:
-- 004 wrote the photo *read* policy against is_book_member, and 006
-- tightened only the three write policies to is_book_editor. Left alone,
-- a member whose role is 'agent' would still select storage.objects and
-- mint a signed URL for every photo in the book.
--
-- J16.10 says it may not, so the read policy learns about agents. The
-- three write policies need nothing: they are already is_book_editor,
-- which an agent is not.
--
-- A picture *linked* by public URL is a different thing and is not here
-- at all — it lives on the recipe, inside recipes.data, and no policy in
-- this file governs it. An agent bringing a recipe in from the web
-- brings that picture with it, the same way a share link does (J6.2).

drop policy if exists "book members read photos" on storage.objects;
create policy "book members read photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'recipe-photos'
    and public.is_book_member(((storage.foldername(name))[1])::uuid)
    and not public.is_book_agent(((storage.foldername(name))[1])::uuid)
  );

-- ---------------------------------------------------------------------
-- 5. An agent gets no book of its own
-- ---------------------------------------------------------------------
--
-- Any authenticated user may create a book, and an anonymous user is
-- authenticated — so without this the credential could make itself a
-- library no member list will ever show, own it, and write to it as
-- owner. J16.1 says an agent is a member and not an account; this is
-- where that stops being a wish.
--
-- It asks the **token**, not the table. `authenticated` holds no grant on
-- auth.users and a policy body runs as the caller, so a subquery against
-- that table here would raise permission denied for everybody creating a
-- book, a person included, and the most ordinary path in the app would
-- fail closed. Nothing in this schema has ever read auth.users from a
-- policy — the only reads of it are from handle_new_user, which is
-- definer and walks past the grant. `is_anonymous` is a top-level claim
-- on an anonymous session's token, so the answer is already in hand.
--
-- coalesce because a Google session's token carries no such claim at
-- all, and a missing claim is not an agent.

drop policy if exists "create own book" on public.books;
create policy "create own book" on public.books
  for insert to authenticated
  with check (
    owner = auth.uid()
    and not coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
  );

-- With no book of its own, an agent has nothing to rename or delete —
-- those policies are already owner-only and it owns nothing — and every
-- remaining write it can reach names a book_id that a policy checks.

-- ---------------------------------------------------------------------
-- 6. Placing one
-- ---------------------------------------------------------------------
--
-- book_members has no INSERT path for this. Migration 005 deliberately
-- left only "join a book you own", because the policy that allowed more
-- was how somebody could be put into a book they never agreed to. So
-- this is a definer function, and it carries the two checks that keep
-- that hole shut: the caller owns the book, and the thing being placed
-- is nobody.

create or replace function public.add_agent(book uuid, agent_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not is_book_owner(book) then
    raise exception 'only the owner of a book may add an agent to it';
  end if;

  -- The line the rest of this file rests on. An anonymous user is
  -- nobody's account, so placing one in a book takes nothing from
  -- anyone. A permanent user's id here would be 005's hole reopened
  -- through a new door.
  if not exists (
    select 1 from auth.users where id = agent_id and is_anonymous is true
  ) then
    raise exception 'an agent is not a person''s account';
  end if;

  -- An agent belongs to one book, and this is what makes that true
  -- rather than merely intended.
  --
  -- Every member of a book can read its roster, so every member can read
  -- an agent's id out of it. Without this, any of them could call this
  -- function against a book of their own — everybody owns the one their
  -- signup made — and attach somebody else's agent to it. The credential
  -- would then reach a book its owner cannot see and cannot revoke, and
  -- `resolveBook` picks between books by whatever order the server
  -- returns, so the household's recipes could sync into a stranger's.
  --
  -- Scoped to *any* book rather than this one on purpose. A retried
  -- create is the one case that lands here harmlessly, so it is answered
  -- first and separately: already in this book as an agent is the result
  -- this call wanted.
  if exists (
    select 1 from book_members
    where book_id = book and user_id = agent_id and role = 'agent'
  ) then
    return;
  end if;
  if exists (select 1 from book_members where user_id = agent_id) then
    raise exception 'that agent already belongs to a book';
  end if;

  insert into book_members (book_id, user_id, role)
    values (book, agent_id, 'agent')
    on conflict do nothing;
end;
$$;

-- Every function in "public" is a PostgREST endpoint and is executable
-- by everybody until told otherwise — 006 says the same about
-- move_recipe, and this pair is written rather than assumed.
revoke execute on function public.add_agent(uuid, uuid) from anon, public;
grant execute on function public.add_agent(uuid, uuid) to authenticated;

-- Removing one needs nothing new: "owner removes or self leaves" already
-- lets the owner delete any membership row in their book, and an agent's
-- is a membership row like any other (J16.7).
--
-- Changing one's role does need something new, and this file said the
-- opposite for a while. The claim was that "owner sets a member's role"
-- (006) already refuses it, because its `with check` constrains the new
-- role to 'editor' or 'viewer'. That is half the sentence: a `with
-- check` describes the row being written and cannot see the row being
-- replaced. So `update book_members set role = 'editor'` on an agent
-- satisfies `using` (the caller owns the book, it is not their own row)
-- and satisfies `with check` ('editor' is on the list), and succeeds.
--
-- What that gave away is the whole point of the role: a credential
-- handed to a program, widened in one request into a full editor — and
-- once the role is no longer 'agent', `is_book_agent` goes false and §4's
-- photo exclusion goes with it. The dialog offers no such control, but
-- this file has said from the top that the app hiding a button is a
-- courtesy and the database is the gate.
--
-- A policy is the wrong tool, because the question is about the old row.
-- The trigger 006 wrote for exactly that reason is the right one, so it
-- gains a clause. An agent is not a rung on the ladder in either
-- direction: changing one is removing it and adding another (J16.8).

create or replace function public.book_members_role_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.book_id is distinct from old.book_id
     or new.user_id is distinct from old.user_id then
    raise exception 'a membership row is one person in one book; only their role may change'
      using errcode = 'check_violation';
  end if;
  if old.role = 'agent' or new.role = 'agent' then
    raise exception 'an agent is not a role you change; remove it and add another'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists book_members_role_only on public.book_members;
create trigger book_members_role_only
  before update on public.book_members
  for each row execute function public.book_members_role_only();

-- ---------------------------------------------------------------------
-- 6b. Clearing up after ourselves
-- ---------------------------------------------------------------------
--
-- Making an agent is two steps: sign an anonymous account in, then place
-- it in the book. If the second fails — not the owner, a network blip, a
-- retry that raced itself — the first has already happened and there is
-- an account sitting there belonging to nobody and able to see nothing.
-- We made it, so we clear it up, in the moment rather than by a job that
-- runs on a Sunday.
--
-- Deleting from auth.users needs rights the app does not have and must
-- never be given, so this is definer and its scope is the whole of its
-- safety: an account that is anonymous *and* in no book at all. A person
-- has an identity and fails the first test. An agent in use fails the
-- second. There is nothing else it can reach, which is why it is safe to
-- let any signed-in caller ask for it.

create or replace function public.discard_orphan_agent(agent_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  delete from auth.users
  where id = agent_id
    and is_anonymous is true
    and not exists (select 1 from book_members where user_id = agent_id);
end;
$$;

revoke execute on function public.discard_orphan_agent(uuid) from anon, public;
grant execute on function public.discard_orphan_agent(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6d. An invite is for a person
-- ---------------------------------------------------------------------
--
-- This one is not about agents at all; it is the bill this feature ran
-- up elsewhere and has to pay before it ships.
--
-- Turning on anonymous sign-ins is a project-wide setting, and it is a
-- prerequisite for everything above. After it, anybody at all can call
-- signInAnonymously with the publishable key and be `authenticated` with
-- a real auth.uid(). `redeem_invite` (005, 006) asks only that the caller
-- is signed in — which, from the day it was written until now, meant a
-- person with a Google account.
--
-- So without this, an invite link stops being "good for one person" and
-- becomes good for anyone who has it, with no Google account and no
-- trail: sign in anonymously, redeem, and be an editor. That is J7.4 and
-- J7.5 undone by a setting in a different part of the dashboard, and it
-- would be undone for every book in the project, not only books with
-- agents in them.
--
-- An agent is placed by an owner (J16.2). Nothing anonymous joins a book
-- by holding a link.

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
  -- in a book by its owner and never arrives holding a link.
  if exists (
    select 1 from auth.users where id = auth.uid() and is_anonymous is true
  ) then
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

-- `preview_invite` is left alone. It reads a name and a role and joins
-- nobody to anything, so an anonymous caller learning that a link is live
-- costs nothing that redeeming it would not have cost more.

-- ---------------------------------------------------------------------
-- 7. No book for an anonymous signup
-- ---------------------------------------------------------------------
--
-- handle_new_user gives every new account a profile and a book named
-- after them. An agent wants the first and not the second: the profile
-- is what puts its name in the member list (002 lets co-members read
-- each other's display_name), and a book of its own is exactly what §5
-- is stopping.
--
-- This is not made redundant by that policy. The trigger is definer and
-- definer code walks straight past row-level security — the policy
-- guards the PostgREST door, this guards the trigger door, and both are
-- needed.

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  person text;
  b uuid;
begin
  person := coalesce(
    nullif(new.raw_user_meta_data ->> 'name', ''),
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    split_part(coalesce(new.email, 'cook'), '@', 1)
  );

  insert into profiles (user_id, display_name) values (new.id, left(person, 80));

  -- An agent is placed in somebody's book by its owner and has no use
  -- for one of its own (J16.1). It keeps the profile above, because that
  -- is where its name lives.
  if new.is_anonymous then
    return new;
  end if;

  -- "Dave's recipes" — the books.name check allows up to 80 characters.
  insert into books (name, owner)
    values (left(person, 60) || '''s recipes', new.id)
    returning id into b;

  insert into book_members (book_id, user_id, role) values (b, new.id, 'owner');
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. A trap, written where the person who springs it will be reading
-- ---------------------------------------------------------------------
--
-- Supabase do not clean up anonymous users, and their docs offer a query
-- for doing it yourself. That query matches on `is_anonymous is true`
-- and an age — which is exactly what every agent is, a fortnight after
-- it was made. Run it as written and every household's assistant loses
-- its credential on the same afternoon.
--
-- There is no such job here and there does not need to be: 6b clears up
-- the only orphans this app makes, at the moment it makes them. If one
-- is ever wanted anyway, the guard is the same one 6b uses — an agent in
-- a book is in use:
--
--   and not exists (select 1 from book_members where user_id = auth.users.id)
