-- ============================================================
-- 117 — CAD pricing in the admin revenue view
--
-- GOLSZ subscription pricing moved to fixed Canadian dollars on 2026-08-10:
--   Free C$0 · Basic C$10 · Pro C$24 · Elite C$48
-- replacing the previous USD 0/6/14/30.
--
-- admin_scout_margin_summary() computes monthly_revenue and the AI-cost
-- percentage from prices hardcoded in SQL — migration 052's own comment
-- flags that these live in code, not a table, and are kept in sync by hand.
-- Left at 6/14/30 the Admin Panel would under-report revenue by ~60% and
-- correspondingly over-report AI cost as a share of it, which is the number
-- the whole cost-control dashboard exists to watch.
--
-- THIS CHANGES NO ENTITLEMENT. It is a reporting function: SELECT-only,
-- admin-gated, and touched by nothing at request time. Plan limits, feature
-- gates (FEATURE_MIN_PLAN), PLAN_RANK, the Scout daily allowances and the
-- free lifetime cap are all untouched by this migration and by the
-- accompanying code change.
--
-- Currency note: the figures are bare numerics with no currency column, and
-- were already being read as "dollars" by the dashboard. They are now CAD.
-- Nothing converts between currencies anywhere in GOLSZ.
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
    p.plan,
    count(distinct p.id),
    count(distinct p.id) * (case p.plan when 'starter' then 10 when 'pro' then 24 when 'elite' then 48 else 0 end),
    coalesce(sum(u.total_cost), 0),
    case when count(distinct p.id) * (case p.plan when 'starter' then 10 when 'pro' then 24 when 'elite' then 48 else 0 end) > 0
      then round(100 * coalesce(sum(u.total_cost), 0) / (count(distinct p.id) * (case p.plan when 'starter' then 10 when 'pro' then 24 when 'elite' then 48 else 0 end)), 2)
      else 0
    end
  from profiles p
  left join scout_daily_usage u on u.user_id = p.id and u.usage_date >= date_trunc('month', now())::date
  group by p.plan;
end;
$$;

grant execute on function admin_scout_margin_summary() to authenticated;

-- Verification (as an admin):
--   select * from admin_scout_margin_summary() order by plan;
--   -- monthly_revenue for 'starter' must equal subscriber_count * 10.
--
-- Confirm no entitlement moved:
--   select plan, count(*) from profiles group by plan order by plan;
--   -- must match the distribution from before this migration ran.
