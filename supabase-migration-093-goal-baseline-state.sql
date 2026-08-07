-- 093 — goal state (same directive, §11 state machine: GOAL_DEFINED/GOAL)
-- goal_text is a hard, athlete-confirmed fact (like full_name/sport — see
-- PROFILE_FIELD_MAP in api/scout.js), distinct from the existing SOFT/
-- inferred scout_context.dream_outcome and .target_level, which stay
-- exactly as they are. goal_defined is never set directly by the model —
-- it's derived server-side the moment goal_text is written (see
-- persistProfileUpdates in api/scout.js), so the state machine never
-- depends on the LLM correctly self-reporting a boolean.
--
-- baseline_complete lives on pathway_plan rather than profiles: a
-- "baseline" is meaningless before a Pathway exists to baseline against,
-- and this avoids a redundant standalone table for a single flag.
-- ============================================================

alter table profiles add column if not exists goal_defined boolean not null default false;
alter table profiles add column if not exists goal_text text;
alter table pathway_plan add column if not exists baseline_complete boolean not null default false;

-- ============================================================
-- Done.
