-- ============================================================
-- 162 — An admin is only an admin on a session that passed a second factor.
--
-- *** NOT YET APPLIED ***  (written 2026-10-22; the owner runs it by hand)
--
-- WHY. A stolen admin password, or a stolen session, was a stolen platform:
-- is_admin() answered true on the strength of `profiles.is_admin` alone, and
-- 51 migrations' policies and functions lean on that one answer.
--
-- WHAT IT DOES. is_admin() now also requires the session's token to carry
-- `aal` = 'aal2', which Supabase Auth issues only after a TOTP code has been
-- verified in that session. Everything that asks is_admin() (every admin RLS
-- policy, the profiles trigger exemption, every admin_* RPC) inherits it with
-- no further edit. An admin on a password-only session is treated as an
-- ordinary athlete by the database.
--
-- !! DO NOT RUN THIS BEFORE YOU HAVE ENROLLED AN AUTHENTICATOR !!
-- Until you have, running it turns you into an ordinary user: the Admin Panel
-- loads nothing. Order:
--   1. Supabase dashboard, Authentication, Multi-Factor: TOTP enabled.
--   2. Ship the code from the same branch as this file (the Admin Panel's
--      "set up your authenticator" screen and the API's aal2 check).
--   3. Open the Admin Panel, scan the QR code, enter the code. It then opens.
--   4. Only now run this file.
--
-- RECOVERY if you lose the authenticator. Enrolling a factor needs only a
-- normal session, so signing in and enrolling a second one is not blocked, but
-- you cannot reach the panel until it is verified. If you cannot verify any:
-- in the SQL Editor (it is exempt, auth.role() is null) run
--     delete from auth.mfa_factors where user_id = '<your-uuid>';
-- then enrol again. Or temporarily restore migration 126's one-line is_admin().
--
-- SCOPE. The service role, the SQL Editor and api/*.js reads of
-- profiles.is_admin are unchanged (they carry no session). api/admin-user-action.js
-- checks the token's `aal` itself.
--
-- HOW TO APPLY. Paste into the SQL Editor and run once. Idempotent.
-- ============================================================

begin;

create or replace function is_admin()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false)
     and coalesce(auth.jwt() ->> 'aal', '') = 'aal2';
$$;

commit;


-- ============================================================
-- 162 — Verification. Run these AFTER the migration, separately.
-- ============================================================
--
-- 1) Signed in to the app as the owner WITH the second factor verified this
--    session: the Admin Panel loads users and stats.
-- 2) Sign out, sign in with the password only, open the Admin Panel: it must
--    ask for the code and load nothing until you give it.
-- 3) From the SQL Editor (no session) the answer is false, as it always was:
--      select is_admin();   -- false
-- ============================================================
