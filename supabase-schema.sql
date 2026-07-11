-- ============================================================
-- GOLSZ — Supabase schema reference (current live state)
--
-- This file documents what is ACTUALLY deployed against the live GOLSZ
-- Supabase project (ref: wachjqfhlbchcuovyewg), confirmed via direct
-- information_schema / pg_proc / pg_policies introspection, plus every
-- migration applied since (002, 004, 005 — concatenated below in order).
--
-- ⚠️ THIS IS NOT A FROM-SCRATCH BOOTSTRAP SCRIPT. It assumes the base
-- tables already exist: profiles, athletes, coaches, agents, clubs,
-- parent_links, scout_history. Those predate this migration history and
-- were never fully re-documented here — in particular, profiles.role and
-- profiles.plan are Postgres enum types whose exact allowed values were
-- never introspected (only inferred from usage: plan is used as
-- 'free'/'pro'/'elite' throughout the app and the Stripe webhook). Do
-- NOT use this file to provision a fresh empty database without first
-- confirming those enum definitions via:
--   select t.typname, e.enumlabel from pg_type t
--   join pg_enum e on e.enumtypid = t.oid
--   where t.typname in ('user_role', 'plan_tier');
-- (or whatever the real type names are — also unconfirmed; check
--  information_schema.columns.udt_name for profiles.role / profiles.plan).
--
-- Confirmed real base-table shape (2026-07-07 introspection):
--   profiles(id, full_name, role enum, plan enum, dob, created_at,
--            is_minor, pending_parent_email, is_admin, stripe_customer_id)
--   athletes(id, sport, position, height_cm, weight_kg, grad_year, gpa,
--            club_id, highlights jsonb, created_at, gender)
--            — id IS profiles.id, there is no separate profile_id column
--   coaches(id, club_id, title)         — RLS on, zero policies, fully locked
--   agents(id, agency)                  — RLS on, zero policies, fully locked
--   clubs(id, name, city, country, created_at)  — no write policy, read-only
--   parent_links(id, parent_id, athlete_id, relationship, approved_at, created_at)
--   scout_history(id, user_id, messages jsonb, created_at)
--
-- Everything below this point (posts, post_likes, events, gender column,
-- the parent-verification RPC/policies, is_minor/admin/stripe columns,
-- post_reports, blocks) is fully created by the statements in this file —
-- safe to re-run against the live project (every statement is
-- idempotent: create-if-not-exists / create-or-replace / drop-then-create
-- policy).
--
-- Migration history, in the order actually applied:
--   1. (undocumented — created the base tables listed above, predates
--      this session)
--   2. supabase-migration-002-posts-events.sql
--   3. supabase-migration-004-fix-real-schema.sql
--   4. supabase-migration-005-launch-readiness.sql
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
--  - parent_links.approved_at is set to null on insert (pending) — an
--    actual verification step (email confirmation to the parent, admin
--    review, etc.) should set it before a parent gets real access to a
--    minor's data. Don't let a self-reported parent_links row auto-approve.
-- ============================================================


-- ============================================================
-- From supabase-migration-004-fix-real-schema.sql
-- ============================================================

-- ============================================================
-- 004 — Reconcile with the REAL live schema, and finish parent verification
--
-- supabase-schema.sql in this repo does NOT match what's actually deployed.
-- The live database was built up across earlier, undocumented sessions and
-- drifted from that file: different column names, missing columns, and a
-- couple of functions that reference columns which no longer exist. This
-- migration was written directly against the live schema (confirmed via
-- information_schema.columns / pg_proc / pg_policies on 2026-07-07), not
-- against supabase-schema.sql. Treat THIS file, not supabase-schema.sql, as
-- the source of truth going forward until supabase-schema.sql is rewritten
-- to match (tracked separately — see CLAUDE.md).
--
-- Confirmed real shape at the time of writing:
--   profiles(id, full_name, role enum, plan enum, dob, created_at)      -- no email column
--   athletes(id, sport, position, height_cm, weight_kg, grad_year, gpa,
--            club_id, highlights jsonb, created_at, gender)             -- id IS profiles.id, no profile_id column
--   coaches(id, club_id, title)                                          -- RLS enabled, zero policies -> fully locked
--   agents(id, agency)                                                   -- RLS enabled, zero policies -> fully locked
--   clubs(id, name, city, country, created_at)
--   parent_links(parent_id, athlete_id)                                  -- no id/relationship/approved_at/created_at
--   scout_history(id, user_id, messages jsonb, created_at)               -- no role/content/athlete_id columns
--
-- Migration 002 (posts/post_likes/events/athletes.gender) already matches
-- the live schema exactly and does not need to change.
-- ============================================================

