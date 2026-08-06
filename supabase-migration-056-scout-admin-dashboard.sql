-- ============================================================
-- 056 — Admin cost/margin dashboard
-- Golsz Multi-Model AI Scout & Cost-Control System (approved plan).
--
-- Extends the existing Analytics -> "AI Model Usage" card
-- (admin_scout_model_mix/admin_scout_cost_summary, migrations 039/040)
-- rather than building a parallel dashboard. Same is_admin()-gated
-- security-definer pattern throughout. Every function here returns dollar
-- figures / counts only — never question or answer text — and the
-- existing privacy boundaries stay unchanged: scout_routing_log still has
-- no user_id (migration-038 audit — admins never see who asked what);
-- scout_daily_usage carries user_id + cost numbers only, the same
-- metadata-yes/content-no line already drawn around scout_faq_misses.
-- ============================================================

create or replace function admin_scout_cost_by_plan()
returns table (plan text, message_count bigint, total_cost numeric, avg_cost numeric)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  return query
  select coalesce(l.plan, 'unknown'), count(*), coalesce(sum(l.estimated_cost_usd), 0), coalesce(avg(l.estimated_cost_usd), 0)
  from scout_routing_log l
  where l.created_at >= date_trunc('month', now())
  group by coalesce(l.plan, 'unknown');
end;
$$;

grant execute on function admin_scout_cost_by_plan() to authenticated;

create or replace function admin_scout_cache_stats()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  result jsonb;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select jsonb_build_object(
    'cached_answers', count(*),
    'total_hits', coalesce(sum(hit_count), 0)
  ) into result
  from scout_response_cache
  where expires_at >= now();
  return result;
end;
$$;

grant execute on function admin_scout_cache_stats() to authenticated;

create or replace function admin_scout_top_cost_users(p_limit int default 10)
returns table (user_id uuid, full_name text, plan text, total_cost numeric, questions_used bigint)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  return query
  select u.user_id, p.full_name, p.plan, sum(u.total_cost), sum(u.questions_used)
  from scout_daily_usage u
  join profiles p on p.id = u.user_id
  where u.usage_date >= date_trunc('month', now())::date
  group by u.user_id, p.full_name, p.plan
  order by sum(u.total_cost) desc
  limit least(coalesce(p_limit, 10), 25);
end;
$$;

grant execute on function admin_scout_top_cost_users(int) to authenticated;

-- Plan prices hardcoded here (matching PLANS in golsz-app.html: Free $0,
-- Starter $6, Pro $14, Elite $30) since pricing lives in client display
-- code today, not a DB table — kept in sync manually if PLANS ever changes.
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
    count(distinct p.id) * (case p.plan when 'starter' then 6 when 'pro' then 14 when 'elite' then 30 else 0 end),
    coalesce(sum(u.total_cost), 0),
    case when count(distinct p.id) * (case p.plan when 'starter' then 6 when 'pro' then 14 when 'elite' then 30 else 0 end) > 0
      then round(100 * coalesce(sum(u.total_cost), 0) / (count(distinct p.id) * (case p.plan when 'starter' then 6 when 'pro' then 14 when 'elite' then 30 else 0 end)), 2)
      else 0
    end
  from profiles p
  left join scout_daily_usage u on u.user_id = p.id and u.usage_date >= date_trunc('month', now())::date
  group by p.plan;
end;
$$;

grant execute on function admin_scout_margin_summary() to authenticated;
