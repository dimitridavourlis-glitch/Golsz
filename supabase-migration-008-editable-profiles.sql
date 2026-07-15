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
