-- ============================================================
-- 156 — assessment_snapshots: so "am I improving?" has an answer
--
-- *** APPLIED 2026-10-14. Verified: 0 rows (no backfill), RLS on, and
--     exactly 2 policies whose verbs are INSERT and SELECT — no UPDATE and
--     no DELETE, so a recorded day can never be rewritten. ***
--
-- GOLSZ computes a Passport Strength every time Home loads and has never kept
-- one. An athlete can see today's number and has no way to know whether it is
-- better than last month's, which makes the single most prominent number in
-- the product unanswerable for the question people actually have.
--
-- ONE ROW PER ATHLETE PER DAY. The primary key is (athlete_id, taken_on), so
-- writing it repeatedly in a day is a no-op rather than a growing pile. There
-- is no history to backfill: the first snapshot is the day this ships, and
-- everything before it is genuinely unknown.
--
-- WRITTEN BY THE CLIENT, NOT A CRON, AND THAT IS DELIBERATE. The score is
-- computed on Home from rows the client has already fetched; a cron would have
-- to recompute it for every athlete every day, including the ones who have not
-- opened the app in a year, to produce a flat line nobody asked for. A
-- snapshot taken when an athlete actually looks is a record of their real
-- engagement, and the gaps in it are honest.
--
-- WHAT THIS IS NOT. It is not an assessment of the athlete. Passport Strength
-- measures how complete and well-evidenced their profile is — it is not speed,
-- not technique, not ability. Nothing here licenses "you are improving as a
-- player"; the only honest reading is "your Passport is more complete than it
-- was". BENCHMARK_BANDS is still empty and there is still no population to
-- compare anyone against.
-- ============================================================

create table if not exists public.assessment_snapshots (
  athlete_id  uuid        not null references public.profiles(id) on delete cascade,
  taken_on    date        not null,
  composite   smallint    not null,
  -- The five sub-scores as computed that day. jsonb rather than columns
  -- because READINESS_DIMENSIONS is the client's list and has changed before;
  -- a column per dimension would turn every future change into a migration.
  sub_scores  jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  primary key (athlete_id, taken_on)
);

alter table public.assessment_snapshots drop constraint if exists assessment_snapshots_composite_range;
alter table public.assessment_snapshots add constraint assessment_snapshots_composite_range
  check (composite >= 0 and composite <= 100);

alter table public.assessment_snapshots enable row level security;

-- Self only, and NO update: a snapshot is a record of what was true on a day.
-- Allowing an edit would let today rewrite last month, which is the one thing
-- a history must not permit. Insert is the only write, and the primary key
-- makes a repeat harmless.
drop policy if exists assessment_snapshots_own_read on public.assessment_snapshots;
create policy assessment_snapshots_own_read on public.assessment_snapshots
  for select to authenticated using (athlete_id = auth.uid());

drop policy if exists assessment_snapshots_own_insert on public.assessment_snapshots;
create policy assessment_snapshots_own_insert on public.assessment_snapshots
  for insert to authenticated with check (athlete_id = auth.uid());

-- Deliberately no update or delete policy. RLS denies by default, so the
-- absence IS the rule, and it is stated here so nobody adds one by reflex.

create index if not exists assessment_snapshots_athlete_date_idx
  on public.assessment_snapshots (athlete_id, taken_on desc);

comment on table public.assessment_snapshots is
  'Dated record of Passport Strength, one row per athlete per day, insert-only. Measures profile completeness and evidence — NOT athletic ability. Written by the client when Home loads; gaps mean the athlete did not open the app, which is honest.';

-- ============================================================
-- VERIFY AFTER APPLYING
--   select count(*) from assessment_snapshots;        -- expect 0, no backfill
--   select count(*) from pg_policies where tablename = 'assessment_snapshots';
--   -- expect 2: select and insert only, no update, no delete
--   select relrowsecurity from pg_class where relname = 'assessment_snapshots';
--   -- expect true
-- ============================================================
