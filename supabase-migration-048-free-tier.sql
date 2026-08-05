-- ============================================================
-- 048 — Add a real "free" plan tier
-- Additive on top of 002 + ... + 047.
--
-- Before this migration, plan_tier only had 'starter' | 'pro' | 'elite',
-- and 'starter' did double duty as the free/default tier (see the note at
-- the top of this file dated 2026-07-15). That was fine while Starter cost
-- $0 — but this session moved Starter to a real $6/mo paid tier, and
-- nothing else was updated to match: protect_profile_columns() still let
-- any signed-in user self-assign plan='starter' with no payment (it only
-- blocks changes to anything OTHER than 'starter'), so a user could get
-- the $6 tier for free via Settings > choosePlan("starter"). This
-- migration adds a genuine 'free' tier and moves that self-service,
-- no-payment path onto it instead — 'starter' now requires checkout like
-- Pro and Elite.
--
-- Run the ALTER TYPE statement on its own (Postgres cannot use a new enum
-- value in the same transaction that adds it) before running the rest of
-- this file.
-- ============================================================

alter type plan_tier add value if not exists 'free';

-- ---- run everything below as a separate statement/query from the above ----

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
-- Done.
-- ============================================================
