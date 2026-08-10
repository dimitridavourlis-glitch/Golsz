-- ============================================================
-- 119 — admin_scout_margin_summary() never actually ran  [BUG FIX]
--
-- Found by the behavioural verification of migration 118: impersonating a
-- real admin (set local role authenticated + their JWT claims, inside a
-- rolled-back transaction) and calling the function produced:
--
--   ERROR 42804: structure of query does not match function result type
--   DETAIL: Returned type plan_tier does not match expected type text
--           in column 1.
--
-- profiles.plan is the plan_tier ENUM. The function's signature declares
-- `returns table (plan text, ...)`. PostgreSQL does not implicitly coerce an
-- enum to text in a RETURNS TABLE, so the function raised on its first row
-- every single time it was called.
--
-- NOT INTRODUCED BY 117 OR 118. The mismatch dates from migration 056,
-- which created the function; 117 copied the body verbatim and changed only
-- the price literals, and 118 changed only grants. This has been broken for
-- every admin since the function shipped — the Admin Panel's margin card
-- has been silently erroring, which is exactly why nobody noticed a wrong
-- number: there was never a number.
--
-- It also means the ~60%-under-reporting risk flagged when 117 was written
-- was hypothetical: the function could not report anything at all. 117 was
-- still correct and necessary — this makes it reachable.
--
-- There were TWO type mismatches, found one at a time because PostgreSQL
-- reports only the first offending column:
--   column 1  plan            plan_tier -> text
--   column 3  monthly_revenue bigint    -> numeric
-- (count() returns bigint; bigint * integer is still bigint, but the
-- signature declares numeric.)
--
-- FIX: cast both at the point of return. Grouping still happens on the enum
-- (cheaper, and preserves its ordering semantics); only the projected
-- columns are cast. The else-branch of ai_cost_pct is cast too so the CASE
-- cannot resolve to integer on a zero-revenue plan.
--
-- Everything else is byte-identical to 117: same CAD prices (10/24/48),
-- same is_admin() gate, same security definer, same left join. Grants are
-- untouched, so 118's revoke of PUBLIC/anon stands — `create or replace`
-- preserves the ACL.
--
-- NO ENTITLEMENT CHANGES. Read-only reporting function.
-- ============================================================

create or replace function admin_scout_margin_summary()
returns table (plan text, subscriber_count bigint, monthly_revenue numeric, ai_cost numeric, ai_cost_pct numeric)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  return query
  select
    p.plan::text,
    count(distinct p.id),
    (count(distinct p.id) * (case p.plan when 'starter' then 10 when 'pro' then 24 when 'elite' then 48 else 0 end))::numeric,
    coalesce(sum(u.total_cost), 0),
    case when count(distinct p.id) * (case p.plan when 'starter' then 10 when 'pro' then 24 when 'elite' then 48 else 0 end) > 0
      then round(100 * coalesce(sum(u.total_cost), 0) / (count(distinct p.id) * (case p.plan when 'starter' then 10 when 'pro' then 24 when 'elite' then 48 else 0 end)), 2)
      else 0::numeric
    end
  from profiles p
  left join scout_daily_usage u on u.user_id = p.id and u.usage_date >= date_trunc('month', now())::date
  group by p.plan;
end;
$$;

-- Verification, impersonating a real admin (substitute a profiles.id where
-- is_admin is true). Must return one row per plan present, with
-- monthly_revenue = subscriber_count * the CAD price:
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<ADMIN-UUID>","role":"authenticated"}';
--     select plan, subscriber_count, monthly_revenue
--       from admin_scout_margin_summary() order by plan;
--   rollback;
--
-- And that 118's lockdown survived `create or replace`:
--   select has_function_privilege('anon','admin_scout_margin_summary()','execute');
--   -- expected: false
