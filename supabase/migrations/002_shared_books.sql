-- Migration 002 — make shared books usable (M3)
--
-- Run this in the Supabase dashboard (SQL Editor -> New query -> Run)
-- after the initial supabase/schema.sql.
--
-- Why: the base policy lets a user read only their own profile row, so a
-- member list in a shared book would show no names. This adds a second,
-- additive SELECT policy allowing people who share a book to see each
-- other's display name. Policies are OR'd, so the original stays as-is.

-- Security definer: the membership lookup must not re-enter RLS on
-- book_members, which would recurse.
create or replace function public.shares_book_with(other uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1
    from book_members mine
    join book_members theirs on theirs.book_id = mine.book_id
    where mine.user_id = auth.uid()
      and theirs.user_id = other
  );
$$;

create policy "co-members read profiles" on public.profiles
  for select to authenticated
  using (shares_book_with(user_id));
