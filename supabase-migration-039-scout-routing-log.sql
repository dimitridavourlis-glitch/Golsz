-- ============================================================
-- 039 — Scout AI routing log
-- Additive on top of 002 + 004 + ... + 038.
--
-- Records which model actually answered each real Scout reply — haiku,
-- sonnet, or database (a placeholder bucket that stays at 0 until
-- DB-first club/coach/opportunity search replaces some of Sonnet's
-- tool-use calls with a direct query, no LLM involved). Written from
-- api/scout.js via the service-role key on every successful reply.
--
-- Deliberately does NOT store the question or answer text — only the
-- routing decision (which model, what intent, what confidence) — so
-- this table can be safely read in aggregate without touching the same
-- "never expose real conversation content" boundary that kept
-- scout_history and messages out of admin_analytics_counts() (028).
-- RLS is enabled with no select policy at all; the only read path is
-- the security-definer RPC below, same is_admin()-gated pattern used
-- throughout this schema.
-- ============================================================

create table if not exists scout_routing_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  answered_by text not null check (answered_by in ('haiku', 'sonnet', 'database')),
  intent text,
  confidence numeric
);

alter table scout_routing_log enable row level security;
-- No select/insert/update/delete policies for authenticated/anon —
-- only the service-role key (used server-side in api/scout.js) can
-- write, and only admin_scout_model_mix() below can read, in aggregate.

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
    'database', count(*) filter (where answered_by = 'database')
  ) into result
  from scout_routing_log;
  return result;
end;
$$;

grant execute on function admin_scout_model_mix() to authenticated;

-- ============================================================
-- Done.
-- ============================================================
