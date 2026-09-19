-- ============================================================
-- 143 — Discovery off. Applied to production 2026-09-19.
--
-- GOLSZ is a growth app right now. Athlete search is a feature of the product
-- it becomes later, not the one it is today, so the one live path by which a
-- signed-in account could surface another athlete is closed.
--
-- WHAT THIS CLOSES. search_players() is security definer and migration 022
-- granted execute to `authenticated`. No .sql in this repo ever revoked it, so
-- any signed-in account could call the RPC directly with the public anon key,
-- bypassing Scout, the Starter+ plan gate and the 402 that enforces it. The
-- client never did — grep for search_players in golsz-app.html returns
-- nothing — but the grant is the thing that matters, not whether anyone had
-- used it yet.
--
-- The revoke is done by signature lookup rather than by typing the argument
-- list, so a typo cannot silently leave one overload still granted.
--
-- KEPT, DELIBERATELY: the function itself, the athletes.scout_visible column,
-- and its partial index. Discovery should come back by being switched on after
-- a decision, not rebuilt from memory. service_role keeps execute for the same
-- reason; no caller uses it, since the search tool was removed from Scout in
-- the same change.
--
-- The client stops showing the "Findable by scouts" toggle while this is off.
-- A privacy control over a capability that cannot happen is worse than no
-- control: it tells an athlete they have turned something off that was never
-- on, and — because the column defaults to true — tells everyone else they are
-- findable when nobody can find them.
-- ============================================================

do $$
declare f record;
begin
  for f in select oid::regprocedure as sig from pg_proc where proname = 'search_players'
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    execute format('revoke all on function %s from authenticated', f.sig);
  end loop;
end $$;

comment on function search_players(text, text, text, int, text, text, int) is
  'DISCOVERY IS OFF (143). Execute revoked from public/anon/authenticated; only the service role can reach it, and no caller does. The scout_visible column and this function are kept intact so discovery can be switched back on deliberately rather than rebuilt.';

-- Verification (run as any role):
--   select has_function_privilege('authenticated',
--     'search_players(text,text,text,int,text,text,int)', 'execute');   -- false
--   select has_function_privilege('anon', ...);                          -- false
--   select has_function_privilege('service_role', ...);                  -- true
