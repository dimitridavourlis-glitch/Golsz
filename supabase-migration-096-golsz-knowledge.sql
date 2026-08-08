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
