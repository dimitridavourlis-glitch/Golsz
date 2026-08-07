-- ============================================================
-- 092 — plan_config: GOLSZ product knowledge, database-first
-- (GOLSZ Final Product / AI Scout / Pathway / Elite Architecture directive
-- §10: "AI Scout must understand FREE/BASIC/PRO/ELITE... the database/
-- configuration must be the source of truth. Do not hard-code aspirational
-- features into prompts as if they are already live.")
--
-- Mirrors the existing scout_model_config pattern (migration 052) — same
-- service-role-only RLS (no policies at all; api/scout.js reads it with
-- the service key server-side, same as getModelConfigByTier()). The
-- client-side PLANS/FEATURE_MIN_PLAN in golsz-app.html are NOT replaced by
-- this — this table exists so Scout's own context can ground itself in
-- real, current plan facts instead of whatever the model prompt happens
-- to say, without needing a deploy to correct a stale claim. Seeded from
-- the exact live values already in golsz-app.html's PLANS constant and
-- api/scout.js's *_DAILY_LIMIT / FREE_LIFETIME_LIMIT env vars at the time
-- of this migration.
-- ============================================================

create table if not exists plan_config (
  plan_id text primary key check (plan_id in ('free', 'starter', 'pro', 'elite')),
  plan_name text not null,
  tagline text,
  price_usd numeric not null,
  display_order int not null,
  live_features jsonb not null default '[]'::jsonb,
  coming_soon_features jsonb not null default '[]'::jsonb,
  ai_daily_question_limit int,
  ai_lifetime_question_limit int,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table plan_config enable row level security;
-- no select/insert/update policy — service-role only, same as scout_model_config

insert into plan_config (plan_id, plan_name, tagline, price_usd, display_order, live_features, ai_daily_question_limit, ai_lifetime_question_limit) values
  ('free', 'Free', 'Understand me', 0,
    0,
    '["Digital Sports Passport", "Profile creation & editing", "Approved media links, achievements, career history", "General AI Scout conversation & athlete discovery", "Basic recruiting/development explanations"]'::jsonb,
    3, 40),
  ('starter', 'Basic', 'Build my path', 6,
    1,
    '["Everything in Free", "Personalized Pathway", "Baseline assessment", "My Next Move", "Target identification & basic target lists", "Basic outreach strategy", "AI-drafted introduction emails", "Passport PDF export", "Milestones & basic action planning", "Ongoing AI Scout access"]'::jsonb,
    8, null),
  ('pro', 'Pro', 'Manage my journey', 14,
    2,
    '["Everything in Basic", "Richer target lists & status tracking", "Outreach & follow-up tracking", "Monthly/weekly objectives & reminders", "GOLSZ Readiness", "Progress reviews", "Deeper AI Scout involvement & opportunity research", "Periodic pathway reassessment"]'::jsonb,
    15, null),
  ('elite', 'Elite', 'Live the plan', 30,
    3,
    '["Everything in Pro", "Training organization", "Performance benchmarks", "Schedule", "Athlete diary", "Recovery, sleep & general nutrition education", "Reminders & push alerts", "Periodic reassessment", "GOLSZ Motion exercise demonstrations"]'::jsonb,
    20, null)
on conflict (plan_id) do update set
  plan_name = excluded.plan_name, tagline = excluded.tagline, price_usd = excluded.price_usd,
  display_order = excluded.display_order, live_features = excluded.live_features,
  ai_daily_question_limit = excluded.ai_daily_question_limit,
  ai_lifetime_question_limit = excluded.ai_lifetime_question_limit,
  updated_at = now();

-- ============================================================
-- Done.
