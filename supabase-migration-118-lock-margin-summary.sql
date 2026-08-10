-- ============================================================
-- 118 — Revoke PUBLIC/anon EXECUTE on admin_scout_margin_summary()
--
-- Found while verifying migration 117 in production:
--   has_function_privilege('anon', 'admin_scout_margin_summary()', 'execute')
--   => true
--
-- Not introduced by 117. Postgres grants EXECUTE to PUBLIC by default on
-- every newly created function, and `create or replace` preserves the
-- existing ACL, so this has been inherited since migration 056 created the
-- function. Migration 102 revoked PUBLIC execute on several service-role-
-- only functions but never covered this one.
--
-- SEVERITY: low, but worth closing. The function is security definer with
-- an in-body `if not is_admin() then raise exception 'not authorized'`, so
-- an anon caller already gets an exception rather than data. This removes
-- the ability to even reach that check — defence in depth, not a fix for a
-- live leak. Nothing was exposed.
--
-- WHAT MUST KEEP WORKING
-- The Admin Panel calls this through supabase-js:
--     sb.rpc("admin_scout_margin_summary")     -- golsz-app.html
-- which sends the signed-in admin's JWT, so PostgREST executes it as role
-- `authenticated`. That grant is therefore preserved deliberately and
-- explicitly re-granted below, so this migration is idempotent and cannot
-- lock an admin out even if run twice or out of order.
--
-- Admin-ness itself is NOT a database role — it is profiles.is_admin, read
-- by is_admin() via auth.uid(). Every authenticated user may call the
-- function; only an admin gets past the first statement inside it. That
-- two-layer arrangement is unchanged here.
--
-- NO ENTITLEMENT CHANGES. This is a grant on a read-only reporting
-- function. It touches no profile row, no plan, no feature gate.
-- ============================================================

revoke execute on function admin_scout_margin_summary() from public;
revoke execute on function admin_scout_margin_summary() from anon;

-- Re-assert the grant the application actually needs. Harmless if already
-- present; the point is that this file alone is sufficient to leave the
-- function in the correct end state.
grant execute on function admin_scout_margin_summary() to authenticated;

-- Verification:
--   select has_function_privilege('anon', p.oid, 'execute')          as anon,
--          has_function_privilege('authenticated', p.oid, 'execute') as authed,
--          p.prosecdef                                               as secdef
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'admin_scout_margin_summary';
--   -- expected: anon = false, authed = true, secdef = true
--
-- Behavioural check, impersonating a real caller inside a rolled-back
-- transaction (substitute a real profiles.id for each):
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<NON-ADMIN-UUID>"}';
--     select * from admin_scout_margin_summary();   -- expect: not authorized
--   rollback;
