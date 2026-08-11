-- ============================================================
-- 124 — Split 'database' into 'faq' and 'cache', and repair the
--       answered_by constraint that has been silently dropping rows.
--
-- WHY (1): THE QUESTION YOU CANNOT ANSWER TODAY
-- api/scout.js writes answered_by = 'database' at TWO different sites for
-- TWO different mechanisms:
--   • the FAQ match      — a pre-written answer from scout_faq (migration 041)
--   • the response cache — a previously generated reply (migration 054)
-- Both are $0-AI-cost, which is why they were lumped together. But the
-- correction gate shipped on 2026-08-11 (the Tusculum failure) added an
-- is_correction + short-reactive check to BOTH paths. If the $0 share moves,
-- the current label cannot say which gate moved it. A measurement that
-- returns a number, just not the number you are about to act on, is worse
-- than no measurement.
--
-- Going forward: 'faq' and 'cache' are distinct. Historical rows keep
-- 'database' and stay honestly ambiguous — the same reasoning as migration
-- 123's NULL-for-history: do not let a backfill invent a fact.
--
-- WHY (2): THE CONSTRAINT HAS BEEN REJECTING REAL ROWS
-- This is the actual bug found while doing the above, and it is worse than
-- the labelling problem.
--
--   migration 109 → check (... 'haiku','sonnet','database','failed')
--   migration 111 → DROP CONSTRAINT, then
--                   check (... 'haiku','sonnet','database','cross_provider')
--
-- Migration 111 dropped and re-added the constraint from scratch and did not
-- carry 'failed' forward. Since then, every `logRouting("failed", ...)` call
-- has produced a 400 from PostgREST. logRouting() does not check r.ok and
-- swallows everything in a try/catch, so the row simply never appeared and
-- nothing was logged about it. Failed Scout requests — the ones you most need
-- to count — have been invisible.
--
-- The bitter part: migration 111's own comment describes this exact failure
-- mode for cross_provider ("its INSERT is rejected by the constraint and
-- silently dropped ... the one situation you most need telemetry for would be
-- the one situation with no telemetry") and then reintroduces it for 'failed'
-- in the same statement. A drop-and-recreate of a CHECK constraint is a
-- rewrite of the whole list, not an addition to it.
--
-- This migration therefore states the list ONCE, in full, with every value
-- api/scout.js can actually pass. tests/test_answered_by_labels.cjs asserts
-- that set equals the set of literals in scout.js, so the next person to add
-- a routing outcome gets a red test instead of silent data loss.
--
-- WHY (3): THE DASHBOARD COUNTS BY LITERAL
-- admin_scout_model_mix() counts 'haiku', 'sonnet' and 'database' by name.
-- Introducing 'cache' without touching it would have made those rows vanish
-- from the Admin Panel rather than move — a third instance of the same trap
-- in the same column. 'cross_provider' and 'failed' were already uncounted,
-- so 'total' has not equalled the sum of the parts for some time. Both are
-- added here.
--
-- No data is modified. No row is rewritten. Purely constraint + reporting.
-- ============================================================

-- ---- 1. One authoritative list -------------------------------------------
-- Every literal api/scout.js passes to logRouting(), in one place:
--   haiku · sonnet · cross_provider · failed · database (history) · faq · cache
alter table scout_routing_log drop constraint if exists scout_routing_log_answered_by_check;
alter table scout_routing_log add constraint scout_routing_log_answered_by_check
  check (answered_by in ('haiku', 'sonnet', 'database', 'cross_provider', 'failed', 'faq', 'cache'));

comment on column scout_routing_log.answered_by is
  'Which path produced the reply. haiku/sonnet = a real model call; cross_provider = emergency non-Anthropic fallback; failed = no reply produced; faq = pre-written scout_faq answer; cache = scout_response_cache hit; database = pre-migration-124 rows where faq and cache were indistinguishable.';

-- ---- 2. Reporting counts every value it can now see -----------------------
create or replace function admin_scout_model_mix()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  result jsonb;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select jsonb_build_object(
    'total', count(*),
    'haiku', count(*) filter (where answered_by = 'haiku'),
    'sonnet', count(*) filter (where answered_by = 'sonnet'),
    -- 'database' is retained so historical rows keep reporting. New traffic
    -- lands in 'faq' or 'cache'; this bucket should stop growing and its
    -- staleness is itself the signal that the split took effect.
    'database', count(*) filter (where answered_by = 'database'),
    'faq', count(*) filter (where answered_by = 'faq'),
    'cache', count(*) filter (where answered_by = 'cache'),
    'cross_provider', count(*) filter (where answered_by = 'cross_provider'),
    'failed', count(*) filter (where answered_by = 'failed'),
    'sonnet_by_plan', (
      select coalesce(jsonb_object_agg(coalesce(plan, 'unknown'), n), '{}'::jsonb)
      from (
        select plan, count(*) as n
        from scout_routing_log
        where answered_by = 'sonnet'
        group by plan
      ) s
    ),
    'sonnet_escalation_reasons', (
      select coalesce(jsonb_object_agg(coalesce(escalation_reason, 'unknown'), n), '{}'::jsonb)
      from (
        select escalation_reason, count(*) as n
        from scout_routing_log
        where answered_by = 'sonnet'
        group by escalation_reason
      ) s
    )
  ) into result
  from scout_routing_log;
  return result;
end;
$$;

grant execute on function admin_scout_model_mix() to authenticated;

-- Verification:
--   -- the constraint accepts everything scout.js can send
--   select unnest(array['haiku','sonnet','database','cross_provider','failed','faq','cache']) as v;
--   -- and the split becomes visible as traffic arrives
--   select answered_by, count(*), min(created_at), max(created_at)
--     from scout_routing_log group by 1 order by 2 desc;
--   -- immediately after deploy: faq = 0, cache = 0, database = every old row.
--   -- 'failed' should start appearing for the first time since migration 111.
--
-- ============================================================
-- RE-MEASURING LATENCY AFTER 2026-08-11: SPLIT BY PATH, NEVER BLENDED.
--
-- Later the same day, two routing bugs were fixed that had been forcing
-- ordinary conversation onto Sonnet (a classifier field leaking into the
-- intent enum, and an over-broad statement-form escalation rule). The fix
-- moves a large share of traffic back onto Haiku and the $0 paths.
--
-- That means the NEXT latency reading is taken over a different population.
-- The blended average will improve dramatically and most of that improvement
-- will be COMPOSITION, NOT SPEED. Comparing a blended before/after would say
-- "latency fixed itself" and skip the streaming decision on an artifact.
--
-- Same-day baseline to compare against, per path, measured rows only:
--   sonnet  ~25-27s avg, 48.6s max   (against a 50s SCOUT_BUDGET_MS)
--   haiku    ~12.7s avg, 18.6s max
--   faq/cache ~2.5s
-- n = 13, so treat these as a lower bound on the tail, not a distribution:
-- anything that died past the budget could not be logged at the time.
--
--   select answered_by,
--          count(*)                                as n,
--          round(avg(response_time_ms))            as avg_ms,
--          percentile_cont(0.95) within group (order by response_time_ms) as p95_ms,
--          max(response_time_ms)                   as max_ms
--     from scout_routing_log
--    where created_at > '2026-08-11 13:30+00'
--    group by 1 order by 3 desc;
--
-- The decision this feeds: whether to stream the reply instead of returning
-- it whole. Sonnet's ~25s is structural, so the question is what share of
-- traffic still lands there AFTER the routing fix, and what its p95 is — not
-- what the overall average did.
-- ============================================================
