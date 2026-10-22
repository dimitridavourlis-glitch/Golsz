-- ============================================================
-- 161 — Admin roles: owner and moderator.
--
-- *** NOT YET APPLIED ***  (written 2026-10-22; the owner runs it by hand)
--
-- WHY. Until now every admin held the same full power: `profiles.is_admin` is
-- one boolean, checked in 51 migrations' policies and functions, and the
-- profiles trigger let any admin write ANY column, including `is_admin`
-- itself. A moderator who only needed to review reports could therefore grant
-- admin, change anyone's plan, comp full access, or (through the API) delete
-- accounts. Nothing about the product's money or power had a second tier.
--
-- WHAT IT DOES
--   161.1  profiles.admin_role: 'owner' | 'moderator' | null. Existing admins
--          become OWNERS, so nobody loses power on the day this runs.
--   161.2  is_admin_owner(): is_admin() and role = 'owner'.
--   161.3  protect_profile_columns() is re-created from migration 126's body
--          with two insertions, each fenced by `>>> 161` / `<<< 161` comment
--          lines so a diff against 126 shows nothing else moved:
--            * a moderator's writes to is_admin, admin_role, plan,
--              full_access, ai_unlimited and stripe_customer_id are reverted;
--            * admin_role follows is_admin (a new admin is a moderator), and
--              the last owner cannot be removed.
--
-- WHAT A MODERATOR CAN STILL DO: everything the moderation tools do (reports,
-- the AI moderation queue, appeals, verification review, errors, ban/unban,
-- the verified badge, reading users and the audit log).
-- WHAT ONLY AN OWNER CAN DO: grant or revoke admin or ownership, change a
-- plan, comp full access or unlimited Scout, and delete accounts (the last is
-- enforced in api/admin-user-action.js; account deletion is not a profiles
-- write).
--
-- NOT COVERED, STATED PLAINLY: the 15 or so admin_* RPCs are still callable by
-- any admin (each opens with `if not is_admin()`); moderators keep them.
-- Restricting one means editing that function; none moves money or power.
--
-- ORDER. Safe to run at any time, before or after the matching code ships:
-- api/admin-user-action.js and the Admin Panel fall back to today's behaviour
-- (every admin an owner) while this column does not exist. Run 162 (MFA) only
-- after the owner has enrolled an authenticator in the Admin Panel.
--
-- HOW TO APPLY. Paste into the Supabase SQL Editor and run once. One
-- transaction; every statement is idempotent. Verification at the bottom.
-- ============================================================

begin;

-- 161.1
alter table profiles add column if not exists admin_role text
  check (admin_role in ('owner', 'moderator'));

comment on column profiles.admin_role is
  'owner | moderator, meaningful only while is_admin is true (161). Owner-only to change; maintained by protect_profile_columns().';

-- Existing admins keep what they have today. Runs before the trigger is
-- replaced, as the SQL Editor (auth.role() is null), so it is exempt.
update profiles set admin_role = 'owner' where is_admin = true and admin_role is null;

-- 161.2
create or replace function is_admin_owner()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select is_admin() and coalesce((select admin_role from profiles where id = auth.uid()), 'moderator') = 'owner';
$$;

revoke execute on function is_admin_owner() from public, anon;
grant execute on function is_admin_owner() to authenticated;

-- 161.3
create or replace function protect_profile_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  -- The ONLY columns a normal signed-in user may change on their own
  -- profiles row. Everything else is pinned to its previous value.
  -- See the banner above for how this list was derived; adding to it is a
  -- security decision, not a formality.
  v_self_editable constant text[] := array[
    'full_name',
    'occupation',
    'avatar_url',
    'goal_text',
    'goal_defined',
    'goal_source',                 -- migration 113; may not exist yet on
    'goal_updated_at',             -- older databases — harmless either way,
                                   -- the loop only ever sees real columns
    'onboarding_conversion_shown',
    'passport_public',             -- judgment call: see banner
    'plan'                         -- then narrowed to downgrade-only below
  ];
  v_new jsonb;
  v_old jsonb;
  v_col text;
  v_privileged boolean;
