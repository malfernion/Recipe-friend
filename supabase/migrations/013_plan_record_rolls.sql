-- 013 · The record of what was planned rolls instead of filling up (J18.21)
--
-- 007 capped a book at 2000 recorded plans and refused the insert after
-- that, sized for a plan finished once a week. Since adding a recipe to a
-- list records it (J18.21), every add is a row, and a book that cooks
-- most nights reaches 2000 in a few years. A refusal then is no use to
-- anyone: the add has already happened on the list, and the record is only
-- a note of when something was planned. So at the quota the oldest rows
-- go to make room, and the book keeps the most recent 2000.
--
-- Idempotent: it replaces the one function the trigger from 007 calls.

create or replace function public.check_plan_quota()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  excess integer;
begin
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
