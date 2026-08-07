-- ============================================================
-- 082 — scout_routing_log: request_id, model_version, response_time_ms,
-- success (corrected pre-launch directive §7 — AI cost telemetry gaps)
-- Every prior scout_routing_log write (039/040/044/051) only ever fired on
-- a successful answer, so a failed request (both Sonnet and Haiku down,
-- logError-only today) left zero trace in cost/usage telemetry — the
-- Admin Panel's AI Model Usage view had no way to see failure rate at
-- all. api/scout.js now writes a row here for the exhausted-failover case
-- too, with success=false and no cost/tokens.
--
-- model_version is the literal model string that answered (e.g.
-- "claude-haiku-4-5"), distinct from answered_by (which only says the
-- *tier* — haiku/sonnet/database) and from provider (which only says
-- *who* — anthropic) — neither previously let anyone see which literal
-- model version was actually in use, which matters once model IDs get
-- swapped via SCOUT_HAIKU_MODEL/SCOUT_MODEL env vars.
--
-- request_id reuses the same client-supplied id already used for
-- isDuplicateRequest() idempotency — no new id scheme, just persisted
-- alongside the row it produced instead of only living in an in-memory
-- Map. response_time_ms is measured from handler entry to the point the
-- reply (or the exhausted-failover failure) is about to be returned.
-- ============================================================

alter table scout_routing_log add column if not exists request_id text;
alter table scout_routing_log add column if not exists model_version text;
alter table scout_routing_log add column if not exists response_time_ms int;
alter table scout_routing_log add column if not exists success boolean not null default true;

-- The original answered_by check constraint only allowed
-- ('haiku','sonnet','database') — too narrow for the new exhausted-
-- failover failure row (no model answered at all), so it's widened to
-- also allow 'failed'.
alter table scout_routing_log drop constraint if exists scout_routing_log_answered_by_check;
alter table scout_routing_log add constraint scout_routing_log_answered_by_check
  check (answered_by in ('haiku', 'sonnet', 'database', 'failed'));

-- Done.
-- ============================================================
