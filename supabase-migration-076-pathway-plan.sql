-- ============================================================
-- 076 — Pathway plan (brief §7 "PATHWAYS — DO NOT MAKE GOLSZ NCAA-ONLY" +
-- §13 PRO — GUIDE ME "personalized pathway")
-- One row per athlete (not a list, like outreach_targets/benchmarks/
-- development_plan_items) — this is THE athlete's stated pathway, matching
-- the brief's singular "Where do you want to go?" framing. pathway_type
-- covers the exact set §7 lists so GOLSZ never brands itself NCAA-only.
-- milestones is a small jsonb checklist ([{id,label,done}]) rather than a
-- separate table — right-sized for "a few milestones," not a project
-- management system.
-- ============================================================

create table if not exists pathway_plan (
  user_id uuid primary key references profiles(id) on delete cascade,
  pathway_type text not null check (pathway_type in ('ncaa', 'naia', 'juco', 'canadian_university', 'academy', 'european_club', 'professional', 'development', 'agent_representation', 'trainer_performance', 'other')),
  target_timeline text,
  milestones jsonb not null default '[]'::jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table pathway_plan enable row level security;

drop policy if exists pathway_plan_own_read on pathway_plan;
create policy pathway_plan_own_read on pathway_plan for select using (
  user_id = auth.uid() or is_parent_of(user_id)
);

drop policy if exists pathway_plan_own_insert on pathway_plan;
create policy pathway_plan_own_insert on pathway_plan for insert with check (
  user_id = auth.uid() or is_parent_of(user_id)
);

drop policy if exists pathway_plan_own_update on pathway_plan;
create policy pathway_plan_own_update on pathway_plan for update using (
  user_id = auth.uid() or is_parent_of(user_id)
) with check (
  user_id = auth.uid() or is_parent_of(user_id)
);

drop policy if exists pathway_plan_own_delete on pathway_plan;
create policy pathway_plan_own_delete on pathway_plan for delete using (
  user_id = auth.uid() or is_parent_of(user_id)
);
