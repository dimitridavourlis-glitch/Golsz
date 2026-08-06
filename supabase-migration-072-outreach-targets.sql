-- ============================================================
-- 072 — Target school/club list + outreach status pipeline
-- The brief's "MOVE" phase: turning a plan into real outreach. status is a
-- simple linear pipeline (researching -> contacted -> responded ->
-- follow_up -> closed) an athlete drives themselves; draft_email lives as
-- a column on the SAME row rather than a separate table, since it's a
-- 1:1 property of one target, not its own many-to-one relationship.
-- Self-service only (no admin visibility) — this is the athlete's own
-- working list, not moderated content.
-- ============================================================

create table if not exists outreach_targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  name text not null,
  contact_name text,
  contact_email text,
  status text not null default 'researching' check (status in ('researching', 'contacted', 'responded', 'follow_up', 'closed')),
  notes text,
  draft_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists outreach_targets_user_idx on outreach_targets (user_id, status);

alter table outreach_targets enable row level security;

drop policy if exists outreach_targets_own_read on outreach_targets;
create policy outreach_targets_own_read on outreach_targets for select using (
  user_id = auth.uid() or is_parent_of(user_id)
);

drop policy if exists outreach_targets_own_insert on outreach_targets;
create policy outreach_targets_own_insert on outreach_targets for insert with check (
  user_id = auth.uid() or is_parent_of(user_id)
);

drop policy if exists outreach_targets_own_update on outreach_targets;
create policy outreach_targets_own_update on outreach_targets for update using (
  user_id = auth.uid() or is_parent_of(user_id)
) with check (
  user_id = auth.uid() or is_parent_of(user_id)
);

drop policy if exists outreach_targets_own_delete on outreach_targets;
create policy outreach_targets_own_delete on outreach_targets for delete using (
  user_id = auth.uid() or is_parent_of(user_id)
);
