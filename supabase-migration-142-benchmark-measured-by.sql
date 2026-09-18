-- ============================================================
-- 142 — Who took the measurement (Step 4, benchmark provenance)
--
-- Applied to production 2026-09-18. Verified: column present and nullable,
-- 0 of 3 existing rows backfilled, constraint present and rejecting anything
-- but self/coach/official or NULL.
--
-- Migration 114 gave athlete_benchmarks the HOW: metric_key plus a protocol
-- jsonb holding the measurement dimensions the athlete answered. It did not
-- give it the WHO, and the Passport brief asks for both — "hand-timed,
-- electronic, and who measured it".
--
-- WHY THIS IS NOT JUST ANOTHER KEY IN protocol.
-- 114 documents that column as holding "only the PROTOCOL_DIMENSIONS the
-- athlete actually reported", and api/scout.js owns that list. The client is
-- held to it: tests/test_benchmark_input.cjs lifts PROTOCOL_DIMENSIONS out of
-- api/scout.js and asserts the picker offers no dimension the engine does not
-- know, and exactly the values it does know. That guard is correct — the
-- engine decides what is comparable, and a client inventing a dimension would
-- be asserting a comparability the server never agreed to. So this gets its
-- own column rather than smuggling a non-engine key into a documented one.
--
-- WHY IT IS NOT A COMPARABILITY DIMENSION EITHER.
-- Two hand-timed sprints are the same measurement whoever held the watch. Who
-- measured changes how much a READER should trust the number, not what the
-- number means, so it must never join a protocol signature or the Passport
-- would start refusing to compare readings that are genuinely comparable.
-- It is provenance, displayed beside the reading and never used to gate a
-- trend.
--
-- NULL MEANS NOT RECORDED, FOREVER, AND IS NEVER BACKFILLED.
-- Every existing row gets NULL, and the Passport already renders "Method not
-- recorded" for an absent protocol. Guessing that historical readings were
-- self-measured because most probably were is exactly the fabrication 114 was
-- written to prevent. The check constraint allows NULL for that reason.
--
-- No index: this is read with the row it belongs to and filtered by nothing.
-- ============================================================

alter table athlete_benchmarks add column if not exists measured_by text;

alter table athlete_benchmarks drop constraint if exists athlete_benchmarks_measured_by_check;
alter table athlete_benchmarks add constraint athlete_benchmarks_measured_by_check
  check (measured_by is null or measured_by in ('self', 'coach', 'official'));

comment on column athlete_benchmarks.measured_by is
  'Who took the measurement: self, coach, official. NULL means not recorded and must never be inferred. Provenance for a reader, NOT a comparability dimension — it must never affect whether two readings can be compared.';

-- Verification:
--   select metric, protocol, measured_by from athlete_benchmarks limit 20;
--   -- every pre-existing row: measured_by NULL. Expected.
--
--   -- the constraint rejects anything else:
--   insert into athlete_benchmarks (user_id, metric, value, measured_by)
--   values (auth.uid(), 'test', 1, 'physio');   -- must fail
