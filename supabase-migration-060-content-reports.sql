-- ============================================================
-- 060 — Generalized reports (DMs, profiles)
-- Golsz Trust & Safety Moderation System (approved plan).
--
-- post_reports (an original-schema table) stays exactly as-is for posts
-- — this adds a parallel table for target types post_reports never
-- covered (direct messages, profiles), rather than migrating existing
-- rows/call sites. Both tables are read together by the admin Reports
-- tab. Events already have an admin-block path (`is_blocked`) and don't
-- need a user-facing report route.
-- ============================================================

create table if not exists content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles(id) on delete cascade,
  target_type text not null check (target_type in ('message', 'profile')),
  target_id uuid not null,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists content_reports_target_idx on content_reports (target_type, target_id);

alter table content_reports enable row level security;

drop policy if exists content_reports_insert on content_reports;
create policy content_reports_insert on content_reports for insert with check (
  reporter_id = auth.uid()
);

drop policy if exists content_reports_admin_read on content_reports;
create policy content_reports_admin_read on content_reports for select using (
  is_admin()
);
