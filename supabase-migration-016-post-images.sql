-- ============================================================
-- 016 — Photo attachments on Feed posts
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 +
-- 012 + 013 + 014 + 015.
--
-- Adds posts.image_url (set by the client after a successful upload to the
-- new "post-images" Storage bucket) and the bucket + RLS to allow it.
-- Links don't need a schema change — golsz-app.html auto-linkifies any
-- http(s) URL typed into a post's body text at render time.
-- ============================================================

alter table posts add column if not exists image_url text;

-- Public bucket (read is unauthenticated, same posture as posts_read
-- itself — "using (true)" — since Feed is public to any signed-in user
-- and images need to load in <img> tags without a signed request).
insert into storage.buckets (id, name, public)
values ('post-images', 'post-images', true)
on conflict (id) do nothing;

drop policy if exists post_images_read on storage.objects;
create policy post_images_read on storage.objects for select using (
  bucket_id = 'post-images'
);

-- Uploads must land under a path prefixed with the uploader's own user id
-- (golsz-app.html uploads to `${uid}/${filename}`) — this is what stops
-- one user from writing into another's "folder", not a real filesystem
-- permission, just a naming convention enforced by this policy.
drop policy if exists post_images_write on storage.objects;
create policy post_images_write on storage.objects for insert with check (
  bucket_id = 'post-images' and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists post_images_delete on storage.objects;
create policy post_images_delete on storage.objects for delete using (
  bucket_id = 'post-images' and (storage.foldername(name))[1] = auth.uid()::text
);

-- ============================================================
-- Done.
-- ============================================================
