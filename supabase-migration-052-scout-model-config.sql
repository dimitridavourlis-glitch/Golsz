-- ============================================================
-- 052 — Admin-editable model/pricing config
-- Golsz Multi-Model AI Scout & Cost-Control System (approved plan).
--
-- Today MODEL_REGISTRY in api/scout.js hardcodes model IDs and their
-- prices live only in a PRICING constant used for cost estimation —
-- neither is admin-editable without a deploy. scout_model_config makes
-- provider/model/tier/pricing a runtime, admin-editable row set;
-- api/scout.js reads it (service-role, bypasses RLS) to pick which
-- model answers a given tier and to estimate cost before calling it,
-- falling back to its own hardcoded defaults if a tier has no
-- enabled row (so a bad edit here degrades gracefully, never hard-fails
-- Scout).
--
-- Economy/standard point at Haiku and advanced/premium point at Sonnet
-- today — the only two models GOLSZ actually calls. Gemini/Grok/OpenAI
-- rows are seeded disabled (enabled=false) as real, ready-to-flip
-- placeholders: turning one on is editing this table (or the admin
-- RPC below), not a code change — but nothing here has been tested
-- against a real key, so they stay off until that happens deliberately.
--
-- Admin-only: no SELECT policy (service-role bypasses RLS for the
-- request-time read); admin dashboard reads via admin_get_model_config()
-- and writes enabled/priority via admin_update_model_config(), same
-- is_admin()-gated security-definer pattern used throughout this schema.
-- ============================================================

create table if not exists scout_model_config (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model_name text not null,
  model_tier text not null check (model_tier in ('economy', 'standard', 'advanced', 'premium')),
  input_cost_per_million numeric not null,
  output_cost_per_million numeric not null,
  cached_input_cost_per_million numeric,
  max_output_tokens int not null,
  enabled boolean not null default true,
  priority int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, model_name, model_tier)
);

alter table scout_model_config enable row level security;

create or replace function admin_get_model_config()
returns setof scout_model_config language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  return query select * from scout_model_config order by model_tier, priority;
end;
$$;

grant execute on function admin_get_model_config() to authenticated;

-- Deliberately narrow write surface: live enable/disable + priority
-- reordering is the operational lever (kill a misbehaving model, or
-- prefer a cheaper one within a tier) without a deploy. Pricing/model
-- edits go through the SQL editor directly — rare, deliberate changes,
-- not something the admin panel needs a form for on day one.
create or replace function admin_update_model_config(p_id uuid, p_enabled boolean, p_priority int)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  update scout_model_config set enabled = p_enabled, priority = coalesce(p_priority, priority), updated_at = now() where id = p_id;
end;
$$;

grant execute on function admin_update_model_config(uuid, boolean, int) to authenticated;

-- Seed real, currently-paid-for models plus disabled placeholders for
-- the providers named in the spec. Cached-input rates are Anthropic's
-- ~10% (Haiku) / ~20% (Sonnet, verified this session) of input price.
-- Placeholder model IDs (Gemini/Grok/OpenAI) are current as of this
-- session's own pricing lookup but MUST be re-verified against the
-- provider's live pricing page before ever setting enabled = true.
insert into scout_model_config (provider, model_name, model_tier, input_cost_per_million, output_cost_per_million, cached_input_cost_per_million, max_output_tokens, enabled, priority) values
  ('anthropic', 'claude-haiku-4-5', 'economy', 1, 5, 0.1, 1024, true, 10),
  ('anthropic', 'claude-haiku-4-5', 'standard', 1, 5, 0.1, 2048, true, 10),
  ('anthropic', 'claude-sonnet-5', 'advanced', 3, 15, 0.3, 4096, true, 10),
  ('anthropic', 'claude-sonnet-5', 'premium', 3, 15, 0.3, 4096, true, 10),
  ('google', 'gemini-3.1-flash-lite', 'economy', 0.25, 1.5, null, 1024, false, 20),
  ('xai', 'grok-4.1-fast', 'economy', 0.20, 0.50, 0.05, 1024, false, 20),
  ('openai', 'gpt-5-mini', 'economy', 0.25, 2, null, 1024, false, 30)
on conflict (provider, model_name, model_tier) do nothing;
