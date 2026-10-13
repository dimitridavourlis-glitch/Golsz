-- ============================================================
-- 144 — athlete_actions: the one action table Home, Plan and Scout share
--
-- APPROVED BY THE OWNER 2026-10-13. *** NOT YET APPLIED ***
-- Filed here rather than left in /tmp so it cannot be lost. The Supabase
-- dashboard had no authenticated session when the go-ahead came, and
-- credentials are the owner's to enter. Flip this header the moment it runs,
-- and add it to supabase-schema.sql in the same commit — that file fell eight
-- migrations behind once already.
--
-- Additive only — it creates a table and reads
-- nothing, writes nothing, and migrates nothing. Applying it changes no
-- behaviour; the cutover is a later, separate step (see MIGRATION PLAN).
--
-- WHAT ALREADY EXISTS AND WHY IT IS NOT ENOUGH (checked before writing this):
--   * pathway_plan.milestones (076, extended by 128) is a jsonb ARRAY on one
--     row per athlete: {id, label, done, due, stage, due_src}. It is already
--     the shared store — Home ticks it, Plan edits it, Scout proposes into it
--     — so the brief's "one unified action system" is half true today.
--     What it cannot hold: category, priority, the REASON an action exists,
--     an evidence requirement, or a completion date. And because it is one
--     jsonb column, every write is a read-modify-write of the whole array;
--     two screens editing at once is a lost update, which is why save() had
--     to grow a promise chain and a snapshot.
--   * development_plan_items (075) is habits, not actions — one lifetime
--     status per row, ticked daily via development_plan_ticks (141).
--   * outreach_targets (077) is organisations to approach, not tasks.
--
-- WHY STATUS IS THREE VALUES, NOT SIX.
-- The brief lists Upcoming / Today / Overdue / Completed / Rescheduled /
-- Dropped. The first three are NOT states — they are the due date read
-- against today. Storing them guarantees drift: a row written "upcoming"
-- is wrong tomorrow and nothing would correct it, and the app would need a
-- nightly job whose only purpose is to fix a column it should never have
-- had. So: status holds what cannot be derived, due_on holds the date, and
-- upcoming/today/overdue are computed at read time exactly as Home already
-- computes `stepsLate` today.
--
-- WHY due_src SURVIVES.
-- A date GOLSZ proposed is not a date the athlete agreed to. suggestedDate()
-- is the predicate every punitive surface asks first, and dropping it here
-- would let an AI-suggested Tuesday call a 19-year-old late. Values: null
-- (theirs), 'scout', 'retest'.
--
-- RLS IS SELF-ONLY, with no is_parent_of branch, matching 141 and for the
-- same reason: parent accounts were switched off 2026-09-19 in the client
-- flag and in api/create-child-account.js, which returns 403. A policy
-- granting access nobody should have is not worth keeping warm.
-- ============================================================

create table if not exists athlete_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,

  -- WHAT IT IS
  title text not null,
  description text,
  -- Why this action exists, in the app's words or Scout's. The brief calls
  -- this "reason"; it is what Home's WHY line renders.
  reason text,
  category text not null default 'other',

  -- WHERE IT SITS. stage_id is a pathway_plan.stages[].id — deliberately NOT
  -- a foreign key: stages live inside a jsonb array, so there is no row to
  -- reference, and 128 already established that a stage id is server-minted
  -- and never derived from its label. An action whose stage is deleted is
  -- unfiled, not cascaded away, which is what deleteStage already does.
  stage_id text,

  -- WHEN
  due_on date,
  due_src text,
  completed_at timestamptz,

  -- STATE. Only what cannot be derived from due_on + completed_at.
  status text not null default 'open',

  -- WHAT WOULD PROVE IT. Free text for now: the brief asks for an evidence
  -- requirement, and until the verification ladder exists there is nothing
  -- structured to point at. A column that promised a link to evidence GOLSZ
  -- cannot yet hold would be the fabrication this product exists to avoid.
  evidence_note text,

  priority smallint not null default 0,

  -- PROVENANCE OF THE ROW ITSELF, so a Scout-created action is legible as
  -- one forever, not only until the athlete edits it.
  created_by text not null default 'athlete',

  -- The jsonb id this row came from, when it came from one. Lets the
  -- migration run twice without duplicating, and lets a reader trace a row
  -- back to the array it replaced.
  legacy_milestone_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table athlete_actions drop constraint if exists athlete_actions_status_check;
