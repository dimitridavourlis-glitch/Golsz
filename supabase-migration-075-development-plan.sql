-- ============================================================
-- 075 — Development/Preparedness plan (brief §5 "TRAINING, NUTRITION,
-- SLEEP & RECOVERY" + §13 PRO — GUIDE ME "development planning")
-- A short list of focus areas the athlete is actively working on — not a
-- structured training program, matching the brief's own scope ("general
-- training planning... recovery... sleep habits... hydration... general
-- sports nutrition education", never a prescribed protocol). Self-service
-- only (no admin visibility), same as outreach_targets (072) — this is the
-- athlete's own working list, not moderated content. Private to the owner,
-- same as athlete_benchmarks (071) — never fetched for another athlete's
-- viewed Passport.
-- ============================================================

create table if not exists development_plan_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  focus_area text not null check (focus_area in ('training', 'strength', 'speed', 'conditioning', 'recovery', 'sleep', 'hydration', 'nutrition', 'other')),
  goal text not null,
  status text not null default 'active' check (status in ('active', 'done', 'paused')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists development_plan_items_user_idx on development_plan_items (user_id, status);

alter table development_plan_items enable row level security;

drop policy if exists development_plan_items_own_read on development_plan_items;
create policy development_plan_items_own_read on development_plan_items for select using (
  user_id = auth.uid() or is_parent_of(user_id)
);

drop policy if exists development_plan_items_own_insert on development_plan_items;
create policy development_plan_items_own_insert on development_plan_items for insert with check (
  user_id = auth.uid() or is_parent_of(user_id)
);

drop policy if exists development_plan_items_own_update on development_plan_items;
create policy development_plan_items_own_update on development_plan_items for update using (
  user_id = auth.uid() or is_parent_of(user_id)
) with check (
  user_id = auth.uid() or is_parent_of(user_id)
);

drop policy if exists development_plan_items_own_delete on development_plan_items;
create policy development_plan_items_own_delete on development_plan_items for delete using (
  user_id = auth.uid() or is_parent_of(user_id)
);
