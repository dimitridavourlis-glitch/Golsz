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
