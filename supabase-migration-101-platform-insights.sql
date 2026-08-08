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
