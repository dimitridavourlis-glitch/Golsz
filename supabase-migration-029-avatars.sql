-- ============================================================
-- 029 — Profile photo (avatar) upload
-- Additive on top of 002 + 004 + ... + 028.
--
-- Same shape as post-images (migrations 016/017), just for a profile
-- photo instead of a Feed post attachment: its own Storage bucket
-- (public read, owner-only write, size/type limits baked in from the
-- start this time instead of a follow-up hardening migration), and the
-- URL lives on profiles.avatar_url.
--
-- avatar_url also needs to be on public_profile_names — same reasoning
-- as occupation (020) and verified_tier (025): an athlete viewing
-- someone ELSE's Passport needs to see their photo, not just their own.
-- CREATE OR REPLACE VIEW can add a new trailing column safely (unlike
-- renaming one, which needed a real drop+recreate back in migration
-- 025) since full_name/occupation/verified_tier keep their exact
-- existing positions/names.
--
-- No new column-protection needed in protect_profile_columns() —
-- avatar_url is a normal self-editable profile field, same bucket as
-- full_name, not an admin-only or payment-derived one like
-- is_admin/plan/verified_tier.
-- ============================================================

alter table profiles add column if not exists avatar_url text;

create or replace view public_profile_names as
select id, full_name, occupation, verified_tier, avatar_url from profiles;

grant select on public_profile_names to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 8388608, array['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects for select using (
  bucket_id = 'avatars'
);

drop policy if exists avatars_write on storage.objects;
create policy avatars_write on storage.objects for insert with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists avatars_update on storage.objects;
create policy avatars_update on storage.objects for update using (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
) with check (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete on storage.objects for delete using (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
);

-- ============================================================
-- Done.
-- ============================================================
