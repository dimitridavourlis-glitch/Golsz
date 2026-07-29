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
-- were never fully re-documented here.
--
-- profiles.plan is a Postgres enum (plan_tier) confirmed LIVE via direct
-- write attempts (2026-07-15): valid values are 'starter' | 'pro' |
-- 'elite' — there is NO 'free' value. Every check in this codebase now
-- uses 'starter' for the free tier (fixed in migration 008 — before that,
-- api/scout.js checked `plan === 'free'`, a value the enum can't even
-- hold, so the Scout daily-call limit silently never applied to anyone).
-- profiles.role's enum values are still unconfirmed.
--
-- Confirmed real base-table shape (2026-07-07 introspection, athletes
-- columns extended 2026-07-15 by migration 008):
--   profiles(id, full_name, role enum, plan enum('starter'|'pro'|'elite'),
--            dob, created_at, is_minor, pending_parent_email, is_admin,
--            stripe_customer_id)
--   athletes(id, sport, position, height_cm, weight_kg, grad_year, gpa,
--            club_id, highlights jsonb, created_at, gender, bio, foot,
--            recruiting_status, country, club_name)
--            — id IS profiles.id, there is no separate profile_id column
--            — club_id/clubs is a separate, empty, read-only directory;
--              club_name is the real free-text field the UI actually uses
--   coaches(id, club_id, title)         — RLS on, zero policies, fully locked
--   agents(id, agency)                  — RLS on, zero policies, fully locked
--   clubs(id, name, city, country, created_at)  — no write policy, read-only, empty
--   parent_links(id, parent_id, athlete_id, relationship, approved_at, created_at)
--   scout_history(id, user_id, conversation_id, messages jsonb, created_at)
--   follows(follower_id, followed_id, created_at)
--   messages(id, sender_id, recipient_id, body, created_at, read_at)
--
-- Everything below this point (posts, post_likes, events, gender column,
-- the parent-verification RPC/policies, is_minor/admin/stripe columns,
-- post_reports, blocks, follows, messages, editable-profile columns,
-- scout_history.conversation_id) is fully created by the statements in
-- this file — safe to re-run against the live project (every statement is
-- idempotent: create-if-not-exists / create-or-replace / drop-then-create
-- policy).
--
-- Migration history, in the order actually applied:
--   1. (undocumented — created the base tables listed above, predates
--      this session)
--   2. supabase-migration-002-posts-events.sql
--   3. supabase-migration-004-fix-real-schema.sql
--   4. supabase-migration-005-launch-readiness.sql
--   5. supabase-migration-006-follows.sql
--   6. supabase-migration-007-messages.sql
--   7. supabase-migration-008-editable-profiles.sql
--   8. supabase-migration-009-admin-panel.sql
--   9. supabase-migration-010-scout-conversations.sql
--  10. supabase-migration-011-personal-events.sql
--  11. supabase-migration-012-scout-history-delete.sql
--  12. supabase-migration-013-hide-conversations.sql
--  13. supabase-migration-014-push-notifications.sql
--  14. supabase-migration-015-realtime-messages.sql
--  15. supabase-migration-016-post-images.sql
--  16. supabase-migration-017-post-images-hardening.sql
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

-- ============================================================
-- Migration 006 — Follows
-- ============================================================
-- ============================================================
-- 006 — Follows (profiles can follow each other)
-- Additive on top of 002 + 004 + 005.
-- ============================================================

create table if not exists follows (
  follower_id  uuid not null references profiles(id) on delete cascade,
  followed_id  uuid not null references profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, followed_id),
  check (follower_id <> followed_id)
);
alter table follows enable row level security;

-- public read (same "public directory" pattern as posts/athletes) — needed
-- so follower/following counts can be shown on any profile, not just your own
drop policy if exists follows_read on follows;
create policy follows_read on follows for select using (true);

drop policy if exists follows_write on follows;
create policy follows_write on follows for insert with check (follower_id = auth.uid());

drop policy if exists follows_delete on follows;
create policy follows_delete on follows for delete using (follower_id = auth.uid());

-- ============================================================
-- Done. No minor-safety special case needed here: a restricted minor
-- already can't post (posts_write) and is hidden from Discover
-- (athletes_read), so there's no UI path to follow one anyway — the
-- existing gates already cover it.
-- ============================================================

