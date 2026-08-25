-- Migration 004 — photos live in Storage, not in the recipe row (M4)
--
-- Run in the Supabase dashboard SQL Editor after 003.
--
-- Why: photos were embedded in recipes.data as base64 data URIs. That
-- inflates every row by ~33%, spends the 500MB database allowance on
-- images, and pushes rows toward the size cap. Storage has its own 1GB
-- allowance and serves images properly.
--
-- The bucket is PRIVATE: nothing in it is readable without a token, and
-- the app asks for a short-lived signed URL each time it shows a photo.
-- Paths are "<book_id>/<recipe_id>.jpg", so membership of the owning book
-- is decidable from the path alone and every policy reuses is_book_member.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'recipe-photos',
  'recipe-photos',
  false,                                  -- private: no anonymous reads
  3145728,                                -- 3MB ceiling; the app compresses to ~150KB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Reading is what signing a URL requires, so members need select too.
create policy "book members read photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'recipe-photos'
    and public.is_book_member(((storage.foldername(name))[1])::uuid)
  );

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
