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
--   a. As an **agent**: select from recipes, live_plans and plans for its
--      book returns rows. `insert into recipes` succeeds. `update` and
--      `delete` on recipes are both refused — which is also what refuses
--      a favourite, since starring is an update (J16.3, and the boundary
--      note about an agent's taste). `insert` and `update` on live_plans
--      succeed.
--   b. As an **agent**: `insert into plans` is refused. This is J16.4 and
--      it is the one people will be tempted to "fix" — Done writes the
--      history the agent reads, so it stays a person's.
--   c. As an **agent**, against a book it is not in: every select returns
--      nothing and every write is refused. No error, no rows — what a
--      policy that does not match looks like.
--   d. As an **agent**: selecting storage.objects for its own book
--      returns nothing, and asking for a signed URL on a photo path it
--      has been handed fails (J16.10).
--   e. As an **agent**: `insert into books (name, owner) values (…, auth.uid())`
--      is refused, and selecting books returns only the one it was placed
--      in. The credential cannot make itself a library no member list
--      will ever show.
--   f. As a **person**: creating a book still works. Check this one even
--      though it sounds absurd — the guard in §5 sits on the most
--      ordinary path in the app, and a guard that reads auth.users
--      instead of the token would refuse everybody.
--   g. `add_agent` called by a non-owner raises. Called with a *permanent*
--      user's id raises — the most important line in this file. Called
--      twice with the same agent, the second call is a quiet no-op.
--   h. The roster update still refuses `role = 'agent'`, and still
--      refuses moving an agent to 'editor' (J16.8).
--   i. Deleting the agent's book_members row stops every read and write
--      in (a) immediately.
--   j. Signed out (anon): unchanged, nothing.
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

revoke execute on function public.is_book_agent(uuid) from anon;
grant execute on function public.is_book_agent(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Recipes: an agent may add one, and may not touch one that is there
-- ---------------------------------------------------------------------
--
-- Only the insert policy moves. Update stays editor-only, which is what
-- stops an agent editing a recipe somebody wrote — and, because a
-- favourite is a property of the recipe (J3.6), what stops it starring
-- one. Delete stays editor-only for the obvious reason.

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

-- `plans` is deliberately untouched. An agent does not finish a plan
-- (J16.4) and does not undo one: the archive is the record it reads to
-- decide what to suggest, and a thing that writes its own evidence can
-- talk itself into anything. Both policies stay is_book_editor.

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

  -- A retried create lands here with the row already saying 'agent',
  -- which is the answer rather than an error. A row saying anything
  -- else is an identity somebody added another way; leave it alone and
  -- say so, rather than quietly narrowing what it may do.
  if exists (
    select 1 from book_members
    where book_id = book and user_id = agent_id and role <> 'agent'
  ) then
    raise exception 'that account already belongs to this book';
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
-- Changing one's role needs nothing new either, and that is the point.
-- "owner sets a member's role" constrains the new role to 'editor' or
-- 'viewer', so it already refuses 'agent' — and an agent moved to
-- 'editor' would be a credential silently widened past what it was
-- handed over for. J16.8 is implemented by leaving that policy exactly
-- as it is, which is worth a sentence because the temptation on reading
-- this file is to add 'agent' to that list.

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
set search_path = public
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
-- If such a job is ever wanted, it needs no admin key to be safe, only
-- one more line:
--
--   delete from auth.users
--   where is_anonymous is true
--     and created_at < now() - interval '30 days'
--     and id not in (select user_id from book_members);
--
-- An agent that is in a book is in use. One that is in no book is the
-- orphan a failed `add_agent` leaves behind, and is what such a job
-- should be for.