-- ============================================================
-- Migration 007 — Messages
-- ============================================================
-- ============================================================
-- 007 — Direct messages between profiles that follow each other
-- Additive on top of 002 + 004 + 005 + 006.
-- ============================================================

create table if not exists messages (
  id            uuid primary key default gen_random_uuid(),
  sender_id     uuid not null references profiles(id) on delete cascade,
  recipient_id  uuid not null references profiles(id) on delete cascade,
  body          text not null check (char_length(trim(body)) between 1 and 2000),
  created_at    timestamptz not null default now(),
  read_at       timestamptz,
  check (sender_id <> recipient_id)
);
create index if not exists messages_thread_idx  on messages (sender_id, recipient_id, created_at);
create index if not exists messages_thread_idx2 on messages (recipient_id, sender_id, created_at);
alter table messages enable row level security;

-- Two profiles can message each other once there's a follow relationship
-- in either direction, and neither has blocked the other. Mirrors "message
-- anyone you follow, or who follows you" rather than requiring mutual follow.
create or replace function can_message(a uuid, b uuid)
returns boolean language sql security definer set search_path to 'public' as $$
  select exists (
    select 1 from follows
    where (follower_id = a and followed_id = b) or (follower_id = b and followed_id = a)
  ) and not exists (
    select 1 from blocks
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
  );
$$;

drop policy if exists messages_read on messages;
create policy messages_read on messages for select using (
  sender_id = auth.uid() or recipient_id = auth.uid()
);

-- restricted minors (see is_restricted_minor() in migration 005) can't send
-- or receive DMs either, same posture as posts/Discover visibility
drop policy if exists messages_write on messages;
create policy messages_write on messages for insert with check (
  sender_id = auth.uid()
  and not is_restricted_minor(auth.uid())
  and not is_restricted_minor(recipient_id)
  and can_message(auth.uid(), recipient_id)
);

-- recipient marks their own inbound messages read
drop policy if exists messages_update on messages;
create policy messages_update on messages for update using (
  recipient_id = auth.uid()
) with check (
  recipient_id = auth.uid()
);

-- sender can unsend/delete their own messages
drop policy if exists messages_delete on messages;
create policy messages_delete on messages for delete using (
  sender_id = auth.uid()
);

-- ============================================================
-- Done. This is the first real backend for the Messages tab — it was a
-- hardcoded THREADS demo array with no insert/read path at all before.
-- ============================================================

-- ============================================================
-- Migration 008 — Editable profiles + plan fix
-- ============================================================
-- ============================================================
-- 008 — Editable athlete profiles + fix plan assignment on signup
-- Additive on top of 002 + 004 + 005 + 006 + 007.
-- ============================================================

-- 1) New editable athlete profile fields. bio/foot/recruiting_status/
--    country/club_name were all display-only fake data in golsz-app.html
--    before this — no columns existed. club_name is deliberately free
--    text rather than the clubs(id) FK: clubs is an empty, read-only
--    directory with no insert policy (a separate, unbuilt "verified club"
--    feature), not something a user can register themselves into today.
alter table athletes add column if not exists bio text;
alter table athletes add column if not exists foot text;
alter table athletes add column if not exists recruiting_status text;
alter table athletes add column if not exists country text;
alter table athletes add column if not exists club_name text;
-- owner/parent write access to these is already covered by the
-- pre-existing athletes_rw policy — no new RLS needed.

-- 2) handle_new_user() captured the chosen plan in signup metadata but
--    never applied it to profiles.plan, which silently kept its column
--    default ('starter') for every signup. Separately, api/scout.js's
--    free-tier Scout limit checks `plan === 'free'` — a value the
--    plan_tier enum doesn't even contain (confirmed live: only
--    'starter' | 'pro' | 'elite' are valid) — so that check could never
--    fire for anyone, on any plan. Net effect: the Scout daily-call
--    limit has not been enforced for a single user in production.
--    Fixed here (enum-safe) and in api/scout.js + api/stripe-webhook.js,
--    which now check/set 'starter' instead of the nonexistent 'free'.
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_dob date;
  v_is_minor boolean := false;
  v_parent_email text;
  v_parent_id uuid;
  v_plan text;
