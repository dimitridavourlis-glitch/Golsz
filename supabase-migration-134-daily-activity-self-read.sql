-- ============================================================
-- 134) An athlete can read their OWN activity days.
--
-- daily_activity has been filling up since migration 031: record_activity_ping()
-- writes a row per user per day and the app calls it every minute the athlete
-- has GOLSZ open. RLS was enabled on the table and exactly ONE select policy
-- was ever created — daily_activity_admin_read (migration 032), gated on
-- is_admin(). Writes go through the security-definer RPC, so nothing broke and
-- nothing complained.
--
-- The consequence only surfaced on 2026-09-10, when Home started rendering a
-- four-week activity strip: an ADMIN account saw four weeks of real history,
-- and every ordinary athlete saw "No days logged yet" forever. The feature was
-- verified on an admin account, which is exactly the account that cannot
-- observe the bug — the first check I ran read profiles with no id filter and
-- came back with somebody else's row, which is how the account was misread as
-- non-admin in the first place.
--
-- This adds the missing self-read. It grants nothing beyond a user's own rows:
-- the admin policy is untouched and still covers the Admin Panel's
-- cross-athlete view, and there is deliberately still no authenticated INSERT
-- or UPDATE policy, so minutes can only ever be written by
-- record_activity_ping() and an athlete cannot inflate their own record.
-- ============================================================

drop policy if exists daily_activity_own_read on daily_activity;
create policy daily_activity_own_read on daily_activity for select using (
  user_id = auth.uid()
);