alter table athlete_actions add constraint athlete_actions_status_check
  check (status in ('open', 'completed', 'dropped'));

alter table athlete_actions drop constraint if exists athlete_actions_category_check;
alter table athlete_actions add constraint athlete_actions_category_check
  check (category in (
    'training', 'recovery', 'testing', 'film', 'outreach', 'academic',
    'recruiting', 'application', 'competition', 'profile', 'other'
  ));

alter table athlete_actions drop constraint if exists athlete_actions_due_src_check;
alter table athlete_actions add constraint athlete_actions_due_src_check
  check (due_src is null or due_src in ('scout', 'retest'));

alter table athlete_actions drop constraint if exists athlete_actions_created_by_check;
alter table athlete_actions add constraint athlete_actions_created_by_check
  check (created_by in ('athlete', 'scout', 'golsz'));

-- A completed action must carry its completion date and vice versa, or
-- "am I improving" is answered from a column that disagrees with itself.
alter table athlete_actions drop constraint if exists athlete_actions_completed_coherent;
alter table athlete_actions add constraint athlete_actions_completed_coherent
  check ((status = 'completed') = (completed_at is not null));

-- The two reads the app actually does: "my open actions by date" (Home's
-- next action, TODAY, THIS WEEK, the overdue count) and "everything on a
-- stage" (Plan's per-stage counts).
create index if not exists athlete_actions_user_due_idx
  on athlete_actions (user_id, due_on) where status = 'open';
create index if not exists athlete_actions_user_stage_idx
  on athlete_actions (user_id, stage_id) where stage_id is not null;
-- Makes the backfill idempotent.
create unique index if not exists athlete_actions_legacy_idx
  on athlete_actions (user_id, legacy_milestone_id) where legacy_milestone_id is not null;

alter table athlete_actions enable row level security;

drop policy if exists athlete_actions_own_read on athlete_actions;
create policy athlete_actions_own_read on athlete_actions
  for select to authenticated using (user_id = auth.uid());

drop policy if exists athlete_actions_own_insert on athlete_actions;
create policy athlete_actions_own_insert on athlete_actions
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists athlete_actions_own_update on athlete_actions;
create policy athlete_actions_own_update on athlete_actions
  for update to authenticated using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists athlete_actions_own_delete on athlete_actions;
create policy athlete_actions_own_delete on athlete_actions
  for delete to authenticated using (user_id = auth.uid());

comment on table athlete_actions is
  'One action per row, shared by Home, Plan and Scout. Replaces the pathway_plan.milestones jsonb array. status holds only what cannot be derived — upcoming/today/overdue are due_on read against today, never stored.';

-- ============================================================
-- MIGRATION PLAN — the part that touches live data, NOT in this file
--
-- This migration is additive and safe to apply on its own. Nothing reads
-- athlete_actions until the client is changed, so applying it today and
-- cutting over next week is fine.
--
-- 1. APPLY THIS. No behaviour changes.
-- 2. BACKFILL, idempotent via athlete_actions_legacy_idx:
--      insert into athlete_actions (user_id, title, due_on, due_src, stage_id,
--                                   status, completed_at, legacy_milestone_id)
--      select p.user_id,
--             left(m->>'label', 120),
--             nullif(m->>'due','')::date,
--             nullif(m->>'due_src',''),
--             nullif(m->>'stage',''),
--             case when (m->>'done')::boolean then 'completed' else 'open' end,
--             case when (m->>'done')::boolean then now() else null end,
--             m->>'id'
--      from pathway_plan p, jsonb_array_elements(p.milestones) m
--      on conflict (user_id, legacy_milestone_id) do nothing;
--    NOTE the completed_at here is the backfill time, not the real completion
--    time — the jsonb never recorded one. That is a known, stated loss; do
--    not invent a date that looks like history.
-- 3. DUAL-WRITE from the client for one release, so a rollback loses nothing.
-- 4. CUT OVER READERS one screen at a time: Plan, then Home, then Scout.
-- 5. STOP WRITING the jsonb. Keep the column — it is the rollback.
--
-- Verification before step 3:
--   select count(*) from athlete_actions;
--   select count(*) from pathway_plan p, jsonb_array_elements(p.milestones);
--   -- these must match.
-- ============================================================
