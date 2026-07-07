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
