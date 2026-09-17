-- 138 — GOLSZ is for athletes and the people who pay for them. Scout, Coach
-- and Physio are gone.
--
-- These were never separate versions of the app: occupation only ever branched
-- Player / Parent / everything-else, and the three removed values shared the
-- same generic non-player profile. What they did do was appear in a signup
-- dropdown, in the verification flow, and in every allowlist here — surface
-- area for user types the product does not serve.
--
-- ORDER MATTERS. Existing rows are migrated to 'Other' BEFORE the constraint
-- tightens, because a CHECK is validated against rows already in the table and
-- would otherwise refuse to be added at all. 'Other' rather than null: null
-- means "never answered", and someone who told us they were a coach did
-- answer. Their row is preserved; only the label they no longer have is not.
--
-- THE TRIGGER'S ALLOWLIST MOVES IN THE SAME MIGRATION. It nulls an unknown
-- occupation rather than rejecting it, so leaving it wider than the constraint
-- would let a signup carrying occupation='Coach' pass the trigger and then die
-- on the CHECK — a hard signup failure instead of a quietly ignored field.
-- handle_new_user is reproduced verbatim from migration 116 with that one line
-- changed; nothing else about it is touched.
--
-- Idempotent. Safe to re-run.

update public.profiles set occupation = 'Other'
 where occupation in ('Scout', 'Coach', 'Physio');

alter table public.profiles
  drop constraint if exists profiles_occupation_check;

alter table public.profiles
  add constraint profiles_occupation_check
  check (occupation is null or occupation in ('Player', 'Parent', 'Agent', 'Other'));

create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_dob date;
  v_is_minor boolean := false;
  v_parent_email text;
  v_parent_id uuid;
  v_occupation text;
  v_honeypot text;
  v_trust_score int := 50;
begin
  v_dob := nullif(new.raw_user_meta_data->>'date_of_birth', '')::date;
  if v_dob is not null then
    v_is_minor := (date_part('year', age(v_dob)) < 18);
  end if;
  v_parent_email := nullif(new.raw_user_meta_data->>'parent_email', '');

  -- raw_user_meta_data->>'plan' is deliberately NOT read any more. The
  -- client still sends it (it records which plan the athlete intends to buy,
  -- and the signup flow uses it to pick the right Stripe Payment Link), but
  -- it is a statement of intent, never an entitlement. Only
  -- api/stripe-webhook.js may change profiles.plan.

  v_occupation := nullif(new.raw_user_meta_data->>'occupation', '');
  if v_occupation is not null and v_occupation not in ('Player', 'Parent', 'Agent', 'Other') then
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
