-- 014 · An agent that puts a recipe on a list records it as planned (J18.21, J16.4)
--
-- Since lists, adding a recipe to a list is what "Last planned" records:
-- one row in `plans` per add (J18.21). 008 kept an agent out of `plans`
-- altogether, when a row there meant a finished week. Now a row means "a
-- recipe went on a list", and an agent putting one there is planning it
-- just as a person is, so it records it the same way (J16.4 as amended).
--
-- What changes is INSERT, in the agent's own book only. An agent still
-- cannot update a record (nobody can) or delete one (Undo is a person's),
-- and cannot touch another book's.
--
-- The roll-off from 013 (the oldest records go to keep a book at 2000)
-- ran BEFORE INSERT and as whoever inserted. Both were wrong once an
-- agent may insert:
--   * as the inserter, an agent's roll-off deleted nothing (it may not
--     delete), so the book grew past its quota;
--   * before the insert, it ran for rows that never went in: an insert
--     refused by the policies, or one that met `on conflict do nothing`,
--     still deleted the oldest record — a way to erase a book's history
--     one row at a time.
-- So it runs AFTER INSERT, for rows that were inserted and so passed the
-- policies, as the definer, keeping the new row.
--
-- Idempotent: a policy, a trigger and functions dropped or replaced.

drop policy if exists "agent plans insert" on public.plans;
create policy "agent plans insert" on public.plans
  for insert to authenticated with check (is_book_agent(book_id));

create or replace function public.roll_off_plans()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  excess integer;
begin
  select count(*) - 2000 into excess from plans where book_id = new.book_id;
  if excess > 0 then
    delete from plans
     where (book_id, id) in (
       select book_id, id from plans
        where book_id = new.book_id and id <> new.id
        order by completed_at asc, id asc
        limit excess
     );
  end if;
  return null;
end;
$$;

drop trigger if exists plans_quota on public.plans;
drop function if exists public.check_plan_quota();

drop trigger if exists plans_roll_off on public.plans;
create trigger plans_roll_off
  after insert on public.plans
  for each row execute function public.roll_off_plans();
