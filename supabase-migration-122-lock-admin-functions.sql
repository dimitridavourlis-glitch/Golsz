-- ============================================================
-- 122 — Revoke PUBLIC/anon EXECUTE across every admin_* function
--
-- Migration 118 fixed admin_scout_margin_summary(). The full audit then
-- showed 118 had fixed exactly ONE instance of a systemic default: every
-- other admin_* security-definer function was still
--
--   has_function_privilege('anon',   fn, 'execute') => true
--   has_function_privilege('public', fn, 'execute') => true
--
-- including admin_analytics_counts, admin_moderation_stats,
-- admin_review_appeal, admin_review_verification and admin_get_model_config.
-- PostgreSQL grants EXECUTE to PUBLIC by default on every new function and
-- `create or replace` preserves the ACL, so this was inherited from whichever
-- migration first created each one. Migration 102 covered a handful of
-- service-role-only functions; nothing covered the admin surface as a set.
--
-- SEVERITY: low, and NOTHING WAS EXPOSED. Every function this touches has an
-- in-body `if not is_admin() then raise exception 'not authorized'` gate, so
-- an anon caller already received an exception rather than data — verified
-- behaviourally against production for admin_scout_margin_summary() when 118
-- shipped. This removes the ability to reach that check at all. Defence in
-- depth, not a leak fix.
--
-- WHY THIS IS DYNAMIC RATHER THAN ~36 HAND-WRITTEN LINES
-- A list would be stale the day someone adds admin_something_new(). The loop
-- below re-derives the set from the catalogue, so re-running this migration
-- after new admin functions ship re-secures them too.
--
-- THE SAFETY PREDICATE IS THE POINT. It only touches a function when ALL of:
--   * schema is public
--   * SECURITY DEFINER
--   * name matches 'admin_%' (underscore escaped via ESCAPE '@', never a
--     backslash: a backslash survives one round of string-escaping and
--     silently matches NOTHING, which is exactly how the first run of this
--     migration reported success while securing zero functions)
--   * the body actually contains is_admin()
-- That last condition is what makes this safe to run blind: a function that
-- has no internal gate is NOT touched here, because for such a function the
-- grant might be the only access control and revoking it could break a real
-- caller. Those are tracked separately and are not in scope for this file.
--
-- WHAT MUST KEEP WORKING
-- The Admin Panel calls these through supabase-js (sb.rpc(...)), which sends
-- the signed-in admin's JWT, so PostgREST executes as role `authenticated`.
-- That grant is re-asserted explicitly for every function touched, so this
-- migration is idempotent and cannot lock an admin out even if run twice.
--
-- Admin-ness is NOT a database role — it is profiles.is_admin, read by
-- is_admin() via auth.uid(). Every authenticated user may still call these;
-- only an admin gets past the first statement inside. That two-layer
-- arrangement is unchanged.
--
-- NO ENTITLEMENT CHANGES. Grants only. No profile row, plan or feature gate
-- is touched.
-- ============================================================

do $$
declare
  fn record;
  touched int := 0;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       and p.proname like 'admin@_%' escape '@'
       and pg_get_functiondef(p.oid) like '%is_admin()%'
     order by p.proname
  loop
    execute format('revoke execute on function %s from public', fn.sig);
    execute format('revoke execute on function %s from anon',   fn.sig);
    execute format('grant  execute on function %s to authenticated', fn.sig);
    touched := touched + 1;
  end loop;
  raise notice 'migration 122: secured % admin_* functions', touched;
end $$;

-- Verification:
--   select count(*) filter (where has_function_privilege('anon', p.oid, 'execute'))          as anon_can_run,
--          count(*) filter (where has_function_privilege('public', p.oid, 'execute'))        as public_can_run,
--          count(*) filter (where has_function_privilege('authenticated', p.oid, 'execute')) as authed_can_run,
--          count(*)                                                                          as total
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.prosecdef and p.proname like 'admin@_%' escape '@'
--      and pg_get_functiondef(p.oid) like '%is_admin()%';
--   -- expected: anon_can_run = 0, public_can_run = 0, authed_can_run = total
--
-- Behavioural check that a real admin still works through the app's path:
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<ADMIN-UUID>","role":"authenticated"}';
--     select * from admin_scout_margin_summary() order by plan;
--   rollback;
