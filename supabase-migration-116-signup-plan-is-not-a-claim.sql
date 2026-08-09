-- ============================================================
-- 116 — A signup cannot grant itself a paid plan  [SECURITY FIX]
--
-- Found while wiring the Stripe live-mode gate (P0-2), not part of the
-- approved remediation list. Reporting it explicitly.
--
-- THE PROBLEM
-- handle_new_user() read the plan out of raw_user_meta_data — a value the
-- CLIENT supplies at signup — and wrote it straight into profiles.plan:
--
--     v_plan := new.raw_user_meta_data->>'plan';
--     if v_plan not in ('free','starter','pro','elite') then v_plan := 'free';
--     insert into profiles (..., plan) values (..., v_plan::plan_tier);
--
-- The allow-list validated that the string was a real tier. It did not, and
-- could not, validate that anybody had paid for it. So:
--
--   * picking Pro or Elite on the signup screen granted Pro or Elite,
--     independent of whether Stripe checkout was ever completed — and the
--     links are still sandbox links, so nobody has ever actually paid;
--   * calling supabase.auth.signUp() directly with
--     { data: { plan: "elite" } } granted Elite to anyone, no UI involved.
--
-- Every paid entitlement is downstream of profiles.plan: FEATURE_MIN_PLAN in
-- the client, capTier() and the daily Scout limits in api/scout.js. So this
-- is a full bypass of the paywall AND of the AI cost controls.
--
-- THE FIX
-- Every new account starts on 'free'. profiles.plan is written by exactly
-- one thing afterwards: api/stripe-webhook.js, using the service-role key,
-- on a verified Stripe event with a real signature. That is the only place
-- that can actually know a payment happened.
--
-- Nothing else in the function changes — DOB, minor detection, occupation,
-- honeypot trust scoring and parent linking are all byte-identical to the
-- previous definition.
--
-- NOT A PRICING CHANGE. The tiers and their prices are untouched; this only
-- stops the product giving them away.
--
-- EXISTING ACCOUNTS ARE NOT TOUCHED, AND THAT IS NOW A DECISION, NOT A GAP.
--
-- Audited against production on 2026-08-10, immediately after applying this
-- migration. 13 accounts: 12 on 'starter', 1 on 'free', none on pro/elite.
-- That split is not people gaming the paywall — the pre-116 function fell
-- back to 'starter' for any signup without a valid metadata plan, so the
-- normal flow put everybody there. Of the 12: 1 is the admin account, 1 is a
-- deliberate ai_unlimited grant (migration 045), 1 carries a stripe_customer_id
-- from a TEST-mode checkout (which incidentally proves the webhook path works
-- end to end), and 9 are unexplained. Several are self-evidently test accounts
-- by name.
--
-- Owner decision, 2026-08-10: GRANDFATHER ALL OF THEM. No demotion. The cost
-- is AI usage on ~9 accounts, most of which are the owner's own tests, and
-- demoting a real athlete would visibly strip Targets/Benchmarks/Pathway and
-- cut their Scout allowance from 8/day to 3/day plus the 40-lifetime cap —
-- a worse outcome than the money involved.
--
-- This migration is what stops it recurring. Every account created from here
-- starts on 'free'. The audit query at the bottom still works if the position
-- is ever revisited.
-- ============================================================

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

-- Verification — a new signup must land on 'free' whatever it claims:
--   select plan from profiles order by created_at desc limit 1;
--
-- Audit of accounts that may hold an unpaid plan today. stripe_customer_id
-- is null for anyone the webhook never saw, which is everyone so far, since
-- the Payment Links are still in test mode:
--   select id, full_name, plan, stripe_customer_id, created_at
--     from profiles
--    where plan <> 'free' and stripe_customer_id is null
--    order by created_at desc;
