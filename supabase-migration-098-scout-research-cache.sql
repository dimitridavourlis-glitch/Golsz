-- 098 — SCOUT CACHE: reusable RESEARCH, not reusable replies
-- Scout Intelligence Architecture, layer 4.
--
-- Deliberately separate from scout_response_cache (migration 054), which
-- caches a whole formatted REPLY keyed by the exact question. That can't be
-- reused across athletes because the reply is personalised. This table
-- caches the FACTUAL RESULT of expensive research (a league structure, an
-- eligibility rule, a position benchmark) so a different athlete asking the
-- same factual question later doesn't re-pay for Sonnet + web search.
--
-- scope='global' rows are cross-user reusable (the spec's cross-user
-- research reuse) and deliberately carry NO athlete_id, so reuse can never
-- reveal which athlete's question originally triggered the research.
-- scope='athlete' rows are personal analysis and stay owner-only.
-- ============================================================

create table if not exists scout_research_cache (
  id uuid primary key default gen_random_uuid(),
  topic_key text not null,                    -- normalised topic, e.g. 'ncaa:transfer_rules:soccer'
  scope text not null default 'global' check (scope in ('global','athlete')),
  -- Enforced below: global rows must NOT be athlete-attributable.
  athlete_id uuid references profiles(id) on delete cascade,
  sport text,
  country text,
  summary text not null,
  sources jsonb not null default '[]'::jsonb,
  confidence numeric(3,2) not null default 0.5 check (confidence >= 0 and confidence <= 1),
  model_used text,
  -- Athlete-scoped analysis is only valid while the athlete's situation
  -- hasn't materially changed; this records the state it was computed against.
  athlete_state_hash text,
  valid_until timestamptz not null,
  hit_count int not null default 0,
  created_at timestamptz not null default now(),
  constraint scout_research_scope_shape check (
    (scope = 'global' and athlete_id is null) or (scope = 'athlete' and athlete_id is not null)
  )
);

create unique index if not exists scout_research_global_key_idx
  on scout_research_cache (topic_key) where scope = 'global';
create index if not exists scout_research_athlete_idx
  on scout_research_cache (athlete_id, topic_key) where scope = 'athlete';
create index if not exists scout_research_valid_idx on scout_research_cache (valid_until);

alter table scout_research_cache enable row level security;

-- Global research is readable by any signed-in athlete (that's the point —
-- shared institutional benefit). Athlete-scoped rows stay private.
drop policy if exists scout_research_read on scout_research_cache;
create policy scout_research_read on scout_research_cache for select using (
  scope = 'global' or athlete_id = auth.uid() or is_parent_of(athlete_id)
);
-- Writes are service-role only: a client must never be able to plant a
-- "fact" that other athletes would then be served as cached research.
