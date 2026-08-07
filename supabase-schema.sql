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
-- 25) ADDITIVE — verified badge tiers (Pro/Elite), admin-controlled and
-- independent of payment plan
-- See supabase-migration-025-verified-tier.sql for full context.
-- ============================================================

drop table if exists verification_requests cascade;
drop function if exists admin_review_verification_request(uuid, boolean);
alter table profiles drop constraint if exists is_verified_requires_paid_plan;

alter table profiles add column if not exists verified_tier text not null default 'none'
  check (verified_tier in ('none', 'pro', 'elite'));

update profiles set verified_tier = case when plan = 'elite' then 'elite' else 'pro' end
  where is_verified = true and verified_tier = 'none';

drop view if exists public_profile_names;
create view public_profile_names as
select id, full_name, occupation, verified_tier from profiles;

grant select on public_profile_names to anon, authenticated;

alter table profiles drop column if exists is_verified;

create or replace function protect_profile_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if not (auth.role() is null or auth.role() = 'service_role' or is_admin()) then
    new.is_admin := old.is_admin;
    new.is_banned := old.is_banned;
    new.verified_tier := old.verified_tier;
    new.stripe_customer_id := old.stripe_customer_id;
    if new.plan is distinct from old.plan and new.plan <> 'starter' then
      new.plan := old.plan;
    end if;
  end if;

  if new.plan is distinct from old.plan then
    new.verified_tier := case new.plan when 'elite' then 'elite' when 'pro' then 'pro' else 'none' end;
  end if;

  return new;
end;
$$;

-- ============================================================
-- 26) ADDITIVE — push notification triggers (messages/follows -> api/send-push)
-- See supabase-migration-026-push-webhook-triggers.sql for full context.
-- ============================================================

create extension if not exists pg_net schema extensions;

create or replace function notify_send_push()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  perform net.http_post(
    url := 'https://golsz.vercel.app/api/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-webhook-secret', '2209b4e6446eab5feeed1a7817fad4797e8278cc2452dacf023738485d07fbb5'
    ),
    body := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(NEW),
      'old_record', null
    )
  );
  return NEW;
end;
$$;

drop trigger if exists notify_new_message on public.messages;
create trigger notify_new_message
  after insert on public.messages
  for each row execute function notify_send_push();

drop trigger if exists notify_new_follower on public.follows;
create trigger notify_new_follower
  after insert on public.follows
  for each row execute function notify_send_push();

-- ============================================================
-- 27) ADDITIVE — real auth-layer ban/delete, plus coaches/agents RLS
-- See supabase-migration-027-admin-auth-actions.sql for full context.
-- ============================================================

drop function if exists admin_delete_profile(uuid);

create or replace function admin_delete_profile_data(p_target uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  delete from scout_history where user_id = p_target;
  delete from parent_links where athlete_id = p_target or parent_id = p_target;
  delete from athletes where id = p_target;
  delete from coaches where id = p_target;
  delete from agents where id = p_target;
end;
$$;

revoke all on function admin_delete_profile_data(uuid) from public, authenticated, anon;
grant execute on function admin_delete_profile_data(uuid) to service_role;

drop policy if exists coaches_rw on coaches;
create policy coaches_rw on coaches for all using (
  id = auth.uid()
) with check (
  id = auth.uid()
);

drop policy if exists agents_rw on agents;
create policy agents_rw on agents for all using (
  id = auth.uid()
) with check (
  id = auth.uid()
);

-- ============================================================
-- 28) ADDITIVE — admin analytics aggregate counts
-- See supabase-migration-028-admin-analytics.sql for full context.
-- ============================================================

create or replace function admin_analytics_counts()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  result jsonb;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select jsonb_build_object(
    'messages_total', (select count(*) from messages),
    'messages_7d', (select count(*) from messages where created_at > now() - interval '7 days'),
    'scout_conversations_total', (select count(*) from scout_history),
    'scout_users_total', (select count(distinct user_id) from scout_history),
    'push_subscribers_total', (select count(distinct user_id) from push_subscriptions)
  ) into result;
  return result;
end;
$$;

grant execute on function admin_analytics_counts() to authenticated;

-- ============================================================
-- 29) ADDITIVE — profile photo (avatar) upload
-- See supabase-migration-029-avatars.sql for full context.
-- ============================================================

alter table profiles add column if not exists avatar_url text;

create or replace view public_profile_names as
select id, full_name, occupation, verified_tier, avatar_url from profiles;

grant select on public_profile_names to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 8388608, array['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'])
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects for select using (
  bucket_id = 'avatars'
);

drop policy if exists avatars_write on storage.objects;
create policy avatars_write on storage.objects for insert with check (
  bucket_id = 'avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists avatars_update on storage.objects;
create policy avatars_update on storage.objects for update using (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
) with check (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete on storage.objects for delete using (
  bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
);

-- ============================================================
-- 30) ADDITIVE — admin action audit log
-- See supabase-migration-030-admin-audit-log.sql for full context.
-- ============================================================

create table if not exists admin_action_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references profiles(id) on delete set null,
  action text not null,
  target_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_action_log_created_idx on admin_action_log (created_at desc);

alter table admin_action_log enable row level security;

drop policy if exists admin_action_log_read on admin_action_log;
create policy admin_action_log_read on admin_action_log for select using (
  is_admin()
);

create or replace function log_admin_action(p_action text, p_target_id uuid, p_detail jsonb default null)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  insert into admin_action_log (admin_id, action, target_id, detail)
  values (auth.uid(), p_action, p_target_id, p_detail);
end;
$$;

grant execute on function log_admin_action(text, uuid, jsonb) to authenticated;

-- ============================================================
-- 31) ADDITIVE — time-on-app tracking
-- See supabase-migration-031-activity-tracking.sql for full context.
-- ============================================================

create table if not exists daily_activity (
  user_id uuid not null references profiles(id) on delete cascade,
  activity_date date not null default current_date,
  minutes int not null default 0,
  primary key (user_id, activity_date)
);

create index if not exists daily_activity_date_idx on daily_activity (activity_date);

alter table daily_activity enable row level security;
-- Deliberately no policy for `authenticated` at all — see migration file.

create or replace function record_activity_ping(p_minutes int default 1)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null then
    return;
  end if;
  insert into daily_activity (user_id, activity_date, minutes)
  values (auth.uid(), current_date, p_minutes)
  on conflict (user_id, activity_date) do update set minutes = daily_activity.minutes + excluded.minutes;
end;
$$;

grant execute on function record_activity_ping(int) to authenticated;

create or replace function admin_analytics_counts()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  result jsonb;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select jsonb_build_object(
    'messages_total', (select count(*) from messages),
    'messages_7d', (select count(*) from messages where created_at > now() - interval '7 days'),
    'scout_conversations_total', (select count(*) from scout_history),
    'scout_users_total', (select count(distinct user_id) from scout_history),
    'push_subscribers_total', (select count(distinct user_id) from push_subscriptions),
    'activity_minutes_7d', (select coalesce(sum(minutes), 0) from daily_activity where activity_date > current_date - interval '7 days'),
    'activity_users_7d', (select count(distinct user_id) from daily_activity where activity_date > current_date - interval '7 days'),
    'activity_minutes_30d', (select coalesce(sum(minutes), 0) from daily_activity where activity_date > current_date - interval '30 days'),
    'activity_users_30d', (select count(distinct user_id) from daily_activity where activity_date > current_date - interval '30 days'),
    'activity_minutes_365d', (select coalesce(sum(minutes), 0) from daily_activity where activity_date > current_date - interval '365 days'),
    'activity_users_365d', (select count(distinct user_id) from daily_activity where activity_date > current_date - interval '365 days')
  ) into result;
  return result;
end;
$$;

grant execute on function admin_analytics_counts() to authenticated;

-- ============================================================
-- 32) ADDITIVE — admin can view a specific user's daily activity
-- See supabase-migration-032-admin-view-user-activity.sql for full context.
-- ============================================================

drop policy if exists daily_activity_admin_read on daily_activity;
create policy daily_activity_admin_read on daily_activity for select using (
  is_admin()
);

-- ============================================================
-- 33) ADDITIVE — moderation review queue
-- See supabase-migration-033-moderation-queue.sql for full context.
-- ============================================================

create table if not exists moderation_queue (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references profiles(id) on delete set null,
  content_type text not null,
  text text,
  surface text,
  decision text not null,
  primary_reason_code text,
  reason_codes jsonb,
  confidence numeric,
  minor_safety_triggered boolean not null default false,
  rationale text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references profiles(id) on delete set null
);

create index if not exists moderation_queue_created_idx on moderation_queue (created_at desc);
create index if not exists moderation_queue_unresolved_idx on moderation_queue (resolved_at) where resolved_at is null;

alter table moderation_queue enable row level security;

drop policy if exists moderation_queue_admin_read on moderation_queue;
create policy moderation_queue_admin_read on moderation_queue for select using (
  is_admin()
);

create or replace function resolve_moderation_item(p_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  update moderation_queue set resolved_at = now(), resolved_by = auth.uid() where id = p_id;
end;
$$;

grant execute on function resolve_moderation_item(uuid) to authenticated;

-- ============================================================
-- 34) ADDITIVE — constrain clip-post URLs at the database level
-- See supabase-migration-034-clip-post-url-check.sql for full context.
-- ============================================================

alter table posts drop constraint if exists posts_clip_body_is_http;
alter table posts add constraint posts_clip_body_is_http check (
  kind <> 'clip' or body is null or body ~* '^https?://'
);

-- ============================================================
-- 35) ADDITIVE — rate limit api/moderate.js
-- See supabase-migration-035-moderation-rate-limit.sql for full context.
-- ============================================================

create table if not exists moderation_check_usage (
  user_id uuid not null references profiles(id) on delete cascade,
  usage_date date not null default current_date,
  calls int not null default 0,
  primary key (user_id, usage_date)
);

alter table moderation_check_usage enable row level security;

