-- Migration 004 — photos live in Storage, not in the recipe row (M4)
--
-- Run in the Supabase dashboard SQL Editor after 003.
--
-- Why: photos were embedded in recipes.data as base64 data URIs. That
-- inflates every row by ~33%, counts against the 500MB database
-- allowance, and pushes rows toward the size cap. Storage has its own
-- 1GB allowance, serves images over HTTP with caching, and - because the
-- resulting URLs are ordinary https links - lets share links carry a
-- photo, which data URIs never could.
--
-- Paths are "<book_id>/<recipe_id>.jpg", so membership of the book is
-- decidable from the path alone.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'recipe-photos',
  'recipe-photos',
  true,                                   -- see the note on public read below
  3145728,                                -- 3MB ceiling; the app compresses to ~150KB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Read is public. The path's first segment is a book id (a UUID) and the
-- second a recipe id, so URLs are unguessable, but anyone given one can
-- view that image - the same bargain share links already make. Writes are
-- another matter: only members of the owning book may add, replace or
-- remove a photo.
create policy "book members upload photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'recipe-photos'
    and public.is_book_member(((storage.foldername(name))[1])::uuid)
  );

create policy "book members replace photos"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'recipe-photos'
    and public.is_book_member(((storage.foldername(name))[1])::uuid)
  );

create policy "book members remove photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'recipe-photos'
    and public.is_book_member(((storage.foldername(name))[1])::uuid)
  );
