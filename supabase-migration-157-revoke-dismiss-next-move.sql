-- ============================================================
-- 157 — revoke dismiss_next_move(), which nothing has ever called
--
-- *** APPLIED 2026-10-14. Verified: EXECUTE is now false for both
--     authenticated and anon. The function itself is kept. ***
--
-- Migration 070 created dismiss_next_move() and granted EXECUTE to every
-- authenticated user. Verified today: zero call sites in golsz-app.html and
-- zero across api/. It has been callable by any signed-in account, from the
-- browser console or any HTTP client, for its entire existence, and nothing
-- in the product has ever needed it.
--
-- An unused grant is not neutral. It is a reachable write path nobody reviews,
-- nobody tests and nobody would notice being used — which is the definition of
-- the thing you remove rather than keep "in case".
--
-- THE FUNCTION IS KEPT, ONLY THE GRANT GOES. If the next-move surface ever
-- wants a dismiss, the implementation is still there to grant again in one
-- line, with a call site and a test alongside it. Dropping the function would
-- throw away a design decision; dropping the grant only closes a door that was
-- never used.
-- ============================================================

revoke all on function public.dismiss_next_move() from authenticated, anon, public;

comment on function public.dismiss_next_move() is
  'UNUSED since migration 070 and EXECUTE revoked by 157: zero call sites in the client and the API. Kept because the implementation is a design decision worth preserving. If a dismiss surface is built, grant execute to authenticated again IN THE SAME CHANGE as its call site and its test — not before.';

-- ============================================================
-- VERIFY AFTER APPLYING
--   select has_function_privilege('authenticated', p.oid, 'EXECUTE')
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where p.proname = 'dismiss_next_move' and n.nspname = 'public';
--   -- expect false
-- ============================================================
