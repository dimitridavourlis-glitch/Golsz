-- ============================================================
-- 144 — Access hardening: eight data-access rules an audit found too wide.
--
-- WHAT THIS DOES (one section per finding, numbered to match the audit):
--   144.1  public_profile_names returns only rows the caller may already
--          read on profiles (security_invoker), not every member.
--   144.2  handle_new_user() refuses a signup with no date of birth or an
--          age under 18, and no longer auto-links a parent_email.
--   144.3  A parent link can only be approved by the athlete when the
--          PARENT initiated it (new parent_links.requested_by column).
--   144.4  Storage: avatars / post-images can be listed only inside your own
--          folder (or by an admin). Public URLs are unaffected.
--   144.5  events: non-admins can only create or keep PRIVATE rows; the
--          column defaults to 'private'; Scout's search_events() only
--          returns public events created by an admin (or with no creator).
--   144.6  Shared Passport RPCs honour athletes.show_club / show_country and
--          return nothing for a banned account.
--   144.7  plan_config.live_features (what Scout tells athletes each plan
--          includes) matches what the product actually ships.
--   144.8  scout_model_config: claude-sonnet-5 priced at $2 / $10 per 1M.
--
-- HOW TO APPLY
-- Paste into the Supabase SQL Editor and run ONCE, top to bottom. It is one
-- transaction: if any statement fails, nothing is applied. Every statement
-- is idempotent (create or replace / drop ... if exists / add column if not
-- exists / guarded updates), so a second run is harmless.
--
-- BEFORE RUNNING, CONFIRM (each must hold or 144.1 / 144.4 behave wrongly):
--   select current_setting('server_version_num')::int >= 150000;   -- true (security_invoker needs PG15)
--   select has_table_privilege('authenticated', 'public.profiles', 'select');  -- true
--   select relrowsecurity from pg_class where oid = 'public.profiles'::regclass;  -- true
--   select polname, polcmd, pg_get_expr(polqual, polrelid) from pg_policy
--    where polrelid = 'public.profiles'::regclass and polcmd in ('r', '*');
--   -- expected: profiles_self (id = auth.uid() or is_parent_of(id)),
--   --           profiles_linked, profiles_admin_read (is_admin())
--
-- WHAT TO CHECK AFTERWARDS: see the "144 — Verification" block at the end.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--   * It does not touch api/ or golsz-app.html. Two code follow-ups are
--     named where they arise: the Admin Panel's (currently unmounted)
--     createEvent() must pass visibility: 'public' if it is ever re-enabled
--     (144.5), and api/create-child-account.js cannot pass the new signup
--     gate as written if parent accounts are re-enabled (144.2).
--   * It does not auto-revoke any parent link or auto-privatise any event.
--     Neither can be identified precisely from the data, so each section
--     carries a commented review query for the owner instead of a guess.
-- ============================================================

begin;