begin
  -- Set by the few SECURITY DEFINER RPCs that are granted to `authenticated`
  -- and legitimately write a protected column on the caller's behalf. It is
  -- transaction-local and there is no client-reachable way to set it — see
  -- 126.3b.
  v_privileged := coalesce(current_setting('golsz.privileged_profile_write', true), 'off') = 'on';

  if not (auth.role() is null
          or auth.role() = 'service_role'
          or v_privileged
          or is_admin()) then

    v_new := to_jsonb(new);
    v_old := to_jsonb(old);

    -- to_jsonb(old) has exactly one key per column of profiles AS IT EXISTS
    -- RIGHT NOW. That is the introspection: no hardcoded list to go stale,
    -- and a column added by a future migration is denied by default.
    for v_col in select jsonb_object_keys(v_old) loop
      if not (v_col = any (v_self_editable)) then
        v_new := jsonb_set(v_new, array[v_col], v_old -> v_col);
      end if;
    end loop;

    new := jsonb_populate_record(new, v_new);

    -- Preserved exactly as before: a user may move themselves DOWN to the
    -- free plan (Settings' cancel), never up. Any other plan change is
    -- reverted. Upgrades arrive via the Stripe webhook, which uses the
    -- service-role key and is exempted above.
    if new.plan is distinct from old.plan and new.plan <> 'free' then
      new.plan := old.plan;
    end if;
  end if;
  -- >>> 161 owner-only columns
  -- The allowlist above lets ANY admin through (is_admin()). The columns that
  -- decide who holds power and who pays are owner-only: a moderator's write to
  -- them is reverted here, silently and in the same statement, whatever the
  -- client sent. Service role, the SQL Editor and the few privileged RPCs are
  -- exempt exactly as above; an owner is unaffected.
  if not (auth.role() is null or auth.role() = 'service_role' or v_privileged)
     and is_admin() and not is_admin_owner() then
    new.is_admin := old.is_admin;
    new.admin_role := old.admin_role;
    new.plan := old.plan;
    new.full_access := old.full_access;
    new.ai_unlimited := old.ai_unlimited;
    new.stripe_customer_id := old.stripe_customer_id;
  end if;
  -- <<< 161


  -- Runs for EVERY caller, including admins and the service role, exactly as
  -- before: verified_tier is derived from plan, never independent of it.
  if new.plan is distinct from old.plan then
    new.verified_tier := case new.plan when 'elite' then 'elite' when 'pro' then 'pro' else 'none' end;
  end if;

  -- >>> 161 role follows flag
  -- admin_role means something only while is_admin is true, and a new admin
  -- is a moderator until an owner says otherwise (least privilege). Runs for
  -- every caller, so an admin made from the SQL Editor is consistent too.
  if new.is_admin is not true then
    new.admin_role := null;
  elsif new.admin_role is null then
    new.admin_role := 'moderator';
  end if;

  -- The platform must never be left with nobody who can grant or revoke
  -- admin. Applies to every caller, the SQL Editor included: to move
  -- ownership, make the new owner first, then demote the old one.
  if old.admin_role = 'owner' and new.admin_role is distinct from 'owner'
     and not exists (select 1 from profiles p where p.admin_role = 'owner' and p.id <> old.id) then
    raise exception 'GOLSZ: cannot remove the last owner - make another owner first'
      using errcode = 'check_violation';
  end if;
  -- <<< 161


  return new;
end;
$$;
-- Re-assert the trigger binding (it already exists from migration 023).
drop trigger if exists protect_profile_columns_trigger on profiles;
create trigger protect_profile_columns_trigger
  before update on profiles
  for each row execute function protect_profile_columns();

commit;


-- ============================================================
-- 161 — Verification. Run these AFTER the migration, separately.
-- ============================================================
--
-- 1) The column and the backfill:
--      select id, is_admin, admin_role from profiles where is_admin;
--      -- expected: every admin has admin_role 'owner'.
--      select count(*) from profiles where not is_admin and admin_role is not null;
--      -- expected: 0.
--
-- 2) A moderator cannot touch the owner-only columns. Make a second,
--    throwaway admin a moderator, sign in as them, then:
--      update profiles set plan = 'elite' where id = '<any-user>';
--      select plan from profiles where id = '<any-user>';   -- unchanged
--      update profiles set is_admin = true where id = '<any-user>';
--      select is_admin from profiles where id = '<any-user>';   -- unchanged
--    (Both statements succeed and change nothing: the trigger reverts them.)
--
-- 3) The last owner is protected (as the SQL Editor):
--      update profiles set is_admin = false where admin_role = 'owner';
--      -- expected: ERROR  GOLSZ: cannot remove the last owner
--      --                   (when exactly one owner exists)
--
-- 4) To make a moderator: an owner flips is_admin in the Admin Panel (the
--    new admin is a moderator); to make another owner, "Make owner".
--    From the SQL Editor: update profiles set is_admin = true,
--      admin_role = 'owner' where id = '<uuid>';
-- ============================================================
