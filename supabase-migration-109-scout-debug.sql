-- Migration 109 — admin Scout debug read + the §25 reset, exposed safely
--
-- §26 asks for a developer harness to inspect what Scout actually derived for
-- an athlete. The obvious implementation — let admins read scout_memory —
-- is the one thing this schema deliberately refuses:
--
--   scout_memory has NO admin read policy (see its comment: "this is an
--   athlete's private intelligence file ... must never leak sideways").
--
-- Admins are users. An athlete telling Scout about an injury, a family
-- situation or a coach they don't trust has not consented to staff reading
-- it, and a debug tool is not a good enough reason to break that. So this
-- function returns COUNTS AND DERIVED STATE ONLY:
--
--   * how many memories exist, grouped by type — never their content
--   * how many research-cache rows exist — never their content
--   * the state machine's own outputs, which are already the athlete's own
--     profile fields (state, readiness flags, trial position, plan, goal)
-- Per-athlete routing history is NOT here, and no column was added to make
-- it possible: scout_routing_log has no user identifier by design. It is
-- aggregate telemetry (answered_by, intent, plan, model, latency, timeout
-- reason), and adding user_id to satisfy a debug view would turn every model
-- call into a personally attributable record. Model-mix and failure rates
-- stay answerable from admin_scout_model_mix(); "what did THIS athlete's
-- last ten calls do" is not worth that trade.
--
-- That is enough to answer every question the harness actually needs to
-- answer — "why is this athlete stuck in TRIAGE", "did the memory write
-- land", "is it falling back to Haiku" — without reading anyone's file.
--
-- goal_text IS included: it is the athlete's stated objective, already shown
-- in their own UI and already sent to the model as ATHLETE STATE. It is the
-- one free-text field where seeing the actual value is the difference
-- between a usable harness and a wall of counts.

create or replace function admin_scout_debug(p_user uuid)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_profile record;
  v_athlete record;
  v_mem jsonb;
  v_mem_total int;
  v_research int;
begin
  if not is_admin() then raise exception 'not authorized'; end if;

  select plan, is_admin, ai_unlimited, goal_defined, goal_text,
         scout_state, scout_profile_ready, scout_profile_confirmed_at,
         scout_trial_started_at, scout_trial_used, free_ai_lifetime_used
    into v_profile from profiles where id = p_user;

  if not found then return jsonb_build_object('found', false); end if;

  -- The critical/high-value fields scoutReadiness() weighs, as PRESENCE
  -- booleans plus the few short categorical values. This is what makes the
  -- harness able to answer "which field is holding this athlete at 40%".
  select sport, position, club_name, recruiting_status,
         (dob is not null or age_reported is not null) as has_age,
         (current_city is not null or country is not null) as has_current,
         (home_city is not null or home_country is not null) as has_home,
         (previous_clubs is not null and jsonb_array_length(previous_clubs) > 0) as has_history,
         (grad_year is not null) as has_grad_year,
         (height_cm is not null or weight_kg is not null) as has_measurements,
         (citizenship is not null) as has_citizenship
    into v_athlete from athletes where id = p_user;

  select coalesce(jsonb_object_agg(t, c), '{}'::jsonb), coalesce(sum(c), 0)
    into v_mem, v_mem_total
    from (select type as t, count(*) as c from scout_memory
           where athlete_id = p_user and active and superseded_by is null
           group by type) x;

  select count(*) into v_research from scout_research_cache where athlete_id = p_user;

  return jsonb_build_object(
    'found', true,
    'plan', v_profile.plan,
    'is_admin', v_profile.is_admin,
    'ai_unlimited', v_profile.ai_unlimited,
    'goal_defined', v_profile.goal_defined,
    'goal_text', v_profile.goal_text,
    'scout_state', v_profile.scout_state,
    'scout_profile_ready', v_profile.scout_profile_ready,
    'scout_profile_confirmed_at', v_profile.scout_profile_confirmed_at,
    'trial_started_at', v_profile.scout_trial_started_at,
    'trial_used', v_profile.scout_trial_used,
    'free_ai_lifetime_used', v_profile.free_ai_lifetime_used,
    'fields', to_jsonb(v_athlete),
    'memory_by_type', v_mem,
    'memory_total', v_mem_total,
    'research_cache_rows', v_research
  );
end;
$$;

revoke execute on function admin_scout_debug(uuid) from public, anon, authenticated;
grant execute on function admin_scout_debug(uuid) to authenticated;
