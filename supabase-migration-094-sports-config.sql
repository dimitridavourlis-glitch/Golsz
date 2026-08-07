-- 094 — sports config (same directive: "GOLSZ is multi-sport but not
-- generic" — CORE sports get real pathway/benchmark/rules depth over
-- time; SECONDARY sports stay honest about not having that depth yet).
--
-- athletes.sport stays free text on purpose (unchanged) — this table is
-- a soft lookup by name, not a foreign key, so it never breaks on an
-- existing athlete row whose sport string doesn't exactly match a seeded
-- name here. Deliberately NOT building sport_positions/sport_benchmarks/
-- sport_pathway_types/sport_leagues/sport_recruiting_rules yet — those
-- are premature before any one sport has real authored pathway content;
-- this table only carries the CORE/SUPPORTED/SECONDARY flag Scout needs
-- to avoid claiming depth GOLSZ doesn't have.
-- ============================================================

create table if not exists sports (
  id text primary key,
  name text not null,
  support_level text not null default 'secondary' check (support_level in ('core', 'supported', 'secondary')),
  team_or_individual text not null check (team_or_individual in ('team', 'individual')),
  pathway_enabled boolean not null default false,
  benchmarks_enabled boolean not null default false,
  display_order int
);

alter table sports enable row level security;
-- no select/insert/update policy — service-role only (api/scout.js reads
-- server-side); the client's existing SPORTS array in golsz-app.html is
-- untouched and keeps driving the profile-editor sport picker as-is.

insert into sports (id, name, support_level, team_or_individual, pathway_enabled, benchmarks_enabled, display_order) values
  ('soccer', 'Soccer', 'core', 'team', true, true, 1),
  ('futsal', 'Futsal', 'core', 'team', true, true, 2),
  ('american_football', 'American Football', 'core', 'team', true, true, 3),
  ('baseball', 'Baseball', 'core', 'team', true, true, 4),
  ('basketball', 'Basketball', 'core', 'team', true, true, 5),
  ('tennis', 'Tennis', 'core', 'individual', true, true, 6),
  ('golf', 'Golf', 'core', 'individual', true, true, 7),
  ('lacrosse', 'Lacrosse', 'core', 'team', true, true, 8),
  ('handball', 'Handball', 'core', 'team', true, true, 9),
  ('volleyball', 'Volleyball', 'core', 'team', true, true, 10)
on conflict (id) do update set
  support_level = excluded.support_level, pathway_enabled = excluded.pathway_enabled,
  benchmarks_enabled = excluded.benchmarks_enabled, display_order = excluded.display_order;

-- Every other sport already offered client-side (golsz-app.html's SPORTS
-- array — Track, Swimming, Wrestling, Boxing, etc.) stays fully usable
-- for Passport/goals/AI Scout/basic Pathways (directive §"Secondary
-- sports"), it's just not seeded into this table as 'core' — a lookup
-- miss here means "secondary" by the default column value, not "blocked."

-- ============================================================
-- Done.
