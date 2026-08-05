-- ============================================================
-- 050 — Structured Athlete Context
-- Phase 2a of the AI Scout architecture plan (approved).
--
-- Adds athletes.scout_context, a jsonb column holding the "softer"
-- athlete-intelligence fields the plan's Athlete Context describes that
-- have no home in the existing Passport columns (sport/position/etc.
-- are untouched — this is purely additive): dream_outcome, target_level,
-- target_country, timeline, perceived_strengths, perceived_weaknesses,
-- main_gap, urgency, confidence, professional_interest, college_interest,
-- trial_interest, and ai_meta (conversation_stage, missing_information,
-- recommended_pathway, next_best_question, recommended_specialist —
-- written by the classifier, see api/scout.js Phase 2c).
--
-- Each top-level field (except ai_meta, a single always-fresh blob
-- recomputed every turn) is stored as
-- {value, source: 'athlete_stated'|'ai_inferred', confidence, updated_at}
-- rather than a bare scalar — never silently promoted to "verified";
-- that word is reserved for a real future verification pathway, not
-- self-reported by the model. api/scout.js is the only writer
-- (service-role), via merge_scout_context() below so a partial update
-- never clobbers fields it didn't touch — jsonb || is a top-level-key
-- merge, which is exactly right here: distinct soft-fact keys accumulate
-- independently, while ai_meta is deliberately replaced wholesale each
-- turn since it's a live routing decision, not an accumulating fact.
-- ============================================================

alter table athletes add column if not exists scout_context jsonb not null default '{}'::jsonb;

create or replace function merge_scout_context(p_user uuid, p_updates jsonb)
returns void language sql security definer set search_path to 'public' as $$
  update athletes set scout_context = coalesce(scout_context, '{}'::jsonb) || p_updates where id = p_user;
$$;

revoke execute on function merge_scout_context(uuid, jsonb) from anon;
revoke execute on function merge_scout_context(uuid, jsonb) from authenticated;
revoke execute on function merge_scout_context(uuid, jsonb) from public;
grant execute on function merge_scout_context(uuid, jsonb) to service_role;