begin
  v_dob := nullif(new.raw_user_meta_data->>'date_of_birth', '')::date;
  if v_dob is not null then
    v_is_minor := (date_part('year', age(v_dob)) < 18);
  end if;
  v_parent_email := nullif(new.raw_user_meta_data->>'parent_email', '');

  v_plan := new.raw_user_meta_data->>'plan';
  if v_plan is null or v_plan not in ('starter', 'pro', 'elite') then
    v_plan := 'starter';
  end if;

  insert into profiles (id, full_name, dob, is_minor, pending_parent_email, plan)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    v_dob,
    v_is_minor,
    case when v_is_minor then v_parent_email else null end,
    v_plan::plan_tier
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

-- ============================================================
-- Done.
-- ============================================================

-- ============================================================
-- Migration 009 — Admin panel
-- ============================================================
-- ============================================================
-- 009 — Admin panel: broaden RLS for admins, add report resolution state
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008.
--
-- Reuses the existing is_admin() helper (migration 005) — this migration
-- only adds the extra read/write access an admin needs to actually run a
-- moderation panel, plus a resolved_at column so reports can be dismissed
-- without deleting the underlying post.
-- ============================================================

alter table post_reports add column if not exists resolved_at timestamptz;

-- admin can see every profile (user list in the admin panel) — additive
-- to whatever profiles_self already grants the owner.
drop policy if exists profiles_admin_read on profiles;
create policy profiles_admin_read on profiles for select using (is_admin());

-- admin can update any profile — the admin UI only ever writes is_admin
-- or plan, but RLS is row-level, not column-level, so this technically
-- allows any column. Same trust posture as posts_delete's is_admin()
-- bypass elsewhere in this schema: gate the capability, keep the UI narrow.
drop policy if exists profiles_admin_write on profiles;
create policy profiles_admin_write on profiles for update using (is_admin()) with check (is_admin());

-- admin can see restricted minors too (needed to moderate them)
drop policy if exists athletes_read on athletes;
create policy athletes_read on athletes for select using (
  not is_restricted_minor(id) or id = auth.uid() or is_parent_of(id) or is_admin()
);

-- admin can manage any event, not just their own
drop policy if exists events_update on events;
create policy events_update on events for update using (created_by = auth.uid() or is_admin());
drop policy if exists events_delete on events;
create policy events_delete on events for delete using (created_by = auth.uid() or is_admin());

-- admin can mark a report resolved (dismiss without deleting the post)
drop policy if exists post_reports_update on post_reports;
create policy post_reports_update on post_reports for update using (is_admin()) with check (is_admin());

-- ============================================================
-- Done. To make yourself admin (one-time, run once for your own account):
--   update profiles set is_admin = true where id =
--     (select id from auth.users where email = '<your-email>');
-- ============================================================

-- ============================================================
-- Migration 010 — Scout conversation threads
-- ============================================================
-- ============================================================
-- 010 — Scout conversation threads (New chat + History, like Claude/ChatGPT)
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009.
--
-- scout_history was previously one flat, ever-growing transcript per user
-- (every turn since the beginning, all flattened into one chat on load —
-- no concept of "a conversation"). This adds conversation_id so turns can
-- be grouped into distinct threads: the client starts a fresh uuid on
-- "New chat", keeps logging turns under it, and can list/reopen past ones.
-- ============================================================

alter table scout_history add column if not exists conversation_id uuid;

-- group each user's pre-existing (pre-feature) turns into one legacy
-- conversation per user, rather than fragmenting every historical row
-- into its own separate "conversation" of one message.
with legacy as (
  select user_id, gen_random_uuid() as cid
  from scout_history
  where conversation_id is null
  group by user_id
)
update scout_history sh
set conversation_id = legacy.cid
from legacy
where sh.user_id = legacy.user_id and sh.conversation_id is null;

alter table scout_history alter column conversation_id set default gen_random_uuid();
alter table scout_history alter column conversation_id set not null;

create index if not exists scout_history_conversation_idx on scout_history (conversation_id, created_at);
create index if not exists scout_history_user_idx on scout_history (user_id, created_at desc);

