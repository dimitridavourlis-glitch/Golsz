-- ============================================================
-- 017 — Close two gaps in post-images (migration 016)
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 +
-- 012 + 013 + 014 + 015 + 016.
--
-- 1) post_images_write only checked "are you uploading into your own
--    folder" — it never checked is_restricted_minor(), unlike posts_write
--    (which already blocks a restricted minor from creating a post at
--    all). That meant a restricted minor could still upload a file to the
--    public bucket and get a real public URL, even though it could never
--    be attached to a post they're allowed to create. Now matches
--    posts_write's posture exactly.
-- 2) The 8MB size cap and "must be an image" check only existed in
--    golsz-app.html's client-side pickImage() — nothing stopped someone
--    from calling the Storage API directly with their own credentials and
--    uploading a larger or non-image file. Storage buckets support real
--    server-side limits (file_size_limit, allowed_mime_types); set here so
--    the client-side check becomes a courtesy/UX nicety, not the only gate.
-- ============================================================

update storage.buckets
set file_size_limit = 8388608, -- 8MB, matches golsz-app.html's pickImage() check
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif']
where id = 'post-images';

drop policy if exists post_images_write on storage.objects;
create policy post_images_write on storage.objects for insert with check (
  bucket_id = 'post-images'
  and (storage.foldername(name))[1] = auth.uid()::text
  and not is_restricted_minor(auth.uid())
);

-- ============================================================
-- Done.
-- ============================================================
