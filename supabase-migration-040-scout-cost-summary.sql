-- ============================================================
-- 040 — Scout monthly cost summary
-- Additive on top of 002 + 004 + ... + 039.
--
-- Extends scout_routing_log (migration 039) with real token usage and an
-- estimated dollar cost per reply, computed server-side in api/scout.js
-- from Anthropic's own usage numbers (same pricing math verified against
-- real production traffic earlier: input/output tokens at each model's
-- per-1M rate, cache reads at ~10% of input price, cache writes at
-- ~1.25x). This is an estimate for planning/budgeting, not a bill —
-- Anthropic's own invoice is always the source of truth — but it tracks
-- closely since it's built from the same real usage figures the API
-- returns for every call.
--
-- admin_scout_cost_summary() (security definer, is_admin()-gated, same
-- pattern as every other admin RPC here) returns this month's total
-- estimated cost, average cost per message, and message count — powers
-- the Admin Panel Analytics tab's two new monthly cost cards. Token
-- counts and cost are the only new columns; still never the question or
-- answer text.
-- ============================================================

alter table scout_routing_log
  add column if not exists input_tokens bigint,
  add column if not exists cache_read_input_tokens bigint,
  add column if not exists cache_creation_input_tokens bigint,
  add column if not exists output_tokens bigint,
  add column if not exists estimated_cost_usd numeric;

create or replace function admin_scout_cost_summary()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  result jsonb;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select jsonb_build_object(
    'message_count_month', count(*),
    'total_cost_month', coalesce(sum(estimated_cost_usd), 0),
    'avg_cost_per_message_month', coalesce(avg(estimated_cost_usd), 0)
  ) into result
  from scout_routing_log
  where created_at >= date_trunc('month', now());
  return result;
end;
$$;

grant execute on function admin_scout_cost_summary() to authenticated;

-- ============================================================
-- Done.
-- ============================================================