-- ------------------------------------------------------------
-- 1) athletes had NO public-read policy — only athletes_rw (owner/parent
--    ALL). Discover needs to read every athlete's row, not just your own.
-- ------------------------------------------------------------
drop policy if exists athletes_read on athletes;
create policy athletes_read on athletes for select using (true);

-- ------------------------------------------------------------
-- 2) handle_new_user() only ever set (id, full_name) and never created the
--    athletes row — so every signup so far has a profiles row with nothing
--    in athletes, which is why Discover/Feed have nothing real to show yet.
--    Add dob capture + auto-create the athletes row. role/plan are left on
--    their column defaults since the signup form doesn't collect a role
--    today (matches current product behavior — don't invent enum values).
-- ------------------------------------------------------------
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  insert into profiles (id, full_name, dob)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'date_of_birth', '')::date
  )
  on conflict (id) do nothing;

  insert into athletes (id) values (new.id)
  on conflict (id) do nothing;

  return new;
end;
$$;

-- one-time backfill: give any existing profile (e.g. already-confirmed
-- signups from before this fix) an athletes row too, so they show up.
insert into athletes (id)
select p.id from profiles p
where not exists (select 1 from athletes a where a.id = p.id);

-- ------------------------------------------------------------
-- 3) increment_scout_usage() referenced scout_history(athlete_id, role,
--    content) — none of those columns exist on the real table
--    (id, user_id, messages, created_at). It would have errored at runtime
--    the moment Scout metering was ever actually exercised (SUPABASE_URL
--    unset in Vercel so far, so this hasn't surfaced yet). Rewritten
--    against the real columns: a metering call inserts a row with an empty
--    messages array, and today's count is rows where messages = '[]' — real
--    transcript rows (written by the client) always have a non-empty
--    array, so counting by the empty marker keeps metering accurate
--    regardless of how many transcript rows exist.
-- ------------------------------------------------------------
create or replace function increment_scout_usage(p_user uuid)
returns int language plpgsql security definer set search_path to 'public' as $$
declare v int;
begin
  insert into scout_history (user_id, messages) values (p_user, '[]'::jsonb);

  select count(*) into v
  from scout_history
  where user_id = p_user
    and messages = '[]'::jsonb
    and created_at >= date_trunc('day', now());

  return v;
end $$;

-- ------------------------------------------------------------
-- 4) parent_links verification (child approves the parent) — for real this
--    time, against the actual (parent_id, athlete_id) table. Adds the
--    columns the live table never had, closes the "any linked row = full
--    access" hole in is_parent_of(), and adds request/approve/deny.
--    Still mutual in-app consent, not identity-verified parental consent.
-- ------------------------------------------------------------
alter table parent_links add column if not exists id uuid default gen_random_uuid();
update parent_links set id = gen_random_uuid() where id is null;
alter table parent_links alter column id set not null;
do $$ begin
  alter table parent_links add primary key (id);
exception when invalid_table_definition then null; end $$;

alter table parent_links add column if not exists relationship text;
alter table parent_links add column if not exists approved_at timestamptz;
alter table parent_links add column if not exists created_at timestamptz not null default now();

do $$ begin
  alter table parent_links add constraint parent_links_unique unique (parent_id, athlete_id);
exception when duplicate_table then null; end $$;

-- is_parent_of() previously granted access on ANY parent_links row, with no
-- approval gate at all. This is the actual compliance fix.
create or replace function is_parent_of(child uuid)
returns boolean language sql security definer set search_path to 'public' as $$
  select exists (
    select 1 from parent_links
    where parent_id = auth.uid() and athlete_id = child and approved_at is not null
  );
$$;

-- request a link by email. profiles has no email column, so this looks the
-- child up in auth.users (readable by a SECURITY DEFINER function) and only
-- ever returns a boolean — never the looked-up id.
create or replace function request_parent_link(p_child_email text, p_relationship text default null)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare v_child uuid;
begin
  if auth.uid() is null then return false; end if;

  select id into v_child from auth.users where email = p_child_email;
  if v_child is null or v_child = auth.uid() then return false; end if;

  insert into parent_links (parent_id, athlete_id, relationship)
  values (auth.uid(), v_child, p_relationship)
  on conflict (parent_id, athlete_id) do nothing;

  return true;