-- ============================================================
-- Done. No RLS changes — scout_history's existing owner-scoped policies
-- already cover this column since it's just an additional field on the
-- same row.
-- ============================================================

-- ============================================================
-- Migration 011 — Personal opportunities (private events)
-- ============================================================
-- ============================================================
-- 011 — Personal opportunities (save a post/message/manual entry to
-- your own private events list, distinct from the public events directory)
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010.
--
-- Reuses the existing events table rather than a parallel one — a
-- personal "add this trial to my events" entry and a public combine
-- listing are the same shape, just different visibility. events_write/
-- update/delete already scope to created_by = auth.uid() (or is_admin()),
-- so only events_read needs to change: private rows are now only visible
-- to their owner (and admins), where before every row was fully public.
-- ============================================================

alter table events add column if not exists visibility text not null default 'public' check (visibility in ('public','private'));
alter table events add column if not exists notes text;

drop policy if exists events_read on events;
create policy events_read on events for select using (
  visibility = 'public' or created_by = auth.uid() or is_admin()
);

-- ============================================================
-- Done.
-- ============================================================

-- ============================================================
-- Migration 012 — Scout conversation delete
-- ============================================================
-- ============================================================
-- 012 — Allow deleting your own Scout conversations
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011.
--
-- scout_history predates this migration series (base table, RLS policies
-- undocumented/unconfirmed — see supabase-schema.sql's header warning).
-- Rather than guess at and possibly clash with an existing policy name,
-- this just adds a new, uniquely-named delete policy — RLS policies for
-- the same command are OR'd together, so this is safe to run regardless
-- of whatever already exists on the table.
-- ============================================================

drop policy if exists scout_history_delete on scout_history;
create policy scout_history_delete on scout_history for delete using (
  user_id = auth.uid()
);

-- ============================================================
-- Done.
-- ============================================================

-- ============================================================
-- Migration 013 — Hide/delete a conversation
-- ============================================================
-- ============================================================
-- 013 — Delete a whole conversation (hide it from your own list)
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 + 012.
--
-- Deliberately NOT a real destructive delete of the messages table: the
-- existing messages_delete RLS only lets you delete rows you sent
-- (sender_id = auth.uid()), so a true "delete conversation" would either
-- (a) only remove your half of it and leave the other person's messages
-- behind, or (b) require letting either participant delete the other's
-- messages too, which would silently wipe the thread for both people.
-- Instead this is a "delete for me" hide: a row here just means "don't
-- show me this conversation" as of hidden_at — it reappears automatically
-- the moment a new message arrives after that point, same as most DM
-- apps' archive/delete-thread behavior. Nothing is destroyed, and the
-- other participant's view is completely unaffected.
-- ============================================================

create table if not exists hidden_conversations (
  user_id    uuid not null references profiles(id) on delete cascade,
  other_id   uuid not null references profiles(id) on delete cascade,
  hidden_at  timestamptz not null default now(),
  primary key (user_id, other_id)
);
alter table hidden_conversations enable row level security;

drop policy if exists hidden_conversations_rw on hidden_conversations;
create policy hidden_conversations_rw on hidden_conversations for all using (
  user_id = auth.uid()
) with check (
  user_id = auth.uid()
);

-- ============================================================
-- 14) ADDITIVE — PUSH_SUBSCRIPTIONS (real Web Push notifications)
-- See supabase-migration-014-push-notifications.sql for full context.
-- ============================================================

create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;

drop policy if exists push_subscriptions_rw on push_subscriptions;
create policy push_subscriptions_rw on push_subscriptions for all using (
  user_id = auth.uid()
) with check (
  user_id = auth.uid()
);

-- ============================================================
-- 15) ADDITIVE — live message delivery via Realtime
-- See supabase-migration-015-realtime-messages.sql for full context.
-- ============================================================

alter publication supabase_realtime add table messages;

-- ============================================================
-- 16) ADDITIVE — photo attachments on Feed posts
-- See supabase-migration-016-post-images.sql for full context.
-- ============================================================

alter table posts add column if not exists image_url text;

insert into storage.buckets (id, name, public)
values ('post-images', 'post-images', true)
on conflict (id) do nothing;

