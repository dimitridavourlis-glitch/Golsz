-- ============================================================
-- 073 — Admin Analytics: catch up with tonight's build
-- admin_analytics_counts() (028) predates everything shipped this
-- session (lifetime AI budget, the conversion screen, benchmarks,
-- targets, real identity verification) — the Admin Panel had zero
-- visibility into any of it. Extends the SAME dashboard RPC rather than
-- adding a parallel one, same "one dashboard, not three" discipline the
-- 056/064 additions already followed.
--
-- profile_quality_avg is a SQL approximation of the client's
-- computeProfileQuality() (golsz-app.html) — same 9 of its ~10 checks
-- (everything except the sport-specific position field, which isn't
-- worth replicating SPORT_POSITION_LABEL/SPORTS_WITHOUT_POSITION for in
-- SQL just for an admin-facing average). Directionally accurate, not
-- byte-for-byte identical to any one athlete's own score.
--
-- free_ai_exhausted_count uses 40 as the reference cap — the same
-- default FREE_LIFETIME_LIMIT falls back to in api/scout.js when that
-- env var is unset. If you ever change the env var, this number stops
-- being exact (still directionally useful) until this function is
-- updated to match.
-- ============================================================

create or replace function admin_analytics_counts()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  result jsonb;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select jsonb_build_object(
    'messages_total', (select count(*) from messages),
    'messages_7d', (select count(*) from messages where created_at > now() - interval '7 days'),
    'scout_conversations_total', (select count(*) from scout_history),
    'scout_users_total', (select count(distinct user_id) from scout_history),
    'push_subscribers_total', (select count(distinct user_id) from push_subscriptions),
    'activity_minutes_7d', (select coalesce(sum(minutes), 0) from daily_activity where activity_date > current_date - interval '7 days'),
    'activity_users_7d', (select count(distinct user_id) from daily_activity where activity_date > current_date - interval '7 days'),
    'activity_minutes_30d', (select coalesce(sum(minutes), 0) from daily_activity where activity_date > current_date - interval '30 days'),
    'activity_users_30d', (select count(distinct user_id) from daily_activity where activity_date > current_date - interval '30 days'),
    'activity_minutes_365d', (select coalesce(sum(minutes), 0) from daily_activity where activity_date > current_date - interval '365 days'),
    'activity_users_365d', (select count(distinct user_id) from daily_activity where activity_date > current_date - interval '365 days'),
    'identity_verified_count', (select count(*) from profiles where identity_verified = true),
    'free_ai_users_total', (select count(*) from profiles where plan = 'free'),
    'free_ai_avg_used', (select round(coalesce(avg(free_ai_lifetime_used), 0)::numeric, 1) from profiles where plan = 'free'),
    'free_ai_exhausted_count', (select count(*) from profiles where plan = 'free' and free_ai_lifetime_used >= 40),
    'conversion_shown_count', (select count(*) from profiles where onboarding_conversion_shown = true),
    'conversion_now_paid_count', (select count(*) from profiles where onboarding_conversion_shown = true and plan <> 'free'),
    'benchmarks_total', (select count(*) from athlete_benchmarks),
    'benchmarks_users', (select count(distinct user_id) from athlete_benchmarks),
    'targets_total', (select count(*) from outreach_targets),
    'targets_users', (select count(distinct user_id) from outreach_targets),
    'targets_by_status', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (select status, count(*) as n from outreach_targets group by status) s
    ),
    'profile_quality_avg', (
      select round(coalesce(avg(
        (
          (case when a.sport is not null and a.sport <> '' then 1 else 0 end) +
          (case when a.club_name is not null and a.club_name <> '' then 1 else 0 end) +
          (case when a.grad_year is not null then 1 else 0 end) +
          (case when a.country is not null and a.country <> '' then 1 else 0 end) +
          (case when a.recruiting_status is not null and a.recruiting_status <> '' then 1 else 0 end) +
          (case when a.bio is not null and a.bio <> '' then 1 else 0 end) +
          (case when p.avatar_url is not null and p.avatar_url <> '' then 1 else 0 end) +
          (case when jsonb_array_length(coalesce(a.highlights, '[]'::jsonb)) > 0 then 1 else 0 end) +
          (case when jsonb_array_length(coalesce(a.timeline, '[]'::jsonb)) > 0 then 1 else 0 end)
        ) * 100.0 / 9
      ), 0)::numeric, 1)
      from athletes a join profiles p on p.id = a.id
    )
  ) into result;
  return result;
end;
$$;

grant execute on function admin_analytics_counts() to authenticated;
