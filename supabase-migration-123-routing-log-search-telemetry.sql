-- ============================================================
-- 123 — Web-search telemetry on scout_routing_log
--
-- WHY
-- The 2026-08-11 cost audit could measure everything except the single
-- biggest cost driver. scout_routing_log already carries input_tokens,
-- output_tokens, cache_read_input_tokens, cache_creation_input_tokens and
-- estimated_cost_usd, which is where the blended $0.0422/call, the 52%
-- cache-read share and the token averages came from. What it could not
-- answer was "what fraction of messages trigger a web search, and what does
-- a search actually cost us", because nothing recorded that a search
-- happened. Sonnet calls averaged 55,835 cache-read tokens against Haiku's
-- 8,688, which is search results dominating the context — but that was an
-- inference, not a measurement, and you cannot tune a router on an
-- inference.
--
-- WHAT
-- Two counts per model call, taken from block types already present in the
-- response the handler parses:
--   web_search_count   — how many web_search_tool_result blocks came back
--   server_tool_calls  — how many server_tool_use blocks were issued
-- Keeping both separates "asked to search" from "got results", which is the
-- difference between a wasted search and a useful one.
--
-- NULL FOR HISTORY, 0 GOING FORWARD — DELIBERATELY, AND NOT A DEFAULT.
-- These columns are added WITHOUT a DEFAULT. In PostgreSQL 11+ an
-- `ADD COLUMN ... DEFAULT 0` backfills every existing row with 0, which
-- would assert that 255 historical calls performed no searches. They may
-- well have; we simply do not know. Leaving history NULL keeps "unknown"
-- distinguishable from "none", so the first week of real data is not
-- diluted by rows that never had the field.
--
-- This mirrors the reasoning already used for timeout_reason in this table
-- (migration 106), which defaults to the explicit string "none" on new rows
-- precisely so that NULL can keep meaning "this row predates the concept".
-- Same idea, opposite direction: there the default was chosen to make
-- "nothing went wrong" explicit; here the absence of a default is chosen to
-- stop a backfill inventing a fact.
--
-- The handler always writes an integer, so every row created after this
-- migration is explicit. A NULL appearing in new data would mean the capture
-- broke, which is a signal worth keeping visible.
--
-- NOTHING ELSE CHANGES. No index (the table is small and every planned query
-- is a full aggregate over a date range), no RLS change, no cost or routing
-- behaviour. Purely additive observation.
-- ============================================================

alter table scout_routing_log
  add column if not exists web_search_count int,
  add column if not exists server_tool_calls int;

comment on column scout_routing_log.web_search_count is
  'Count of web_search_tool_result blocks in the model response. NULL = row predates migration 123; 0 = no search performed.';
comment on column scout_routing_log.server_tool_calls is
  'Count of server_tool_use blocks issued in the model response. NULL = row predates migration 123; 0 = no server tool used.';

-- Verification:
--   select count(*)                                            as rows,
--          count(*) filter (where web_search_count is null)     as unknown_history,
--          count(*) filter (where web_search_count is not null) as measured,
--          count(*) filter (where web_search_count > 0)         as with_search
--     from scout_routing_log;
--   -- immediately after deploy: unknown_history = every existing row,
--   -- measured = 0. Both move only as new traffic arrives.
--
-- The analysis this unblocks:
--   -- search hit rate (measured rows only)
--   select round(100.0 * count(*) filter (where web_search_count > 0) / count(*), 1)
--     from scout_routing_log where web_search_count is not null;
--   -- cost with search vs without
--   select web_search_count > 0 as searched, count(*), round(avg(estimated_cost_usd)::numeric, 5)
--     from scout_routing_log where web_search_count is not null group by 1;
