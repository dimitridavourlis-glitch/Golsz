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