-- ============================================================
-- 144.1 — public_profile_names listed every member to every signed-in user.
--
-- Migration 038 gave this view a visibility WHERE clause; 126.4d dropped it
-- when it removed the dead is_restricted_minor() predicate, leaving
--     select id, full_name, occupation, verified_tier, avatar_url from profiles
-- with no filter, owned by postgres and therefore NOT subject to profiles'
-- RLS. Any signed-in account could page through every member's name and
-- photo URL.
--
-- THE FIX: security_invoker = true. The view now runs with the caller's
-- privileges, so the profiles policies apply to it exactly as they apply to
-- the table: profiles_self (own row; an approved parent's child),
-- profiles_linked (either side of an APPROVED link, 126.2) and
-- profiles_admin_read (is_admin()). Same five columns, same grants.
--
-- LIVE CALL SITES CHECKED (golsz-app.html), all still work:
--   * AdminPanel name lookups — reports, audit log, moderation queue,
--     verification requests, appeals: the caller is an admin, so
--     profiles_admin_read returns every row exactly as before.
--   * Passport(other) — reachable only through MyAthletes (parent accounts
--     are off), i.e. a parent viewing an approved child: profiles_self.
--   * Passport follower/following names — fetched for the owner's own
--     Passport but FollowListCard is not rendered; non-visible names fall
--     back to "GOLSZ User" as the code already does.
--   * Feed, Discover, Messages, BlockedAccounts — not mounted.
--   * api/send-push.js reads the view with the service role, which has
--     BYPASSRLS, so it is unaffected (and its triggers are on retired
--     tables anyway).
-- ============================================================

create or replace view public_profile_names with (security_invoker = true) as
select id, full_name, occupation, verified_tier, avatar_url
from profiles;

-- Re-asserted so a re-run fixes a view someone recreated without it.
alter view public_profile_names set (security_invoker = true);

revoke all on public_profile_names from anon;
grant select on public_profile_names to authenticated;


-- ============================================================
-- 144.2 — handle_new_user() computed is_minor but never refused anyone.
--
-- GOLSZ contracts with adults only. The client blocks under-18 signups, but
-- the client is not the gate: a direct POST to Supabase Auth's /signup with
-- the public anon key could create an account aged 15, or one with no date
-- of birth at all, and the trigger would happily write it. It also turned a
-- client-supplied parent_email into a PENDING parent_links row naming
-- whoever owns that address — and the minor could then approve that row
-- themselves (see 144.3).
--
-- Reproduced verbatim from migration 138 with exactly two changes:
--   (a) raise when the date of birth is missing or the age is under 18,
--       unless raw_app_meta_data.managed_by_parent = true. raw_app_meta_data
--       is writable only through the Admin API (service role); a public
--       signup cannot set it, unlike raw_user_meta_data.
--   (b) the parent_email -> parent_links auto-link branch is removed
--       (parent accounts are switched off), and with it v_parent_id.
-- Everything else — the is_minor expression, pending_parent_email, the
-- 'free' plan, the Player/Parent occupation allowlist, the honeypot
-- trust_score — is unchanged.
--
-- THE AGE EXPRESSION IS THE SAME ONE is_minor HAS ALWAYS USED
-- (date_part('year', age(v_dob)) < 18), so the gate and the stored flag
-- cannot disagree. age() uses the database's current date (UTC), so a
-- signup on the 18th birthday in a timezone ahead of UTC can be refused for
-- a few hours; the client computes age in local time. Accepted: it fails
-- toward the rule.
--
-- PARENT-MANAGED CHILDREN (api/create-child-account.js — DISABLED today,
-- PARENT_ACCOUNTS_ENABLED = false, returns 403 before creating anything).
-- Today that endpoint sets only user_metadata
--     { full_name, date_of_birth, managed_by_parent: true }
-- which is client-settable and therefore NOT honoured here. To pass this
-- gate when re-enabled it must set app_metadata.managed_by_parent = true.
-- BUT NOTE: Supabase Auth's admin createUser (supabase/auth
-- internal/api/admin.go, adminUserCreate) INSERTs the auth.users row with
-- app_metadata = {provider, providers} and applies the caller's
-- app_metadata in a follow-up UPDATE inside the same transaction. This
-- trigger fires on the INSERT, so it will not see the flag on that path and
-- the child creation will be refused (fail-closed). Re-enabling the child
-- path therefore also needs one of: a deferred check that re-reads the row
-- at commit, or a service-role-only "ticket" table the endpoint writes
-- before createUser and this function consumes. Decide that when parent
-- accounts come back; nothing live depends on it now.
--
-- OPERATIONAL CONSEQUENCE: "Add user" in the Supabase dashboard sends no
-- date of birth and will now be refused. Create test users through the
-- app's signup, or the Admin API with user_metadata.date_of_birth (18+).
-- ============================================================

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_dob date;
  v_is_minor boolean := false;
  v_parent_email text;
  v_occupation text;
  v_honeypot text;
  v_trust_score int := 50;
  v_parent_managed boolean;