create or replace function increment_moderation_usage(p_user uuid)
returns int language plpgsql security definer set search_path to 'public' as $$
declare v int;
begin
  insert into moderation_check_usage (user_id, usage_date, calls)
  values (p_user, current_date, 1)
  on conflict (user_id, usage_date) do update set calls = moderation_check_usage.calls + 1
  returning calls into v;
  return v;
end $$;

revoke all on function increment_moderation_usage(uuid) from public, authenticated, anon;
grant execute on function increment_moderation_usage(uuid) to service_role;

-- ============================================================
-- 36) ADDITIVE — application error log (general monitoring)
-- See supabase-migration-036-error-log.sql for full context.
-- ============================================================

create table if not exists error_log (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  message text not null,
  detail jsonb,
  url text,
  user_id uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references profiles(id) on delete set null
);

create index if not exists error_log_created_idx on error_log (created_at desc);
create index if not exists error_log_unresolved_idx on error_log (resolved_at) where resolved_at is null;

alter table error_log enable row level security;

drop policy if exists error_log_admin_read on error_log;
create policy error_log_admin_read on error_log for select using (
  is_admin()
);

create or replace function log_client_error(p_message text, p_detail jsonb default null, p_url text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  insert into error_log (source, message, detail, url, user_id)
  values ('client', left(coalesce(p_message, 'Unknown error'), 2000), p_detail, left(p_url, 500), auth.uid());
end;
$$;

grant execute on function log_client_error(text, jsonb, text) to authenticated, anon;

create or replace function resolve_error_log_item(p_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  update error_log set resolved_at = now(), resolved_by = auth.uid() where id = p_id;
end;
$$;

grant execute on function resolve_error_log_item(uuid) to authenticated;

-- ============================================================
-- 37) ADDITIVE — Instagram-style message requests
-- See supabase-migration-037-message-requests.sql for full context.
-- Redefines can_message() (originally from migration 007) to require an
-- explicit message_requests row instead of a follow relationship.
-- ============================================================

create table if not exists message_requests (
  sender_id uuid not null references profiles(id) on delete cascade,
  recipient_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  primary key (sender_id, recipient_id),
  check (sender_id <> recipient_id)
);

create index if not exists message_requests_recipient_idx on message_requests (recipient_id, status);

alter table message_requests enable row level security;

drop policy if exists message_requests_read on message_requests;
create policy message_requests_read on message_requests for select using (
  sender_id = auth.uid() or recipient_id = auth.uid()
);

create or replace function ensure_message_request(p_recipient uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null or p_recipient is null or p_recipient = auth.uid() then
    return;
  end if;
  if exists (
    select 1 from message_requests
    where (sender_id = auth.uid() and recipient_id = p_recipient)
       or (sender_id = p_recipient and recipient_id = auth.uid())
  ) then
    return;
  end if;
  insert into message_requests (sender_id, recipient_id, status)
  values (auth.uid(), p_recipient, 'pending');
end;
$$;

grant execute on function ensure_message_request(uuid) to authenticated;

create or replace function respond_to_message_request(p_sender uuid, p_accept boolean)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update message_requests
  set status = case when p_accept then 'accepted' else 'declined' end,
      responded_at = now()
  where sender_id = p_sender and recipient_id = auth.uid() and status = 'pending';
end;
$$;

grant execute on function respond_to_message_request(uuid, boolean) to authenticated;

create or replace function can_message(a uuid, b uuid)
returns boolean language sql security definer set search_path to 'public' as $$
  select
    not exists (
      select 1 from blocks
      where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
    )
    and (
      exists (
        select 1 from message_requests
        where sender_id = a and recipient_id = b and status in ('pending', 'accepted')
      )
      or exists (
        select 1 from message_requests
        where sender_id = b and recipient_id = a and status = 'accepted'
      )
    );
$$;

-- ============================================================
-- 038 — Close a real privacy leak in public_profile_names
-- Found during a full security audit. Additive/corrective on top of
-- every prior migration; only touches the public_profile_names view.
--
-- public_profile_names (first created in migration 020, last redefined
-- in migration 029 to add avatar_url) is a plain
--   select id, full_name, occupation, verified_tier, avatar_url from profiles
-- with no WHERE clause, granted to BOTH anon and authenticated. It exists
-- because profiles itself has no general cross-user read policy (only
-- profiles_self and the admin policies) — the view is the sanctioned,
-- deliberately narrow "just enough columns to show someone else's name/
-- photo" bypass, used everywhere the app needs to resolve another user's
-- display name (Feed authors, Discover, Messages senders, Passport,
-- follower lists, admin panel).
--
-- The bug: a Postgres view with no `security_invoker` runs as its OWNER,
-- which bypasses the underlying table's RLS entirely — so this view was
-- never subject to is_restricted_minor()'s gating, unlike every other
-- read path in this app (profiles_read, athletes_read, Discover, etc.).
-- Combined with the `anon` grant, this meant a completely unauthenticated
-- request could read every real user's full_name, occupation,
-- verified_tier, and avatar_url — including a restricted minor (someone
-- whose parent hasn't approved them yet), whose whole point is to be
-- invisible outside their own session and their linked parent's. Verified
-- live via a plain curl with the public anon key before this fix: the
-- base `profiles` table correctly returned [] for the same anon request,
-- but the view returned every row.
--
-- Fix, mirroring the exact `not is_restricted_minor(id) or id = auth.uid()
-- or is_parent_of(id) or is_admin()` shape already used by profiles_read/
-- athletes_read elsewhere in this schema:
--   1. Add that filter to the view itself, so a restricted minor's name/
--      photo simply doesn't resolve through this path either (their own
--      profile view doesn't use this view at all — see golsz-app.html's
--      Passport.load(), which only queries public_profile_names in the
--      `other` branch — so this filter never affects viewing your own
--      profile as yourself).
--   2. Drop the `anon` grant entirely. Every real call site in
--      golsz-app.html only ever queries this view from inside the
--      authenticated app (Feed/Discover/Messages/Passport/Admin) — there
--      is no logged-out screen that needs it. api/send-push.js's usage is
--      via the service-role key, which bypasses view grants/RLS anyway,
--      so it's unaffected either way.
-- ============================================================

drop view if exists public_profile_names;
create view public_profile_names as
select id, full_name, occupation, verified_tier, avatar_url
from profiles
where not is_restricted_minor(id) or id = auth.uid() or is_parent_of(id) or is_admin();

revoke all on public_profile_names from anon;
grant select on public_profile_names to authenticated;

-- ============================================================
-- 039 — Scout AI routing log
-- Records which model actually answered each real Scout reply — haiku,
-- sonnet, or database (a placeholder bucket that stays at 0 until
-- DB-first club/coach/opportunity search replaces some of Sonnet's
-- tool-use calls with a direct query, no LLM involved). Written from
-- api/scout.js via the service-role key on every successful reply.
--
-- Deliberately does NOT store the question or answer text — only the
-- routing decision (which model, what intent, what confidence) — so
-- this table can be safely read in aggregate without touching the same
-- "never expose real conversation content" boundary that kept
-- scout_history and messages out of admin_analytics_counts() (028).
-- RLS is enabled with no select policy at all; the only read path is
-- the security-definer RPC below, same is_admin()-gated pattern used
-- throughout this schema.
-- ============================================================

create table if not exists scout_routing_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  answered_by text not null check (answered_by in ('haiku', 'sonnet', 'database')),
  intent text,
  confidence numeric
);

alter table scout_routing_log enable row level security;

create or replace function admin_scout_model_mix()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  result jsonb;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select jsonb_build_object(
    'total', count(*),
    'haiku', count(*) filter (where answered_by = 'haiku'),
    'sonnet', count(*) filter (where answered_by = 'sonnet'),
    'database', count(*) filter (where answered_by = 'database')
  ) into result
  from scout_routing_log;
  return result;
end;
$$;

grant execute on function admin_scout_model_mix() to authenticated;

-- ============================================================
-- 040 — Scout monthly cost summary
-- Extends scout_routing_log (039) with real token usage and an estimated
-- dollar cost per reply, computed server-side in api/scout.js from
-- Anthropic's own usage numbers (verified pricing math: per-1M input/
-- output rates, cache reads at ~10% of input price, cache writes at
-- ~1.25x). An estimate for planning/budgeting, not a bill — Anthropic's
-- own invoice is always the source of truth — but built from the same
-- real usage figures the API returns for every call. Still never the
-- question or answer text.
-- ============================================================

alter table scout_routing_log
  add column if not exists input_tokens bigint,
  add column if not exists cache_read_input_tokens bigint,
  add column if not exists cache_creation_input_tokens bigint,
  add column if not exists output_tokens bigint,
  add column if not exists estimated_cost_usd numeric;

create or replace function admin_scout_cost_summary()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  result jsonb;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select jsonb_build_object(
    'message_count_month', count(*),
    'total_cost_month', coalesce(sum(estimated_cost_usd), 0),
    'avg_cost_per_message_month', coalesce(avg(estimated_cost_usd), 0)
  ) into result
  from scout_routing_log
  where created_at >= date_trunc('month', now());
  return result;
end;
$$;

grant execute on function admin_scout_cost_summary() to authenticated;

-- ============================================================
-- 041 — Scout FAQ: a real $0-AI-cost answer path
-- scout_faq holds pre-written answers to the most common questions
-- athletes ask across sports. api/scout.js checks every incoming Scout
-- message against it BEFORE calling any model — a match is served
-- directly, logged as answered_by='database' with $0 cost, and never
-- touches Haiku or Sonnet. Matching uses Postgres trigram similarity
-- (pg_trgm) — free, no embeddings model — which catches close
-- rephrasings well but not a question meaning the same thing in very
-- different words; real semantic matching would need embeddings, a
-- separate future upgrade. `lang` keeps matches (and answers) in the
-- athlete's own language.
-- ============================================================

create extension if not exists pg_trgm;

create table if not exists scout_faq (
  id bigint generated always as identity primary key,
  sport text,
  lang text not null default 'en',
  question text not null,
  answer text not null,
  created_at timestamptz not null default now()
);

create index if not exists scout_faq_question_trgm_idx on scout_faq using gin (question gin_trgm_ops);

