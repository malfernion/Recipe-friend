-- Migration 012 — a book's lists (J18)
--
-- Run after 011. Safe to run twice.
--
-- One row per list. Its name and kind are columns; its items live in one
-- jsonb array that the client merges per item and per fact (js/lists.js),
-- the way live_plans.data is merged (007). Deleting a list leaves a
-- tombstone row (`deleted_at`), for two reasons: a phone that has not
-- heard about the delete must not push the list back, and a book whose
-- plan has already been moved into a "Shopping" list must not have it
-- moved in again after somebody deletes that list (the move only runs on
-- a book with no list rows at all).
--
-- Who may do what (J18.4, J18.25):
--   * every member reads every list in the book;
--   * editors and the owner make, rename and delete lists, and change
--     items;
--   * a viewer changes nothing;
--   * an agent changes items and nothing else — it cannot make, rename or
--     delete a list. RLS lets it UPDATE; the trigger below is what keeps
--     that UPDATE to the items column.
-- A list's kind never changes (J18.2) and it never changes book.

create table if not exists public.lists (
  id uuid primary key,
  book_id uuid not null references public.books (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  -- The client's stamp for the name, so two renames made offline settle
  -- the same way on every device (later wins).
  name_at bigint not null default 0,
  kind text not null check (kind in ('checklist', 'stock')),
  -- Bounded so a hostile client cannot use a book as storage. The
  -- client's caps keep a full list well inside it (js/lists.js).
  items jsonb not null default '[]'::jsonb
    check (jsonb_typeof(items) = 'array' and pg_column_size(items) <= 1000000),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  -- The server's own note of the last write. The client uses it to write
  -- only over the row it merged with (compare-and-set), so two phones
  -- saving at once cannot lose either's change.
  updated_at timestamptz not null default now()
);

create index if not exists lists_book_idx on public.lists (book_id);

-- ---------------------------------------------------------------------
-- What an update may change
-- ---------------------------------------------------------------------

create or replace function public.lists_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.book_id is distinct from old.book_id then
      raise exception 'a list belongs to its book'
        using errcode = 'check_violation';
    end if;
    if new.kind is distinct from old.kind then
      raise exception 'a list''s kind does not change'
        using errcode = 'check_violation';
    end if;
    -- An agent works on items, never on the list itself (J18.25).
    if is_book_agent(old.book_id) and not is_book_editor(old.book_id) and (
         new.name is distinct from old.name
      or new.name_at is distinct from old.name_at
      or new.deleted_at is distinct from old.deleted_at
      or new.created_at is distinct from old.created_at
    ) then
      raise exception 'an agent may change a list''s items, not the list'
        using errcode = '42501';
    end if;
    -- Deleted is final. A phone that had not heard pushes its copy
    -- quietly into the tombstone rather than failing for ever.
    if old.deleted_at is not null then
      new.deleted_at := old.deleted_at;
      new.name := old.name;
      new.name_at := old.name_at;
      new.items := '[]'::jsonb;
    end if;
    new.created_at := old.created_at;
  else
    new.created_at := now();
  end if;
  if new.deleted_at is not null then
    new.items := '[]'::jsonb;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists lists_guarded on public.lists;
create trigger lists_guarded
  before insert or update on public.lists
  for each row execute function public.lists_guard();

-- ---------------------------------------------------------------------
-- Who may read and write
-- ---------------------------------------------------------------------
--
-- No DELETE policy: a list is deleted by writing its tombstone, which is
-- an UPDATE an editor may make and an agent may not (above). The row
-- itself goes when its book does.

alter table public.lists enable row level security;

drop policy if exists "member lists read" on public.lists;
create policy "member lists read" on public.lists
  for select to authenticated using (is_book_member(book_id));

drop policy if exists "editor lists insert" on public.lists;
create policy "editor lists insert" on public.lists
  for insert to authenticated with check (is_book_editor(book_id));

drop policy if exists "editor or agent lists update" on public.lists;
create policy "editor or agent lists update" on public.lists
  for update to authenticated
  using (is_book_editor(book_id) or is_book_agent(book_id))
  with check (is_book_editor(book_id) or is_book_agent(book_id));

revoke all on public.lists from anon;

-- ---------------------------------------------------------------------
-- Keeping the lights on
-- ---------------------------------------------------------------------
--
-- 200 lists a book, tombstones included — far past any household, and
-- small enough that a book cannot be used as storage.

create or replace function public.check_list_quota()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (select count(*) from lists where book_id = new.book_id) >= 200 then
    raise exception 'this book has as many lists as it can hold';
  end if;
  return new;
end;
$$;

drop trigger if exists lists_quota on public.lists;
create trigger lists_quota
  before insert on public.lists
  for each row execute function public.check_list_quota();
