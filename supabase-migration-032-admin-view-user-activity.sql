-- ============================================================
-- 032 — Let admins view a specific user's daily activity
-- Additive on top of 002 + 004 + ... + 031.
--
-- Migration 031 deliberately kept daily_activity admin-visible only in
-- aggregate (via admin_analytics_counts()), the same way messages/
-- scout_history stay hidden row-by-row — those hold real private
-- content. daily_activity doesn't: a row is just "this user was active
-- for N minutes on this date," the same shape of presence information
-- profiles.created_at or is_banned already exposes to admins. There's
-- no reason to keep per-user daily minutes locked behind an aggregate
-- when an admin already sees far more sensitive fields (plan, ban
-- status, verified tier) directly on the same person.
--
-- This adds one admin-read policy so the Admin Panel's Users tab can
-- fetch a specific user's last 14 days of activity directly — same
-- direct-read pattern as profiles_admin_read, posts_read, follows_read.
-- Nothing else about daily_activity changes: writes still only happen
-- through record_activity_ping() (migration 031), still stamped to
-- auth.uid() only.
-- ============================================================

drop policy if exists daily_activity_admin_read on daily_activity;
create policy daily_activity_admin_read on daily_activity for select using (
  is_admin()
);

-- ============================================================
-- Done.
-- ============================================================
