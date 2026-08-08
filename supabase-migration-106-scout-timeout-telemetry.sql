-- Migration 106 — timeout / fallback telemetry on scout_routing_log
--
-- Step 8 of the Scout context/memory/routing directive asks for per-request
-- logging of: provider, model, latency, timeout reason, fallback used, and
-- response success/failure.
--
-- Four of those six already exist and are populated:
--   provider          (migration 051)
--   model_version     (migration 082)
--   response_time_ms  (migration 082)
--   success           (migration 082)
--
-- The two genuinely missing ones are added here. They are what turn "Scout
-- occasionally times out" from an anecdote into something answerable,
-- because the user-visible message ("That one took me too long to work
-- through. Send it again...") is emitted CLIENT-side by
-- AbortSignal.timeout(58000) in golsz-app.html and therefore says nothing
-- at all about which layer actually ran long.
--
-- timeout_reason is deliberately a constrained vocabulary rather than free
-- text, so it can be grouped in the Admin Panel without string cleanup:
--   classifier_timeout    the 4.5s withTimeout() around classifyIntent()
--                         fired; routing degraded to the complexity score.
--   tool_budget_exhausted runDeepReply() stopped its tool loop because
--                         SCOUT_BUDGET_MS left no room for another turn.
--   retry_skipped         the deep call failed and there was not enough
--                         budget left to retry it at all.
--   provider_error        the provider returned a non-ok response.
--   none                  completed inside budget.
--
-- fallback_used records WHICH degraded path produced the answer, so a reply
-- that succeeded only because it fell back is never counted as a clean
-- success in the model-mix cards:
--   sonnet_retry          the deep call was retried once and then worked.
--   haiku_cross_model     cross-model fallback to a plain no-tools Haiku.
--   none                  primary path answered.
--
-- Both nullable with no default: an old row predates the concept and should
-- read as unknown, not be silently backfilled as "none".

alter table scout_routing_log add column if not exists timeout_reason text;
alter table scout_routing_log add column if not exists fallback_used text;

alter table scout_routing_log drop constraint if exists scout_routing_log_timeout_reason_check;
alter table scout_routing_log add constraint scout_routing_log_timeout_reason_check
  check (timeout_reason is null or timeout_reason in
    ('none', 'classifier_timeout', 'tool_budget_exhausted', 'retry_skipped', 'provider_error'));

alter table scout_routing_log drop constraint if exists scout_routing_log_fallback_used_check;
alter table scout_routing_log add constraint scout_routing_log_fallback_used_check
  check (fallback_used is null or fallback_used in ('none', 'sonnet_retry', 'haiku_cross_model'));

-- Partial index: the interesting rows are the degraded ones, and they are a
-- small minority of traffic, so an index over just those keeps the "what is
-- going wrong lately" query cheap without carrying every clean row.
create index if not exists scout_routing_log_degraded_idx
  on scout_routing_log (created_at desc)
  where (timeout_reason is not null and timeout_reason <> 'none')
     or (fallback_used is not null and fallback_used <> 'none')
     or not success;
