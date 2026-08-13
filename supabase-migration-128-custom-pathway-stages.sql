-- 128 — per-athlete pathway stages
--
-- WHY
-- Stages come from SPORT_PATHWAY_STAGES in the client: Academy -> U19 -> Senior
-- -> Professional, identical for every Soccer athlete. That is the route the
-- SPORT has, not the route this athlete is on. Athletes need to rename, add,
-- reorder and delete their own sections (max 7, enforced client-side).
--
-- ADDITIVE ONLY. Both columns default to "nothing stored", and the client reads
-- an empty `stages` as "use the sport's defaults" — so every existing row keeps
-- rendering exactly as it does today and nothing needs backfilling. That is
-- deliberate: a backfill would write a guess into every athlete's row, and the
-- rule here is that stored data is stated, never inferred.
--
-- WHY current_stage_id EXISTS
-- currentStageIndex() infers "where you are now" from recruiting_status and
-- club_name against the sport's known sequence. That inference only means
-- something while the stages ARE the sport's. It cannot know what "Trials with
-- Panathinaikos" is. So once an athlete has custom stages, they state where
-- they are and nothing guesses. The heuristic survives only for untouched
-- default rows.
--
-- SHAPE (client-enforced, deliberately not a CHECK constraint — a constraint
-- here would need rewriting every time the shape moves, and migration 111
-- already showed how a drop-and-recreate silently loses values):
--   stages: [{ "id": "<stable>", "label": "<athlete's words>" }]
-- `id` is fixed at creation and NEVER derived from the label, because
-- milestones store `stage` as that id — renaming a section must not orphan the
-- steps filed under it.

alter table pathway_plan add column if not exists stages jsonb not null default '[]'::jsonb;
alter table pathway_plan add column if not exists current_stage_id text;

-- No RLS change. pathway_plan's existing policies are per-user on user_id and
-- already cover both columns; adding a column does not widen them.

-- VERIFY (run separately, do not trust this file):
--   select column_name, data_type, column_default, is_nullable
--     from information_schema.columns
--    where table_name = 'pathway_plan' and column_name in ('stages','current_stage_id');
--   select count(*) from pathway_plan where stages <> '[]'::jsonb;   -- expect 0
