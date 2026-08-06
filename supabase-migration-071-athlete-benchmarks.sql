-- ============================================================
-- 071 — Performance benchmarks (record + retest history)
-- A real table (not a jsonb array like highlights/timeline) since retest
-- history benefits from being queryable/aggregatable later (trend charts,
-- GOLSZ Readiness's future Performance sub-score) rather than baked into
-- one blob column. Deliberately no fixed metric taxonomy per sport — free-
-- text metric name + numeric value + optional unit, same "don't invent an
-- exhaustive schema across 39 sports" judgment call SPORT_POSITION_LABEL
-- already made. Private to the owner in v1 (not shown on another
-- athlete's Passport, unlike highlights) — a "show publicly" toggle is
-- real future work once there's a reason to build it, not before.
-- ============================================================

create table if not exists athlete_benchmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  metric text not null,
  value numeric not null,
  unit text,
  recorded_date date not null default current_date,
  created_at timestamptz not null default now()
);

create index if not exists athlete_benchmarks_user_idx on athlete_benchmarks (user_id, metric, recorded_date desc);

alter table athlete_benchmarks enable row level security;

drop policy if exists athlete_benchmarks_own_read on athlete_benchmarks;
create policy athlete_benchmarks_own_read on athlete_benchmarks for select using (
  user_id = auth.uid() or is_parent_of(user_id)
);

drop policy if exists athlete_benchmarks_own_insert on athlete_benchmarks;
create policy athlete_benchmarks_own_insert on athlete_benchmarks for insert with check (
  user_id = auth.uid() or is_parent_of(user_id)
);

drop policy if exists athlete_benchmarks_own_delete on athlete_benchmarks;
create policy athlete_benchmarks_own_delete on athlete_benchmarks for delete using (
  user_id = auth.uid() or is_parent_of(user_id)
);
