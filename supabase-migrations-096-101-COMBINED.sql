-- GOLSZ Scout Intelligence Architecture — migrations 096-101
-- Paste this whole file into the Supabase SQL Editor and Run once.
-- Safe to re-run: every statement is idempotent (if not exists / or replace / on conflict).

-- ===== 096-golsz-knowledge =====
-- 096 — GOLSZ CORE: institutional knowledge base
-- Scout Intelligence Architecture, layer 1. The spec is explicit that we
-- should NOT hand-populate a worldwide sports database here — this builds
-- the ARCHITECTURE so verified entries can be added/sourced/rechecked
-- progressively, and so a fact researched for one athlete is reusable for
-- every other athlete (Level 3 network learning) without re-paying for it.
--
-- verification_status is the candidate-knowledge pipeline the spec asks
-- for. Only 'verified'/'active' rows are ever presented to an athlete as
-- GOLSZ knowledge; 'discovered'/'candidate' rows are Scout's own research
-- output awaiting review, and are deliberately NOT readable by clients.
-- This is the structural guarantee behind "USER CLAIMS ARE NOT GLOBAL
-- FACTS / SCOUT INFERENCES ARE NOT GLOBAL FACTS".
-- ============================================================

create table if not exists golsz_knowledge (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  category text not null,                      -- eligibility | league | pathway | transfer | benchmark | recruiting_calendar | governing_body | product | other
  sport text,                                  -- null = sport-agnostic (e.g. NCAA amateurism)
  country text,
  league text,
  rule_type text,
  content text not null,
  source text,
  source_url text,
  confidence numeric(3,2) not null default 0.5 check (confidence >= 0 and confidence <= 1),
  verification_status text not null default 'discovered'
    check (verification_status in ('discovered','candidate','verified','active','stale','rejected')),
  discovered_at timestamptz not null default now(),
  verified_at timestamptz,
  last_checked timestamptz,
  -- Time-sensitive knowledge (transfer windows, eligibility rules, rosters)
  -- must expire rather than silently harden into permanent "fact".
  recheck_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists golsz_knowledge_lookup_idx
  on golsz_knowledge (category, sport, country)
  where verification_status in ('verified','active');
create index if not exists golsz_knowledge_subject_idx on golsz_knowledge (lower(subject));
create index if not exists golsz_knowledge_recheck_idx on golsz_knowledge (recheck_after)
  where verification_status in ('verified','active');

alter table golsz_knowledge enable row level security;

-- Only trusted knowledge is client-readable. Unverified research output is
-- server-side only, so it can never reach an athlete as though GOLSZ had
-- verified it.
drop policy if exists golsz_knowledge_read_trusted on golsz_knowledge;
create policy golsz_knowledge_read_trusted on golsz_knowledge for select using (
  verification_status in ('verified','active')
);
-- Writes: service-role (api/scout.js) or admin only. No client-side insert.
drop policy if exists golsz_knowledge_admin_write on golsz_knowledge;
create policy golsz_knowledge_admin_write on golsz_knowledge for all
  using (is_admin()) with check (is_admin());

-- Retrieval helper. Returns ONLY trusted, non-stale rows, newest/most
-- confident first — the "search GOLSZ Core" step of the request flow.
create or replace function search_golsz_knowledge(
  p_query text default null,
  p_category text default null,
  p_sport text default null,
  p_country text default null,
  p_limit int default 5
)
returns table (
  subject text, category text, sport text, country text, league text,
  content text, source text, source_url text, confidence numeric, verified_at timestamptz
)
language sql security definer set search_path to 'public' as $$
  select k.subject, k.category, k.sport, k.country, k.league,
         k.content, k.source, k.source_url, k.confidence, k.verified_at
  from golsz_knowledge k
  where k.verification_status in ('verified','active')
    and (k.recheck_after is null or k.recheck_after > now())
    and (p_category is null or k.category = p_category)
    and (p_sport is null or k.sport is null or k.sport ilike p_sport)
    and (p_country is null or k.country is null or k.country ilike p_country)
    and (p_query is null or k.subject ilike '%' || p_query || '%' or k.content ilike '%' || p_query || '%')
  order by k.confidence desc, k.verified_at desc nulls last
  limit least(coalesce(p_limit, 5), 20);
$$;
grant execute on function search_golsz_knowledge(text, text, text, text, int) to authenticated;

-- ===== 097-scout-memory =====
-- 097 — SCOUT MEMORY: the living athlete intelligence file
-- Scout Intelligence Architecture, layer 3 — the most important addition.
--
-- This does NOT replace athletes.scout_context (migration 050). That column
-- already holds 17 typed fields with {value, source, confidence} and is
-- still the fast "what does Scout know about the softer stuff" lookup.
-- scout_memory is the ADDITIVE part scout_context can't express: many rows
-- per subject, an explicit type taxonomy, supersession history, and
-- importance ranking for retrieval.
--
-- The critical rule from the spec — FACTS and INFERENCES must never be
-- treated as the same thing — is enforced by `type` being a hard CHECK
-- constraint, not a convention. A row's type cannot drift.
--
-- superseded_by implements the contradiction rule: when the athlete's club
-- changes, the old row goes active=false + superseded_by=<new row>, so
-- current state is unambiguous while career history is preserved.
-- ============================================================

create table if not exists scout_memory (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references profiles(id) on delete cascade,
  type text not null check (type in (
    'FACT','USER_STATED','SCOUT_INFERENCE','GOAL','PREFERENCE','CONCERN',
    'UNKNOWN','NEXT_DATA_NEEDED','ASSESSMENT','DECISION',
    'PATHWAY_CONSIDERED','PATHWAY_REJECTED','PATHWAY_ACTIVE','MILESTONE'
  )),
  sport text,
  subject text not null,
  content text not null,
  confidence numeric(3,2) not null default 0.5 check (confidence >= 0 and confidence <= 1),
  source text,                                  -- 'athlete_stated' | 'scout_inference' | 'profile' | 'research' | 'outcome'
  importance int not null default 3 check (importance between 1 and 5),
  active boolean not null default true,
  superseded_by uuid references scout_memory(id) on delete set null,
  last_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Reserved for optional semantic retrieval later. Nullable and unused for
  -- now: deterministic retrieval ships today, so enabling pgvector later is
  -- a backfill rather than a migration rewrite, and GOLSZ's intelligence
  -- stays model-independent (no embedding-provider dependency) meanwhile.
  embedding_pending boolean not null default false
);

-- Retrieval path: active memory for this athlete, most important first.
create index if not exists scout_memory_retrieval_idx
  on scout_memory (athlete_id, active, importance desc, updated_at desc);
create index if not exists scout_memory_type_idx on scout_memory (athlete_id, type) where active;
create index if not exists scout_memory_unknowns_idx
  on scout_memory (athlete_id, importance desc) where active and type in ('UNKNOWN','NEXT_DATA_NEEDED');

alter table scout_memory enable row level security;

-- Private to the athlete (and their guardian for a managed minor account) —
-- same self-service pattern pathway_plan/development_plan_items use. No
-- admin read policy: this is an athlete's private intelligence file, and
-- Level 1 of the spec's learning model says it must never leak sideways.
drop policy if exists scout_memory_own_read on scout_memory;
create policy scout_memory_own_read on scout_memory for select using (
  athlete_id = auth.uid() or is_parent_of(athlete_id)
);
drop policy if exists scout_memory_own_write on scout_memory;
create policy scout_memory_own_write on scout_memory for all
  using (athlete_id = auth.uid() or is_parent_of(athlete_id))
  with check (athlete_id = auth.uid() or is_parent_of(athlete_id));

-- Supersede-and-insert in one atomic step (the contradiction rule).
-- security definer so api/scout.js can call it with the verified user id;
-- p_athlete is never taken from the client request body.
create or replace function supersede_scout_memory(
  p_athlete uuid, p_type text, p_subject text, p_content text,
  p_confidence numeric default 0.6, p_source text default 'athlete_stated',
  p_importance int default 3
)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_new uuid;
begin
  insert into scout_memory (athlete_id, type, subject, content, confidence, source, importance, last_confirmed_at)
  values (p_athlete, p_type, p_subject, p_content, p_confidence, p_source, p_importance, now())
  returning id into v_new;
  -- Any earlier ACTIVE row on the same subject+type is now history, not a
  -- competing truth.
  update scout_memory
     set active = false, superseded_by = v_new, updated_at = now()
   where athlete_id = p_athlete and type = p_type
     and lower(subject) = lower(p_subject)
     and id <> v_new and active;
  return v_new;
end;
$$;
revoke execute on function supersede_scout_memory(uuid, text, text, text, numeric, text, int) from anon, authenticated;

-- ===== 098-scout-research-cache =====
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

-- ===== 099-product-capabilities =====
-- 099 — PRODUCT CAPABILITIES: single source of truth for what GOLSZ can do
-- Scout Intelligence Architecture — closes the "never recommend
-- functionality that doesn't exist" rule structurally instead of by
-- hoping the prompt stays in sync with reality.
--
-- api/scout.js reads this and GENERATES the capability paragraph of the
-- system prompt from live rows, so switching a feature on/off here changes
-- what Scout will offer, with no prompt edit and no redeploy.
--
-- Seeded honestly against what actually ships TODAY: Discover and
-- user-to-user messaging are present as rows with available=false, so Scout
-- is explicitly told they do not exist rather than merely not being told
-- that they do.
-- ============================================================

create table if not exists product_capabilities (
  key text primary key,
  label text not null,
  available boolean not null default false,
  plan_min text check (plan_min in ('free','starter','pro','elite')),
  notes text,
  updated_at timestamptz not null default now()
);

alter table product_capabilities enable row level security;
drop policy if exists product_capabilities_read on product_capabilities;
create policy product_capabilities_read on product_capabilities for select using (true);
drop policy if exists product_capabilities_admin_write on product_capabilities;
create policy product_capabilities_admin_write on product_capabilities for all
  using (is_admin()) with check (is_admin());

insert into product_capabilities (key, label, available, plan_min, notes) values
  ('sports_passport',    'Digital Sports Passport',        true,  'free',    'Profile, achievements, media, career history.'),
  ('scout_chat',         'AI Scout conversation',          true,  'free',    'Capped per plan.'),
  ('passport_share',     'Shareable Passport link',        true,  'free',    'Revocable no-login link.'),
  ('passport_pdf',       'Passport PDF export',            true,  'starter', null),
  ('pathway_plan',       'Personalized Pathway',           true,  'starter', null),
  ('next_move',          'My Next Move',                   true,  'free',    'Deterministic, app-computed.'),
  ('targets',            'Target lists & outreach drafts', true,  'starter', 'Scout drafts; the athlete sends it themselves.'),
  ('benchmarks',         'Performance benchmarks',         true,  'starter', null),
  ('readiness',          'GOLSZ Readiness (full detail)',  true,  'pro',     'Composite + status words are visible on every plan.'),
  ('development_plan',   'Training & development plan',    true,  'pro',     null),
  ('identity_verify',    'Identity verification request',  true,  'free',    'Admin-reviewed.'),
  ('athlete_search',     'Search GOLSZ athletes',          true,  'free',    'Public scouting fields only, respects each athlete visibility setting.'),
  ('event_search',       'Search GOLSZ events',            true,  'free',    null),
  ('discover_feed',      'Discover / browse feed',         false, null,      'REMOVED from the product. Never suggest finding anyone via Discover.'),
  ('direct_messaging',   'User-to-user messaging',         false, null,      'REMOVED from the product. Never suggest messaging another member on GOLSZ.'),
  ('golsz_motion',       'GOLSZ Motion exercise library',  false, null,      'Schema reserved, no shipped UI. Never present as available.'),
  ('athlete_schedule',   'Weekly schedule',                false, null,      'Schema reserved, no shipped UI.'),
  ('athlete_diary',      'Athlete diary',                  false, null,      'Schema reserved, no shipped UI.'),
  ('push_alerts',        'Push notifications',             true,  'free',    'Follow-up reminders only.')
on conflict (key) do update set
  label = excluded.label, available = excluded.available,
  plan_min = excluded.plan_min, notes = excluded.notes, updated_at = now();

-- ===== 100-athlete-visibility =====
-- 100 — ATHLETE VISIBILITY: explicit, per-athlete scout-visibility control
-- Closes a REAL gap found in the audit, not a hypothetical one: before this
-- migration there was no visibility control anywhere in the schema (no
-- scout_visible / profile_visibility / is_public column existed), so every
-- athlete with a sport set was discoverable by every Scout user via
-- search_players. The spec requires "explicit visibility controls" for
-- public athlete information — a prompt rule cannot provide that, only the
-- query can.
--
-- Default TRUE preserves current behaviour exactly (no athlete silently
-- disappears from search on deploy), while giving every athlete a real
-- switch. search_players is rewritten below to honour it, so the control is
-- enforced server-side in the query itself — never client-side.
-- ============================================================

alter table athletes add column if not exists scout_visible boolean not null default true;
alter table athletes add column if not exists show_club boolean not null default true;
alter table athletes add column if not exists show_country boolean not null default true;

create index if not exists athletes_scout_visible_idx on athletes (sport) where scout_visible;

-- Rewritten search_players: same signature and same non-sensitive field set
-- (no dob, GPA, bio, height/weight — unchanged), now additionally
-- respecting each athlete's own visibility choices. Club/country are
-- blanked per-athlete rather than excluding the whole row, so an athlete can
-- stay discoverable while keeping their club private.
create or replace function search_players(
  p_sport text default null,
  p_position text default null,
  p_country text default null,
  p_grad_year int default null,
  p_gender text default null,
  p_recruiting_status text default null,
  p_limit int default 10
)
returns table (
  id uuid, full_name text, sport text, "position" text, country text,
  club_name text, grad_year int, gender text, recruiting_status text
)
language sql security definer set search_path to 'public' as $$
  select p.id, p.full_name, a.sport, a.position,
         case when a.show_country then a.country else null end,
         case when a.show_club then a.club_name else null end,
         a.grad_year, a.gender, a.recruiting_status
  from athletes a
  join profiles p on p.id = a.id
  where a.sport is not null
    and a.scout_visible                                  -- the new gate
    and (p.occupation is null or p.occupation = 'Player')
    and not is_restricted_minor(a.id)
    and not is_banned(a.id)
    and (p_sport is null or a.sport ilike p_sport)
    and (p_position is null or a.position ilike '%' || p_position || '%')
    -- country filter must not leak an athlete who hid their country
    and (p_country is null or (a.show_country and a.country ilike p_country))
    and (p_grad_year is null or a.grad_year = p_grad_year)
    and (p_gender is null or a.gender = p_gender)
    and (p_recruiting_status is null or a.recruiting_status = p_recruiting_status)
  order by a.created_at desc nulls last
  limit least(coalesce(p_limit, 10), 25);
$$;

-- ===== 101-platform-insights =====
-- 101 — PLATFORM INSIGHTS + OUTCOMES: Level 2 network learning
-- Scout Intelligence Architecture — anonymized/aggregated learning.
--
-- Two pieces:
--   athlete_outcomes  — verified, structured outcomes (trial, offer, commit,
--                       contract, transfer, benchmark improvement). Private
--                       to the athlete, exactly like scout_memory.
--   platform_insights — the ONLY aggregate surface. Rows carry cohort_size,
--                       and the generator function refuses to emit a row
--                       below MIN_COHORT, so a small group can never be
--                       produced at all. The threshold is enforced in SQL,
--                       not in prompt text — the spec's privacy requirement
--                       has to be structural to be real.
--
-- Nothing here promotes free-text conversation content into global
-- knowledge: insights are counts over typed enum columns only.
-- ============================================================

create table if not exists athlete_outcomes (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references profiles(id) on delete cascade,
  outcome_type text not null check (outcome_type in (
    'trial_obtained','trial_unsuccessful','offer_received','college_commitment',
    'professional_contract','transfer_completed','scholarship_received',
    'position_changed','benchmark_improved'
  )),
  sport text,
  country text,
  level text,
  detail text,
  -- Correlation/observation/inference/verified must stay distinguishable —
  -- an aggregate must never be built from unverified self-report as though
  -- it were confirmed.
  evidence text not null default 'user_reported'
    check (evidence in ('user_reported','scout_inferred','verified')),
  occurred_on date,
  created_at timestamptz not null default now()
);
create index if not exists athlete_outcomes_athlete_idx on athlete_outcomes (athlete_id, created_at desc);
create index if not exists athlete_outcomes_agg_idx on athlete_outcomes (outcome_type, sport, evidence);

alter table athlete_outcomes enable row level security;
drop policy if exists athlete_outcomes_own on athlete_outcomes;
create policy athlete_outcomes_own on athlete_outcomes for all
  using (athlete_id = auth.uid() or is_parent_of(athlete_id))
  with check (athlete_id = auth.uid() or is_parent_of(athlete_id));

create table if not exists platform_insights (
  id uuid primary key default gen_random_uuid(),
  insight_key text not null unique,
  category text not null,
  sport text,
  country text,
  cohort_filter jsonb not null default '{}'::jsonb,
  cohort_size int not null,
  summary text not null,
  metric jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  -- Defence in depth: even a buggy generator can't persist a row that would
  -- allow an individual to be inferred.
  constraint platform_insights_min_cohort check (cohort_size >= 20)
);

alter table platform_insights enable row level security;
drop policy if exists platform_insights_read on platform_insights;
create policy platform_insights_read on platform_insights for select using (true);
drop policy if exists platform_insights_admin_write on platform_insights;
create policy platform_insights_admin_write on platform_insights for all
  using (is_admin()) with check (is_admin());

-- Aggregate generator. Emits ONLY cohorts of >= 20 verified/reported
-- outcomes; anything smaller is skipped entirely rather than rounded or
-- masked. Returns how many insights were written.
create or replace function rebuild_platform_insights()
returns int language plpgsql security definer set search_path to 'public' as $$
declare MIN_COHORT constant int := 20; v_written int := 0; r record;
begin
  for r in
    select outcome_type, sport, count(*)::int as n
    from athlete_outcomes
    where sport is not null
    group by outcome_type, sport
    having count(*) >= MIN_COHORT
  loop
    insert into platform_insights (insight_key, category, sport, cohort_size, summary, metric)
    values (
      'outcome:' || r.outcome_type || ':' || r.sport, 'outcome', r.sport, r.n,
      r.n || ' recorded ' || replace(r.outcome_type, '_', ' ') || ' outcomes in ' || r.sport || '.',
      jsonb_build_object('outcome_type', r.outcome_type, 'count', r.n)
    )
    on conflict (insight_key) do update set
      cohort_size = excluded.cohort_size, summary = excluded.summary,
      metric = excluded.metric, computed_at = now();
    v_written := v_written + 1;
  end loop;
  return v_written;
end;
$$;
revoke execute on function rebuild_platform_insights() from anon, authenticated;