end $$;

revoke all on function request_parent_link(text, text) from public;
grant execute on function request_parent_link(text, text) to authenticated;

-- only the CHILD side can approve (parent_id is deliberately excluded here)
drop policy if exists parent_links_approve on parent_links;
create policy parent_links_approve on parent_links
  for update using (athlete_id = auth.uid())
  with check (athlete_id = auth.uid());

-- either side can remove a link (deny a pending request, or revoke)
drop policy if exists parent_links_delete on parent_links;
create policy parent_links_delete on parent_links
  for delete using (parent_id = auth.uid() or athlete_id = auth.uid());

-- both sides of a pending/approved link need to see each other's name to
-- make an informed approve/deny decision — profiles_self alone can't do
-- that (is_parent_of() now requires approved_at, which is the thing being
-- decided). Scoped strictly to pairs with an existing parent_links row.
drop policy if exists profiles_linked on profiles;
create policy profiles_linked on profiles
  for select using (
    exists (select 1 from parent_links where parent_id = auth.uid() and athlete_id = profiles.id)
    or exists (select 1 from parent_links where athlete_id = auth.uid() and parent_id = profiles.id)
  );

-- ============================================================
-- Done. Still true / known gaps after this migration:
--  - coaches/agents have RLS enabled with zero policies -> fully locked to
--    every client, including their own owner. Not touched here since
--    nothing in the app currently signs anyone up as coach/agent (role is
--    never set from the signup form). Revisit if/when that's built.
--  - clubs has no write policy at all (read-only to every client).
--  - This is mutual in-app consent for parent access, not COPPA/GDPR-K
--    verified parental consent. Get legal input before relying on it for
--    real minors at launch.
-- ============================================================

-- ------------------------------------------------------------
-- 5) profiles has no public-read policy at all (only profiles_self and the
--    parent_links-scoped profiles_linked added above) — correct, since
--    profiles.dob is sensitive, especially for minors. But that means
--    Feed/Discover embedding profiles(full_name) through athletes/posts
--    silently returns null for anyone else's row. A blanket "select using
--    (true)" policy would fix the embed but also expose dob/role/plan to
--    every authenticated user, which we don't want. Instead: a narrow view
--    exposing only (id, full_name), owned by postgres so it bypasses RLS
--    on the base table while only ever surfacing those two columns.
-- ------------------------------------------------------------
create or replace view public_profile_names as
select id, full_name from profiles;

grant select on public_profile_names to anon, authenticated;


-- ============================================================
-- From supabase-migration-005-launch-readiness.sql
-- ============================================================

-- ============================================================
-- 005 — Launch readiness: minor safety, Stripe plan gating, Feed
--        moderation. Additive on top of 002 + 004. Written against
--        the real live schema confirmed in this session (profiles has
--        no email column, parent_links is id/parent_id/athlete_id/
--        relationship/approved_at/created_at, athletes.id = profiles.id).
--
-- IMPORTANT — read before running: the minor-safety mechanism below is
-- mutual in-app consent (a minor optionally names a parent's email at
-- signup; if that parent already has an account, a pending parent_links
-- row is auto-created; the minor stays restricted — no public posts, not
-- shown in Discover — until that link is approved). This is NOT
-- COPPA/GDPR-K verified parental consent. Get real legal review before
-- relying on this for real minors in production.
-- ============================================================

-- ------------------------------------------------------------
-- 1) profiles: minor tracking, admin flag, Stripe customer id
-- ------------------------------------------------------------
alter table profiles add column if not exists is_minor boolean not null default false;
alter table profiles add column if not exists pending_parent_email text;
alter table profiles add column if not exists is_admin boolean not null default false;
alter table profiles add column if not exists stripe_customer_id text;

-- ------------------------------------------------------------
-- 2) handle_new_user() — compute is_minor from date_of_birth, capture
--    pending_parent_email, and auto-request a parent_links row if that
--    parent email already has an account (still requires the parent's
--    approval — see is_restricted_minor() below, this does NOT itself
--    grant access).
-- ------------------------------------------------------------
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_dob date;
  v_is_minor boolean := false;
  v_parent_email text;
  v_parent_id uuid;
