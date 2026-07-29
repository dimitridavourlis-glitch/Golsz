-- ============================================================
-- 024 — Admin-controlled "verified" badge for non-player accounts
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 +
-- 012 + 013 + 014 + 015 + 016 + 017 + 018 + 019 + 020 + 021 + 022 + 023.
--
-- Real risk, not a hypothetical one: profiles.occupation (migration 020)
-- is entirely self-declared — anyone can pick "Coach"/"Agent"/"Scout" at
-- signup with zero check, and it's shown as a trust-looking badge right
-- next to their name on the Passport. That's exactly the setup for
-- impersonation: a bad actor picks "Coach", looks legitimate immediately,
-- and messages an athlete (once a follow relationship satisfies
-- can_message()) with no verification behind the claim at all.
--
-- This doesn't (and can't, from inside the database) verify that someone
-- really is who they say — that's a manual, offline process the admin
-- does (checking a coaching license, calling the claimed club/agency,
-- checking a LinkedIn, etc.). What this adds is the ability to record the
-- *result* of that check, and — the actually important part — flips the
-- default so an unverified claim reads as unverified instead of looking
-- identical to a checked one. golsz-app.html's Passport now shows a
-- distinct, amber "UNVERIFIED" badge for any non-Player occupation until
-- an admin flips is_verified, rather than the same trusted-looking lime
-- pill every occupation got before.
--
-- is_verified goes into the exact same "never self-editable" bucket as
-- is_admin/is_banned from migration 023's protect_profile_columns() —
-- without that, a scammer could just set is_verified=true on themselves
-- via the same client call pattern that made the plan/is_admin escalation
-- possible before migration 023, which would defeat the entire point of
-- this feature.
-- ============================================================

alter table profiles add column if not exists is_verified boolean not null default false;

-- Same reasoning migration 020 used for occupation: this has to clear the
-- same public-read boundary full_name already does, since the whole point
-- is for an athlete viewing someone ELSE's profile to see whether that
-- account has been verified — not just visible on your own.
create or replace view public_profile_names as
select id, full_name, occupation, is_verified from profiles;

grant select on public_profile_names to anon, authenticated;

create or replace function protect_profile_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.role() is null or auth.role() = 'service_role' or is_admin() then
    return new;
  end if;
  new.is_admin := old.is_admin;
  new.is_banned := old.is_banned;
  new.is_verified := old.is_verified;
  new.stripe_customer_id := old.stripe_customer_id;
  if new.plan is distinct from old.plan and new.plan <> 'starter' then
    new.plan := old.plan;
  end if;
  return new;
end;
$$;

-- ============================================================
-- Done. No new trigger needed — protect_profile_columns_trigger (023)
-- already fires BEFORE UPDATE on profiles and picks up this new function
-- body automatically via CREATE OR REPLACE.
-- ============================================================