begin
  v_dob := nullif(new.raw_user_meta_data->>'date_of_birth', '')::date;
  if v_dob is not null then
    v_is_minor := (date_part('year', age(v_dob)) < 18);
  end if;
  v_parent_email := nullif(new.raw_user_meta_data->>'parent_email', '');

  -- 144.2 (a): adults only. raw_app_meta_data, never raw_user_meta_data:
  -- only the Admin API (service role) can write app_metadata.
  v_parent_managed := coalesce(new.raw_app_meta_data->>'managed_by_parent', '') = 'true';
  if v_dob is null then
    raise exception 'GOLSZ signup refused: a date of birth is required'
      using errcode = 'check_violation';
  end if;
  if v_is_minor and not v_parent_managed then
    raise exception 'GOLSZ signup refused: account holders must be 18 or over'
      using errcode = 'check_violation';
  end if;

  -- raw_user_meta_data->>'plan' is deliberately NOT read any more. The
  -- client still sends it (it records which plan the athlete intends to buy,
  -- and the signup flow uses it to pick the right Stripe Payment Link), but
  -- it is a statement of intent, never an entitlement. Only
  -- api/stripe-webhook.js may change profiles.plan.

  v_occupation := nullif(new.raw_user_meta_data->>'occupation', '');
  if v_occupation is not null and v_occupation not in ('Player', 'Parent') then
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
    'free'::plan_tier,
    v_occupation,
    v_trust_score
  )
  on conflict (id) do nothing;

  insert into athletes (id) values (new.id)
  on conflict (id) do nothing;

  -- 144.2 (b): the parent_email -> parent_links auto-link that stood here is
  -- removed. It created a link the athlete initiated and could approve
  -- themselves (144.3), from an address the client typed.

  return new;
end;
$$;


-- ============================================================
-- 144.3 — An athlete could approve a parent link they created themselves.
--
-- parent_links_approve (004) is `for update using (athlete_id = auth.uid())`.
-- That is right for the one legitimate flow — the PARENT calls
-- request_parent_link(child_email), a pending row is inserted, the child
-- approves or denies — but it does not ask who created the row. The
-- handle_new_user() auto-link (removed in 144.2) created rows the ATHLETE
-- initiated (by typing an email at signup); the athlete could then approve
-- their own claim, and an approved link opens the parent's full profile row
-- to them through profiles_linked (126.2) and the child's rows to the
-- parent through profiles_self / athletes_rw.
--
-- LEGITIMATE FLOWS IN THE CODE
--   1. request_parent_link() (140) — authenticated PARENT inserts a pending
--      row (parent_id = auth.uid()); the athlete approves (FamilyAccess,
--      not mounted while PARENT_ACCOUNTS_ENABLED = false).
--   2. api/create-child-account.js — service role inserts the row already
--      approved (approved_at set). Disabled today.
--   There is no flow in which the athlete legitimately initiates a link.
--
-- DESIGN: record the initiator, and let the athlete approve only rows the
-- parent initiated.
--   * parent_links.requested_by — stamped by a BEFORE INSERT trigger as
--     auth.uid() for every non-service-role caller, so it cannot be forged
--     from the client. Inside request_parent_link() (security definer)
--     auth.uid() is still the calling parent, so its rows get
--     requested_by = parent_id. Service role / direct SQL keep whatever they
--     supply (create-child-account supplies none; its rows are born
--     approved, so they never need approving).
--   * The same trigger forces approved_at = null on a client-originated
--     insert: a link a client creates is always born pending.
--   * protect_parent_link_columns() (126.15) now also pins requested_by.
--   * parent_links_approve requires requested_by = parent_id.
-- No default on the column: existing rows stay NULL ("initiator unknown")
-- and are therefore NOT approvable by the athlete. A pending legacy row must
-- be deleted (either side can — parent_links_delete) and re-requested by the
-- parent. Production had 0 parent links when parent accounts were switched
-- off (2026-09-19), so this should strand nobody.
-- ============================================================

