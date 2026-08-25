-- Recipe Friend — Supabase schema, RLS policies, and functions (M1)
--
-- Run this once in the Supabase dashboard: SQL Editor -> New query ->
-- paste the whole file -> Run. It is idempotent-ish for a fresh project;
-- re-running on a project that already has these objects will error on
-- the CREATEs, which is fine — this file is the source of truth and
-- future changes ship as new migration files.
--
-- Model: anyone can sign in (Google), but every table is locked down by
-- row-level security. A user sees only books they are a member of.

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 80),
  unit_prefs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.books (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  owner uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.book_members (
  book_id uuid not null references public.books (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'editor' check (role in ('owner', 'editor')),
  created_at timestamptz not null default now(),
  primary key (book_id, user_id)
);

create table public.recipes (
  id uuid primary key,
  book_id uuid not null references public.books (id) on delete cascade,
  data jsonb not null check (pg_column_size(data) <= 1200000), -- ~1.2MB: recipe + one compressed photo
  updated_at timestamptz not null default now(),
  deleted_at timestamptz, -- tombstone: deletes must not resurrect from another device's cache
  created_at timestamptz not null default now()
);

create index recipes_book_idx on public.recipes (book_id, updated_at desc);

create table public.invites (
  code text primary key default encode(gen_random_bytes(9), 'base64'),
  book_id uuid not null references public.books (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null default now() + interval '7 days'
);

-- ---------------------------------------------------------------------
-- Helper: membership check usable inside policies without recursion
-- ---------------------------------------------------------------------

create or replace function public.is_book_member(b uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from book_members
    where book_id = b and user_id = auth.uid()
  );
$$;

create or replace function public.is_book_owner(b uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from books where id = b and owner = auth.uid()
  );
$$;

-- ---------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.books enable row level security;
alter table public.book_members enable row level security;
alter table public.recipes enable row level security;
alter table public.invites enable row level security;

-- profiles: each user handles only their own row
create policy "own profile read" on public.profiles
  for select to authenticated using (user_id = auth.uid());
create policy "own profile update" on public.profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- books: members see them; any signed-in user may create; only owners change them
create policy "member book read" on public.books
  for select to authenticated using (is_book_member(id) or owner = auth.uid());
create policy "create own book" on public.books
  for insert to authenticated with check (owner = auth.uid());
create policy "owner book update" on public.books
  for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner book delete" on public.books
  for delete to authenticated using (owner = auth.uid());

-- book_members: members see the roster; owners manage it; anyone may leave
create policy "member roster read" on public.book_members
  for select to authenticated using (is_book_member(book_id));
create policy "owner adds members" on public.book_members
  for insert to authenticated with check (is_book_owner(book_id));
create policy "owner removes or self leaves" on public.book_members
  for delete to authenticated using (is_book_owner(book_id) or user_id = auth.uid());

-- recipes: the whole point — members only, for everything
create policy "member recipes all" on public.recipes
  for all to authenticated
  using (is_book_member(book_id))
  with check (is_book_member(book_id));

-- invites: only the book owner sees or manages them (redemption is the RPC below)
create policy "owner invites all" on public.invites
  for all to authenticated
  using (is_book_owner(book_id))
  with check (is_book_owner(book_id) and created_by = auth.uid());

-- ---------------------------------------------------------------------
-- New-user bootstrap: profile + personal book on first sign-in
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  b uuid;
begin
  insert into profiles (user_id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(coalesce(new.email, 'cook'), '@', 1))
  );
  insert into books (name, owner) values ('My recipes', new.id) returning id into b;
  insert into book_members (book_id, user_id, role) values (b, new.id, 'owner');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- Invite redemption: runs as definer so a code alone (no read access to
-- anything) is enough to join, after validation
-- ---------------------------------------------------------------------

create or replace function public.redeem_invite(invite_code text)
returns table (book_id uuid, book_name text)
language plpgsql security definer
set search_path = public
as $$
declare
  inv record;
begin
  select * into inv from invites
    where code = invite_code and expires_at > now();
  if not found then
    raise exception 'invalid or expired invite';
  end if;
  insert into book_members (book_id, user_id, role)
    values (inv.book_id, auth.uid(), 'editor')
    on conflict do nothing;
  return query select b.id, b.name from books b where b.id = inv.book_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Guardrail: cap recipes per book so no single account can soak the
-- free tier (adjust freely; 2000 is far beyond household scale)
-- ---------------------------------------------------------------------

create or replace function public.check_book_quota()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from recipes where book_id = new.book_id and deleted_at is null) >= 2000 then
    raise exception 'this recipe book is full (2000 recipes)';
  end if;
  return new;
end;
$$;

create trigger recipes_quota
  before insert on public.recipes
  for each row execute function public.check_book_quota();
