-- Migration 111 — telemetry support for the cross-provider failover
--
-- Context: until now every model GOLSZ could call was Anthropic, and the
-- "automatic failover" chain was Sonnet -> Sonnet retry -> Haiku. All three
-- are the same vendor, so an Anthropic-wide outage exhausted the whole chain
-- and AI Scout went dark — a live violation of Master Architecture
-- Non-Negotiable #2 ("GOLSZ must not depend on a single AI provider").
--
-- api/scout.js now adds a final cross-PROVIDER step using an
-- OpenAI-compatible endpoint, configured entirely by env vars and inert
-- unless SCOUT_FALLBACK_API_KEY is set.
--
-- This migration only widens two CHECK constraints and one reporting
-- function so that step is VISIBLE. Without it the new path still answers
-- the athlete, but its scout_routing_log INSERT is rejected by the
-- constraint and silently dropped (logRouting is best-effort by design), so
-- the one situation you most need telemetry for — a provider outage —
-- would be the one situation with no telemetry. No data is modified.

-- answered_by: 'cross_provider' joins haiku/sonnet/database. Kept as its own
-- value rather than reusing 'haiku'/'sonnet' so cost and model-mix reporting
-- can never confuse a degraded third-party reply with a normal Anthropic one.
alter table scout_routing_log drop constraint if exists scout_routing_log_answered_by_check;
alter table scout_routing_log add constraint scout_routing_log_answered_by_check
  check (answered_by in ('haiku', 'sonnet', 'database', 'cross_provider'));

-- fallback_used: 'cross_provider' records that the answer only exists because
-- the emergency provider caught it. Same rationale as the existing
-- 'sonnet_retry'/'haiku_cross_model' values — a reply that succeeded only via
-- fallback must never read as a clean success.
alter table scout_routing_log drop constraint if exists scout_routing_log_fallback_used_check;
alter table scout_routing_log add constraint scout_routing_log_fallback_used_check
  check (fallback_used is null or fallback_used in
    ('none', 'sonnet_retry', 'haiku_cross_model', 'cross_provider'));

-- The Admin Panel's model-mix card counts each answered_by value explicitly,
-- so a cross_provider row would land in 'total' while being invisible in the
-- breakdown — the numbers would silently stop adding up during an outage,
-- which is precisely when someone is staring at them. Same function shape as
-- before, one extra counter.
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
    'database', count(*) filter (where answered_by = 'database'),
    'cross_provider', count(*) filter (where answered_by = 'cross_provider'),
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