alter table scout_faq enable row level security;
create policy scout_faq_admin_read on scout_faq for select using (is_admin());

create or replace function match_scout_faq(p_question text, p_lang text default 'en', p_sport text default null)
returns table(id bigint, question text, answer text, similarity real)
language sql stable as $$
  select id, question, answer, similarity(question, p_question) as similarity
  from scout_faq
  where lang = p_lang
    and (p_sport is null or sport is null or sport = p_sport)
    and similarity(question, p_question) > 0.30
  order by similarity(question, p_question) desc
  limit 1;
$$;

grant execute on function match_scout_faq(text, text, text) to service_role, authenticated;

-- ============================================================
-- 043 — Scout FAQ misses: what to add to scout_faq next
-- Powers the "Commonly Asked Questions" view under Analytics -> Scout
-- AI, so scout_faq can grow based on real gaps. Deliberately narrow:
-- only logged when a message did NOT match an existing FAQ, only for
-- FAQ-shaped intents (simple_knowledge, career_advice,
-- scouting_analysis, player_comparison — never off_topic,
-- profile_assist, agent_workflow, db_lookup), no user_id or any
-- identifying column, question truncated to 500 characters.
-- ============================================================

create table if not exists scout_faq_misses (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  intent text,
  question text not null
);

alter table scout_faq_misses enable row level security;
create policy scout_faq_misses_admin_read on scout_faq_misses for select using (is_admin());

-- ============================================================
-- 044 — scout_routing_log: subscription tier + escalation reason
-- Pure routing metadata, same privacy bar as the rest of this table — no
-- question/answer text, no user_id. Prerequisite for seeing whether
-- Sonnet usage actually differs by tier before any tier-based Sonnet
-- quota gets designed.
-- ============================================================

alter table scout_routing_log add column if not exists plan text;
alter table scout_routing_log add column if not exists escalation_reason text;

create or replace function admin_scout_model_mix()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  result jsonb;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select jsonb_build_object(
    'total', count(*),
    'haiku', count(*) filter (where answered_by = 'haiku'),
    'sonnet', count(*) filter (where answered_by = 'sonnet'),
    'database', count(*) filter (where answered_by = 'database'),
    'sonnet_by_plan', (
      select coalesce(jsonb_object_agg(coalesce(plan, 'unknown'), n), '{}'::jsonb)
      from (
        select plan, count(*) as n
        from scout_routing_log
        where answered_by = 'sonnet'
        group by plan
      ) s
    ),
    'sonnet_escalation_reasons', (
      select coalesce(jsonb_object_agg(coalesce(escalation_reason, 'unknown'), n), '{}'::jsonb)
      from (
        select escalation_reason, count(*) as n
        from scout_routing_log
        where answered_by = 'sonnet'
        group by escalation_reason
      ) s
    )
  ) into result
  from scout_routing_log;
  return result;
end;
$$;

grant execute on function admin_scout_model_mix() to authenticated;

-- ============================================================
-- 045 — Admin override: grant a specific athlete unlimited Scout access
-- Separate from is_admin (grants nothing but a higher Scout ceiling) and
-- separate from plan (no billing change). Covered by the existing
-- profiles_admin_write policy (023) — no new RLS policy needed.
-- ============================================================

alter table profiles add column if not exists ai_unlimited boolean not null default false;

-- ============================================================
-- 046 — Public, shareable Passport pages + a small minor-safety gap fix
-- get_public_passport() is the one narrow anon-readable RPC that returns
-- what any signed-in member already sees on someone else's Passport,
-- minus gpa/license/looking_for_players. Gated by is_restricted_minor(),
-- same pattern as athletes_read/public_profile_names/search_players.
-- ensure_message_request() now also checks is_restricted_minor() on both
-- sides — previously only the real messages insert did, so a contact
-- *request* (not the message content itself) could still reach an
-- unapproved minor.
-- ============================================================

create or replace function get_public_passport(p_user uuid)
returns jsonb language sql security definer set search_path to 'public' as $$
  select case
    when p_user is null or is_restricted_minor(p_user) then null
    else (
      select jsonb_build_object(
        'full_name', p.full_name,
        'occupation', p.occupation,
        'verified_tier', p.verified_tier,
        'avatar_url', p.avatar_url,
        'sport', a.sport,
        'position', a.position,
        'club_name', a.club_name,
        'country', a.country,
        'grad_year', a.grad_year,
        'recruiting_status', a.recruiting_status,
        'foot', a.foot,
        'height_cm', a.height_cm,
        'weight_kg', a.weight_kg,
        'bio', a.bio,
        'highlights', coalesce(a.highlights, '[]'::jsonb)
      )
      from profiles p
      left join athletes a on a.id = p.id
      where p.id = p_user
    )
  end;
$$;

grant execute on function get_public_passport(uuid) to anon, authenticated;

