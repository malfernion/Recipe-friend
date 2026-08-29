-- Migration 007 — a book you can read but not change
--
-- Run in the Supabase dashboard SQL Editor after 006.
--
-- Membership was binary. `book_members.role` existed, defaulted to
-- 'editor' and was checked against ('owner', 'editor') — but no policy
-- ever consulted it. `is_book_owner` reads books.owner, not the role, and
-- the recipes policy was one `for all` on plain membership. So the column
-- decided nothing: in a book meant read, write, edit and delete
-- everything in it, plus upload and remove its photos.
--
-- There was also no UPDATE policy on book_members at all, so even the
-- role that existed could never be changed. An owner's only lever over a
-- member was removal.
--
-- Three things, then: a third role that can read and not write, policies
-- that actually ask which one you hold, and a way to change it.
--
-- Ownership stays where it is — on books.owner, separate from the role
-- ladder. It is what every existing policy already trusts, and folding it
-- into the ladder would mean touching all of them for no visible gain.

-- ---------------------------------------------------------------------
-- 1. The role itself
-- ---------------------------------------------------------------------

alter table public.book_members drop constraint if exists book_members_role_check;
alter table public.book_members add constraint book_members_role_check
  check (role in ('owner', 'editor', 'viewer'));

-- Who may change what is in a book: its owner, or a member holding
-- 'owner' or 'editor'. Security definer for the same reason the other
-- helpers are — a policy on book_members must not re-enter book_members.
create or replace function public.is_book_editor(b uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from books where id = b and owner = auth.uid())
      or exists (
        select 1 from book_members
        where book_id = b and user_id = auth.uid() and role in ('owner', 'editor')
      );
$$;

revoke execute on function public.is_book_editor(uuid) from anon;
grant execute on function public.is_book_editor(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Reading and writing part company
-- ---------------------------------------------------------------------
--
-- One `for all` policy cannot say "everyone reads, some write", so it
-- becomes four: SELECT for any member, the rest for editors.

drop policy if exists "member recipes all" on public.recipes;

create policy "member recipes read" on public.recipes
  for select to authenticated using (is_book_member(book_id));
create policy "editor recipes insert" on public.recipes
  for insert to authenticated with check (is_book_editor(book_id));
create policy "editor recipes update" on public.recipes
  for update to authenticated
  using (is_book_editor(book_id)) with check (is_book_editor(book_id));
create policy "editor recipes delete" on public.recipes
  for delete to authenticated using (is_book_editor(book_id));

-- Photos follow their recipes: any member may look, only editors may
-- add, replace or remove. The path's first segment is the book, exactly
-- as migration 004 set it up.

drop policy if exists "book members upload photos" on storage.objects;
drop policy if exists "book members replace photos" on storage.objects;
drop policy if exists "book members remove photos" on storage.objects;

create policy "book editors upload photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'recipe-photos'
    and public.is_book_editor(((storage.foldername(name))[1])::uuid)
  );

create policy "book editors replace photos"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'recipe-photos'
    and public.is_book_editor(((storage.foldername(name))[1])::uuid)
  );

create policy "book editors remove photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'recipe-photos'
    and public.is_book_editor(((storage.foldername(name))[1])::uuid)
  );

-- ---------------------------------------------------------------------
-- 3. Moving, now that "member" is not the same as "may write"
-- ---------------------------------------------------------------------
--
-- 006 asked only that you belong to the book a recipe is going to. A
-- viewer belongs to books they cannot write to, so that is no longer the
-- question.

create or replace function public.move_recipe(
  recipe_id uuid,
  target_book uuid,
  new_id uuid,
  new_data jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  src record;
begin
  select * into src from recipes where id = recipe_id and deleted_at is null;
  if not found then
    raise exception 'that recipe is not here to move';
  end if;
  if not is_book_owner(src.book_id) then
    raise exception 'only the owner of a book may move recipes out of it';
  end if;
  if src.book_id = target_book then
    raise exception 'that recipe is already in that book';
  end if;
  if not is_book_editor(target_book) then
    raise exception 'you cannot add recipes to that book';
  end if;

  insert into recipes (id, book_id, data, updated_at)
    values (new_id, target_book, coalesce(new_data, src.data), now());

  update recipes
    set deleted_at = now(), updated_at = now()
    where id = recipe_id;

  return new_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Invites say what they are offering
-- ---------------------------------------------------------------------

alter table public.invites
  add column if not exists role text not null default 'editor'
  check (role in ('editor', 'viewer'));

-- An invite cannot hand out ownership: a book has exactly one owner, and
-- it is the person in books.owner.

-- 005's bodies, with one line changed in each: the role an invite grants
-- comes from the invite instead of being 'editor' by law, and the preview
-- says which. Everything else — the signed-in guard, the row lock that
-- stops two people spending the last use at once, the search path — is
-- kept exactly as it was rather than rewritten from memory.

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
    values (inv.book_id, auth.uid(), inv.role);
  update invites set used_count = used_count + 1 where code = inv.code;

  return query select b.id, b.name from books b where b.id = inv.book_id;
end;
$$;

drop function if exists public.preview_invite(text);
create function public.preview_invite(invite_code text)
returns table (book_name text, owner_name text, already_member boolean, role text)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
declare
  inv record;
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;
  select i.book_id, i.used_count, i.max_uses, i.role into inv
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
           ),
           inv.role
    from books b
    left join profiles p on p.user_id = b.owner
    where b.id = inv.book_id;
end;
$$;

-- The return type changed, so the old signature has to go first or
-- CREATE OR REPLACE refuses. Dropping is safe: nothing but the app calls
-- it, and the app is deployed with this.
revoke execute on function public.redeem_invite(text) from anon, public;
revoke execute on function public.preview_invite(text) from anon, public;
grant execute on function public.redeem_invite(text) to authenticated;
grant execute on function public.preview_invite(text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. An owner can change somebody's role
-- ---------------------------------------------------------------------
--
-- There was no UPDATE policy on book_members at all, so this was not
-- possible by any route. The `with check` is what stops the obvious
-- abuses: only the owner of the book may write here, the row must stay
-- in the same book, nobody may be made 'owner' through this door, and
-- the owner's own membership row cannot be demoted out from under them.

create policy "owner sets a member's role" on public.book_members
  for update to authenticated
  using (is_book_owner(book_id) and user_id <> auth.uid())
  with check (
    is_book_owner(book_id)
    and user_id <> auth.uid()
    and role in ('editor', 'viewer')
  );

-- A policy cannot compare the old row with the new one, and this one has
-- to: without the trigger below, an owner could keep the policy happy
-- while rewriting user_id — quietly putting somebody who never agreed to
-- anything into their book by editing a row that was already there. That
-- is the hole migration 005 was written to close, re-opened through a
-- different door. A membership row is one person in one book; only the
-- role they hold may change.

create or replace function public.book_members_role_only()
returns trigger
language plpgsql
as $$
begin
  if new.book_id is distinct from old.book_id
     or new.user_id is distinct from old.user_id then
    raise exception 'a membership row is one person in one book; only their role may change'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists book_members_role_only on public.book_members;
create trigger book_members_role_only
  before update on public.book_members
  for each row execute function public.book_members_role_only();
