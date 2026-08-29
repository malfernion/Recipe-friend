-- Migration 007 — the plan a book is shopping for, and the plans it finished
--
-- Run in the Supabase dashboard SQL Editor after 006. One file for the
-- whole meal-planner feature: later parts of it append here rather than
-- arriving as 008, 009, so there is one thing to run and one thing to
-- verify.
--
-- Two tables, and the difference between them is the whole design.
--
-- 1. `live_plans` holds the plan being built, keyed by book_id. The
--    primary key IS the book, so "one live plan per book" (J12.2) is true
--    by construction rather than by convention. That matters offline: two
--    devices each editing the plan with no network do not come back with
--    two plans and a question about which one is live — they come back
--    with two versions of one row, which is a merge the client already
--    knows how to do (J12.11).
--
-- 2. `plans` holds the finished ones (J14.1). A row is written once, when
--    Done is pressed, and never updated afterwards — so there is no
--    reconciliation to get wrong and no such thing as a conflicting
--    archive row. The client reconciles it by comparing ids: the server
--    has some it lacks, it has some the server lacks, and both sides are
--    right. The row's id is the plan's own id, which is what makes
--    pressing Done twice — two devices, or a retry after a half-failed
--    completion — a duplicate key rather than a plan counted twice
--    (J14.10 counts every appearance, so a double insert would be a lie).
--
-- Clearing a plan (J14.4) needs no tombstone, and that is worth spelling
-- out against J9.4, which is emphatic that deletes must travel as
-- tombstones. A deleted *recipe* needs one because recipes are a set of
-- rows keyed by id: the row's absence is what has to travel, and an
-- absence carries no timestamp for a stale cache to lose against. A
-- cleared plan deletes nothing. It overwrites one row that always exists
-- with an empty plan bearing a later stamp and a new id, and the merge
-- compares stamps. There is no absence anywhere, so there is nothing for
-- a tombstone to say.
--
-- That holds *because the client treats a new plan id as a new plan*. It
-- did not hold before this increment: `mergePlans` merged settled amounts
-- per item whatever plan they came from, so a device holding yesterday's
-- cleared plan put its "we have onions" straight back into the fresh one
-- — a resurrection of exactly the kind J9.4 warns about, arriving through
-- the settlements rather than the meals. js/plan.js now takes the later
-- `createdAt` whole when two ids differ.
--
-- Nothing here is exported (J10, boundaries): planning history lives in
-- these two tables and does not travel with a backup.
--
-- ---------------------------------------------------------------------
-- What a reviewer has to check by hand, in the dashboard
-- ---------------------------------------------------------------------
--
-- Row-level security is the security model and none of it is covered by
-- tests — `docs/journeys.md` says so at the end, and this file is inside
-- that gap. So after running this, in the dashboard:
--
--   a. Table editor → live_plans and plans both show "RLS enabled". A
--      table with policies and RLS off is wide open and looks fine.
--   b. As a **viewer** of somebody else's book (book_members.role =
--      'viewer'): selecting from live_plans and plans for that book
--      returns rows, and every write is refused —
--        insert into live_plans …        -> refused
--        update live_plans set data = …  -> refused (0 rows / policy)
--        insert into plans …             -> refused
--        delete from plans …             -> refused
--      This is J12.10 and J7.17, and it is the same gate 006 put on
--      recipes: is_book_editor, not is_book_member.
--   c. As an **editor**: all four succeed for their own book, and none of
--      them succeed against a book they are not in.
--   d. Signed out (anon): both tables return nothing at all.
--   e. Insert the same plan id into `plans` twice — the second is a
--      duplicate key error, not a second row. The client depends on this
--      to make a retried Done idempotent.
--   f. Try `update live_plans set book_id = <another book you edit>` —
--      refused by the trigger below, the same way a recipe cannot change
--      book (006).
--
-- ---------------------------------------------------------------------
-- 1. The plan being built: one row per book
-- ---------------------------------------------------------------------

