-- ============================================================
-- 020 — Add profiles.occupation (Scout / Agent / Coach / Physio / Other)
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 +
-- 012 + 013 + 014 + 015 + 016 + 017 + 018 + 019.
--
-- A new, purpose-built column rather than reusing the pre-existing
-- profiles.role — this schema's own header warning notes role's enum
-- values were never confirmed live, so writing new values into it without
-- introspecting first is exactly the kind of guess this file warns against.
-- occupation is plain text with a check constraint instead, scoped to
-- these 5 values only.
--
-- Captured at signup (handle_new_user() below reads it from the same
-- raw_user_meta_data payload date_of_birth/parent_email/plan already use)
-- and editable later via ProfileEditor, same as every other Passport field.
--
-- Visible on the Passport for anyone viewing someone else's profile too,
-- not just your own — that means it has to clear the same public-read
-- boundary full_name already does. public_profile_names exists exactly
-- for this (a narrow, non-sensitive view of profiles so Feed/Discover/
-- Passport can show someone else's name without a blanket "select using
-- (true)" policy on profiles itself, which would also leak dob/plan/
-- is_admin). Adding occupation to that view is safe by the same logic:
-- it's not sensitive, unlike the columns that view deliberately excludes.
-- ============================================================

alter table profiles add column if not exists occupation text
  check (occupation in ('Scout', 'Agent', 'Coach', 'Physio', 'Other'));

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
  if v_occupation is not null and v_occupation not in ('Scout', 'Agent', 'Coach', 'Physio', 'Other') then
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
-- Done.
-- ============================================================