drop policy if exists post_images_read on storage.objects;
create policy post_images_read on storage.objects for select using (
  bucket_id = 'post-images'
);

drop policy if exists post_images_write on storage.objects;
create policy post_images_write on storage.objects for insert with check (
  bucket_id = 'post-images'
  and (storage.foldername(name))[1] = auth.uid()::text
  and not is_restricted_minor(auth.uid())
);

drop policy if exists post_images_delete on storage.objects;
create policy post_images_delete on storage.objects for delete using (
  bucket_id = 'post-images' and (storage.foldername(name))[1] = auth.uid()::text
);

-- ============================================================
-- 17) ADDITIVE — close two post-images gaps (restricted-minor upload,
-- server-side size/type enforcement)
-- See supabase-migration-017-post-images-hardening.sql for full context.
-- ============================================================

update storage.buckets
set file_size_limit = 8388608,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif']
where id = 'post-images';

-- ============================================================
-- 18) ADDITIVE — athletes.education_level (High School / University / Other)
-- See supabase-migration-018-education-level.sql for full context.
-- ============================================================

alter table athletes add column if not exists education_level text;

-- ============================================================
-- 19) ADDITIVE — admin: ban accounts, delete accounts, block events
-- See supabase-migration-019-admin-ban-block.sql for full context.
-- ============================================================

alter table profiles add column if not exists is_banned boolean not null default false;
alter table events add column if not exists is_blocked boolean not null default false;

create or replace function is_banned(p_user uuid)
returns boolean language sql security definer set search_path to 'public' as $$
  select coalesce((select is_banned from profiles where id = p_user), false);
$$;

drop policy if exists posts_write on posts;
create policy posts_write on posts for insert with check (
  (author_id = auth.uid() and not is_restricted_minor(auth.uid()) and not is_banned(auth.uid()))
  or is_parent_of(author_id)
);

drop policy if exists athletes_read on athletes;
create policy athletes_read on athletes for select using (
  (not is_restricted_minor(id) or id = auth.uid() or is_parent_of(id) or is_admin())
  and (not is_banned(id) or id = auth.uid() or is_admin())
);

drop policy if exists events_read on events;
create policy events_read on events for select using (
  (visibility = 'public' or created_by = auth.uid() or is_admin())
  and (not is_blocked or is_admin())
);

create or replace function admin_delete_profile(p_target uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  if p_target = auth.uid() then
    raise exception 'cannot delete your own account';
  end if;
  delete from scout_history where user_id = p_target;
  delete from parent_links where athlete_id = p_target or parent_id = p_target;
  delete from athletes where id = p_target;
  delete from coaches where id = p_target;
  delete from agents where id = p_target;
  delete from profiles where id = p_target;
end;
$$;

grant execute on function admin_delete_profile(uuid) to authenticated;

-- ============================================================
-- 20) ADDITIVE — profiles.occupation (Scout/Agent/Coach/Physio/Other)
-- See supabase-migration-020-occupation.sql for full context.
-- ============================================================

alter table profiles add column if not exists occupation text
  check (occupation in ('Player', 'Scout', 'Agent', 'Coach', 'Physio', 'Other'));

create or replace view public_profile_names as
select id, full_name, occupation from profiles;

grant select on public_profile_names to anon, authenticated;

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_dob date;
  v_is_minor boolean := false;
  v_parent_email text;
  v_parent_id uuid;
  v_plan text;
  v_occupation text;
begin
  v_dob := nullif(new.raw_user_meta_data->>'date_of_birth', '')::date;
  if v_dob is not null then
    v_is_minor := (date_part('year', age(v_dob)) < 18);
  end if;
  v_parent_email := nullif(new.raw_user_meta_data->>'parent_email', '');

  v_plan := new.raw_user_meta_data->>'plan';
  if v_plan is null or v_plan not in ('starter', 'pro', 'elite') then
    v_plan := 'starter';
  end if;

  v_occupation := nullif(new.raw_user_meta_data->>'occupation', '');
  if v_occupation is not null and v_occupation not in ('Player', 'Scout', 'Agent', 'Coach', 'Physio', 'Other') then
    v_occupation := null;
  end if;

  insert into profiles (id, full_name, dob, is_minor, pending_parent_email, plan, occupation)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    v_dob,
    v_is_minor,
    case when v_is_minor then v_parent_email else null end,
    v_plan::plan_tier,
    v_occupation
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