create or replace function ensure_message_request(p_recipient uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null or p_recipient is null or p_recipient = auth.uid() then
    return;
  end if;
  if is_restricted_minor(auth.uid()) or is_restricted_minor(p_recipient) then
    return;
  end if;
  if exists (
    select 1 from message_requests
    where (sender_id = auth.uid() and recipient_id = p_recipient)
       or (sender_id = p_recipient and recipient_id = auth.uid())
  ) then
    return;
  end if;
  insert into message_requests (sender_id, recipient_id, status)
  values (auth.uid(), p_recipient, 'pending');
end;
$$;

-- ============================================================
-- 047 — Passport sharing is opt-in, not on-by-default
-- get_public_passport() now also requires profiles.passport_public = true
-- (default false for everyone) on top of the existing is_restricted_minor
-- gate — sharing only happens because the athlete clicked "Share",
-- not automatically for every account the moment 046 shipped.
-- ============================================================

alter table profiles add column if not exists passport_public boolean not null default false;

create or replace function get_public_passport(p_user uuid)
returns jsonb language sql security definer set search_path to 'public' as $$
  select case
    when p_user is null or is_restricted_minor(p_user) then null
    when not coalesce((select passport_public from profiles where id = p_user), false) then null
    else (
      select jsonb_build_object(
        'full_name', p.full_name,
        'occupation', p.occupation,
        'verified_tier', p.verified_tier,
        'avatar_url', p.avatar_url,
        'sport', a.sport,
        'position', a.position,
        'club_name', a.club_name,
        'country', a.country,
        'grad_year', a.grad_year,
        'recruiting_status', a.recruiting_status,
        'foot', a.foot,
        'height_cm', a.height_cm,
        'weight_kg', a.weight_kg,
        'bio', a.bio,
        'highlights', coalesce(a.highlights, '[]'::jsonb)
      )
      from profiles p
      left join athletes a on a.id = p.id
      where p.id = p_user
    )
  end;
$$;

-- ============================================================
-- 048 — Add a real "free" plan tier
-- Before this migration, plan_tier only had 'starter' | 'pro' | 'elite',
-- and 'starter' did double duty as the free/default tier. That was fine
-- while Starter cost $0 — but this session moved Starter to a real $6/mo
-- paid tier, and protect_profile_columns() still let any signed-in user
-- self-assign plan='starter' with no payment (it only blocks changes to
-- anything OTHER than 'starter'), so a user could get the $6 tier for free
-- via Settings > choosePlan("starter"). This adds a genuine 'free' tier
-- and moves that self-service, no-payment path onto it instead —
-- 'starter' now requires checkout like Pro and Elite.
--
-- See supabase-migration-048-free-tier.sql — run the ALTER TYPE statement
-- as its own query before the rest (Postgres cannot use a new enum value
-- in the same transaction that adds it).
-- ============================================================

alter type plan_tier add value if not exists 'free';

alter table profiles alter column plan set default 'free';

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
  if v_plan is null or v_plan not in ('free', 'starter', 'pro', 'elite') then
    v_plan := 'free';
  end if;

  -- 'Parent' was added to the client's OCCUPATIONS list this session but
  -- never added here — harmless today since Auth's signup form never sends
  -- occupation (it's only ever set later via ProfileEditor, a different
  -- code path this trigger doesn't touch), but fixed in passing since this
  -- function is already being redefined.
  v_occupation := nullif(new.raw_user_meta_data->>'occupation', '');
  if v_occupation is not null and v_occupation not in ('Player', 'Parent', 'Scout', 'Agent', 'Coach', 'Physio', 'Other') then
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

create or replace function protect_profile_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if not (auth.role() is null or auth.role() = 'service_role' or is_admin()) then
    new.is_admin := old.is_admin;
    new.is_banned := old.is_banned;
    new.verified_tier := old.verified_tier;
    new.stripe_customer_id := old.stripe_customer_id;
    -- self-service plan changes may only ever move TO 'free' (the real
    -- no-payment tier) — 'starter'/'pro'/'elite' all require checkout,
    -- applied by the Stripe webhook (service_role) or an admin.
    if new.plan is distinct from old.plan and new.plan <> 'free' then
      new.plan := old.plan;
    end if;
  end if;

  if new.plan is distinct from old.plan then
    new.verified_tier := case new.plan when 'elite' then 'elite' when 'pro' then 'pro' else 'none' end;
  end if;

  return new;
end;
$$;

-- ============================================================
-- 049 — Scout conversation summaries
-- Phase 2b of the AI Scout architecture plan (approved): stop resending
-- the entire conversation transcript to the model on every turn. Adds a
-- running per-conversation summary, produced as a byproduct of the
-- classifier call (classifyIntent()) that already runs on every
-- message — no new model call. Server-written only (service-role key,
-- same pattern as scout_routing_log / persistProfileUpdates); RLS only
-- needs an owner-scoped SELECT policy for the client's own restore-on-
-- mount read.
-- ============================================================

create table if not exists scout_conversation_summaries (
  conversation_id uuid primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  summary text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists scout_conversation_summaries_user_idx on scout_conversation_summaries (user_id);

alter table scout_conversation_summaries enable row level security;

create policy scout_conversation_summaries_read on scout_conversation_summaries
  for select using (auth.uid() = user_id);

-- ============================================================
-- 050 — Structured Athlete Context
-- Phase 2a of the AI Scout architecture plan (approved). Adds
-- athletes.scout_context, a jsonb column holding the "softer"
-- athlete-intelligence fields (dream_outcome, target_level,
-- target_country, timeline, perceived_strengths, perceived_weaknesses,
-- main_gap, urgency, confidence, professional_interest, college_interest,
-- trial_interest, plus an ai_meta blob written by the classifier — see
-- Phase 2c) that have no home in the existing Passport columns, which
-- remain untouched. Each field is stored as
-- {value, source: 'athlete_stated'|'ai_inferred', confidence, updated_at}
-- — never silently promoted to "verified". api/scout.js is the only
-- writer (service-role), via merge_scout_context(), whose jsonb ||
-- merge preserves fields a given update doesn't touch.
-- ============================================================

alter table athletes add column if not exists scout_context jsonb not null default '{}'::jsonb;

create or replace function merge_scout_context(p_user uuid, p_updates jsonb)
returns void language sql security definer set search_path to 'public' as $$
  update athletes set scout_context = coalesce(scout_context, '{}'::jsonb) || p_updates where id = p_user;
$$;

revoke execute on function merge_scout_context(uuid, jsonb) from anon;
revoke execute on function merge_scout_context(uuid, jsonb) from authenticated;
revoke execute on function merge_scout_context(uuid, jsonb) from public;
grant execute on function merge_scout_context(uuid, jsonb) to service_role;

-- ============================================================
-- 051 — scout_routing_log: provider + specialist columns
-- Phase 2c/2f of the AI Scout architecture plan (approved). provider is
-- hardcoded "anthropic" by api/scout.js for now (every model it calls
-- today is Anthropic's) — becomes meaningful once Phase 3 wires up a
-- second real provider behind the Phase 2e model registry. specialist
-- records the classifier's recommended_specialist for that turn. Both
-- additive/nullable.
-- ============================================================

alter table scout_routing_log add column if not exists provider text;
alter table scout_routing_log add column if not exists specialist text;

-- ============================================================
-- 052 — Admin-editable model/pricing config
-- Golsz Multi-Model AI Scout & Cost-Control System (approved plan).
--
-- Today MODEL_REGISTRY in api/scout.js hardcodes model IDs and their
-- prices live only in a PRICING constant used for cost estimation —
-- neither is admin-editable without a deploy. scout_model_config makes
-- provider/model/tier/pricing a runtime, admin-editable row set;
-- api/scout.js reads it (service-role, bypasses RLS) to pick which
-- model answers a given tier and to estimate cost before calling it,
-- falling back to its own hardcoded defaults if a tier has no
-- enabled row (so a bad edit here degrades gracefully, never hard-fails
-- Scout).
--
-- Economy/standard point at Haiku and advanced/premium point at Sonnet
-- today — the only two models GOLSZ actually calls. Gemini/Grok/OpenAI
-- rows are seeded disabled (enabled=false) as real, ready-to-flip
-- placeholders: turning one on is editing this table (or the admin
-- RPC below), not a code change — but nothing here has been tested
-- against a real key, so they stay off until that happens deliberately.
--
-- Admin-only: no SELECT policy (service-role bypasses RLS for the
-- request-time read); admin dashboard reads via admin_get_model_config()
-- and writes enabled/priority via admin_update_model_config(), same
-- is_admin()-gated security-definer pattern used throughout this schema.
-- ============================================================

create table if not exists scout_model_config (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model_name text not null,
  model_tier text not null check (model_tier in ('economy', 'standard', 'advanced', 'premium')),
  input_cost_per_million numeric not null,
  output_cost_per_million numeric not null,
  cached_input_cost_per_million numeric,
  max_output_tokens int not null,
  enabled boolean not null default true,
  priority int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, model_name, model_tier)
);

alter table scout_model_config enable row level security;

create or replace function admin_get_model_config()
returns setof scout_model_config language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  return query select * from scout_model_config order by model_tier, priority;
end;
$$;

grant execute on function admin_get_model_config() to authenticated;

-- Deliberately narrow write surface: live enable/disable + priority
-- reordering is the operational lever (kill a misbehaving model, or
-- prefer a cheaper one within a tier) without a deploy. Pricing/model
-- edits go through the SQL editor directly — rare, deliberate changes,
-- not something the admin panel needs a form for on day one.
create or replace function admin_update_model_config(p_id uuid, p_enabled boolean, p_priority int)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  update scout_model_config set enabled = p_enabled, priority = coalesce(p_priority, priority), updated_at = now() where id = p_id;
end;
$$;

grant execute on function admin_update_model_config(uuid, boolean, int) to authenticated;

-- Seed real, currently-paid-for models plus disabled placeholders for
-- the providers named in the spec. Cached-input rates are Anthropic's
-- ~10% (Haiku) / ~20% (Sonnet, verified this session) of input price.
-- Placeholder model IDs (Gemini/Grok/OpenAI) are current as of this
-- session's own pricing lookup but MUST be re-verified against the
-- provider's live pricing page before ever setting enabled = true.
insert into scout_model_config (provider, model_name, model_tier, input_cost_per_million, output_cost_per_million, cached_input_cost_per_million, max_output_tokens, enabled, priority) values
  ('anthropic', 'claude-haiku-4-5', 'economy', 1, 5, 0.1, 1024, true, 10),
  ('anthropic', 'claude-haiku-4-5', 'standard', 1, 5, 0.1, 2048, true, 10),
  ('anthropic', 'claude-sonnet-5', 'advanced', 3, 15, 0.3, 4096, true, 10),
  ('anthropic', 'claude-sonnet-5', 'premium', 3, 15, 0.3, 4096, true, 10),
  ('google', 'gemini-3.1-flash-lite', 'economy', 0.25, 1.5, null, 1024, false, 20),
  ('xai', 'grok-4.1-fast', 'economy', 0.20, 0.50, 0.05, 1024, false, 20),
  ('openai', 'gpt-5-mini', 'economy', 0.25, 2, null, 1024, false, 30)
on conflict (provider, model_name, model_tier) do nothing;

-- ============================================================
-- 053 — Atomic daily-usage reservation
-- Golsz Multi-Model AI Scout & Cost-Control System (approved plan).
--
-- Fixes a real race condition in increment_scout_usage() (migration
-- ~008): that function inserts a scout_history marker row
-- UNCONDITIONALLY, then counts same-day markers — the actual limit
-- check (`calls > limit`) happens afterward, in api/scout.js. Two
-- concurrent requests near a plan's daily limit (e.g. two browser
-- tabs) can each insert their own marker and each read a count that
-- doesn't yet reflect the other's insert, letting both through when
-- only one slot remained.
--
-- scout_daily_usage is one row per (user_id, usage_date, UTC).
-- reserve_scout_question() does the increment-and-check as a single
-- atomic statement (INSERT ... ON CONFLICT ... DO UPDATE) — Postgres
-- row-locks the (user_id, usage_date) row for the duration, so a
-- concurrent second call genuinely waits for the first to commit
-- before it sees (and acts on) the current count. No check-then-act
-- window exists.
--
-- release_scout_question() gives the slot back when a reservation
-- succeeded but the request failed before any model was actually
-- called (e.g. a config error) — "retries caused by provider
-- failures must not count as additional user questions."
--
-- record_scout_usage_cost() adds the real token/cost numbers to the
-- same day's row once a reply actually completes — reservation and
-- cost-recording are separate calls because the cost isn't known
-- until after the model responds.
--
-- Server-role only (service key), same access pattern as
-- increment_scout_usage; the old function is left in place unused
-- (only api/scout.js's meter() called it, and that call site is being
-- replaced) rather than dropped, to avoid touching anything else that
-- might reference it.
-- ============================================================

create table if not exists scout_daily_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  usage_date date not null,
  questions_used int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  total_cost numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, usage_date)
);

create index if not exists scout_daily_usage_date_idx on scout_daily_usage (usage_date);

alter table scout_daily_usage enable row level security;

create policy scout_daily_usage_read on scout_daily_usage
  for select using (auth.uid() = user_id);

