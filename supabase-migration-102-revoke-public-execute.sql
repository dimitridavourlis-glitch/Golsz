-- Migration 102 — revoke PUBLIC execute on service-role-only functions
--
-- SECURITY FIX for migrations 097 and 101.
--
-- Those migrations ended with:
--     revoke execute on function ... from anon, authenticated;
-- intending to make the function service-role-only. That does NOT work.
--
-- PostgreSQL grants EXECUTE to the pseudo-role PUBLIC by default on every new
-- function. `anon` and `authenticated` inherit that grant, so revoking the
-- grant they were never individually given leaves the PUBLIC grant intact and
-- the function stays callable by anyone with the anon key.
--
-- Verified live before this fix, using only the public anon key:
--   POST /rest/v1/rpc/supersede_scout_memory    -> 409 FK violation
--        (409 = the call was AUTHORIZED and reached the insert; a blocked call
--         returns 401/403. Because the function is SECURITY DEFINER it runs as
--         owner and bypasses RLS entirely, so an anonymous caller could write
--         Scout Memory rows against any real athlete_id and flip that
--         athlete's existing memories to active = false.)
--   POST /rest/v1/rpc/rebuild_platform_insights -> 200, returned 0
--        (anonymous callers could trigger a full aggregate rebuild at will)
--
-- The correct form is `from public`. Revoking from anon/authenticated as well
-- is kept as belt-and-braces in case a future migration grants them directly.
--
-- search_golsz_knowledge is also tightened: it should be reachable by signed-in
-- users only, not by anyone holding the anon key. It keeps its explicit grant to
-- authenticated (migration 096), which survives the PUBLIC revoke.

revoke execute on function supersede_scout_memory(uuid, text, text, text, numeric, text, int) from public, anon, authenticated;

revoke execute on function rebuild_platform_insights() from public, anon, authenticated;

revoke execute on function search_golsz_knowledge(text, text, text, text, int) from public, anon;
grant execute on function search_golsz_knowledge(text, text, text, text, int) to authenticated;
