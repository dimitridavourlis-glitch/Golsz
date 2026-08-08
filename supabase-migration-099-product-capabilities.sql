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
