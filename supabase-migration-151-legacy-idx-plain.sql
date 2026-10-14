-- ============================================================
-- 151 — make athlete_actions' legacy key usable from the client
--
-- *** DO NOT APPLY. SUPERSEDED, AND NOW ACTIVELY DANGEROUS. ***
--
-- This was written to let PostgREST's on_conflict name the key, back when the
-- plan was a client-side dual-write. That design was rejected in favour of
-- sync_athlete_actions() (migration 152), which is raw SQL and CAN name a
-- partial index's predicate — so the problem this solves no longer exists.
--
-- Worse, applying it now would BREAK the sync. 152 and 155 both write:
--     on conflict (user_id, legacy_milestone_id) where legacy_milestone_id is not null
-- Postgres matches that inference against the PARTIAL index. Replace the index
-- with a plain unique constraint and the predicate matches nothing, and every
-- call to sync_athlete_actions() fails with 42P10 — which means every tick,
-- rename and reschedule stops mirroring, silently, for every athlete.
--
-- Caught while about to run it. If the partial index is ever replaced, the
-- function's ON CONFLICT must lose its WHERE clause IN THE SAME CHANGE.
-- Kept as a record of the reasoning, not as work to be done.
--
-- THE PROBLEM, AND IT IS MINE. Migration 144 created:
--
--   create unique index athlete_actions_legacy_idx
--     on athlete_actions (user_id, legacy_milestone_id)
--     where legacy_milestone_id is not null;
--
-- The WHERE made it a PARTIAL index. Two consequences:
--
--   1. Postgres will not infer a partial unique index from a plain
--      ON CONFLICT (user_id, legacy_milestone_id) — it raises
--      42P10 "there is no unique or exclusion constraint matching the
--      ON CONFLICT specification". The backfill hit exactly this.
--   2. PostgREST — which is how the client writes — can only pass COLUMN
--      NAMES to on_conflict. It has no way to express the predicate. So the
--      dual-write cannot upsert against this index at all, and the failure
--      would appear in production the first time a real athlete ticked a
--      step, not in any test.
--
-- THE PREDICATE BUYS NOTHING. A plain UNIQUE (user_id, legacy_milestone_id)
-- behaves identically for the rows the predicate was meant to exclude:
-- Postgres treats NULLs as DISTINCT in a unique index by default, so any
-- number of rows may share a user_id while legacy_milestone_id is NULL. That
-- is precisely what the WHERE was trying to allow. It was defensive clutter
-- that happened to break the one access path the column exists for.
--
-- Replacing an index with a CONSTRAINT rather than another index, because a
-- constraint is what PostgREST resolves on_conflict against most reliably,
-- and it shows up in information_schema where the next person will look.
-- ============================================================

-- Safe: the data already satisfies it. Verified against the live database
-- before writing this, not assumed:
--   rows = 2, distinct (user_id, legacy_milestone_id) pairs = 2, nulls = 0.
--
-- DO NOT ADD "nulls not distinct" TO THIS CONSTRAINT. The server is
-- PostgreSQL 17 (server_version_num 170006), and 15+ accepts that modifier.
-- Adding it would make every action WITHOUT a legacy id collide with every
-- other for the same athlete — which is every action created from now on,
-- since only backfilled rows carry a legacy id. The default, NULLS DISTINCT,
-- is load-bearing here and is the whole reason the partial predicate was
-- unnecessary in the first place.
-- If that is ever untrue the ADD CONSTRAINT fails loudly rather than
-- silently dropping a row, which is the correct outcome.
alter table public.athlete_actions
  drop constraint if exists athlete_actions_legacy_uniq;
alter table public.athlete_actions
  add constraint athlete_actions_legacy_uniq unique (user_id, legacy_milestone_id);

-- Only after the constraint exists, so there is never a window with no
-- uniqueness guarantee on this pair.
drop index if exists athlete_actions_legacy_idx;

comment on constraint athlete_actions_legacy_uniq on public.athlete_actions is
  'Ties a row to the pathway_plan.milestones entry it came from. Deliberately NOT partial: a partial unique index cannot be named by PostgREST on_conflict, and NULLs are distinct in a unique constraint anyway, so the predicate excluded nothing.';

-- ============================================================
-- VERIFY AFTER APPLYING
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conrelid = 'athlete_actions'::regclass and contype = 'u';
--   -- expect athlete_actions_legacy_uniq UNIQUE (user_id, legacy_milestone_id)
--   select count(*) from pg_indexes
--     where tablename = 'athlete_actions' and indexname = 'athlete_actions_legacy_idx';
--   -- expect 0
--   select count(*) from athlete_actions;
--   -- expect 2, unchanged
-- ============================================================
