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
-- 10) ADDITIVE — POSTS (Feed) + POST_LIKES + EVENTS
--     Feed and Events had no backing tables at all (golsz-app.html rendered
--     hardcoded FEED/EVENTS arrays). This section adds them, following the
--     same "public directory read, owner (or parent) write" pattern used by
--     athletes/coaches/clubs above. Safe to append/re-run on top of the
--     tables created earlier in this file.
-- ============================================================
alter table athletes add column if not exists gender text;

create table if not exists posts (
  id           uuid primary key default gen_random_uuid(),
  author_id    uuid not null references profiles(id) on delete cascade,
  kind         text not null default 'post' check (kind in ('post','commit','clip','perf','call')),
  headline     text not null,
  body         text,
  likes_count  int not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists posts_created_at_idx on posts (created_at desc);

create table if not exists post_likes (
  post_id     uuid not null references posts(id) on delete cascade,
  profile_id  uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (post_id, profile_id)
);

-- keep posts.likes_count in sync with post_likes rows instead of trusting the client
create or replace function _post_likes_sync()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT') then
    update posts set likes_count = likes_count + 1 where id = new.post_id;
    return new;
  elsif (tg_op = 'DELETE') then
    update posts set likes_count = greatest(likes_count - 1, 0) where id = old.post_id;
    return old;
  end if;
  return null;
end $$;

drop trigger if exists post_likes_sync on post_likes;
create trigger post_likes_sync
  after insert or delete on post_likes
  for each row execute function _post_likes_sync();

create table if not exists events (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  sport            text,
  location         text,
  level            text,
  event_date       date not null,
  spots_available  int,
  created_by       uuid references profiles(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists events_date_idx on events (event_date);

alter table posts       enable row level security;
alter table post_likes  enable row level security;
alter table events      enable row level security;

-- posts: public directory read, owner (or parent) write — same pattern as athletes
drop policy if exists posts_read on posts;
create policy posts_read on posts for select using (true);
drop policy if exists posts_write on posts;
create policy posts_write on posts for insert with check (author_id = auth.uid() or is_parent_of(author_id));
drop policy if exists posts_update on posts;
create policy posts_update on posts for update using (author_id = auth.uid() or is_parent_of(author_id));
drop policy if exists posts_delete on posts;
create policy posts_delete on posts for delete using (author_id = auth.uid() or is_parent_of(author_id));

-- post_likes: you can only see/create/remove your own like rows (posts.likes_count is the public number)
drop policy if exists post_likes_read on post_likes;
create policy post_likes_read on post_likes for select using (profile_id = auth.uid());
drop policy if exists post_likes_write on post_likes;
create policy post_likes_write on post_likes for insert with check (profile_id = auth.uid());
drop policy if exists post_likes_delete on post_likes;
create policy post_likes_delete on post_likes for delete using (profile_id = auth.uid());

-- events: public directory read, creator write (no admin/club-only gate yet — anyone signed in can post one)
drop policy if exists events_read on events;
create policy events_read on events for select using (true);
drop policy if exists events_write on events;
create policy events_write on events for insert with check (created_by = auth.uid());
drop policy if exists events_update on events;
create policy events_update on events for update using (created_by = auth.uid());
drop policy if exists events_delete on events;
create policy events_delete on events for delete using (created_by = auth.uid());

-- ============================================================
-- Done. Follow-ups, still true here:
--  - Discover now has a `gender` column on athletes to match golsz-app.html's
--    filter UI; it's nullable and unset for existing rows.
--  - Feed/Discover/Events in golsz-app.html fetch from posts/athletes/events
--    when Supabase is configured, falling back to the hardcoded arrays when
--    a query returns zero rows (so the app still looks alive pre-launch).
--  - There's still no UI to create a post or an event — posts/events tables
--    exist and are queried, but nothing writes to them yet apart from
--    post_likes (the Feed's like button).
--  - Scout()'s chat in golsz-app.html doesn't write to scout_history yet —
--    only increment_scout_usage() (called server-side by api/scout.js) logs
--    'usage' rows today. Insert 'user'/'assistant' rows from the client via
--    supabase-js if you want a real transcript, not just a call count.
-- ============================================================

-- ============================================================
-- 11) ADDITIVE — parent_links verification (child approves the parent)
--     approved_at was previously never set by anything. This adds the
--     narrowest mechanism that doesn't need new email infra: a parent (with
--     their own account) requests a link to a child's account by email via
--     request_parent_link(); the child is the ONLY one who can set
--     approved_at (see parent_links_approve below — parent_profile_id is
--     deliberately excluded from that policy's USING clause). This is a
--     mutual-consent safeguard, not verified parental identity/COPPA-grade
--     consent — get legal input before relying on it for real minors.
-- ============================================================

-- request a link by email without exposing profiles to arbitrary lookup:
-- SECURITY DEFINER bypasses profiles RLS internally for the email match,
-- but only ever returns a boolean — never the looked-up id/row itself.
create or replace function request_parent_link(p_child_email text, p_relationship text default null)
returns boolean language plpgsql security definer as $$
declare v_child uuid;
begin
  if auth.uid() is null then return false; end if;

  select id into v_child from profiles where email = p_child_email;
  if v_child is null or v_child = auth.uid() then return false; end if;

  insert into parent_links (parent_profile_id, child_profile_id, relationship)
  values (auth.uid(), v_child, p_relationship)
  on conflict (parent_profile_id, child_profile_id) do nothing;

  return true;
end $$;

revoke all on function request_parent_link(text, text) from public;
grant execute on function request_parent_link(text, text) to authenticated;

-- only the CHILD side of a pending link can approve it
drop policy if exists parent_links_approve on parent_links;
create policy parent_links_approve on parent_links
  for update using (child_profile_id = auth.uid())
  with check (child_profile_id = auth.uid());

-- either side can remove a link (deny a pending request, or revoke an approved one)
drop policy if exists parent_links_delete on parent_links;
create policy parent_links_delete on parent_links
  for delete using (parent_profile_id = auth.uid() or child_profile_id = auth.uid());

-- both sides of a parent_links row (pending or approved) need to see each
-- other's name/email to make an informed approve/deny decision — profiles_self
-- alone won't allow that (is_parent_of() requires approved_at, which is the
-- thing being decided). This is scoped strictly to pairs with an existing
-- parent_links row, not a general profiles read.
drop policy if exists profiles_linked on profiles;
create policy profiles_linked on profiles
  for select using (
    exists (select 1 from parent_links where parent_profile_id = auth.uid() and child_profile_id = profiles.id)
    or exists (select 1 from parent_links where child_profile_id = auth.uid() and parent_profile_id = profiles.id)
  );

-- ============================================================
-- Done (for real this time). Still true:
--  - This is mutual in-app consent, not identity-verified parental consent.
--    A bad actor who also controls (or fakes) the "child" side could still
--    self-approve. Don't market this as COPPA/GDPR-K compliant as-is.
-- ============================================================
