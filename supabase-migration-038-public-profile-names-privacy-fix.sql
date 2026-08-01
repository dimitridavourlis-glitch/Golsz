-- ============================================================
-- 038 — Close a real privacy leak in public_profile_names
-- Found during a full security audit. Additive/corrective on top of
-- every prior migration; only touches the public_profile_names view.
--
-- public_profile_names (first created in migration 020, last redefined
-- in migration 029 to add avatar_url) is a plain
--   select id, full_name, occupation, verified_tier, avatar_url from profiles
-- with no WHERE clause, granted to BOTH anon and authenticated. It exists
-- because profiles itself has no general cross-user read policy (only
-- profiles_self and the admin policies) — the view is the sanctioned,
-- deliberately narrow "just enough columns to show someone else's name/
-- photo" bypass, used everywhere the app needs to resolve another user's
-- display name (Feed authors, Discover, Messages senders, Passport,
-- follower lists, admin panel).
--
-- The bug: a Postgres view with no `security_invoker` runs as its OWNER,
-- which bypasses the underlying table's RLS entirely — so this view was
-- never subject to is_restricted_minor()'s gating, unlike every other
-- read path in this app (profiles_read, athletes_read, Discover, etc.).
-- Combined with the `anon` grant, this meant a completely unauthenticated
-- request could read every real user's full_name, occupation,
-- verified_tier, and avatar_url — including a restricted minor (someone
-- whose parent hasn't approved them yet), whose whole point is to be
-- invisible outside their own session and their linked parent's. Verified
-- live via a plain curl with the public anon key before this fix: the
-- base `profiles` table correctly returned [] for the same anon request,
-- but the view returned every row.
--
-- Fix, mirroring the exact `not is_restricted_minor(id) or id = auth.uid()
-- or is_parent_of(id) or is_admin()` shape already used by profiles_read/
-- athletes_read elsewhere in this schema:
--   1. Add that filter to the view itself, so a restricted minor's name/
--      photo simply doesn't resolve through this path either (their own
--      profile view doesn't use this view at all — see golsz-app.html's
--      Passport.load(), which only queries public_profile_names in the
--      `other` branch — so this filter never affects viewing your own
--      profile as yourself).
--   2. Drop the `anon` grant entirely. Every real call site in
--      golsz-app.html only ever queries this view from inside the
--      authenticated app (Feed/Discover/Messages/Passport/Admin) — there
--      is no logged-out screen that needs it. api/send-push.js's usage is
--      via the service-role key, which bypasses view grants/RLS anyway,
--      so it's unaffected either way.
-- ============================================================

drop view if exists public_profile_names;
create view public_profile_names as
select id, full_name, occupation, verified_tier, avatar_url
from profiles
where not is_restricted_minor(id) or id = auth.uid() or is_parent_of(id) or is_admin();

revoke all on public_profile_names from anon;
grant select on public_profile_names to authenticated;

-- ============================================================
-- Done.
-- ============================================================
