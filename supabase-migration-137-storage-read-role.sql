-- 137 — the two Storage read policies never named a role, so anon could
-- enumerate both buckets.
--
-- Migration 126 added `to authenticated` across the table policies but did not
-- touch storage.objects. avatars_read (029) and post_images_read (016) are
-- still `for select using (bucket_id = '...')` with no role clause, which in
-- Postgres means PUBLIC — so an unauthenticated client holding only the anon
-- key can LIST every object in both buckets. These are photographs of children.
--
-- WHAT THIS DOES AND DOES NOT CHANGE. Both buckets remain public: true, so a
-- direct fetch of /storage/v1/object/public/... still works and the avatar on
-- a shared Passport still loads for a coach who is not signed in. What stops
-- is ENUMERATION — walking the bucket to discover objects nobody linked you to.
-- That is the actual exposure here: the files were never secret, the index was.
--
-- Idempotent. Safe to re-run.
drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects for select to authenticated using (
  bucket_id = 'avatars'
);

drop policy if exists post_images_read on storage.objects;
create policy post_images_read on storage.objects for select to authenticated using (
  bucket_id = 'post-images'
);