alter table parent_links add column if not exists requested_by uuid;

comment on column parent_links.requested_by is
  'Who created the link (144). Stamped from auth.uid() by stamp_parent_link_requester() for every non-service-role insert; NULL = service role, direct SQL, or a row older than migration 144. The athlete may approve only when requested_by = parent_id.';

create or replace function stamp_parent_link_requester()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  -- Direct SQL and the service role are trusted to set their own values,
  -- matching the protect_*_columns triggers.
  if auth.role() is null or auth.role() = 'service_role' then
    return new;
  end if;
  new.requested_by := auth.uid();
  new.approved_at  := null;
  return new;
end;
$$;

drop trigger if exists stamp_parent_link_requester_trigger on parent_links;
create trigger stamp_parent_link_requester_trigger
  before insert on parent_links
  for each row execute function stamp_parent_link_requester();

-- Verbatim from 126.15 plus the requested_by pin.
create or replace function protect_parent_link_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  -- Direct SQL and the service role are exempt, matching the other
  -- protect_*_columns triggers. is_admin() is deliberately NOT exempted:
  -- there is no admin UI that re-points a parent link, and a guardianship
  -- relationship should not be silently reassignable.
  if auth.role() is null or auth.role() = 'service_role' then
    return new;
  end if;
  new.parent_id  := old.parent_id;
  new.athlete_id := old.athlete_id;
  -- 144.3: who initiated the link is history, not an editable field.
  new.requested_by := old.requested_by;
  return new;
end;
$$;

drop policy if exists parent_links_approve on parent_links;
create policy parent_links_approve on parent_links
  for update to authenticated
  using (athlete_id = auth.uid() and requested_by = parent_id)
  with check (athlete_id = auth.uid() and requested_by = parent_id);

-- REVIEW, DO NOT RUN BLIND. Approved links that look like handle_new_user
-- auto-links: the athlete's own signup carried that parent's email, the row
-- says 'parent' and was written within a minute of the athlete's auth row,
-- and the athlete is not a parent-managed child. Nothing records WHO set
-- approved_at, so this is a fingerprint, not proof — review each row.
--
--   select pl.id, pl.parent_id, pl.athlete_id, pl.relationship,
--          pl.created_at, pl.approved_at, cu.created_at as athlete_signed_up_at
--     from parent_links pl
--     join profiles   cp on cp.id = pl.athlete_id
--     join auth.users cu on cu.id = pl.athlete_id
--     join auth.users pu on pu.id = pl.parent_id
--    where pl.approved_at is not null
--      and pl.requested_by is null
--      and pl.relationship = 'parent'
--      and not coalesce(cp.parent_managed, false)
--      and cp.pending_parent_email is not null
--      and lower(cp.pending_parent_email) = lower(pu.email)
--      and abs(extract(epoch from (pl.created_at - cu.created_at))) < 60;
--
-- Then, for the ids you confirm:
--   update parent_links set approved_at = null where id in ('<id>', ...);
-- (A revoked row stays pending and, with requested_by NULL, cannot be
-- re-approved by the athlete; the parent must delete and re-request it.)


-- ============================================================
-- 144.4 — Any signed-in user could list every object in both buckets.
--
-- 137 limited avatars_read / post_images_read to `authenticated` but kept
-- the condition at bucket_id alone, so any account could walk both
-- buckets. Both buckets are public: true, and /storage/v1/object/public/...
-- is served WITHOUT consulting a SELECT policy, so every avatar and post
-- image shown in the app (including on a logged-out shared Passport) keeps
-- loading. Only LISTING and authenticated reads change: your own folder, or
-- an admin.
--
-- CODE PATHS CHECKED
--   * golsz-app.html uploads avatars and post images to `${uid}/...` with
--     upload() (no upsert) and builds the URL with getPublicUrl(), which is
--     client-side string building. Neither lists. The uploader's own folder
--     stays readable, so anything storage does after an insert still works.
--   * api/delete-account.js lists and deletes `${userId}/...` with the
--     service-role key, which bypasses RLS.
-- The insert / update / delete policies (029, 016/126.4c) already scope to
-- the own folder and are untouched.
-- ============================================================

