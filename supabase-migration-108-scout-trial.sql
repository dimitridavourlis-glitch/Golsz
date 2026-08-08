-- Migration 108 — capped Scout trial
--
-- §14 asks for a time-boxed trial so a new athlete experiences the real
-- product before being asked to pay. Implemented CAPPED rather than
-- unmetered, deliberately: an unmetered trial is unbounded spend per signup,
-- and a Sonnet turn costs roughly $0.058 today. Three independent bounds,
-- each of which alone makes spend finite:
--
--   * days   — scout_trial_started_at + TRIAL_DAYS (default 5)
--   * daily  — the EXISTING reserve_scout_question path, called with
--              TRIAL_DAILY_LIMIT (default 8) instead of FREE_DAILY_LIMIT
--   * total  — scout_trial_used vs TRIAL_TOTAL_LIMIT (default 30)
--
-- Worst case per athlete, once ever: 30 x $0.058 ~= $1.74.
--
-- The daily bound reuses the existing atomic reserve rather than being
-- reimplemented here — one source of truth for "how many today", so the
-- trial cannot drift out of sync with the plan limits.
--
-- The trial deliberately does NOT consume free_ai_lifetime_used (migration
-- 068). The lifetime free allowance is what the athlete lands on when the
-- trial ends; spending it during the trial would mean a trial that quietly
-- costs them their free tier, which reads as a bait and switch.
--
-- scout_trial_started_at already exists (migration 107). Only the counter is
-- new. Both are nullable/defaulted so existing accounts are untouched until
-- they next talk to Scout.

alter table profiles add column if not exists scout_trial_used int not null default 0;

comment on column profiles.scout_trial_used is 'Scout messages consumed during the capped trial. Never reset — the trial is once per account.';

-- Atomic start-or-consume. Mirrors reserve_scout_question's shape (migration
-- 053): the row is locked, every bound is checked and the counter moves
-- inside one transaction, so two concurrent requests cannot both pass the
-- final message of the trial.
--
-- Starting the trial is a side effect of the FIRST reserve rather than a
-- separate call: a trial that starts when the athlete first talks to Scout
-- can never be started by an accidental page load, and there is no window in
-- which a started trial has no counter.
create or replace function reserve_trial_question(p_user uuid, p_total_limit int, p_trial_days int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_started timestamptz;
  v_used int;
  v_expires timestamptz;
begin
  -- Callers may only spend their own trial. Admins are allowed through for
  -- support/testing, matching every other reserve function here.
  if p_user is distinct from auth.uid() and not is_admin() then
    raise exception 'not authorized';
  end if;

  select scout_trial_started_at, coalesce(scout_trial_used, 0)
    into v_started, v_used
    from profiles where id = p_user for update;

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'no_profile');
  end if;

  if v_started is null then
    v_started := now();
    update profiles set scout_trial_started_at = v_started where id = p_user;
  end if;

  v_expires := v_started + make_interval(days => greatest(p_trial_days, 0));

  if now() > v_expires then
    return jsonb_build_object('allowed', false, 'reason', 'trial_expired',
      'started_at', v_started, 'expires_at', v_expires, 'used', v_used, 'total', p_total_limit);
  end if;

  if v_used >= p_total_limit then
    return jsonb_build_object('allowed', false, 'reason', 'trial_exhausted',
      'started_at', v_started, 'expires_at', v_expires, 'used', v_used, 'total', p_total_limit);
  end if;

  update profiles set scout_trial_used = v_used + 1 where id = p_user;

  return jsonb_build_object('allowed', true, 'reason', 'ok',
    'started_at', v_started, 'expires_at', v_expires,
    'used', v_used + 1, 'total', p_total_limit,
    'remaining', p_total_limit - (v_used + 1));
end;
$$;

-- Compensating release, same contract as release_scout_question: a reserved
-- message that never actually reached the model must not be charged to the
-- athlete's trial. Clamped at zero so a double release cannot mint credit.
create or replace function release_trial_question(p_user uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if p_user is distinct from auth.uid() and not is_admin() then
    raise exception 'not authorized';
  end if;
  update profiles set scout_trial_used = greatest(coalesce(scout_trial_used, 0) - 1, 0)
   where id = p_user;
end;
$$;

-- Migration 102's lesson: PUBLIC holds EXECUTE by default, so revoking from
-- anon/authenticated alone does nothing. Revoke from public FIRST, then grant
-- back only to authenticated — these are per-user spend gates and must never
-- be reachable by an anonymous caller.
revoke execute on function reserve_trial_question(uuid, int, int) from public, anon, authenticated;
revoke execute on function release_trial_question(uuid) from public, anon, authenticated;
grant execute on function reserve_trial_question(uuid, int, int) to authenticated;
grant execute on function release_trial_question(uuid) to authenticated;

-- §25 — a reset must put the athlete back to a genuinely clean slate,
-- including their trial, or the acceptance run cannot be repeated.
create or replace function reset_scout_intelligence(p_user uuid)
returns text language plpgsql security definer set search_path to 'public' as $$
declare v_mem int; v_hist int;
begin
  if not is_admin() then raise exception 'not authorized'; end if;
  delete from scout_memory where athlete_id = p_user;
  get diagnostics v_mem = row_count;
  delete from scout_history where user_id = p_user;
  get diagnostics v_hist = row_count;
  delete from scout_research_cache where athlete_id = p_user;
  update athletes set scout_context = '{}'::jsonb where id = p_user;
  update profiles set
    scout_state = 0, scout_profile_ready = false, scout_profile_confirmed_at = null,
    scout_assessment = null, scout_trial_started_at = null, scout_trial_used = 0,
    goal_defined = false, goal_text = null
  where id = p_user;
  return format('reset: %s memories, %s history rows, scout_context cleared, trial cleared, state -> 0', v_mem, v_hist);
end;
$$;

revoke execute on function reset_scout_intelligence(uuid) from public, anon, authenticated;
