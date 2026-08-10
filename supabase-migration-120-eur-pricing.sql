-- ============================================================
-- 120 — GOLSZ pricing becomes fixed EUR
--
-- Final pricing, 2026-08-10:
--   Free EUR 0 · Basic EUR 6 · Pro EUR 15 · Elite EUR 30
-- replacing the short-lived CAD 0/10/24/48 set (migration 117), which in
-- turn replaced USD 0/6/14/30.
--
-- WHY THIS MIGRATION EXISTS AT ALL
-- The full audit found that the CAD change updated three of the FOUR places
-- a plan price lives and missed the fourth. plan_config still held the
-- original USD figures (6/14/30), and api/scout.js reads that table to build
-- Scout's product knowledge — so the AI was quoting "Basic ($6/mo)" to
-- athletes while the homepage said C$10. A live, user-facing pricing
-- contradiction that no test caught.
--
-- This migration fixes both halves of that:
--   1. plan_config carries the real prices, and its column is renamed from
--      price_usd to price_eur so the name can no longer lie about the
--      currency (the values had been EUR-agnostic integers all along).
--   2. admin_scout_margin_summary() computes MRR from the same numbers.
--
-- tests/test_pricing.cjs now diffs all four locations against each other, so
-- the class of bug that produced this migration cannot recur silently.
--
-- ENTITLEMENTS ARE UNCHANGED. Plan ids (free/starter/pro/elite), feature
-- gates, FEATURE_MIN_PLAN, PLAN_RANK, Scout daily allowances and the free
-- lifetime cap are all untouched. Internal identifiers keep their historical
-- names on purpose — "starter" is still the DB enum value for the tier the
-- product calls Basic. Only money and currency labels move here.
--
-- DEPLOY ORDER: the column rename and api/scout.js's read of price_eur must
-- land together. They will not in practice, so getPlanKnowledge() retries
-- with the old column name if the new select 404s, exactly like the
-- goal_source pattern in the same file. Either order degrades to "Scout has
-- no plan knowledge this call", never to an error.
-- ============================================================

-- 1. Rename the mislabelled column, idempotently.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'plan_config' and column_name = 'price_usd'
  ) and not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'plan_config' and column_name = 'price_eur'
  ) then
    alter table plan_config rename column price_usd to price_eur;
  end if;
end $$;

-- 2. The prices themselves.
update plan_config set price_eur = 0  where plan_id = 'free';
update plan_config set price_eur = 6  where plan_id = 'starter';   -- displayed as "Basic"
update plan_config set price_eur = 15 where plan_id = 'pro';
update plan_config set price_eur = 30 where plan_id = 'elite';

-- 3. Admin revenue reporting, same EUR numbers.
--    Body is otherwise byte-identical to migration 119: same is_admin() gate,
--    same security definer, same ::text / ::numeric casts that 119 added to
--    make this function return a row at all. Grants untouched, so 118's
--    revoke of PUBLIC/anon stands — `create or replace` preserves the ACL.
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
    (count(distinct p.id) * (case p.plan when 'starter' then 6 when 'pro' then 15 when 'elite' then 30 else 0 end))::numeric,
    coalesce(sum(u.total_cost), 0),
    case when count(distinct p.id) * (case p.plan when 'starter' then 6 when 'pro' then 15 when 'elite' then 30 else 0 end) > 0
      then round(100 * coalesce(sum(u.total_cost), 0) / (count(distinct p.id) * (case p.plan when 'starter' then 6 when 'pro' then 15 when 'elite' then 30 else 0 end)), 2)
      else 0::numeric
    end
  from profiles p
  left join scout_daily_usage u on u.user_id = p.id and u.usage_date >= date_trunc('month', now())::date
  group by p.plan;
end;
$$;

-- Verification:
--   select plan_id, plan_name, price_eur from plan_config order by display_order;
--   -- expected: free 0, starter 6, pro 15, elite 30
--
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<ADMIN-UUID>","role":"authenticated"}';
--     select plan, subscriber_count, monthly_revenue from admin_scout_margin_summary() order by plan;
--   rollback;
--   -- monthly_revenue for 'starter' must equal subscriber_count * 6.
--
--   select plan, count(*) from profiles group by plan order by plan;
--   -- must be unchanged: no entitlement moves in this migration.