drop policy if exists avatars_read on storage.objects;
create policy avatars_read on storage.objects for select to authenticated using (
  bucket_id = 'avatars'
  and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
);

drop policy if exists post_images_read on storage.objects;
create policy post_images_read on storage.objects for select to authenticated using (
  bucket_id = 'post-images'
  and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
);


-- ============================================================
-- 144.5 — Any account could plant an "official" event that Scout recommends.
--
-- events_write (002) only checked created_by = auth.uid(); visibility
-- defaulted to 'public' (011); and search_events() (126.7) hands every
-- public, unblocked row to Scout as a real GOLSZ listing. So any account
-- could insert a fake "official trial" that Scout would recommend to every
-- athlete. The fake-event trigger (062) runs on INSERT only and only reads
-- notes, and events_update let the creator rewrite the title afterwards.
--
-- THE FIX
--   * visibility defaults to 'private'.
--   * events_write: a non-admin may insert only private rows.
--   * events_update: a non-admin's row must still be private after the
--     update (WITH CHECK). A legacy public row owned by a non-admin can no
--     longer be edited unless the same update makes it private.
--   * protect_event_columns() (023, verbatim) now also pins created_by for
--     non-admins, so a row cannot be handed to an admin's id to look
--     admin-created to search_events().
--   * search_events() returns only public, unblocked events whose creator
--     is currently an admin, or that have no creator (seeded via SQL, or a
--     creator whose account was deleted — events.created_by is
--     `on delete set null`; the review query below lists those too).
--
-- LIVE CALL SITES CHECKED
--   * AddToEventsModal (Events page — retired, not routable) already
--     inserts visibility: "private".
--   * AdminPanel createEvent() inserts WITHOUT visibility and would now get
--     'private'. It is not wired to any button (the Manage events view is
--     launch-scoped off). IF RE-ENABLED, it must pass visibility: "public".
--   * api/scout.js calls search_events with the service key; signature and
--     return columns are unchanged.
--
-- is_admin() takes no argument (it reads auth.uid()), so the creator check
-- in search_events() reads profiles.is_admin directly; the function is
-- security definer, so that read is not filtered by RLS.
-- ============================================================

alter table events alter column visibility set default 'private';

drop policy if exists events_write on events;
create policy events_write on events for insert to authenticated with check (
  created_by = auth.uid()
  and (visibility = 'private' or is_admin())
);

drop policy if exists events_update on events;
create policy events_update on events for update to authenticated
  using (created_by = auth.uid() or is_admin())
  with check ((created_by = auth.uid() and visibility = 'private') or is_admin());

create or replace function protect_event_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.role() is null or auth.role() = 'service_role' or is_admin() then
    return new;
  end if;
  new.is_blocked := old.is_blocked;
  -- 144.5: ownership is not editable, so a row cannot be re-attributed.
  new.created_by := old.created_by;
  return new;
end;
$$;

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
    and e.visibility = 'public'
    -- 144.5: only listings GOLSZ itself published
    and (e.created_by is null
         or exists (select 1 from profiles ap where ap.id = e.created_by and ap.is_admin))
    and e.event_date >= coalesce(p_after_date, current_date)
    and (p_sport is null or e.sport ilike p_sport)
    and (p_location is null or e.location ilike '%' || p_location || '%')
    and (p_level is null or e.level ilike p_level)
  order by e.event_date asc
  limit least(coalesce(p_limit, 10), 25);
$$;

