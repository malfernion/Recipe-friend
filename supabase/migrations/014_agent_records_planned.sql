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
-- The roll-off from 013 deletes the oldest rows to make room, and ran as
-- whoever inserted — so for an agent, which may not delete, it would
-- silently delete nothing and the book would grow past its quota. It runs
-- as the definer now, and only for somebody who may insert into that book:
-- a BEFORE trigger fires ahead of the policy check, so without the guard
-- an attempted insert into somebody else's book could delete their rows.
--
-- Idempotent: a policy dropped and made again, a function replaced.

drop policy if exists "agent plans insert" on public.plans;
create policy "agent plans insert" on public.plans
  for insert to authenticated with check (is_book_agent(book_id));

create or replace function public.check_plan_quota()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  excess integer;
begin
  -- Somebody the policies will refuse makes no room in a book that is not
  -- theirs; their insert fails after this, on its own.
  if not (is_book_editor(new.book_id) or is_book_agent(new.book_id)) then
    return new;
  end if;
  select count(*) - 1999 into excess from plans where book_id = new.book_id;
  if excess > 0 then
    delete from plans
     where (book_id, id) in (
       select book_id, id from plans
        where book_id = new.book_id
        order by completed_at asc, id asc
        limit excess
     );
  end if;
  return new;
end;
$$;
