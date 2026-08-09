-- ============================================================
-- 114 — Benchmark protocol capture (P1-2)
--
-- The BENCHMARK INTELLIGENCE V1.2 layer in api/scout.js can tell whether two
-- measurements are comparable — hand vs electronic timing, standing vs
-- approach vertical, different sprint distances. None of that reaches an
-- athlete's own numbers, because athlete_benchmarks stores only a free-text
-- metric name, a value and a free-text unit. "40 yard dash / 4.5 / s" with no
-- timing method is not comparable to anything, and never will be.
--
-- Two columns close that:
--
--   metric_key  the canonical SPORT_SCHEMAS performance_indicators key
--               (sprint_10m, vertical_jump, lane_agility, ...) when the
--               athlete picked from their sport's list. NULL for a free-text
--               entry — the 39 sports with no schema keep working exactly as
--               before, and so does any metric a schema doesn't name.
--
--   protocol    jsonb holding only the PROTOCOL_DIMENSIONS the athlete
--               actually answered: {"timing_method":"electronic",
--               "start_type":"standing"}. Absent keys mean unknown and must
--               stay unknown — protocolCompatible() already treats an
--               unreported dimension as a caveat rather than a guess, and
--               nothing here may invent one to make a comparison possible.
--
-- Existing rows get NULL for both. They remain stored, visible and the
-- athlete's own history; they simply cannot become comparable retroactively,
-- because nobody recorded how they were measured. Backfilling a guess would
-- be fabricating measurement provenance, which is the one thing the whole
-- benchmark layer exists to prevent.
--
-- This changes NOTHING about scoring. BENCHMARK_BANDS is still empty,
-- readinessScoringReady() still returns false, and no comparison is offered
-- anywhere in the UI. This is the input side catching up with the reference
-- side so that real data, when it arrives, has something to compare against.
-- ============================================================

alter table athlete_benchmarks add column if not exists metric_key text;
alter table athlete_benchmarks add column if not exists protocol jsonb;

comment on column athlete_benchmarks.metric_key is
  'Canonical SPORT_SCHEMAS performance_indicators key, or NULL for a free-text metric. Set by the client only from its own picker.';
comment on column athlete_benchmarks.protocol is
  'Only the measurement-protocol dimensions the athlete actually reported. A missing key means UNKNOWN and must never be inferred.';

-- Cheap and useful once reference data exists: "every 10m sprint recorded
-- with electronic timing" is the shape of every future comparison query.
create index if not exists athlete_benchmarks_metric_key_idx
  on athlete_benchmarks (metric_key) where metric_key is not null;

-- Verification:
--   select metric, metric_key, protocol from athlete_benchmarks limit 20;
--   -- pre-existing rows: metric_key NULL, protocol NULL. Expected.
