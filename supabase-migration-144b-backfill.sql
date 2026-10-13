-- 144b — BACKFILL pathway_plan.milestones -> athlete_actions
--
-- *** APPLIED 2026-10-14 by the owner. Verified immediately after:
--     actions=2  legacy=2  steps_without_id=0  empty_titles=0
--     Every legacy step is now a row, and the two counts match exactly. ***
--
-- Step 2 of the cutover plan in supabase-migration-144-athlete-actions.sql.
-- 144 itself is APPLIED (2026-10-13): the table, 5 check constraints, 4
-- indexes, 4 self-only RLS policies and RLS=on were all verified present.
--
-- This file is the half that touches live rows, so it is the owner's to run.
-- At the time of writing production holds 4 pathway_plan rows, 2 of them with
-- steps, 2 steps in total — so this moves 2 rows.
--
-- IDEMPOTENT via athlete_actions_legacy_idx, with one caveat the verification
-- below catches: the unique index is partial (legacy_milestone_id is not
-- null), so a step whose jsonb carries no "id" would insert again on a second
-- run. steps_without_id must read 0 before you re-run this.
--
-- KNOWN, STATED LOSS: completed_at is the backfill time, not the real
-- completion time. The jsonb never recorded one. Do not invent a date that
-- looks like history.

insert into athlete_actions (user_id, title, due_on, due_src, stage_id,
                             status, completed_at, legacy_milestone_id)
select p.user_id,
       left(m->>'label', 120),
       nullif(m->>'due','')::date,
       nullif(m->>'due_src',''),
       nullif(m->>'stage',''),
       case when (m->>'done')::boolean then 'completed' else 'open' end,
       case when (m->>'done')::boolean then now() else null end,
       m->>'id'
from pathway_plan p, jsonb_array_elements(p.milestones) m
-- The index this infers against is PARTIAL (where legacy_milestone_id is not
-- null). Postgres will not match a partial unique index unless ON CONFLICT
-- repeats its predicate, and without it you get:
--   42P10: there is no unique or exclusion constraint matching the ON CONFLICT
-- The predicate is not optional decoration; it is how the index is named.
on conflict (user_id, legacy_milestone_id) where legacy_milestone_id is not null
do nothing;

-- VERIFY. actions and legacy must match, and steps_without_id must be 0
-- before this file is ever run a second time.
select (select count(*) from athlete_actions) as actions,
       (select count(*) from pathway_plan p, jsonb_array_elements(p.milestones)) as legacy,
       (select count(*) from pathway_plan p, jsonb_array_elements(p.milestones) m
          where nullif(m->>'id','') is null) as steps_without_id,
       (select count(*) from athlete_actions where title is null or title = '') as empty_titles;