revoke execute on function search_events(text, text, text, date, int) from public, anon;
grant execute on function search_events(text, text, text, date, int) to authenticated;
-- api/scout.js calls this with the service key. Explicit, so the revoke
-- from public above can never be what takes Scout's event search away.
grant execute on function search_events(text, text, text, date, int) to service_role;

-- REVIEW, DO NOT RUN BLIND. Public events not created by a current admin.
-- They are already invisible to Scout after this migration, but every
-- signed-in account can still read them through events_read.
--
--   select e.id, e.title, e.event_date, e.created_by, e.is_blocked, e.created_at,
--          p.full_name as creator_name
--     from events e
--     left join profiles p on p.id = e.created_by
--    where e.visibility = 'public'
--      and (e.created_by is null or not coalesce(p.is_admin, false))
--    order by e.created_at desc;
--
-- To make the ones you confirm private:
--   update events set visibility = 'private' where id in ('<id>', ...);


-- ============================================================
-- 144.6 — "Show my club / Show my country on your shared Passport" did
--         nothing, and a banned account's Passport stayed public.
--
-- Settings writes athletes.show_club / show_country (100) and labels them
-- "On your shared Passport", but both Passport RPCs (126.4f / 126.4g)
-- returned a.club_name and a.country unconditionally. Each now returns null
-- for a hidden field — the same `case when a.show_* then ... end` shape
-- search_players() has used since 100 — and returns null outright when the
-- account is banned (is_banned()). PublicPassport already renders a null
-- club or country as "—", and a null result as "this Passport is private".
--
-- Bodies reproduced verbatim from 126.4f / 126.4g apart from those changes.
-- In the token variant the ban check sits BEFORE the last_accessed_at
-- touch, so a refused view is not recorded as an access.
-- ============================================================

