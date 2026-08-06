-- ============================================================
-- 054 — Generic AI response cache
-- Golsz Multi-Model AI Scout & Cost-Control System (approved plan).
--
-- scout_faq (migration 041) is a curated, admin-written Q&A table
-- matched by meaning via the classifier — valuable, but bounded to
-- what's been written. scout_response_cache is a plain TTL'd cache of
-- *actual* answers Scout has already produced, keyed by a normalized
-- (intent, sanitized query, model tier, prompt version) so a repeat of
-- the same effective question — same intent/tier/language/db-result
-- version — skips the model call entirely on the next hit. Personalized
-- replies (career_advice, scouting_analysis, anything touching
-- scout_context) are never cached — only genuinely shared, non-personal
-- answers (simple_knowledge, generic profile_assist copy, opportunity
-- searches with identical filters) are cache candidates; api/scout.js
-- decides candidacy, this table just stores what qualified.
--
-- Server-role only — cache lookups/writes happen inside api/scout.js,
-- never client-side, so no SELECT/INSERT policy for authenticated/anon.
-- ============================================================

create table if not exists scout_response_cache (
  id uuid primary key default gen_random_uuid(),
  cache_key text not null unique,
  intent text,
  model_tier text,
  response jsonb not null,
  expires_at timestamptz not null,
  hit_count int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists scout_response_cache_expires_idx on scout_response_cache (expires_at);

alter table scout_response_cache enable row level security;
-- no select/insert/update policy — service-role only, same as scout_model_config