create or replace function reserve_scout_question(p_user uuid, p_plan_limit int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_used int;
begin
  insert into scout_daily_usage (user_id, usage_date, questions_used)
  values (p_user, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, usage_date) do update
    set questions_used = case when scout_daily_usage.questions_used < p_plan_limit
                               then scout_daily_usage.questions_used + 1
                               else scout_daily_usage.questions_used end,
        updated_at = now()
  returning questions_used into v_used;

  return jsonb_build_object('allowed', v_used <= p_plan_limit, 'used', v_used, 'limit', p_plan_limit);
end;
$$;

create or replace function release_scout_question(p_user uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update scout_daily_usage
  set questions_used = greatest(questions_used - 1, 0), updated_at = now()
  where user_id = p_user and usage_date = (now() at time zone 'utc')::date;
end;
$$;

create or replace function record_scout_usage_cost(p_user uuid, p_cost numeric, p_input_tokens int, p_output_tokens int)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update scout_daily_usage
  set total_cost = total_cost + coalesce(p_cost, 0),
      input_tokens = input_tokens + coalesce(p_input_tokens, 0),
      output_tokens = output_tokens + coalesce(p_output_tokens, 0),
      updated_at = now()
  where user_id = p_user and usage_date = (now() at time zone 'utc')::date;
end;
$$;

revoke execute on function reserve_scout_question(uuid, int) from anon;
revoke execute on function reserve_scout_question(uuid, int) from authenticated;
revoke execute on function reserve_scout_question(uuid, int) from public;
grant execute on function reserve_scout_question(uuid, int) to service_role;

revoke execute on function release_scout_question(uuid) from anon;
revoke execute on function release_scout_question(uuid) from authenticated;
revoke execute on function release_scout_question(uuid) from public;
grant execute on function release_scout_question(uuid) to service_role;

revoke execute on function record_scout_usage_cost(uuid, numeric, int, int) from anon;
revoke execute on function record_scout_usage_cost(uuid, numeric, int, int) from authenticated;
revoke execute on function record_scout_usage_cost(uuid, numeric, int, int) from public;
grant execute on function record_scout_usage_cost(uuid, numeric, int, int) to service_role;

-- ============================================================
-- 054 — Generic AI response cache
-- Golsz Multi-Model AI Scout & Cost-Control System (approved plan).
--
-- scout_faq (migration 041) is a curated, admin-written Q&A table
-- matched by meaning via the classifier — valuable, but bounded to
-- what's been written. scout_response_cache is a plain TTL'd cache of
-- *actual* answers Scout has already produced, keyed by a normalized
-- (intent, sanitized query, model tier, prompt version) so a repeat of
-- the same effective question — same intent/tier/language/db-result
-- version — skips the model call entirely on the next hit. Personalized
-- replies (career_advice, scouting_analysis, anything touching
-- scout_context) are never cached — only genuinely shared, non-personal
-- answers (simple_knowledge, generic profile_assist copy, opportunity
-- searches with identical filters) are cache candidates; api/scout.js
-- decides candidacy, this table just stores what qualified.
--
-- Server-role only — cache lookups/writes happen inside api/scout.js,
-- never client-side, so no SELECT/INSERT policy for authenticated/anon.
-- ============================================================

create table if not exists scout_response_cache (
  id uuid primary key default gen_random_uuid(),
  cache_key text not null unique,
  intent text,
  model_tier text,
  response jsonb not null,
  expires_at timestamptz not null,
  hit_count int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists scout_response_cache_expires_idx on scout_response_cache (expires_at);

alter table scout_response_cache enable row level security;
-- no select/insert/update policy — service-role only, same as scout_model_config

-- ============================================================
-- 055 — search_events(): database-first opportunity search
-- Golsz Multi-Model AI Scout & Cost-Control System (approved plan).
--
-- Mirrors search_players() (migration 022) exactly, for the events
-- table instead of athletes. Before this, "show me football trials in
-- Cyprus" had no database-first path at all — events already holds
-- real trials/camps/combines (used today only by the Admin Panel's
-- event manager), but Scout had no way to query it; the question would
-- fall through to general web_search (unverified) or a generic answer.
-- Wired into api/scout.js as a second tool alongside search_golsz_players
-- so Scout can only ever report real, verified GOLSZ events — never
-- invent a listing. Excludes blocked events, same as the public feed.
-- ============================================================

create or replace function search_events(
  p_sport text default null,
  p_location text default null,
  p_level text default null,
  p_after_date date default null,
  p_limit int default 10
)
returns table (
  id uuid,
  title text,
  sport text,
  location text,
  level text,
  event_date date,
  spots_available int
)
language sql security definer set search_path to 'public' as $$
  select e.id, e.title, e.sport, e.location, e.level, e.event_date, e.spots_available
  from events e
  where not e.is_blocked
    and e.event_date >= coalesce(p_after_date, current_date)
    and (p_sport is null or e.sport ilike p_sport)
    and (p_location is null or e.location ilike '%' || p_location || '%')
    and (p_level is null or e.level ilike p_level)
  order by e.event_date asc
  limit least(coalesce(p_limit, 10), 25);
$$;

grant execute on function search_events(text, text, text, date, int) to authenticated;


-- ============================================================
-- 056 — Admin cost/margin dashboard
-- Golsz Multi-Model AI Scout & Cost-Control System (approved plan).
--
-- Extends the existing Analytics -> "AI Model Usage" card
-- (admin_scout_model_mix/admin_scout_cost_summary, migrations 039/040)
-- rather than building a parallel dashboard. Same is_admin()-gated
-- security-definer pattern throughout. Every function here returns dollar
-- figures / counts only — never question or answer text — and the
-- existing privacy boundaries stay unchanged: scout_routing_log still has
-- no user_id (migration-038 audit — admins never see who asked what);
-- scout_daily_usage carries user_id + cost numbers only, the same
-- metadata-yes/content-no line already drawn around scout_faq_misses.
-- ============================================================

create or replace function admin_scout_cost_by_plan()
returns table (plan text, message_count bigint, total_cost numeric, avg_cost numeric)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  return query
  select coalesce(l.plan, 'unknown'), count(*), coalesce(sum(l.estimated_cost_usd), 0), coalesce(avg(l.estimated_cost_usd), 0)
  from scout_routing_log l
  where l.created_at >= date_trunc('month', now())
  group by coalesce(l.plan, 'unknown');
end;
$$;

grant execute on function admin_scout_cost_by_plan() to authenticated;

create or replace function admin_scout_cache_stats()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  result jsonb;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select jsonb_build_object(
    'cached_answers', count(*),
    'total_hits', coalesce(sum(hit_count), 0)
  ) into result
  from scout_response_cache
  where expires_at >= now();
  return result;
end;
$$;

grant execute on function admin_scout_cache_stats() to authenticated;

create or replace function admin_scout_top_cost_users(p_limit int default 10)
returns table (user_id uuid, full_name text, plan text, total_cost numeric, questions_used bigint)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  return query
  select u.user_id, p.full_name, p.plan, sum(u.total_cost), sum(u.questions_used)
  from scout_daily_usage u
  join profiles p on p.id = u.user_id
  where u.usage_date >= date_trunc('month', now())::date
  group by u.user_id, p.full_name, p.plan
  order by sum(u.total_cost) desc
  limit least(coalesce(p_limit, 10), 25);
end;
$$;

grant execute on function admin_scout_top_cost_users(int) to authenticated;

-- Plan prices hardcoded here (matching PLANS in golsz-app.html: Free $0,
-- Starter $6, Pro $14, Elite $30) since pricing lives in client display
-- code today, not a DB table — kept in sync manually if PLANS ever changes.
create or replace function admin_scout_margin_summary()
returns table (plan text, subscriber_count bigint, monthly_revenue numeric, ai_cost numeric, ai_cost_pct numeric)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  return query
  select
    p.plan,
    count(distinct p.id),
    count(distinct p.id) * (case p.plan when 'starter' then 6 when 'pro' then 14 when 'elite' then 30 else 0 end),
    coalesce(sum(u.total_cost), 0),
    case when count(distinct p.id) * (case p.plan when 'starter' then 6 when 'pro' then 14 when 'elite' then 30 else 0 end) > 0
      then round(100 * coalesce(sum(u.total_cost), 0) / (count(distinct p.id) * (case p.plan when 'starter' then 6 when 'pro' then 14 when 'elite' then 30 else 0 end)), 2)
      else 0
    end
  from profiles p
  left join scout_daily_usage u on u.user_id = p.id and u.usage_date >= date_trunc('month', now())::date
  group by p.plan;
end;
$$;

grant execute on function admin_scout_margin_summary() to authenticated;

-- ============================================================
-- 057 — Trust score
-- Golsz Trust & Safety Moderation System (approved plan).
--
-- A computed 0-100 trust signal on profiles, built entirely from data
-- that already exists (moderation_queue history, post_reports against
-- the user, account age, is_banned, and the new identity_verified flag
-- from migration 058) rather than a new tracking system. Recomputed at
-- the moment something relevant changes (a moderation item gets
-- resolved, a report comes in, a ban/unban happens, a verification gets
-- approved) via recompute_trust_score() — not a cron job, since GOLSZ
-- has no scheduled-job infra today and every event that should move the
-- score is already a real, single mutation point.
--
-- Gates (wired in later migrations/code, not here): posting/messaging
-- rate limits for low-trust accounts, review priority in the moderation
-- queue, verification eligibility.
-- ============================================================

alter table profiles add column if not exists trust_score int not null default 50 check (trust_score between 0 and 100);

create or replace function recompute_trust_score(p_user uuid)
returns int language plpgsql security definer set search_path to 'public' as $$
declare
  v_score int := 50;
  v_created timestamptz;
  v_banned boolean;
  v_identity_verified boolean;
  v_violations int;
  v_reporters int;
  v_age_days int;
begin
  select created_at, is_banned, coalesce(identity_verified, false)
    into v_created, v_banned, v_identity_verified
  from profiles where id = p_user;

  if v_created is null then
    return v_score;
  end if;

  v_age_days := extract(day from (now() - v_created));
  v_score := v_score + least(20, (v_age_days / 90) * 5);

  if v_identity_verified then
    v_score := v_score + 10;
  end if;

  select count(*) into v_violations
  from moderation_queue
  where author_id = p_user and decision in ('block', 'review') and resolved_at is not null;
  v_score := v_score - least(45, v_violations * 15);

  select count(distinct reporter_id) into v_reporters
  from post_reports pr join posts p on p.id = pr.post_id
  where p.author_id = p_user;
  v_score := v_score - least(25, v_reporters * 5);

  if v_banned then
    v_score := v_score - 30;
  end if;

  v_score := greatest(0, least(100, v_score));
  update profiles set trust_score = v_score where id = p_user;
  return v_score;
end;
$$;

grant execute on function recompute_trust_score(uuid) to authenticated;


-- ============================================================
-- 058 — Verification workflow
-- Golsz Trust & Safety Moderation System (approved plan).
--
-- Revives a real self-service identity/occupation verification design
-- that was drafted once (~migration 024) and explicitly dropped before
-- shipping. `verified_tier` (migration 025) is a SUBSCRIPTION badge
-- (auto-synced from profiles.plan) — this is a genuinely separate
-- concept: `identity_verified` means "an admin actually looked at proof
-- this account is who it claims to be," independent of what they pay.
-- Scoped to the occupations that already exist as real profiles on
-- GOLSZ (Player/Coach/Scout/Agent/Physio) — not club/university/
-- federation entities, since those aren't real profile types here today.
--
-- Also extends protect_profile_columns() (last defined for migration
-- 048) so a signed-in user can't just PATCH their own trust_score or
-- identity_verified directly — same lockdown as is_admin/is_banned/
-- verified_tier already get.
-- ============================================================

alter table profiles add column if not exists identity_verified boolean not null default false;

create table if not exists verification_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  occupation text,
  proof_url text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  admin_notes text,
  reviewed_by uuid references profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists verification_requests_pending_idx on verification_requests (created_at) where status = 'pending';

alter table verification_requests enable row level security;

drop policy if exists verification_requests_own_read on verification_requests;
create policy verification_requests_own_read on verification_requests for select using (
  user_id = auth.uid() or is_admin()
);

drop policy if exists verification_requests_own_insert on verification_requests;
create policy verification_requests_own_insert on verification_requests for insert with check (
  user_id = auth.uid()
);

create or replace function admin_review_verification(p_id uuid, p_approve boolean, p_notes text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_user uuid;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select user_id into v_user from verification_requests where id = p_id;
  if v_user is null then
    raise exception 'request not found';
  end if;
  update verification_requests
    set status = case when p_approve then 'approved' else 'denied' end,
        admin_notes = p_notes, reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_id;
  if p_approve then
    update profiles set identity_verified = true where id = v_user;
  end if;
  perform recompute_trust_score(v_user);
end;
$$;

grant execute on function admin_review_verification(uuid, boolean, text) to authenticated;

create or replace function protect_profile_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if not (auth.role() is null or auth.role() = 'service_role' or is_admin()) then
    new.is_admin := old.is_admin;
    new.is_banned := old.is_banned;
    new.verified_tier := old.verified_tier;
    new.stripe_customer_id := old.stripe_customer_id;
    new.identity_verified := old.identity_verified;
    new.trust_score := old.trust_score;
    if new.plan is distinct from old.plan and new.plan <> 'free' then
      new.plan := old.plan;
    end if;
  end if;

  if new.plan is distinct from old.plan then
    new.verified_tier := case new.plan when 'elite' then 'elite' when 'pro' then 'pro' else 'none' end;
  end if;

  return new;
end;
$$;


-- ============================================================
-- 059 — Appeals
-- Golsz Trust & Safety Moderation System (approved plan).
--
-- Ties to two real decision points: a moderation_queue item (dispute a
-- "review"/"block" classification) and a ban (profiles.is_banned). On
-- overturn: a moderation_queue-linked appeal has nothing to "restore"
-- for a block decision (blocked content was never saved in the first
-- place — resubmitting is the real remedy), so overturning just marks
-- the appeal resolved and recomputes trust; a ban-linked appeal flips
-- profiles.is_banned back to false at the SQL level.
--
-- IMPORTANT, deliberately not hidden: this does NOT clear the parallel
-- real Supabase Auth ban_duration set via the Admin API in
-- api/admin-user-action.js's "ban" action — a pure SQL function can't
-- call an external HTTP API, so a full unban still needs that
-- endpoint's "unban" action run too. Flagging this limitation rather
-- than pretending the SQL-level flip is the whole story.
-- ============================================================

create table if not exists moderation_appeals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  moderation_queue_id uuid references moderation_queue(id) on delete set null,
  ban_related boolean not null default false,
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'upheld', 'overturned')),
  admin_notes text,
  reviewed_by uuid references profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists moderation_appeals_pending_idx on moderation_appeals (created_at) where status = 'pending';

alter table moderation_appeals enable row level security;

drop policy if exists moderation_appeals_own_read on moderation_appeals;
create policy moderation_appeals_own_read on moderation_appeals for select using (
  user_id = auth.uid() or is_admin()
);

drop policy if exists moderation_appeals_own_insert on moderation_appeals;
create policy moderation_appeals_own_insert on moderation_appeals for insert with check (
  user_id = auth.uid()
);

create or replace function admin_review_appeal(p_id uuid, p_overturn boolean, p_notes text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_user uuid;
  v_ban_related boolean;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select user_id, ban_related into v_user, v_ban_related from moderation_appeals where id = p_id;
  if v_user is null then
    raise exception 'appeal not found';
  end if;
  update moderation_appeals
    set status = case when p_overturn then 'overturned' else 'upheld' end,
        admin_notes = p_notes, reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_id;
  if p_overturn and v_ban_related then
    update profiles set is_banned = false where id = v_user;
  end if;
  perform recompute_trust_score(v_user);
end;
$$;

grant execute on function admin_review_appeal(uuid, boolean, text) to authenticated;


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


-- ============================================================
-- 061 — Trust-based messaging rate limit
-- Golsz Trust & Safety Moderation System (approved plan).
--
-- message_requests (an original-schema table) already gates the FIRST
-- message between two users behind mutual accept — but places no limit
-- on how many DIFFERENT people a brand-new or low-trust account can
-- message-request in a day (a real mass-messaging/spam vector).
-- check_message_request_limit() uses the same atomic reserve pattern as
-- reserve_scout_question (this session's AI Scout work) — one
-- insert-on-conflict statement, row-locked by Postgres, no
-- check-then-act race. It's called from INSIDE ensure_message_request()
-- (not exposed to the client directly) so the limit can't be bypassed by
-- simply not calling it — both functions run under the same
-- security-definer execution context, so the internal call works
-- without needing a client-facing grant.
-- ============================================================

create table if not exists message_request_daily_usage (
  user_id uuid not null references profiles(id) on delete cascade,
  usage_date date not null default current_date,
  requests_sent int not null default 0,
  primary key (user_id, usage_date)
);

alter table message_request_daily_usage enable row level security;

create or replace function check_message_request_limit(p_user uuid, p_daily_limit int)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare
  v_used int;
begin
  insert into message_request_daily_usage (user_id, usage_date, requests_sent)
  values (p_user, current_date, 1)
  on conflict (user_id, usage_date) do update
    set requests_sent = case when message_request_daily_usage.requests_sent < p_daily_limit
                              then message_request_daily_usage.requests_sent + 1
                              else message_request_daily_usage.requests_sent end
  returning requests_sent into v_used;
  return v_used <= p_daily_limit;
end;
$$;

revoke all on function check_message_request_limit(uuid, int) from public, authenticated, anon;
grant execute on function check_message_request_limit(uuid, int) to service_role;

-- Extends ensure_message_request() (an original-schema function) with the
-- trust-based check. Only a genuinely NEW request (no prior thread with
-- this recipient — the existing early-return above already covers "already
-- talking to them") counts against the limit. Only low-trust (<30) or
-- brand-new (<7 days old) accounts are capped; established accounts are
-- unlimited at this layer — the mutual-accept friction remains the primary
-- defense for everyone.
create or replace function ensure_message_request(p_recipient uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_trust int;
  v_created timestamptz;
  v_daily_limit int := 10;
begin
  if auth.uid() is null or p_recipient is null or p_recipient = auth.uid() then
    return;
  end if;
  if exists (
    select 1 from message_requests
    where (sender_id = auth.uid() and recipient_id = p_recipient)
       or (sender_id = p_recipient and recipient_id = auth.uid())
  ) then
    return;
  end if;

  select trust_score, created_at into v_trust, v_created from profiles where id = auth.uid();
  if coalesce(v_trust, 50) < 30 or v_created > now() - interval '7 days' then
    if not check_message_request_limit(auth.uid(), v_daily_limit) then
      raise exception 'Daily message-request limit reached for new/low-trust accounts';
    end if;
  end if;

  insert into message_requests (sender_id, recipient_id, status)
  values (auth.uid(), p_recipient, 'pending');
end;
$$;

grant execute on function ensure_message_request(uuid) to authenticated;


-- ============================================================
-- 062 — Fake-opportunity heuristics for events
-- Golsz Trust & Safety Moderation System (approved plan).
--
-- Rule-based, no AI call — events are created directly client-side
-- (AddToEventsModal for private saves, Admin Panel for public listings),
-- with no serverless proxy function to hook a server-side check into, so
-- this runs as a BEFORE INSERT trigger, the same pattern already used for
-- protect_profile_columns(). Flags (via the existing is_blocked column,
-- same one the Admin Panel's manual block button already uses) a new
-- event as high-risk — pending review, never silently deleted — when
-- either:
--   (a) a near-duplicate (same title/location/date) already exists from
--       a DIFFERENT account, AND the creating account is under 48h old
--       (the spec's "newly created accounts" + "duplicate postings"
--       combination), or
--   (b) the free-text notes contain a common link-shortener domain (often
--       used to obscure a scam destination) or an upfront-payment phrase
--       ("wire transfer", "processing fee", "registration fee", "western
--       union" — the spec's "requests for upfront payment").
-- Real GOLSZ contact for a flagged event still goes through the existing
-- Admin Panel review path (unblock is just flipping is_blocked back).
-- ============================================================

create or replace function check_event_fake_signals()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_creator_created_at timestamptz;
  v_is_new_account boolean;
  v_duplicate_exists boolean;
  v_suspicious_text boolean;
begin
  if new.created_by is null then
    return new;
  end if;

  select created_at into v_creator_created_at from profiles where id = new.created_by;
  v_is_new_account := v_creator_created_at is not null and v_creator_created_at > now() - interval '48 hours';

  select exists (
    select 1 from events e
    where e.created_by is distinct from new.created_by
      and lower(e.title) = lower(new.title)
      and coalesce(lower(e.location), '') = coalesce(lower(new.location), '')
      and e.event_date = new.event_date
  ) into v_duplicate_exists;

  v_suspicious_text := coalesce(new.notes, '') ~* '(bit\.ly|tinyurl|wire transfer|processing fee|registration fee|upfront payment|western union)';

  if (v_is_new_account and v_duplicate_exists) or v_suspicious_text then
    new.is_blocked := true;
  end if;

  return new;
end;
$$;

drop trigger if exists events_fake_signals_check on events;
create trigger events_fake_signals_check before insert on events
  for each row execute function check_event_fake_signals();

-- ============================================================
-- 063 — Server-side honeypot signal
-- Golsz Trust & Safety Moderation System (approved plan).
--
-- The signup honeypot (golsz-app.html's hidden "website" field) was
-- purely client-side — a bot that called Supabase's signup API directly,
-- skipping the React form entirely, bypassed it trivially. This closes
-- that gap the safe way: golsz-app.html now always proceeds with signup
-- (a bot still gets no signal telling it apart from a real submission)
-- but passes the honeypot's value through in signup metadata, and this
-- migration extends handle_new_user() (the real, existing trigger this
-- codebase already uses for every signup) to read it.
--
-- Deliberately NOT a hard rejection — raising an exception here would
-- abort the whole signup transaction, and this trigger's binding to
-- auth.users isn't captured in any migration (set up outside the
-- migration history), so its exact timing/transaction behavior can't be
-- fully verified from the codebase alone. A false positive that locks out
-- a real signup with zero recourse is a worse failure mode than under-
-- reacting, so instead: a non-empty honeypot value just starts the new
-- account at trust_score = 0 instead of the normal 50 default — heavily
-- capped by the trust-score-gated limits (messaging, posting priority)
-- already in place, and visible to an admin, without ever touching
-- whether the signup itself succeeds.
--
-- Full function reproduced from its last definition (~migration 048) with
-- only the honeypot/trust_score addition — every other line unchanged.
-- ============================================================

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_dob date;
  v_is_minor boolean := false;
  v_parent_email text;
  v_parent_id uuid;
  v_plan text;
  v_occupation text;
  v_honeypot text;
  v_trust_score int := 50;
begin
  v_dob := nullif(new.raw_user_meta_data->>'date_of_birth', '')::date;
  if v_dob is not null then
    v_is_minor := (date_part('year', age(v_dob)) < 18);
  end if;
  v_parent_email := nullif(new.raw_user_meta_data->>'parent_email', '');

  v_plan := new.raw_user_meta_data->>'plan';
  if v_plan is null or v_plan not in ('free', 'starter', 'pro', 'elite') then
    v_plan := 'free';
  end if;

  v_occupation := nullif(new.raw_user_meta_data->>'occupation', '');
  if v_occupation is not null and v_occupation not in ('Player', 'Parent', 'Scout', 'Agent', 'Coach', 'Physio', 'Other') then
    v_occupation := null;
  end if;

  v_honeypot := nullif(new.raw_user_meta_data->>'hp', '');
  if v_honeypot is not null then
    v_trust_score := 0;
  end if;

  insert into profiles (id, full_name, dob, is_minor, pending_parent_email, plan, occupation, trust_score)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    v_dob,
    v_is_minor,
    case when v_is_minor then v_parent_email else null end,
    v_plan::plan_tier,
    v_occupation,
    v_trust_score
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
-- ============================================================
-- 064 — Admin moderation analytics
-- Golsz Trust & Safety Moderation System (approved plan).
--
-- One RPC following the exact admin_scout_model_mix()/
-- admin_analytics_counts() pattern already used by the Analytics tab —
-- extends that existing dashboard rather than adding a new one. Reason
-- codes (SPAM, RECRUITING_FRAUD) come from api/moderate.js's own
-- documented reason-code list, so these counts stay in sync with
-- whatever the classifier is actually allowed to emit.
-- ============================================================

create or replace function admin_moderation_stats()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  result jsonb;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select jsonb_build_object(
    'moderation_items_today', (select count(*) from moderation_queue where created_at >= current_date),
    'blocked_today', (select count(*) from moderation_queue where decision = 'block' and created_at >= current_date),
    'spam_blocked_total', (select count(*) from moderation_queue where decision = 'block' and reason_codes @> array['SPAM']),
    'scam_blocked_total', (select count(*) from moderation_queue where decision = 'block' and reason_codes @> array['RECRUITING_FRAUD']),
    'avg_resolution_minutes', (
      select round(avg(extract(epoch from (resolved_at - created_at)) / 60)::numeric, 1)
      from moderation_queue where resolved_at is not null
    ),
    'appeals_pending', (select count(*) from moderation_appeals where status = 'pending'),
    'appeals_upheld', (select count(*) from moderation_appeals where status = 'upheld'),
    'appeals_overturned', (select count(*) from moderation_appeals where status = 'overturned'),
    'verification_pending', (select count(*) from verification_requests where status = 'pending'),
    'verification_approved', (select count(*) from verification_requests where status = 'approved'),
    'events_flagged_total', (select count(*) from events where is_blocked = true),
    'trust_score_buckets', (
      select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb)
      from (
        select
          case
            when trust_score < 20 then '0-19'
            when trust_score < 40 then '20-39'
            when trust_score < 60 then '40-59'
            when trust_score < 80 then '60-79'
            else '80-100'
          end as bucket,
          count(*) as n
        from profiles
        group by 1
      ) b
    )
  ) into result;
  return result;
end;
$$;

grant execute on function admin_moderation_stats() to authenticated;

-- ============================================================
-- 065 — Career timeline on Passport
-- Passport's "CAREER TIMELINE" card was demo-only (hardcoded sample
-- data, never shown on a real account — see the old `{!real && (...)}`
-- guard in golsz-app.html). This makes it real: a self-service, jsonb
-- list on athletes, same proven pattern as athletes.highlights (added
-- pre-session) — no new table, protected by the existing athletes_rw
-- policy (id = auth.uid() or is_parent_of(id)), same as highlights.
-- ============================================================

alter table athletes add column if not exists timeline jsonb not null default '[]'::jsonb;

-- ============================================================
-- 066 — Temporarily disable the minor-restriction gate
-- Golsz Trust & Safety Moderation System (approved plan) follow-up.
--
-- is_restricted_minor() existed to gate exposure surfaces for a minor
-- with no approved parent link: appearing in Discover, posting to the
-- public Feed, receiving message requests, and (as of this session)
-- being viewable via a shared Passport link. With Feed/Discover/Events/
-- Messages launch-scoped off the nav (see golsz-app.html), the only one
-- of those still live is the Passport share link — and since Family &
-- Parent Access (the only way a minor could ever become unrestricted)
-- is also launch-scoped off, every minor who signs up right now is
-- permanently restricted with no path out, which silently breaks Share
-- for them.
--
-- Decision: rather than resurrect Family & Parent Access for a "no
-- contact between accounts" version of the app, disable the gate
-- itself for now — every RLS policy that calls this function keeps its
-- own logic untouched, so restoring real enforcement later (once
-- Discover/Messages come back) is just reverting this one function.
--
-- Does NOT touch the AI moderation minor-safety rules in api/moderate.js
-- (MINOR_CONTACT_SOLICITATION, MINOR_SECRECY, etc.) — that's a
-- different system protecting against unsafe language in the surfaces
-- that ARE live (Scout chat, Passport bio/timeline text), unrelated to
-- "contact between accounts."
-- ============================================================

create or replace function is_restricted_minor(p_user uuid)
returns boolean language sql security definer set search_path to 'public' as $$
  select false;
$$;

-- ============================================================
-- 067 — Expose real identity_verified on the public Passport link
-- get_public_passport() (046/047) predates identity_verified (058) and
-- still only returns verified_tier, which is a subscription badge, not
-- proof of identity. PublicPassport's badge/"VERIFIED MEDIA" label now
-- read identity_verified (matching the same fix already applied to the
-- in-app Highlights component this session) — the RPC needs to return it.
-- ============================================================

create or replace function get_public_passport(p_user uuid)
returns jsonb language sql security definer set search_path to 'public' as $$
  select case
    when p_user is null or is_restricted_minor(p_user) then null
    when not coalesce((select passport_public from profiles where id = p_user), false) then null
    else (
      select jsonb_build_object(
        'full_name', p.full_name,
        'occupation', p.occupation,
        'verified_tier', p.verified_tier,
        'identity_verified', coalesce(p.identity_verified, false),
        'avatar_url', p.avatar_url,
        'sport', a.sport,
        'position', a.position,
        'club_name', a.club_name,
        'country', a.country,
        'grad_year', a.grad_year,
        'recruiting_status', a.recruiting_status,
        'foot', a.foot,
        'height_cm', a.height_cm,
        'weight_kg', a.weight_kg,
        'bio', a.bio,
        'highlights', coalesce(a.highlights, '[]'::jsonb)
      )
      from profiles p
      left join athletes a on a.id = p.id
      where p.id = p_user
    )
  end;
$$;

-- ============================================================
-- 068 — Lifetime free AI budget (distinct from the recurring daily cap)
-- scout_daily_usage (053) resets every UTC day forever — a free-plan
-- account gets FREE_DAILY_LIMIT questions every single day, indefinitely.
-- The product brief's philosophy is "GOLSZ sells athlete progression, not
-- AI questions" — the free plan should be a bounded trial that pushes
-- toward a paid plan once the athlete has gotten real value, not an
-- unlimited-duration free tier. This adds a second, separate, NEVER-
-- resetting counter on profiles that only applies to plan = 'free';
-- paid plans (starter/pro/elite) are governed purely by their existing
-- daily caps and never touch this column.
--
-- reserve_free_ai_question()/release_free_ai_question() mirror
-- reserve_scout_question()/release_scout_question() (053) exactly —
-- same atomic UPDATE...RETURNING row-lock pattern, same reserve-before-
-- call / release-on-failure contract, same server-role-only access.
-- ============================================================

alter table profiles add column if not exists free_ai_lifetime_used int not null default 0;

create or replace function reserve_free_ai_question(p_user uuid, p_lifetime_limit int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_used int;
begin
  update profiles
  set free_ai_lifetime_used = case when free_ai_lifetime_used < p_lifetime_limit
                                    then free_ai_lifetime_used + 1
                                    else free_ai_lifetime_used end
  where id = p_user
  returning free_ai_lifetime_used into v_used;

  return jsonb_build_object('allowed', v_used <= p_lifetime_limit, 'used', v_used, 'limit', p_lifetime_limit);
end;
$$;

create or replace function release_free_ai_question(p_user uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update profiles
  set free_ai_lifetime_used = greatest(free_ai_lifetime_used - 1, 0)
  where id = p_user;
end;
$$;

revoke execute on function reserve_free_ai_question(uuid, int) from anon;
revoke execute on function reserve_free_ai_question(uuid, int) from authenticated;
revoke execute on function reserve_free_ai_question(uuid, int) from public;
grant execute on function reserve_free_ai_question(uuid, int) to service_role;

revoke execute on function release_free_ai_question(uuid) from anon;
revoke execute on function release_free_ai_question(uuid) from authenticated;
revoke execute on function release_free_ai_question(uuid) from public;
grant execute on function release_free_ai_question(uuid) to service_role;

-- ============================================================
-- 069 — One-time "we've learned enough about you" conversion nudge
-- Tracks whether a free-plan account has already been shown the guided-
-- onboarding conversion screen (ConversionScreen in golsz-app.html),
-- shown once real Scout usage exists (free_ai_lifetime_used >= 3, see
-- migration 068) rather than immediately on first profile save. Self-
-- service like passport_public (047) — no RLS/trigger change needed,
-- protect_profile_columns() only locks admin/billing-sensitive columns.
-- ============================================================

alter table profiles add column if not exists onboarding_conversion_shown boolean not null default false;

-- ============================================================
-- 070 — Self-service dismiss for "My Next Move"
-- next_best_action (068's typed-CTA follow-up) lives inside
-- athletes.scout_context.ai_meta, which only the service role can write
-- via merge_scout_context() (revoked from anon/authenticated/public,
-- migration ~050). A "mark done" click needs to clear just that one field
-- from the client, without a service-role round trip and without racing
-- the server's own ai_meta overwrites on the next real Scout turn — same
-- jsonb || merge-one-key pattern persistAiMeta() already uses server-side,
-- just auth.uid()-scoped instead of service-role.
-- ============================================================

create or replace function dismiss_next_move()
returns void language sql security definer set search_path to 'public' as $$
  update athletes
  set scout_context = coalesce(scout_context, '{}'::jsonb) || jsonb_build_object(
    'ai_meta', coalesce(scout_context->'ai_meta', '{}'::jsonb) || jsonb_build_object('next_best_action', null)
  )
  where id = auth.uid();
$$;

grant execute on function dismiss_next_move() to authenticated;

-- ============================================================
-- 071 — Performance benchmarks (record + retest history)
-- A real table (not a jsonb array like highlights/timeline) since retest
-- history benefits from being queryable/aggregatable later (trend charts,
-- GOLSZ Readiness's future Performance sub-score) rather than baked into
-- one blob column. Deliberately no fixed metric taxonomy per sport — free-
-- text metric name + numeric value + optional unit, same "don't invent an
-- exhaustive schema across 39 sports" judgment call SPORT_POSITION_LABEL
-- already made. Private to the owner in v1 (not shown on another
-- athlete's Passport, unlike highlights) — a "show publicly" toggle is
-- real future work once there's a reason to build it, not before.
-- ============================================================

create table if not exists athlete_benchmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  metric text not null,
  value numeric not null,
  unit text,
  recorded_date date not null default current_date,
  created_at timestamptz not null default now()
);

create index if not exists athlete_benchmarks_user_idx on athlete_benchmarks (user_id, metric, recorded_date desc);

alter table athlete_benchmarks enable row level security;

drop policy if exists athlete_benchmarks_own_read on athlete_benchmarks;
create policy athlete_benchmarks_own_read on athlete_benchmarks for select using (
  user_id = auth.uid() or is_parent_of(user_id)
);

drop policy if exists athlete_benchmarks_own_insert on athlete_benchmarks;
create policy athlete_benchmarks_own_insert on athlete_benchmarks for insert with check (
  user_id = auth.uid() or is_parent_of(user_id)
);

drop policy if exists athlete_benchmarks_own_delete on athlete_benchmarks;
create policy athlete_benchmarks_own_delete on athlete_benchmarks for delete using (
  user_id = auth.uid() or is_parent_of(user_id)
);

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

-- ============================================================
-- 073 — Admin Analytics: catch up with tonight's build
-- admin_analytics_counts() (028) predates everything shipped this
-- session (lifetime AI budget, the conversion screen, benchmarks,
-- targets, real identity verification) — the Admin Panel had zero
-- visibility into any of it. Extends the SAME dashboard RPC rather than
-- adding a parallel one, same "one dashboard, not three" discipline the
-- 056/064 additions already followed.
--
-- profile_quality_avg is a SQL approximation of the client's
-- computeProfileQuality() (golsz-app.html) — same 9 of its ~10 checks
-- (everything except the sport-specific position field, which isn't
-- worth replicating SPORT_POSITION_LABEL/SPORTS_WITHOUT_POSITION for in
-- SQL just for an admin-facing average). Directionally accurate, not
-- byte-for-byte identical to any one athlete's own score.
--
-- free_ai_exhausted_count uses 40 as the reference cap — the same
-- default FREE_LIFETIME_LIMIT falls back to in api/scout.js when that
-- env var is unset. If you ever change the env var, this number stops
-- being exact (still directionally useful) until this function is
-- updated to match.
-- ============================================================

create or replace function admin_analytics_counts()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  result jsonb;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select jsonb_build_object(
    'messages_total', (select count(*) from messages),
    'messages_7d', (select count(*) from messages where created_at > now() - interval '7 days'),
    'scout_conversations_total', (select count(*) from scout_history),
    'scout_users_total', (select count(distinct user_id) from scout_history),
    'push_subscribers_total', (select count(distinct user_id) from push_subscriptions),
    'activity_minutes_7d', (select coalesce(sum(minutes), 0) from daily_activity where activity_date > current_date - interval '7 days'),
    'activity_users_7d', (select count(distinct user_id) from daily_activity where activity_date > current_date - interval '7 days'),
    'activity_minutes_30d', (select coalesce(sum(minutes), 0) from daily_activity where activity_date > current_date - interval '30 days'),
    'activity_users_30d', (select count(distinct user_id) from daily_activity where activity_date > current_date - interval '30 days'),
    'activity_minutes_365d', (select coalesce(sum(minutes), 0) from daily_activity where activity_date > current_date - interval '365 days'),
    'activity_users_365d', (select count(distinct user_id) from daily_activity where activity_date > current_date - interval '365 days'),
    'identity_verified_count', (select count(*) from profiles where identity_verified = true),
    'free_ai_users_total', (select count(*) from profiles where plan = 'free'),
    'free_ai_avg_used', (select round(coalesce(avg(free_ai_lifetime_used), 0)::numeric, 1) from profiles where plan = 'free'),
    'free_ai_exhausted_count', (select count(*) from profiles where plan = 'free' and free_ai_lifetime_used >= 40),
    'conversion_shown_count', (select count(*) from profiles where onboarding_conversion_shown = true),
    'conversion_now_paid_count', (select count(*) from profiles where onboarding_conversion_shown = true and plan <> 'free'),
    'benchmarks_total', (select count(*) from athlete_benchmarks),
    'benchmarks_users', (select count(distinct user_id) from athlete_benchmarks),
    'targets_total', (select count(*) from outreach_targets),
    'targets_users', (select count(distinct user_id) from outreach_targets),
    'targets_by_status', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (select status, count(*) as n from outreach_targets group by status) s
    ),
    'profile_quality_avg', (
      select round(coalesce(avg(
        (
          (case when a.sport is not null and a.sport <> '' then 1 else 0 end) +
          (case when a.club_name is not null and a.club_name <> '' then 1 else 0 end) +
          (case when a.grad_year is not null then 1 else 0 end) +
          (case when a.country is not null and a.country <> '' then 1 else 0 end) +
          (case when a.recruiting_status is not null and a.recruiting_status <> '' then 1 else 0 end) +
          (case when a.bio is not null and a.bio <> '' then 1 else 0 end) +
          (case when p.avatar_url is not null and p.avatar_url <> '' then 1 else 0 end) +
          (case when jsonb_array_length(coalesce(a.highlights, '[]'::jsonb)) > 0 then 1 else 0 end) +
          (case when jsonb_array_length(coalesce(a.timeline, '[]'::jsonb)) > 0 then 1 else 0 end)
        ) * 100.0 / 9
      ), 0)::numeric, 1)
      from athletes a join profiles p on p.id = a.id
    )
  ) into result;
  return result;
end;
$$;

grant execute on function admin_analytics_counts() to authenticated;

-- ============================================================
-- 074 — Signup rate limiting (IP-based)
-- The brief's launch-blocker list flagged that the honeypot (migration 063)
-- is client-only — a script calling Supabase's signup API directly skips
-- Auth() entirely and never touches it. This adds a real server-side gate:
-- api/signup-guard.js reads the caller's IP from Vercel's x-forwarded-for
-- header (never trusted from the client body — a bot could put anything
-- there) and calls reserve_signup_attempt() before Auth's submit() ever
-- calls sb.auth.signUp(). Same atomic reserve-then-check idiom as
-- reserve_scout_question (053) / reserve_free_ai_question (068).
--
-- No RLS read/write grants to anon/authenticated at all — signup_attempts
-- is written exclusively through this security-definer RPC, called only
-- from the service-role signup-guard endpoint. A bot has no path to read
-- or forge its own counter down.
-- ============================================================

create table if not exists signup_attempts (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  attempt_date date not null,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(ip, attempt_date)
);

create index if not exists signup_attempts_date_idx on signup_attempts (attempt_date);

alter table signup_attempts enable row level security;
-- Deliberately zero policies — this table has no anon/authenticated access
-- path at all, only the security-definer RPC below (called with the
-- service-role key from api/signup-guard.js).

create or replace function reserve_signup_attempt(p_ip text, p_daily_limit int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_count int;
begin
  if p_ip is null or p_ip = '' then
    -- No usable IP (e.g. a dev environment without x-forwarded-for) — fail
    -- open rather than blocking every signup from an unusual deployment.
    return jsonb_build_object('allowed', true, 'attempts', 0);
  end if;

  insert into signup_attempts (ip, attempt_date, attempts)
  values (p_ip, (now() at time zone 'utc')::date, 1)
  on conflict (ip, attempt_date) do update
    set attempts = signup_attempts.attempts + 1, updated_at = now()
  returning attempts into v_count;

  return jsonb_build_object('allowed', v_count <= p_daily_limit, 'attempts', v_count);
end;
$$;

-- Postgres auto-grants EXECUTE to PUBLIC on newly created functions, which
-- would let a bot call this RPC directly (via the Supabase REST API, with
-- just the anon key) and pass any forged p_ip it likes — completely
-- defeating the point, since the real IP must come from the server-side
-- x-forwarded-for header, never from the client. Revoke explicitly so only
-- the service role (used server-side by api/signup-guard.js) can call it.
revoke execute on function reserve_signup_attempt(text, int) from public, anon, authenticated;

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

-- Done.
-- ============================================================