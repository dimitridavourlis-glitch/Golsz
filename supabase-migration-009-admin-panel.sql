-- ============================================================
-- 009 — Admin panel: broaden RLS for admins, add report resolution state
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008.
--
-- Reuses the existing is_admin() helper (migration 005) — this migration
-- only adds the extra read/write access an admin needs to actually run a
-- moderation panel, plus a resolved_at column so reports can be dismissed
-- without deleting the underlying post.
-- ============================================================

alter table post_reports add column if not exists resolved_at timestamptz;

-- admin can see every profile (user list in the admin panel) — additive
-- to whatever profiles_self already grants the owner.
drop policy if exists profiles_admin_read on profiles;
create policy profiles_admin_read on profiles for select using (is_admin());

-- admin can update any profile — the admin UI only ever writes is_admin
-- or plan, but RLS is row-level, not column-level, so this technically
-- allows any column. Same trust posture as posts_delete's is_admin()
-- bypass elsewhere in this schema: gate the capability, keep the UI narrow.
drop policy if exists profiles_admin_write on profiles;
create policy profiles_admin_write on profiles for update using (is_admin()) with check (is_admin());

-- admin can see restricted minors too (needed to moderate them)
drop policy if exists athletes_read on athletes;
create policy athletes_read on athletes for select using (
  not is_restricted_minor(id) or id = auth.uid() or is_parent_of(id) or is_admin()
);

-- admin can manage any event, not just their own
drop policy if exists events_update on events;
create policy events_update on events for update using (created_by = auth.uid() or is_admin());
drop policy if exists events_delete on events;
create policy events_delete on events for delete using (created_by = auth.uid() or is_admin());

-- admin can mark a report resolved (dismiss without deleting the post)
drop policy if exists post_reports_update on post_reports;
create policy post_reports_update on post_reports for update using (is_admin()) with check (is_admin());

-- ============================================================
-- Done. To make yourself admin (one-time, run once for your own account):
--   update profiles set is_admin = true where id =
--     (select id from auth.users where email = '<your-email>');
-- ============================================================
