-- Migration 003 — name a new user's first book after them (M3 follow-up)
--
-- Run in the Supabase dashboard SQL Editor after 002.
--
-- Why: "My recipes" reads as a system container, which makes people think
-- it is a special personal tier that cannot be shared. Every book is the
-- same kind of thing — one you own and may invite others into — so naming
-- the first one after its owner makes that obvious. Existing books are
-- untouched; owners can rename them in the app.

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

  -- "Dave's recipes" — the books.name check allows up to 80 characters.
  insert into books (name, owner)
    values (left(person, 60) || '''s recipes', new.id)
    returning id into b;

  insert into book_members (book_id, user_id, role) values (b, new.id, 'owner');
  return new;
end;
$$;