create or replace function get_public_passport(p_user uuid)
returns jsonb language sql security definer set search_path to 'public' as $$
  select case
    when p_user is null then null
    when not coalesce((select passport_public from profiles where id = p_user), false) then null
    when is_banned(p_user) then null
    else (
      select jsonb_build_object(
        'full_name', p.full_name,
        'occupation', p.occupation,
        'verified_tier', p.verified_tier,
        'identity_verified', coalesce(p.identity_verified, false),
        'avatar_url', p.avatar_url,
        'sport', a.sport,
        'position', a.position,
        'club_name', case when a.show_club then a.club_name else null end,
        'country', case when a.show_country then a.country else null end,
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

create or replace function get_public_passport_by_token(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_user uuid;
begin
  select user_id into v_user from passport_share_tokens where token = p_token and not revoked;
  if v_user is null then return null; end if;
  if is_banned(v_user) then return null; end if;
  update passport_share_tokens set last_accessed_at = now() where token = p_token;
  return (
    select jsonb_build_object(
      'full_name', p.full_name,
      'occupation', p.occupation,
      'verified_tier', p.verified_tier,
      'identity_verified', coalesce(p.identity_verified, false),
      'avatar_url', p.avatar_url,
      'sport', a.sport,
      'position', a.position,
      'club_name', case when a.show_club then a.club_name else null end,
      'country', case when a.show_country then a.country else null end,
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
    where p.id = v_user
  );
end;
$$;

-- Still reachable logged-out: that is what a shared Passport link is.
-- Same grants 126.4 re-asserted; create or replace preserves them anyway.
grant execute on function get_public_passport(uuid) to anon, authenticated;
grant execute on function get_public_passport_by_token(text) to anon, authenticated;


-- ============================================================
-- 144.7 — Scout was selling features that do not exist.
--
-- api/scout.js builds "GOLSZ PLANS (real, current — never invent a feature
-- ...)" from plan_config.live_features (jsonb array of strings, 092). The
-- 092 seed was never revised: it promised Elite a Schedule, an Athlete
-- diary, GOLSZ Motion exercise demonstrations and nutrition education —
-- product_capabilities (099) itself marks schedule/diary/Motion as
-- "Schema reserved, no shipped UI" — and put benchmarks at Elite when they
-- unlock at Basic.
--
-- Rewritten from the authoritative gate, FEATURE_MIN_PLAN in
-- api/_entitlements.js (mirrored in golsz-app.html): pdf_export, targets,
-- benchmarks, pathway_plan -> Basic ('starter'); readiness (the full
-- Passport Strength breakdown) and development_plan -> Pro; Elite is
-- everything in Pro at the highest question allowance. Question limits
-- match api/scout.js: Free 3/day and 40 lifetime, Basic 8, Pro 15,
-- Elite 20 per day. Prices, taglines and coming_soon_features are left
-- alone (prices are 120's; coming_soon_features is not read by Scout).
-- ============================================================

update plan_config set
  live_features = '["3 AI Scout questions a day, 40 in total over the life of the account", "Digital Sports Passport: profile, highlight links and career timeline", "Shareable Passport link you can revoke at any time", "AI Scout athlete intake and goal discovery", "Passport Strength score and My Next Move"]'::jsonb,
  ai_daily_question_limit = 3,
  ai_lifetime_question_limit = 40,
  updated_at = now()
where plan_id = 'free'
  and (live_features, ai_daily_question_limit, ai_lifetime_question_limit) is distinct from
      ('["3 AI Scout questions a day, 40 in total over the life of the account", "Digital Sports Passport: profile, highlight links and career timeline", "Shareable Passport link you can revoke at any time", "AI Scout athlete intake and goal discovery", "Passport Strength score and My Next Move"]'::jsonb, 3, 40);

update plan_config set
  live_features = '["8 AI Scout questions a day, no lifetime limit", "Everything in Free", "Personalized Pathway with dated milestones", "Target list with outreach tracking and follow-up reminders", "Performance benchmarks and retests", "Passport PDF export"]'::jsonb,
  ai_daily_question_limit = 8,
  ai_lifetime_question_limit = null,
  updated_at = now()
where plan_id = 'starter'
  and (live_features, ai_daily_question_limit, ai_lifetime_question_limit) is distinct from
      ('["8 AI Scout questions a day, no lifetime limit", "Everything in Free", "Personalized Pathway with dated milestones", "Target list with outreach tracking and follow-up reminders", "Performance benchmarks and retests", "Passport PDF export"]'::jsonb, 8, null::int);

update plan_config set
  live_features = '["15 AI Scout questions a day, no lifetime limit", "Everything in Basic", "Full Passport Strength breakdown", "Training and development plan"]'::jsonb,
  ai_daily_question_limit = 15,
  ai_lifetime_question_limit = null,
  updated_at = now()
where plan_id = 'pro'
  and (live_features, ai_daily_question_limit, ai_lifetime_question_limit) is distinct from
      ('["15 AI Scout questions a day, no lifetime limit", "Everything in Basic", "Full Passport Strength breakdown", "Training and development plan"]'::jsonb, 15, null::int);

update plan_config set
  live_features = '["20 AI Scout questions a day, no lifetime limit", "Everything in Pro"]'::jsonb,
  ai_daily_question_limit = 20,
  ai_lifetime_question_limit = null,
  updated_at = now()
where plan_id = 'elite'
  and (live_features, ai_daily_question_limit, ai_lifetime_question_limit) is distinct from
      ('["20 AI Scout questions a day, no lifetime limit", "Everything in Pro"]'::jsonb, 20, null::int);


-- ============================================================
-- 144.8 — Sonnet was priced at its old list price.
--
-- scout_model_config (052; rows seeded by 110) still carries claude-sonnet-5
-- at $3 input / $15 output / $0.30 cached input per 1M tokens. Anthropic's
-- current list price for claude-sonnet-5 is $2 / $10, and a cache read is
-- 10% of input — the same ratio 110 used — so $0.20. budgetGate() and the
-- pre-flight cost estimate read these columns, so the old numbers overstated
-- every Sonnet request by 50%. Only the claude-sonnet-5 rows change.
--
-- NOT CHANGED HERE: api/scout.js's own PRICING / ANTHROPIC_DEFAULTS
-- constants still say 3 / 15, and estimateCost() (scout_routing_log and the
-- admin cost cards) prices from PRICING, not from this table. Those need
-- the matching code change to agree.
-- ============================================================

update scout_model_config set
  input_cost_per_million = 2,
  output_cost_per_million = 10,
  cached_input_cost_per_million = 0.2,
  updated_at = now()
where provider = 'anthropic'
  and model_name = 'claude-sonnet-5'
  and (input_cost_per_million, output_cost_per_million, cached_input_cost_per_million)
      is distinct from (2::numeric, 10::numeric, 0.2::numeric);


commit;


-- ============================================================
-- 144 — Verification. Run these AFTER the migration, separately.
-- ============================================================
--
-- 1) The view runs as the caller:
--      select reloptions from pg_class where oid = 'public_profile_names'::regclass;
--      -- expected: {security_invoker=true}
--    As an ordinary signed-in user (not admin), via the API:
--      GET /rest/v1/public_profile_names?select=id      -- only your own row
--    As an admin: every row, as before (Admin Panel names still resolve).
--
-- 2) The signup gate is live:
--      select pg_get_functiondef('handle_new_user'::regproc) like '%18 or over%';     -- true
--      select pg_get_functiondef('handle_new_user'::regproc) like '%insert into parent_links%';  -- false
--      select tgname, tgenabled from pg_trigger
--       where tgrelid = 'auth.users'::regclass and not tgisinternal;
--      -- expected: the trigger that calls handle_new_user, enabled ('O')
--    Then sign up once through golsz.com with an 18+ date of birth: it must
--    still succeed. (A direct /auth/v1/signup with date_of_birth under 18,
--    or with none, must fail with "Database error saving new user".)
--
-- 3) Parent-link approval:
--      select polname, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)
--        from pg_policy where polrelid = 'parent_links'::regclass and polname = 'parent_links_approve';
--      -- both expressions contain requested_by = parent_id
--      select count(*) from parent_links;   -- expected 0 (or review per 144.3)
--
-- 4) Storage listing:
--      select polname, pg_get_expr(polqual, polrelid) from pg_policy
--       where polrelid = 'storage.objects'::regclass and polname in ('avatars_read','post_images_read');
--      -- both mention storage.foldername(name) and is_admin()
--    Then open a shared Passport logged out and confirm the photo loads.
--
-- 5) Events:
--      select column_default from information_schema.columns
--       where table_name = 'events' and column_name = 'visibility';   -- 'private'::text
--      select count(*) from search_events() s join events e on e.id = s.id
--        left join profiles p on p.id = e.created_by
--       where e.created_by is not null and not coalesce(p.is_admin, false);   -- 0
--
-- 6) Shared Passport flags (pick an athlete with a live share token):
--      update athletes set show_club = false where id = '<uuid>';
--      select get_public_passport_by_token('<token>')->>'club_name';   -- null
--      update athletes set show_club = true where id = '<uuid>';
--
-- 7) Plan copy:
--      select plan_id, live_features from plan_config order by display_order;
--      -- no Schedule / diary / Motion / nutrition; benchmarks under Basic
--
-- 8) Model pricing:
--      select model_tier, input_cost_per_million, output_cost_per_million, cached_input_cost_per_million
--        from scout_model_config where model_name = 'claude-sonnet-5';   -- 2 / 10 / 0.2
--
-- 9) The anon surface did not grow (126.16's check):
--      select p.oid::regprocedure from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public' and p.prosecdef
--         and p.prorettype <> 'trigger'::regtype   -- not callable over the API; 126.16 skips them too
--         and has_function_privilege('anon', p.oid, 'execute') order by 1;
--      -- expected: get_public_passport, get_public_passport_by_token,
--      --           log_client_error, and nothing else.
-- ============================================================