begin
  v_dob := nullif(new.raw_user_meta_data->>'date_of_birth', '')::date;
  if v_dob is not null then
    v_is_minor := (date_part('year', age(v_dob)) < 18);
  end if;
  v_parent_email := nullif(new.raw_user_meta_data->>'parent_email', '');

  insert into profiles (id, full_name, dob, is_minor, pending_parent_email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    v_dob,
    v_is_minor,
    case when v_is_minor then v_parent_email else null end
  )
  on conflict (id) do nothing;

  insert into athletes (id) values (new.id)
  on conflict (id) do nothing;

  if v_is_minor and v_parent_email is not null then
    select u.id into v_parent_id from auth.users u where u.email = v_parent_email;
    if v_parent_id is not null and v_parent_id <> new.id then
      insert into parent_links (parent_id, athlete_id, relationship)
      values (v_parent_id, new.id, 'parent')
      on conflict (parent_id, athlete_id) do nothing;
    end if;
  end if;

  return new;
end;
$$;

-- backfill is_minor for existing profiles from their stored dob
update profiles set is_minor = (dob is not null and date_part('year', age(dob)) < 18)
where dob is not null;

-- ------------------------------------------------------------
-- 3) is_restricted_minor() — the actual gate. True until an approved
--    parent_links row exists.
-- ------------------------------------------------------------
create or replace function is_restricted_minor(p_user uuid)
returns boolean language sql security definer set search_path to 'public' as $$
  select coalesce((select is_minor from profiles where id = p_user), false)
    and not exists (
      select 1 from parent_links where athlete_id = p_user and approved_at is not null
    );
$$;

create or replace function is_admin()
returns boolean language sql security definer set search_path to 'public' as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false);
$$;

-- ------------------------------------------------------------
-- 4) Apply the gate: restricted minors can't post publicly or appear in
--    Discover. Note: Messages/DMs aren't wired to a real backend yet
--    (still a hardcoded array in golsz-app.html) so there's nothing real
--    to gate there — only posts + athlete directory visibility today.
-- ------------------------------------------------------------
drop policy if exists posts_write on posts;
create policy posts_write on posts for insert with check (
  (author_id = auth.uid() and not is_restricted_minor(auth.uid()))
  or is_parent_of(author_id)
);

drop policy if exists athletes_read on athletes;
create policy athletes_read on athletes for select using (
  not is_restricted_minor(id) or id = auth.uid() or is_parent_of(id)
);

-- admin can remove any post (moderation, no UI yet — use the Supabase
-- table editor; flip your own profiles.is_admin to true once via SQL)
drop policy if exists posts_delete on posts;
create policy posts_delete on posts for delete using (
  author_id = auth.uid() or is_parent_of(author_id) or is_admin()
);

-- ------------------------------------------------------------
-- 5) Reporting + blocking (minimum viable moderation)
-- ------------------------------------------------------------
create table if not exists post_reports (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references posts(id) on delete cascade,
  reporter_id  uuid not null references profiles(id) on delete cascade,
  reason       text,
  created_at   timestamptz not null default now()
);
alter table post_reports enable row level security;
drop policy if exists post_reports_insert on post_reports;
create policy post_reports_insert on post_reports for insert with check (reporter_id = auth.uid());
drop policy if exists post_reports_read on post_reports;
create policy post_reports_read on post_reports for select using (
  reporter_id = auth.uid() or is_admin()
);

create table if not exists blocks (
  blocker_id  uuid not null references profiles(id) on delete cascade,
  blocked_id  uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);
alter table blocks enable row level security;
drop policy if exists blocks_read on blocks;
create policy blocks_read on blocks for select using (blocker_id = auth.uid());
drop policy if exists blocks_write on blocks;
create policy blocks_write on blocks for insert with check (blocker_id = auth.uid());
drop policy if exists blocks_delete on blocks;
create policy blocks_delete on blocks for delete using (blocker_id = auth.uid());

-- ============================================================
-- Done. To moderate as admin: run, once, for your own account:
--   update profiles set is_admin = true where id = '<your-user-id>';
-- (find your id via: select id from auth.users where email = '<you>';)
--
-- Known gaps after this migration, unchanged from before:
--  - Mutual in-app consent for minors, not verified legal consent. Get
--    legal review before relying on this for real minors in production.
--  - No moderation queue/UI — report rows land in post_reports for you
--    to review manually; deletion is via posts_delete + is_admin().
--  - Pro/Elite marketing bullets beyond Scout's daily limit (verified
--    passport, priority visibility) aren't backed by any gating
--    mechanic yet — undefined product scope, not built here.
-- ============================================================
