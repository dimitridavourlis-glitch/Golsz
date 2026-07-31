-- ============================================================
-- 031 — Time-on-app tracking (for Admin Panel → Analytics)
-- Additive on top of 002 + 004 + ... + 030.
--
-- Nothing in this schema tracked how long people actually spend in the
-- app before now. This adds a lightweight heartbeat: while the app is
-- open and the tab is visible, the client pings once a minute
-- (record_activity_ping in golsz-app.html's GolszApp) and this just
-- accumulates a per-user, per-day minute count — no raw timestamped
-- session log, no precise start/stop times, just "how many minutes was
-- this person active today."
--
-- Same privacy shape as messages/scout_history in migration 028:
-- no direct `authenticated` read/write policy on daily_activity at all.
-- Writes only happen through record_activity_ping() (security definer,
-- always uses auth.uid(), a user can only ever add to their own count).
-- Reads for the Admin Panel only ever go through admin_analytics_counts()
-- (extended here), which returns pre-aggregated totals — total minutes
-- and distinct active-user counts for the last 7/30/365 days — never a
-- raw per-user-per-day row. That's enough to compute an average without
-- exposing anyone's individual day-by-day activity to an admin.
--
-- Known limitation: this only measures usage from the moment it's
-- deployed onward — there's no historical data to backfill, so the
-- averages start at zero and grow as real usage accumulates.
-- ============================================================

create table if not exists daily_activity (
  user_id uuid not null references profiles(id) on delete cascade,
  activity_date date not null default current_date,
  minutes int not null default 0,
  primary key (user_id, activity_date)
);

create index if not exists daily_activity_date_idx on daily_activity (activity_date);

alter table daily_activity enable row level security;
-- Deliberately no policy for `authenticated` at all — see header comment.

create or replace function record_activity_ping(p_minutes int default 1)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null then
    return;
  end if;
  insert into daily_activity (user_id, activity_date, minutes)
  values (auth.uid(), current_date, p_minutes)
  on conflict (user_id, activity_date) do update set minutes = daily_activity.minutes + excluded.minutes;
end;
$$;

grant execute on function record_activity_ping(int) to authenticated;

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
    'activity_users_365d', (select count(distinct user_id) from daily_activity where activity_date > current_date - interval '365 days')
  ) into result;
  return result;
end;
$$;

grant execute on function admin_analytics_counts() to authenticated;

-- ============================================================
-- Done.
-- ============================================================