-- ============================================================
-- 21) ADDITIVE — non-player Passport fields (license, looking for players)
-- See supabase-migration-021-non-player-passport.sql for full context.
-- ============================================================

alter table athletes add column if not exists license text;
alter table athletes add column if not exists looking_for_players boolean;

-- ============================================================
-- 22) ADDITIVE — search_players() for AI Scout's real-player search
-- See supabase-migration-022-search-players.sql for full context.
-- ============================================================

create or replace function search_players(
  p_sport text default null,
  p_position text default null,
  p_country text default null,
  p_grad_year int default null,
  p_gender text default null,
  p_recruiting_status text default null,
  p_limit int default 10
)
returns table (
  id uuid,
  full_name text,
  sport text,
  "position" text,
  country text,
  club_name text,
  grad_year int,
  gender text,
  recruiting_status text
)
language sql security definer set search_path to 'public' as $$
  select p.id, p.full_name, a.sport, a.position, a.country, a.club_name, a.grad_year, a.gender, a.recruiting_status
  from athletes a
  join profiles p on p.id = a.id
  where a.sport is not null
    and (p.occupation is null or p.occupation = 'Player')
    and not is_restricted_minor(a.id)
    and not is_banned(a.id)
    and (p_sport is null or a.sport ilike p_sport)
    and (p_position is null or a.position ilike '%' || p_position || '%')
    and (p_country is null or a.country ilike p_country)
    and (p_grad_year is null or a.grad_year = p_grad_year)
    and (p_gender is null or a.gender = p_gender)
    and (p_recruiting_status is null or a.recruiting_status = p_recruiting_status)
  order by a.created_at desc nulls last
  limit least(coalesce(p_limit, 10), 25);
$$;

grant execute on function search_players(text, text, text, int, text, text, int) to authenticated;

-- ============================================================
-- 23) ADDITIVE — security hardening (plan/admin self-escalation, event
-- un-blocking, Scout usage-counter griefing)
-- See supabase-migration-023-security-hardening.sql for full context.
-- ============================================================

create or replace function protect_profile_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.role() is null or auth.role() = 'service_role' or is_admin() then
    return new;
  end if;
  new.is_admin := old.is_admin;
  new.is_banned := old.is_banned;
  new.stripe_customer_id := old.stripe_customer_id;
  if new.plan is distinct from old.plan and new.plan <> 'starter' then
    new.plan := old.plan;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_columns_trigger on profiles;
create trigger protect_profile_columns_trigger
  before update on profiles
  for each row execute function protect_profile_columns();

create or replace function protect_event_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.role() is null or auth.role() = 'service_role' or is_admin() then
    return new;
  end if;
  new.is_blocked := old.is_blocked;
  return new;
end;
$$;

drop trigger if exists protect_event_columns_trigger on events;
create trigger protect_event_columns_trigger
  before update on events
  for each row execute function protect_event_columns();

revoke execute on function increment_scout_usage(uuid) from anon;
revoke execute on function increment_scout_usage(uuid) from authenticated;
revoke execute on function increment_scout_usage(uuid) from public;
grant execute on function increment_scout_usage(uuid) to service_role;

-- ============================================================
-- 24) ADDITIVE — admin-controlled "verified" badge for non-player accounts
-- See supabase-migration-024-verified-badge.sql for full context.
-- ============================================================

alter table profiles add column if not exists is_verified boolean not null default false;

create or replace view public_profile_names as
select id, full_name, occupation, is_verified from profiles;

grant select on public_profile_names to anon, authenticated;

create or replace function protect_profile_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.role() is null or auth.role() = 'service_role' or is_admin() then
    return new;
  end if;
  new.is_admin := old.is_admin;
  new.is_banned := old.is_banned;
  new.is_verified := old.is_verified;
  new.stripe_customer_id := old.stripe_customer_id;
  if new.plan is distinct from old.plan and new.plan <> 'starter' then
    new.plan := old.plan;
  end if;
  return new;
end;
$$;

-- ============================================================
-- Done.
-- ============================================================
