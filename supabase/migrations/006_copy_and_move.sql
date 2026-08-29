-- Migration 006 — a recipe's book is fixed; moving is copy-then-delete
--
-- Run in the Supabase dashboard SQL Editor after 005.
--
-- Two problems, one cause.
--
-- 1. A move left no trace in the book it left.
--
--    Moving patched book_id on the same row, and the client then dropped
--    its local copy without a tombstone — deliberately, because a
--    tombstone carries the recipe's id and would have deleted it in its
--    new home too. But every *other* member of the old book still holds
--    that recipe in their cache, and reconciliation is last-write-wins
--    per id: their next sync finds no such row in their book, decides
--    their local copy is the newer one, and pushes it back. The recipe
--    lands wherever the last device to sync put it.
--
-- 2. The same upsert let a recipe be dragged between books by accident.
--
--    Every push sends {id, book_id, ...} and upserts on the primary key.
--    Saving a recipe whose id already belongs to another book therefore
--    rewrote that row's book_id rather than creating anything. A share
--    link opened into a second book was enough to do it.
--
-- Both follow from book_id being mutable, so it is not any more. A recipe
-- belongs to the book it was created in, for life. Moving one now means
-- inserting a copy under a new id and tombstoning the original — which
-- the existing tombstone machinery already propagates correctly, because
-- the id being tombstoned is genuinely finished.
--
-- Moving is also an owner's act from here on. It removes the recipe from
-- a book everyone else is reading, which is not something a guest should
-- do by tapping the wrong control. Note the limit honestly: an editor can
-- still copy a recipe and then delete the original, because editors may
-- delete (J7.3). This makes moving deliberate, not impossible.

-- ---------------------------------------------------------------------
-- 1. A recipe does not change book
-- ---------------------------------------------------------------------

create or replace function public.recipes_book_is_fixed()
returns trigger
language plpgsql
as $$
begin
  if new.book_id is distinct from old.book_id then
    raise exception
      'a recipe cannot change book (%, to %): copy it and delete the original',
      old.book_id, new.book_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists recipes_book_immutable on public.recipes;
create trigger recipes_book_immutable
  before update on public.recipes
  for each row execute function public.recipes_book_is_fixed();

-- ---------------------------------------------------------------------
-- 2. Moving, as one indivisible step
-- ---------------------------------------------------------------------
--
-- Security definer because it writes two rows in two books and must
-- either do both or neither. That bypasses row-level security, so every
-- check the policies would have made is made here instead, explicitly:
-- the caller owns the book the recipe is leaving, and belongs to the one
-- it is going to.
--
-- The new id and the new data come from the caller: the client has to
-- know the id to file the photo under it, and the data carries the new
-- photo path. A colliding id fails on the primary key, which is the
-- right answer.

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
  if not is_book_member(target_book) then
    raise exception 'you are not a member of that book';
  end if;

  -- The copy first: if this fails, nothing has been lost.
  insert into recipes (id, book_id, data, updated_at)
    values (new_id, target_book, coalesce(new_data, src.data), now());

  -- Then the original goes, as a tombstone the other members will see.
  update recipes
    set deleted_at = now(), updated_at = now()
    where id = recipe_id;

  return new_id;
end;
$$;

revoke execute on function public.move_recipe(uuid, uuid, uuid, jsonb) from anon, public;
grant execute on function public.move_recipe(uuid, uuid, uuid, jsonb) to authenticated;

-- Copying needs no function of its own: it is an ordinary insert into a
-- book you belong to, which "member recipes all" already allows, and the
-- per-book quota trigger already counts.