create table if not exists public.live_plans (
  book_id uuid primary key references public.books (id) on delete cascade,
  -- The whole plan: meals, and the amounts settled against each item.
  -- Bounded well above a household week — 200 meals and 500 settled
  -- lines — so a hostile client cannot use a book as storage.
  data jsonb not null check (pg_column_size(data) <= 200000),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- The row's own `updated_at` is for people reading the table; the merge
-- itself runs on the stamps inside `data`, because a settlement carries
-- its own moment and merges per item (J12.11). A single column cannot
-- express that, and a column that looked as though it could would be
-- worse than none. So the server keeps it, rather than taking a client's
-- word for a number the client does not use.

create or replace function public.live_plans_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists live_plans_touched on public.live_plans;
create trigger live_plans_touched
  before update on public.live_plans
  for each row execute function public.live_plans_touch();

-- ---------------------------------------------------------------------
-- 2. The plans that were finished
-- ---------------------------------------------------------------------

create table if not exists public.plans (
  -- The plan's own id, so completing the same plan twice collides here
  -- instead of being counted twice (J14.10).
  id uuid primary key,
  book_id uuid not null references public.books (id) on delete cascade,
  data jsonb not null check (pg_column_size(data) <= 200000),
  -- The date the plan was finished, which is what "Planned 3 weeks ago"
  -- says (J14.5) — never a date anything was cooked.
  completed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists plans_book_idx on public.plans (book_id, completed_at desc);

-- ---------------------------------------------------------------------
-- 3. A plan belongs to its book, for life
-- ---------------------------------------------------------------------
--
-- 006 learnt this the expensive way on recipes: a mutable book_id let an
-- ordinary upsert drag a row between books. `plans` cannot be updated at
-- all (there is no UPDATE policy below), so it needs no trigger. The live
-- row can, so it gets one.

create or replace function public.live_plans_book_is_fixed()
returns trigger
language plpgsql
as $$
begin
  if new.book_id is distinct from old.book_id then
    raise exception 'a plan belongs to its book (%, to %)', old.book_id, new.book_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists live_plans_book_immutable on public.live_plans;
create trigger live_plans_book_immutable
  before update on public.live_plans
  for each row execute function public.live_plans_book_is_fixed();

-- ---------------------------------------------------------------------
-- 4. Who may read, and who may write
-- ---------------------------------------------------------------------
--
-- Exactly the shape 006 gave recipes: SELECT for any member, everything
-- else for editors. A plan is the book's (J12.2), so adding to it is a
-- write, and a read-only member has no planner (J12.10, J7.17) — the
-- same rule that stops them favouriting.
--
-- An upsert needs INSERT *and* UPDATE to be allowed, so both are here:
-- the client writes the live row with one upsert on book_id, and a
-- missing UPDATE policy would make the first save of a book's plan work
-- and every save after it fail.

alter table public.live_plans enable row level security;
alter table public.plans enable row level security;

create policy "member live plan read" on public.live_plans
  for select to authenticated using (is_book_member(book_id));
create policy "editor live plan insert" on public.live_plans
  for insert to authenticated with check (is_book_editor(book_id));
create policy "editor live plan update" on public.live_plans
  for update to authenticated
  using (is_book_editor(book_id)) with check (is_book_editor(book_id));
create policy "editor live plan delete" on public.live_plans
  for delete to authenticated using (is_book_editor(book_id));

create policy "member plans read" on public.plans
  for select to authenticated using (is_book_member(book_id));
create policy "editor plans insert" on public.plans
  for insert to authenticated with check (is_book_editor(book_id));

-- There is deliberately no UPDATE policy on `plans`. An archived plan is
-- a record of something that happened; nothing in the app edits one, and
-- a row nobody can update is a row two devices cannot disagree about.
--
-- DELETE is allowed, and has one caller: Undo, offered in the moment
-- after Done (J14.2). Taking the record back is the whole of what Undo
-- means, and an editor who may delete a recipe may certainly delete a
-- shopping trip. A viewer may not, like everything else here.
create policy "editor plans delete" on public.plans
  for delete to authenticated using (is_book_editor(book_id));

-- Nothing here is for the signed-out. The policies above are all `to
-- authenticated`, so anon matches none of them and sees nothing; the
-- revoke says the same thing a second time, where a reader looking for it
-- will find it.
revoke all on public.live_plans from anon;
revoke all on public.plans from anon;

-- ---------------------------------------------------------------------
-- 5. Keeping the lights on
-- ---------------------------------------------------------------------
--
-- The same guardrail schema.sql put on recipes, for the same reason: no
-- single account should be able to soak the free tier. 2000 archived
-- plans is roughly forty years of weekly shopping.

create or replace function public.check_plan_quota()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (select count(*) from plans where book_id = new.book_id) >= 2000 then
    raise exception 'this book has recorded as many plans as it can hold';
  end if;
  return new;
end;
$$;

drop trigger if exists plans_quota on public.plans;
create trigger plans_quota
  before insert on public.plans
  for each row execute function public.check_plan_quota();
