-- ============================================================
-- GOLSZ — Supabase schema (Postgres)
-- Run this in Supabase → SQL Editor. Safe to run once on a fresh project,
-- and safe to re-run after the reset block below.
--
-- Tables: profiles, athletes, coaches, clubs, agents, parent_links,
-- scout_history — plus Row Level Security so every user only ever
-- touches their own data (or their linked minor's, via parent_links).
-- ============================================================

-- ---------- reset (safe to run even on a clean project) ----------
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user() cascade;
drop function if exists public.increment_scout_usage(uuid) cascade;
drop function if exists public.is_parent_of(uuid) cascade;
drop table if exists public.scout_history cascade;
drop table if exists public.parent_links cascade;
drop table if exists public.agents cascade;
drop table if exists public.coaches cascade;
drop table if exists public.clubs cascade;
drop table if exists public.athletes cascade;
drop table if exists public.profiles cascade;
drop type if exists public.user_role cascade;
drop type if exists public.plan_tier cascade;

-- ---------- extensions ----------
create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ---------- enums ----------
do $$ begin
  create type user_role as enum ('athlete','coach','club','agent','parent','admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type plan_tier as enum ('free','pro','elite');
exception when duplicate_object then null; end $$;

-- ============================================================
-- 1) PROFILES  (1:1 with auth.users — the root identity row for everyone)
-- ============================================================
create table if not exists profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  role           user_role   not null default 'athlete',
  full_name      text,
  email          text,
  date_of_birth  date,
  plan           plan_tier   not null default 'free',
  avatar_url     text,
  created_at     timestamptz not null default now()
);

-- ============================================================
-- 2) ATHLETES  (1:1 extension of profiles, the digital sports passport)
-- ============================================================
create table if not exists athletes (
  profile_id     uuid primary key references profiles(id) on delete cascade,
  sport          text,
  position       text,
  height_cm      int,
  preferred_foot text,
  grad_year      int,
  gpa            numeric(3,2),
  citizenship    text,
  location       text,
  current_club   text,
  level          text,
  budget         text,
  goal           text,
  verified       boolean not null default false,
  updated_at     timestamptz not null default now()
);

-- ============================================================
-- 3) CLUBS  (organizations — not 1:1 with a single profile; created
--    before coaches since coaches.club_id references it)
-- ============================================================
create table if not exists clubs (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  sport             text,
  level             text,
  location          text,
  owner_profile_id  uuid references profiles(id) on delete set null,
  verified          boolean not null default false,
  created_at        timestamptz not null default now()
);

-- ============================================================
-- 4) COACHES  (1:1 extension of profiles)
-- ============================================================
create table if not exists coaches (
  profile_id  uuid primary key references profiles(id) on delete cascade,
  club_id     uuid references clubs(id) on delete set null,
  title       text,
  sport       text,
  bio         text,
  verified    boolean not null default false,
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- 5) AGENTS  (1:1 extension of profiles)
-- ============================================================
create table if not exists agents (
  profile_id      uuid primary key references profiles(id) on delete cascade,
  agency_name     text,
  license_number  text,
  bio             text,
  verified        boolean not null default false,
  updated_at      timestamptz not null default now()
);

-- ============================================================
-- 6) PARENT_LINKS  (parent/guardian accounts linked to a minor athlete)
-- ============================================================
create table if not exists parent_links (
  id                 uuid primary key default gen_random_uuid(),
  parent_profile_id  uuid not null references profiles(id) on delete cascade,
  child_profile_id   uuid not null references profiles(id) on delete cascade,
  relationship       text,
  approved_at        timestamptz,   -- null = pending verification
  created_at         timestamptz not null default now(),
  unique (parent_profile_id, child_profile_id)
);

-- ============================================================
-- 7) SCOUT_HISTORY  (Scout transcript + usage metering, one table)
--    role = 'user' | 'assistant'  -> real conversation turns, written by the app
--    role = 'usage'               -> one row per Scout call, written by increment_scout_usage()
-- ============================================================
create table if not exists scout_history (
  id          uuid primary key default gen_random_uuid(),
  athlete_id  uuid not null references profiles(id) on delete cascade,
  role        text not null check (role in ('user','assistant','usage')),
  content     text not null default '',
  created_at  timestamptz not null default now()
);
create index if not exists scout_history_athlete_day_idx on scout_history (athlete_id, role, created_at);

-- metering helper the proxy (api/scout.js) calls; returns today's call count
create or replace function increment_scout_usage(p_user uuid)
returns int language plpgsql security definer as $$
declare v int;
begin
  insert into scout_history (athlete_id, role, content) values (p_user, 'usage', '');

  select count(*) into v
  from scout_history
  where athlete_id = p_user
    and role = 'usage'
    and created_at >= date_trunc('day', now());

  return v;
end $$;

