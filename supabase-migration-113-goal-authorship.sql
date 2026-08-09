-- ============================================================
-- 113 — Who wrote the goal, and when (P0-5)
--
-- profiles.goal_text (migration 093) is now editable by the athlete
-- directly, not only capturable by Scout from conversation. That creates a
-- conflict the schema could not previously express: if an athlete types
-- "sign a professional contract in Greece" into their Plan, and two turns
-- later Scout hears something it reads as a different goal, whose version
-- wins?
--
-- Master Architecture §42 — don't silently overwrite. The rule GOLSZ
-- implements: a goal the athlete wrote themselves is never overwritten by
-- model extraction. Scout is told the goal is athlete-authored and, if it
-- believes the goal has genuinely changed, must ask rather than assume.
-- A goal Scout captured itself stays freely updatable by Scout, which is
-- the behaviour that finally got goals onto Passports at all.
--
-- goal_source values:
--   'athlete_edited'  — typed by the athlete (or their approved parent) in
--                       the Plan/Home goal editor. Protected.
--   'scout_captured'  — extracted from conversation by Scout, or recovered
--                       by applyGoalSafetyNet() from a stored dream_outcome.
--   null              — pre-existing rows; treated as 'scout_captured', the
--                       permissive value, so this migration cannot retro-
--                       actively lock anyone's goal against them.
-- ============================================================

alter table profiles add column if not exists goal_source text
  check (goal_source is null or goal_source in ('athlete_edited', 'scout_captured'));

alter table profiles add column if not exists goal_updated_at timestamptz;

comment on column profiles.goal_source is
  'Who authored goal_text. athlete_edited is protected from Scout overwrite (see applyGoalAuthorship in api/scout.js); null/scout_captured is not.';

-- Backfill: every goal on record today came from Scout extraction, since no
-- athlete-facing editor existed before this migration. Naming that explicitly
-- is more honest than leaving it null and inferring it later.
update profiles
   set goal_source = 'scout_captured'
 where goal_text is not null
   and goal_text <> ''
   and goal_source is null;

-- Verification:
--   select goal_source, count(*) from profiles where goal_text is not null
--    group by goal_source;
