-- ============================================================
-- 044 — scout_routing_log: subscription tier + escalation reason
-- Additive on top of 002 + ... + 043.
--
-- The model-routing protocol (Haiku/Sonnet/Database) already runs and is
-- already logged (migration 039) with intent/confidence/tokens/cost — but
-- two things it asks to record were still missing: which subscription
-- tier the athlete was on, and *why* a message escalated past Haiku. Both
-- are pure routing metadata, same privacy bar as the rest of this table —
-- no question/answer text, no user_id, nothing identifying. Needed before
-- GOLSZ can actually see whether Sonnet usage differs meaningfully by
-- tier, which is the real prerequisite for any tier-based Sonnet quota
-- (a bigger, separate decision — not part of this migration).
-- ============================================================

alter table scout_routing_log add column if not exists plan text;
alter table scout_routing_log add column if not exists escalation_reason text;

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

-- ============================================================
-- Done.
-- ============================================================