-- ============================================================
-- 8) AUTO-CREATE profile + role-specific row whenever someone signs up
--    Reads role / full_name / date_of_birth from auth signUp options.data
--    (golsz-app.html's Auth component sends full_name, plan, date_of_birth;
--    add `role` there too if you introduce a role picker beyond athlete).
-- ============================================================
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  v_role user_role;
begin
  v_role := coalesce((new.raw_user_meta_data->>'role')::user_role, 'athlete');

  insert into public.profiles (id, role, full_name, email, date_of_birth, plan)
  values (
    new.id,
    v_role,
    new.raw_user_meta_data->>'full_name',
    new.email,
    nullif(new.raw_user_meta_data->>'date_of_birth', '')::date,
    coalesce((new.raw_user_meta_data->>'plan')::plan_tier, 'free')
  );

  if v_role = 'athlete' then
    insert into public.athletes (profile_id) values (new.id);
  elsif v_role = 'coach' then
    insert into public.coaches (profile_id) values (new.id);
  elsif v_role = 'agent' then
    insert into public.agents (profile_id) values (new.id);
  end if;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================
-- 9) ROW LEVEL SECURITY
--    profiles / parent_links / scout_history: strictly owner (or linked
--    parent) only — this is where DOB, email, and Scout transcripts live.
--    athletes / coaches / agents / clubs: readable by any authenticated
--    user (the Discover directory), writable only by the owner.
-- ============================================================
alter table profiles       enable row level security;
alter table athletes       enable row level security;
alter table coaches        enable row level security;
alter table clubs          enable row level security;
alter table agents         enable row level security;
alter table parent_links   enable row level security;
alter table scout_history  enable row level security;

-- helper: is the current user the approved parent of a given profile?
create or replace function is_parent_of(child uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from parent_links
    where child_profile_id = child
      and parent_profile_id = auth.uid()
      and approved_at is not null
  );
$$;

-- profiles: owner or their approved parent
drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles
  for all using (id = auth.uid() or is_parent_of(id))
  with check (id = auth.uid());

-- athletes / coaches / agents: public directory read, owner (or parent) write
drop policy if exists athletes_read on athletes;
create policy athletes_read on athletes for select using (true);
drop policy if exists athletes_write on athletes;
create policy athletes_write on athletes for insert with check (profile_id = auth.uid() or is_parent_of(profile_id));
drop policy if exists athletes_update on athletes;
create policy athletes_update on athletes for update using (profile_id = auth.uid() or is_parent_of(profile_id));
drop policy if exists athletes_delete on athletes;
create policy athletes_delete on athletes for delete using (profile_id = auth.uid() or is_parent_of(profile_id));

drop policy if exists coaches_read on coaches;
create policy coaches_read on coaches for select using (true);
drop policy if exists coaches_write on coaches;
create policy coaches_write on coaches for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());

drop policy if exists agents_read on agents;
create policy agents_read on agents for select using (true);
drop policy if exists agents_write on agents;
create policy agents_write on agents for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- clubs: public directory read, owner write
drop policy if exists clubs_read on clubs;
create policy clubs_read on clubs for select using (true);
drop policy if exists clubs_write on clubs;
create policy clubs_write on clubs for all using (owner_profile_id = auth.uid()) with check (owner_profile_id = auth.uid());

-- parent_links: visible to either side of the link; only the parent can create it
drop policy if exists parent_links_read on parent_links;
create policy parent_links_read on parent_links
  for select using (parent_profile_id = auth.uid() or child_profile_id = auth.uid());
drop policy if exists parent_links_write on parent_links;
create policy parent_links_write on parent_links
  for insert with check (parent_profile_id = auth.uid());

-- scout_history: athlete or their approved parent only; append-only (no update/delete policy)
drop policy if exists scout_history_rw on scout_history;
create policy scout_history_rw on scout_history
  for select using (athlete_id = auth.uid() or is_parent_of(athlete_id));
drop policy if exists scout_history_insert on scout_history;
create policy scout_history_insert on scout_history
  for insert with check (athlete_id = auth.uid());

-- ============================================================
-- Done. Follow-ups, still true here:
--  - Feed / Discover / Events currently render from hardcoded arrays in
--    golsz-app.html — point them at athletes/coaches/clubs once seeded.
--  - Scout()'s chat in golsz-app.html doesn't write to scout_history yet —
--    only increment_scout_usage() (called server-side by api/scout.js) logs
--    'usage' rows today. Insert 'user'/'assistant' rows from the client via
--    supabase-js if you want a real transcript, not just a call count.
--  - parent_links.approved_at is set to null on insert (pending) — an
--    actual verification step (email confirmation to the parent, admin
--    review, etc.) should set it before a parent gets real access to a
--    minor's data. Don't let a self-reported parent_links row auto-approve.
-- ============================================================
