-- ============================================================
-- 025 — Verified badge tiers (Pro / Elite), admin-controlled and
-- independent of payment plan
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 +
-- 012 + 013 + 014 + 015 + 016 + 017 + 018 + 019 + 020 + 021 + 022 + 023 +
-- 024.
--
-- Supersedes an earlier draft of this migration (a self-service
-- request/review workflow, with its own verification_requests table and
-- admin approve/deny screen) that was written but never applied to the
-- live database — this file is the first version of migration 025 to
-- actually ship, and it drops that unused table/function defensively
-- (IF EXISTS) in case it was ever run.
--
-- Replaces the plain profiles.is_verified boolean (migration 024) with a
-- three-state profiles.verified_tier ('none' | 'pro' | 'elite'):
--
--   - Automatic: whenever profiles.plan actually changes — a self-service
--     downgrade to Starter in Settings, an admin manually changing
--     someone's plan, or api/stripe-webhook.js writing a plan change on
--     checkout/upgrade/downgrade/cancellation — verified_tier is synced
--     to match. Pay for Pro, get the lime Pro check; pay for Elite, get
--     the differently-colored (blue) Elite check; drop to Starter, lose
--     it. This sync lives inside protect_profile_columns() so every one
--     of those write paths gets it for free from one place, rather than
--     needing the same logic duplicated in the webhook handler and the
--     admin panel and Settings.
--   - Manual override: an admin can independently set any account's
--     verified_tier from the Admin Panel's Users tab (three buttons —
--     Unverified / Pro check / Elite check) regardless of that account's
--     actual plan. This is the actual point of the feature: a still-
--     paying Pro/Elite account that starts behaving "shady" can have its
--     check pulled without touching their subscription or plan at all
--     (the admin's update only ever writes verified_tier, never plan).
--     Conversely, an admin can grant a badge to a Starter account as a
--     courtesy with no payment involved. Because the automatic sync
--     above only fires when plan actually CHANGES, an admin's manual
--     override survives indefinitely until the next real plan change —
--     a Stripe subscription renewal never touches profiles.plan (it's
--     the same value before and after), so it can never silently
--     overwrite an admin's revoke.
-- ============================================================

drop table if exists verification_requests cascade;
drop function if exists admin_review_verification_request(uuid, boolean);
alter table profiles drop constraint if exists is_verified_requires_paid_plan;

alter table profiles add column if not exists verified_tier text not null default 'none'
  check (verified_tier in ('none', 'pro', 'elite'));

-- Backfill: migration 024's is_verified predates tiers. Anyone an admin
-- had already flipped to true keeps a badge, best-matched to their
-- current plan (defaulting to 'pro' if they're not actually elite,
-- since an admin had already vetted and verified them by hand).
update profiles set verified_tier = case when plan = 'elite' then 'elite' else 'pro' end
  where is_verified = true and verified_tier = 'none';

-- Must repoint the view off is_verified before dropping the column —
-- Postgres refuses to drop a column a view still depends on, and
-- CREATE OR REPLACE VIEW can't rename an existing output column in
-- place (is_verified -> verified_tier), so this needs a real drop/recreate.
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

  -- Auto-sync verified_tier to whatever plan is landing in this row, but
  -- only when plan is actually changing — this is what lets an admin's
  -- manual override (above) survive everything except a real plan
  -- change, while still auto-granting/revoking on subscribe/upgrade/
  -- downgrade/cancel (self-service, admin-driven, or via the Stripe
  -- webhook's service-role writes).
  if new.plan is distinct from old.plan then
    new.verified_tier := case new.plan when 'elite' then 'elite' when 'pro' then 'pro' else 'none' end;
  end if;

  return new;
end;
$$;

-- ============================================================
-- Done. No new trigger needed — protect_profile_columns_trigger (023)
-- already fires BEFORE UPDATE on profiles and picks up this new function
-- body automatically via CREATE OR REPLACE.
-- ============================================================
