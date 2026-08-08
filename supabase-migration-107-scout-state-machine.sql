-- Migration 107 — Scout state machine, weighted readiness, capability manifest
--
-- Audit finding (§29): Scout behaves like a chatbot because nothing constrains
-- WHEN it may do WHAT. `conversation_stage` already existed but was only the
-- classifier's guess, written to scout_context.ai_meta and never read back —
-- so it influenced nothing. Scout planned before it understood the athlete
-- because no code stopped it.
--
-- This adds the authoritative state, derived server-side from real data (the
-- same discipline as computeNextMove and getAthleteState), never from the
-- model's self-report.
--
--   0 NEW           no sport on file
--   1 TRIAGE        learning the athlete; general help only, no personal plan
--   2 PROFILE_READY enough critical data; Scout summarises for confirmation
--   3 ASSESSED      athlete confirmed the summary; assessment + commercial gate
--   4 GUIDED        paid; personalised pathway/targets/roadmap unlocked
--   5 DEVELOPING    ongoing: benchmarks, retests, reassessment
--
-- scout_profile_ready is stored rather than recomputed everywhere so the
-- client, the prompt and the entitlement checks cannot disagree about it.

alter table profiles add column if not exists scout_state int not null default 0 check (scout_state between 0 and 5);
alter table profiles add column if not exists scout_profile_ready boolean not null default false;
alter table profiles add column if not exists scout_profile_confirmed_at timestamptz;
alter table profiles add column if not exists scout_assessment jsonb;
-- §14: the trial is time-boxed from first Scout contact. Nullable so existing
-- accounts are untouched until they next use Scout.
alter table profiles add column if not exists scout_trial_started_at timestamptz;

comment on column profiles.scout_state is 'Authoritative Scout state 0-5, derived server-side from real data. Never set from model output.';
comment on column profiles.scout_profile_ready is 'True once weighted critical/high-value completeness clears the threshold. Gates the confirmation step.';

-- §21E — the capability manifest gains the dimensions that let Scout tell
-- "locked behind a tier" apart from "needs more athlete data" apart from
-- "we genuinely do not do this". Without these it could only say available or
-- not, which is why it told athletes GOLSZ "can't" do things it can do.
alter table product_capabilities add column if not exists requires_profile_ready boolean not null default false;
alter table product_capabilities add column if not exists min_scout_state int not null default 0 check (min_scout_state between 0 and 5);
alter table product_capabilities add column if not exists requires_fields text[] not null default '{}';
alter table product_capabilities add column if not exists safety_note text;

-- Personalised planning needs a confirmed understanding of the athlete first
-- (§10: do not plan too early). General/educational capabilities stay at 0.
update product_capabilities set requires_profile_ready = true, min_scout_state = 3
where key in ('pathway_plan', 'targets', 'development_plan') and available;

update product_capabilities
set safety_note = 'Sports development only. Never diagnose, prescribe rehabilitation, or contradict a clinician. May organise training around restrictions the athlete reports from their own medical team.'
where key = 'development_plan';

-- §25 — admin-only reset so the Yiorgi run can be repeated from clean state.
-- Deliberately does NOT touch auth, the profile row itself, or Passport data
-- (athletes columns, highlights, benchmarks): this clears what SCOUT derived,
-- not who the athlete is.
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
    scout_assessment = null, scout_trial_started_at = null,
    goal_defined = false, goal_text = null
  where id = p_user;
  return format('reset: %s memories, %s history rows, scout_context cleared, state -> 0', v_mem, v_hist);
end;
$$;

-- Admin-gated inside the function AND unreachable by anon/authenticated, the
-- same double lock migrations 102/103 established after the PUBLIC-execute bug.
revoke execute on function reset_scout_intelligence(uuid) from public, anon, authenticated;
