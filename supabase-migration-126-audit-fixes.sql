-- ============================================================
-- 126 — Pre-launch database security audit: confirmed-defect fixes
--
-- WHY THIS FILE EXISTS
-- A full audit of the database layer ran against the live project before
-- launch. It did not produce a list of theoretical weaknesses — every item
-- below was reproduced. Three of them are the kind of defect that only ever
-- gets found the hard way: a usage limit that is structurally incapable of
-- denying anyone, a profile-read policy that hands a stranger someone's date
-- of birth for the price of one unauthenticated-shaped RPC call, and a
-- column-protection trigger that has been protecting a fixed list of seven
-- columns while the profiles table grew to roughly thirty.
--
-- The common thread in all three is the same mistake made three times: a
-- guard written as an ALLOW-list of the threats known on the day it was
-- written, rather than as a DENY-by-default rule that stays correct as the
-- schema grows. Where this file can, it flips that around.
--
-- WHY 126 AND NOT 125
-- The audit brief said to write this as migration 125. 125 was already taken
-- by supabase-migration-125-athlete-editable-context.sql (shipped
-- 2026-08-11, the athlete-editable scout_context work). Overwriting a real,
-- already-applied migration to satisfy a file name would have destroyed
-- history for no benefit, so this is 126. Nothing else about the brief
-- changed.
--
-- HOW TO APPLY
-- Paste into the Supabase SQL Editor and run once, top to bottom. Every
-- statement here is idempotent — `create or replace`, `if not exists`,
-- `drop policy if exists` before `create policy`, and guarded `do $$` blocks
-- for anything DDL-shaped. Re-running it is safe and is in fact the intended
-- way to re-secure the database after a future migration adds a new column
-- or a new SECURITY DEFINER function.
--
-- ORDER MATTERS IN EXACTLY ONE PLACE: section 16 (the blanket EXECUTE
-- revoke) reads the current grant state of every function and preserves it
-- for `authenticated` / `service_role` while stripping `public` / `anon`. It
-- therefore has to run LAST, after sections 1 and 14 have set the grants
-- they want. Do not move it.
--
-- SECTION NUMBERS 13 AND 17 ARE MISSING ON PURPOSE. The audit's items 13 and
-- 17 are not schema changes and so are not in this file:
--   * 13 — supabase-schema.sql was no longer re-runnable: it seeded
--          plan_config.price_usd near the top and renamed that column to
--          price_eur further down, so a second paste aborted at the seed.
--          Fixed in place, in supabase-schema.sql itself.
--   * 17 — the live push webhook secret was committed as a literal in both
--          supabase-schema.sql and
--          supabase-migration-026-push-webhook-triggers.sql. Both literals
--          are now REPLACE_WITH_SUPABASE_WEBHOOK_SECRET with a comment
--          explaining paste-time substitution. THE SECRET ITSELF IS STILL
--          COMPROMISED UNTIL THE OWNER ROTATES IT — removing it from the
--          files does not un-leak it, because git history keeps it.
-- Section 3b is an addition the audit did not ask for; see its own banner
-- for why default-deny could not ship without it.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--   * It does not rotate the leaked push-webhook secret. Only the owner can
--     do that (Vercel env + a re-run of migration 026). The literal has been
--     removed from both files that carried it; the value itself is still
--     compromised until rotated.
--   * It does not restore the minor-restriction gate. See section 4 — that
--     is now a recorded owner decision, not an oversight.
--   * It does not restrict which COLUMNS the athletes table exposes. See
--     section 6 — also an owner decision.
-- ============================================================


-- ============================================================
-- 126.1 — Usage limits were a no-op. Both of them.
--
-- THE DEFECT
-- reserve_scout_question() (053) and reserve_free_ai_question() (068) are
-- the only two things standing between a plan's question allowance and an
-- unbounded Anthropic bill. Both were written as "increment the counter, but
-- clamp it at the limit; then return whether the counter is at or under the
-- limit":
--
--     set questions_used = case when questions_used < p_plan_limit
--                                then questions_used + 1
--                                else questions_used end       -- clamp
--     ...
--     'allowed', v_used <= p_plan_limit                        -- compare
--
-- The clamp guarantees the comparison. v_used can never exceed p_plan_limit,
-- so `v_used <= p_plan_limit` is a tautology: `allowed` was true on every
-- call this function has ever served, on every plan, forever. A free-plan
-- account with a lifetime budget of 40 questions could ask 40,000.
--
-- Nothing downstream caught it, because api/scout.js does exactly what it
-- should — it trusts `allowed` — and the counter it displays looked correct
-- (pinned at the limit) precisely because of the clamp that broke the gate.
--
-- THE FIX
-- Model it on reserve_signup_attempt() (074), which is the one reserve
-- function in this codebase that got this right: increment unconditionally,
-- then compare. `v_used <= p_plan_limit` is then a real test of whether the
-- caller was BELOW the limit before this call incremented it, because
-- v_used = used_before + 1, so `v_used <= limit` is `used_before < limit`.
--
-- The return shape is unchanged — {allowed, used, limit} — because
-- api/scout.js reads all three keys (see reserveScoutQuestion() /
-- reserveFreeAiQuestion()). Both stay `security definer set search_path to
-- 'public'`.
--
-- KNOWN AND ACCEPTED: with the clamp gone, a denied caller's counter keeps
-- climbing past the limit on each rejected attempt (41, 42, ... on a limit
-- of 40). This is the same behaviour reserve_signup_attempt has, it is
-- monotonic so it can never re-open the gate, and `used` is only ever
-- rendered as "N of M" next to a limit the athlete has already hit.
--
-- THE SECOND HALF OF THE FIX, WITHOUT WHICH THE FIRST HALF IS DECORATION
-- reserve_scout_question / release_scout_question never had their grants
-- locked down. PostgreSQL grants EXECUTE to PUBLIC by default (migration
-- 102's lesson), so any holder of the public anon key could call
-- release_scout_question(their_own_uuid) in a loop and drive their daily
-- counter back to zero — defeating the limit just as completely as the
-- clamp did, and by an easier route. 068 already locked its own pair down
-- this way; 053's pair is brought in line here. api/scout.js calls all four
-- of these with SUPABASE_SERVICE_KEY, so service_role is the only grantee
-- anything real needs.
-- ============================================================

create or replace function reserve_scout_question(p_user uuid, p_plan_limit int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_used int;
begin
  -- Unconditional increment. The counter is the source of truth about how
  -- many questions were ASKED; clamping it destroyed the information the
  -- comparison below needs.
  insert into scout_daily_usage (user_id, usage_date, questions_used)
  values (p_user, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, usage_date) do update
    set questions_used = scout_daily_usage.questions_used + 1,
        updated_at = now()
  returning questions_used into v_used;

  -- v_used is the count INCLUDING this call, so `<= limit` is exactly
  -- "the caller was below the limit before this call".
  return jsonb_build_object('allowed', v_used <= p_plan_limit, 'used', v_used, 'limit', p_plan_limit);
end;
$$;

create or replace function reserve_free_ai_question(p_user uuid, p_lifetime_limit int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_used int;
begin
  update profiles
  set free_ai_lifetime_used = free_ai_lifetime_used + 1
  where id = p_user
  returning free_ai_lifetime_used into v_used;

  -- No row matched (no such profile) leaves v_used null, which makes
  -- 'allowed' null and reads as "not allowed" at the call site. That is the
  -- pre-existing behaviour and it fails closed, so it is left alone.
  return jsonb_build_object('allowed', v_used <= p_lifetime_limit, 'used', v_used, 'limit', p_lifetime_limit);
end;
$$;

-- Same lockdown 068 already applied to its own pair. Revoke from public
-- FIRST — revoking from anon/authenticated alone does nothing while the
-- PUBLIC grant stands (migration 102).
revoke execute on function reserve_scout_question(uuid, int) from public, anon, authenticated;
revoke execute on function release_scout_question(uuid) from public, anon, authenticated;
grant execute on function reserve_scout_question(uuid, int) to service_role;
grant execute on function release_scout_question(uuid) to service_role;

-- 068's pair already had these; re-asserted so this file is self-contained
-- and so a future `create or replace` that resets an ACL is re-fixed by a
-- re-run of this migration.
revoke execute on function reserve_free_ai_question(uuid, int) from public, anon, authenticated;
revoke execute on function release_free_ai_question(uuid) from public, anon, authenticated;
grant execute on function reserve_free_ai_question(uuid, int) to service_role;
grant execute on function release_free_ai_question(uuid) to service_role;


-- ============================================================
-- 126.2 — Anyone could read anyone's full profile, by asking to be their
--         parent.
--
-- THE DEFECT
-- The profiles_linked policy granted SELECT on a profile row whenever a
-- parent_links row merely EXISTED between the caller and that profile:
--
--     exists (select 1 from parent_links
--              where parent_id = auth.uid() and athlete_id = profiles.id)
--     or exists (select 1 from parent_links
--              where athlete_id = auth.uid() and parent_id = profiles.id)
--
-- with no approved_at check. request_parent_link(victim_email) is granted to
-- every authenticated user and inserts exactly such a row, pending, with no
-- notification and no consent. So the attack is two calls: claim to be
-- someone's parent, then read their profile row in full — dob,
-- scout_assessment, stripe_customer_id, trust_score, plan, everything.
--
-- This is worse than it looks in isolation, because profiles is the one
-- table in this schema that deliberately has no public read path at all —
-- the app goes through the public_profile_names view precisely BECAUSE
-- "dob is sensitive" (golsz-app.html says so in two separate comments).
-- profiles_linked was the hole in that wall.
--
-- WHY THE POLICY EXISTED, AND HOW THAT PURPOSE SURVIVES
-- It was not gratuitous. Its comment explains the real problem it solved:
-- when a link request is PENDING, both sides need to see the counterparty's
-- NAME to make an approve/deny decision, and is_parent_of() cannot help
-- because is_parent_of() requires approved_at — the very thing being
-- decided. Adding `and approved_at is not null` to the policy is correct but
-- would leave the approve/deny screen showing a blank name.
--
-- So the name lookup moves out of the RLS policy and into a purpose-built
-- SECURITY DEFINER function that returns THREE columns and nothing else:
-- id, full_name, avatar_url. There is no argument to it — it derives the
-- pairs from auth.uid() itself, so a caller cannot point it at someone they
-- have no pending link with. Granted to `authenticated` only, with the
-- PUBLIC default grant revoked (migration 102's lesson again).
-- ============================================================

drop policy if exists profiles_linked on profiles;
create policy profiles_linked on profiles
  for select using (
    exists (
      select 1 from parent_links
      where parent_id = auth.uid() and athlete_id = profiles.id
        and approved_at is not null
    )
    or exists (
      select 1 from parent_links
      where athlete_id = auth.uid() and parent_id = profiles.id
        and approved_at is not null
    )
  );

-- Names for the approve/deny decision, and only for that. Both directions of
-- a PENDING link involving the caller. No parameters on purpose: the pair
-- set is derived from auth.uid(), so this cannot be aimed at a stranger.
create or replace function pending_parent_link_names()
returns table (id uuid, full_name text, avatar_url text)
language sql stable security definer set search_path to 'public' as $$
  select p.id, p.full_name, p.avatar_url
  from profiles p
  where auth.uid() is not null
    and exists (
      select 1 from parent_links pl
      where pl.approved_at is null
        and (
          (pl.parent_id = auth.uid() and pl.athlete_id = p.id)
          or (pl.athlete_id = auth.uid() and pl.parent_id = p.id)
        )
    );
$$;

revoke execute on function pending_parent_link_names() from public, anon;
grant execute on function pending_parent_link_names() to authenticated;

comment on function pending_parent_link_names() is
  'Names/avatars of the counterparties on the caller''s PENDING parent_links rows, for the approve/deny UI. Replaces the approval-blind read that profiles_linked used to grant. Returns three non-sensitive columns only — never dob, plan, stripe_customer_id or scout_assessment.';


-- ============================================================
-- 126.3 — protect_profile_columns() was an allow-list of 2026-era threats.
--         It is now a deny-list of user-editable fields.
--
-- THE DEFECT
-- The trigger reset exactly seven columns for a non-admin, non-service_role
-- caller: is_admin, is_banned, verified_tier, stripe_customer_id,
-- identity_verified, trust_score, and a special case on plan. That list was
-- correct on the day it was written. profiles has since grown to roughly
-- thirty columns, and EVERY column added after that day has been silently
-- self-writable by any signed-in user with a one-line PostgREST PATCH,
-- because profiles_self grants UPDATE on the whole row and RLS in Postgres
-- is row-level, not column-level.
--
-- Three of those were confirmed exploitable and are not subtle:
--   * ai_unlimited      — the exact flag the Admin Panel uses to grant a
--                         user unmetered paid AI. Self-grantable.
--   * free_ai_lifetime_used — the never-resetting free budget from 068.
--                         Self-resettable to 0, forever.
--   * is_minor          — an ADULT could set this true. api/moderate.js
--                         applies its strictest rules to adult→minor
--                         contact based on the recipient's is_minor; an
--                         adult who flips their own flag is not protecting
--                         themselves, they are disabling the rule that
--                         protects children from them.
-- and the rest of the tail (scout_state, scout_assessment, scout_trial_used,
-- payment_past_due, parent_managed, pending_parent_email, ...) is the same
-- category of problem waiting for someone to look.
--
-- THE FIX: DEFAULT-DENY
-- The trigger no longer names the columns it protects. It introspects the
-- row itself — to_jsonb(old) yields exactly the table's current columns, so
-- there is no catalogue query to keep in sync and no way for a future
-- `alter table profiles add column` to escape it — and resets every column
-- back to its old value EXCEPT an explicit self-editable allow-list. A
-- column added tomorrow is protected tomorrow, with no migration.
--
-- HOW THE ALLOW-LIST WAS DERIVED (this is the part worth checking if
-- something breaks)
-- Every write to `profiles` that is performed on behalf of a normal user was
-- read out of the two real clients:
--
--   golsz-app.html  from("profiles").update({...}):
--     full_name, occupation      — ProfileEditor's save (line ~4514)
--     avatar_url                 — photo upload / remove (~4794, ~4814)
--     goal_text, goal_defined, goal_source, goal_updated_at
--                                — GoalCard save (~8151), with a PGRST204
--                                  fallback to the first two
--     onboarding_conversion_shown— dismissConversion() (~9847)
--     plan                       — self-downgrade to 'free' only (~1716)
--
--   api/scout.js  PROFILE_FIELD_MAP (the authoritative list of Scout-
--   writable fields) — its profiles-table entries are:
--     full_name (name), occupation, goal_text (goal)
--   all three already covered above. Every other PROFILE_FIELD_MAP entry
--   targets the athletes table, which this trigger does not govern.
--   (api/scout.js writes with the service-role key anyway, so it takes the
--   service_role exemption regardless — it is listed here because the brief
--   names it as the authoritative source, and because it confirms the
--   client-side list is complete rather than merely current.)
--
-- JUDGMENT CALLS, stated explicitly because a wrong DENY breaks the product
-- and a wrong ALLOW is a vulnerability:
--
--   passport_public — ALLOWED although nothing in golsz-app.html writes it
--     today (the live share flow is the revocable-token path from 078). It
--     is a user-facing privacy preference by construction (migration 047 is
--     literally "public passport opt-in") and get_public_passport() reads it
--     as the athlete's own consent. Denying a consent toggle its owner is
--     supposed to control is the wrong kind of mistake. Erring toward ALLOW
--     per the audit brief.
--
--   plan — ALLOWED into the trigger body, then immediately re-constrained by
--     the pre-existing downgrade-only rule below, which is preserved
--     byte-for-byte. Self-upgrade is still impossible; self-downgrade to
--     'free' still works. Removing it from the list entirely would have
--     broken Settings' "cancel my plan".
--
--   dob — DENIED. Nothing in either client updates profiles.dob after
--     signup; handle_new_user() sets it once, from the signup form, and it
--     is an INSERT so this BEFORE UPDATE trigger never sees it. dob drives
--     is_minor and therefore the whole age posture, so a self-service edit
--     path would be an age-misstatement path. If a "correct my date of
--     birth" flow is ever built, it should go through a SECURITY DEFINER RPC
--     with its own rules, not a raw PATCH — do not simply add 'dob' here.
--
--   role — DENIED. profiles.role is never written by the signup form or by
--     either client (CLAUDE.md: "role is never set from the signup form"),
--     so denying it costs nothing today and closes a self-elevation shape.
--
--   scout_state / scout_profile_ready / scout_profile_confirmed_at /
--   scout_assessment / scout_trial_started_at / scout_trial_used — DENIED.
--     These are Scout's own derived state; every legitimate writer is either
--     api/scout.js (service_role) or an admin RPC. See the note in 126.3b
--     about the one pair of RPCs that needed a route around this.
--
-- WHAT IS UNCHANGED
--   * The exemption set: auth.role() is null (SQL Editor / direct
--     connection), auth.role() = 'service_role', or is_admin().
--   * The plan → verified_tier derivation at the end, which deliberately
--     runs for EVERY caller including admins and the service role, so a plan
--     change from any source keeps the badge consistent.
-- ============================================================

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

  -- Runs for EVERY caller, including admins and the service role, exactly as
  -- before: verified_tier is derived from plan, never independent of it.
  if new.plan is distinct from old.plan then
    new.verified_tier := case new.plan when 'elite' then 'elite' when 'pro' then 'pro' else 'none' end;
  end if;

  return new;
end;
$$;

-- Re-assert the trigger binding. It already exists (migration 023) and this
-- is a no-op there, but it makes this file correct against a database where
-- the function exists and the trigger does not.
drop trigger if exists protect_profile_columns_trigger on profiles;
create trigger protect_profile_columns_trigger
  before update on profiles
  for each row execute function protect_profile_columns();


-- ============================================================
-- 126.3b — The one legitimate writer that default-deny would have broken.
--
-- reserve_trial_question() / release_trial_question() (migration 108) are
-- SECURITY DEFINER but are granted to `authenticated`, not service_role —
-- they are designed to be called by the athlete's own session — and they
-- write profiles.scout_trial_started_at and profiles.scout_trial_used.
--
-- Under 126.3's default-deny those two writes would be silently reverted:
-- the trial would never start and would never consume a message. It would
-- have failed quietly, which is the worst way for it to fail.
--
-- Note that this is LATENT today, not live: nothing in api/ or
-- golsz-app.html calls either function yet (grepped both — zero hits). The
-- trial is built in SQL and not yet wired to a client. That is exactly why
-- it needs fixing now, while it is cheap: the break would otherwise surface
-- weeks later, in a session that has no idea this migration happened.
--
-- WHY NOT JUST ALLOW-LIST scout_trial_used
-- Because then a client could PATCH it back to 0 and take the trial an
-- unlimited number of times — the same defect class 126.3 exists to close.
--
-- THE MECHANISM
-- A transaction-local GUC, set inside the function immediately around its
-- own write and cleared straight after. `set_config(..., true)` is
-- transaction-scoped, and PostgREST runs one request per transaction, so the
-- flag cannot survive into another statement. A client cannot set it: it is
-- not a `request.*` setting (the only namespace PostgREST populates from the
-- request), and set_config() lives in pg_catalog, which is not an exposed
-- schema, so it is not reachable as an RPC.
--
-- Both function bodies below are otherwise byte-identical to migration 108,
-- including the `p_user is distinct from auth.uid() and not is_admin()`
-- authorization check, the `for update` row lock, the expiry/exhaustion
-- branches and every key of the returned jsonb.
-- ============================================================

create or replace function reserve_trial_question(p_user uuid, p_total_limit int, p_trial_days int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_started timestamptz;
  v_used int;
  v_expires timestamptz;
begin
  -- Callers may only spend their own trial. Admins are allowed through for
  -- support/testing, matching every other reserve function here.
  if p_user is distinct from auth.uid() and not is_admin() then
    raise exception 'not authorized';
  end if;

  select scout_trial_started_at, coalesce(scout_trial_used, 0)
    into v_started, v_used
    from profiles where id = p_user for update;

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'no_profile');
  end if;

  if v_started is null then
    v_started := now();
    perform set_config('golsz.privileged_profile_write', 'on', true);
    update profiles set scout_trial_started_at = v_started where id = p_user;
    perform set_config('golsz.privileged_profile_write', 'off', true);
  end if;

  v_expires := v_started + make_interval(days => greatest(p_trial_days, 0));

  if now() > v_expires then
    return jsonb_build_object('allowed', false, 'reason', 'trial_expired',
      'started_at', v_started, 'expires_at', v_expires, 'used', v_used, 'total', p_total_limit);
  end if;

  if v_used >= p_total_limit then
    return jsonb_build_object('allowed', false, 'reason', 'trial_exhausted',
      'started_at', v_started, 'expires_at', v_expires, 'used', v_used, 'total', p_total_limit);
  end if;

  perform set_config('golsz.privileged_profile_write', 'on', true);
  update profiles set scout_trial_used = v_used + 1 where id = p_user;
  perform set_config('golsz.privileged_profile_write', 'off', true);

  return jsonb_build_object('allowed', true, 'reason', 'ok',
    'started_at', v_started, 'expires_at', v_expires,
    'used', v_used + 1, 'total', p_total_limit,
    'remaining', p_total_limit - (v_used + 1));
end;
$$;

create or replace function release_trial_question(p_user uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if p_user is distinct from auth.uid() and not is_admin() then
    raise exception 'not authorized';
  end if;
  perform set_config('golsz.privileged_profile_write', 'on', true);
  update profiles set scout_trial_used = greatest(coalesce(scout_trial_used, 0) - 1, 0)
   where id = p_user;
  perform set_config('golsz.privileged_profile_write', 'off', true);
end;
$$;

-- Grants restated exactly as migration 108 left them (create or replace
-- preserves the ACL, but restating makes this file self-contained).
revoke execute on function reserve_trial_question(uuid, int, int) from public, anon;
revoke execute on function release_trial_question(uuid) from public, anon;
grant execute on function reserve_trial_question(uuid, int, int) to authenticated;
grant execute on function release_trial_question(uuid) to authenticated;


-- ============================================================
-- 126.4 — THE MINOR-RESTRICTION GATE IS OFF. ON PURPOSE. PERMANENTLY.
--
-- ############################################################
-- ##  OWNER DECISION, 2026-08-12 — READ THIS BEFORE          ##
-- ##  "RESTORING" ANYTHING IN THIS SECTION.                  ##
-- ############################################################
--
-- Migration 066 redefined is_restricted_minor(p_user) as `select false`.
-- It described itself as temporary ("disable the gate itself for now",
-- "restoring real enforcement later ... is just reverting this one
-- function"). The audit asked whether to restore it. The owner has decided
-- NOT to. Minors are intentionally unrestricted at the database layer.
--
-- That decision is not what this section changes. What this section changes
-- is the LIE the schema was telling about it.
--
-- Since 066, eight separate objects have carried a predicate of the form
-- `not is_restricted_minor(...)`, each of which reads, to anyone auditing
-- this file, like a live child-safety control:
--
--     posts_write            policy   — "minors can't post"        (false)
--     athletes_read          policy   — "minors aren't discoverable" (false)
--     messages_write         policy   — "minors can't DM"          (false)
--     post_images_write      policy   — "minors can't upload"      (false)
--     public_profile_names   view     — "minors' names are hidden" (false)
--     search_players()       function — "minors aren't searchable" (false)
--     get_public_passport()  function — "minors' passports are private" (false)
--     get_public_passport_by_token()  — same                       (false)
--
-- Every one of those is dead weight that evaluates to `not false` = true.
-- A protection that does not exist is more dangerous than a protection that
-- was never claimed, because it stops anyone from asking the question. The
-- next person to audit this schema — or the next regulator, or the next
-- insurer — would have read eight controls and found zero.
--
-- So: each of those eight objects is redefined below WITHOUT the dead
-- predicate. Every OTHER predicate in each one is carried over verbatim —
-- is_banned, is_parent_of, is_admin, ownership, scout_visible, occupation
-- filters, visibility flags, the lot. Nothing else about who can see or do
-- what changes. Diff any of them against the current definition in
-- supabase-schema.sql and the only thing missing should be the
-- is_restricted_minor call.
--
-- is_restricted_minor() ITSELF IS DELIBERATELY KEPT, as a `select false`
-- stub. It is not dropped and must not be dropped: if any call site was
-- missed here, or lives in a file nobody has looked at, or is added later by
-- someone copying an old policy, it must still RESOLVE rather than error the
-- statement out. A stub that returns false is a safe landing; a missing
-- function is a broken query. It is marked `stable` in section 9 along with
-- the other helpers.
--
-- IF THE DECISION IS EVER REVERSED: restoring `select false` to the real
-- implementation is NOT sufficient any more, because the call sites are gone
-- from these eight objects. Re-adding the predicate to each of them is part
-- of the work. That is the honest cost of this decision and it is recorded
-- here so nobody is surprised by it.
-- ============================================================

comment on function is_restricted_minor(uuid) is
  'STUB — always false. Owner decision 2026-08-12: minors are intentionally unrestricted at the DB layer (see migration 066, made permanent by migration 126.4). Retained ONLY so that any call site missed by 126.4 still resolves instead of erroring. Do not treat a call to this function as a live safety control.';

-- ---- 4a) posts_write -------------------------------------------------
-- Was: (author_id = auth.uid() and not is_restricted_minor(auth.uid())
--       and not is_banned(auth.uid())) or is_parent_of(author_id)
-- Kept: own-authorship, the ban check, and the parent-posting-for-child path.
drop policy if exists posts_write on posts;
create policy posts_write on posts for insert with check (
  (author_id = auth.uid() and not is_banned(auth.uid()))
  or is_parent_of(author_id)
);

-- ---- 4b) messages_write ----------------------------------------------
-- Was: sender_id = auth.uid() and not is_restricted_minor(auth.uid())
--      and not is_restricted_minor(recipient_id)
--      and can_message(auth.uid(), recipient_id)
-- Kept: own-sendership and can_message(), which is the real gate (the
-- Instagram-style request/accept flow from 037, plus the block check).
drop policy if exists messages_write on messages;
create policy messages_write on messages for insert with check (
  sender_id = auth.uid()
  and can_message(auth.uid(), recipient_id)
);

-- ---- 4c) post_images_write -------------------------------------------
-- Was: bucket_id = 'post-images' and (storage.foldername(name))[1] =
--      auth.uid()::text and not is_restricted_minor(auth.uid())
-- Kept: the bucket scope and the own-uid path-prefix rule from migration
-- 016, which is what actually stops someone writing into another user's
-- folder. Bucket-level file_size_limit / allowed_mime_types (017) are
-- untouched.
drop policy if exists post_images_write on storage.objects;
create policy post_images_write on storage.objects for insert with check (
  bucket_id = 'post-images'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- ---- 4d) public_profile_names ----------------------------------------
-- Was: where not is_restricted_minor(id) or id = auth.uid()
--      or is_parent_of(id) or is_admin()
-- With the minor predicate removed the whole WHERE clause collapses — it
-- existed only to exempt yourself/your parent/an admin FROM that predicate.
-- The view's other 038 protections are what actually matter and both stand:
-- the `anon` grant stays revoked, and the column set stays the same four
-- non-sensitive columns. `drop view` then `create view` (not `create or
-- replace`) because the column list is being re-established identically and
-- a plain create is what 038 used.
drop view if exists public_profile_names;
create view public_profile_names as
select id, full_name, occupation, verified_tier, avatar_url
from profiles;

revoke all on public_profile_names from anon;
grant select on public_profile_names to authenticated;

-- ---- 4e) search_players() --------------------------------------------
-- Was: ... and not is_restricted_minor(a.id) ...
-- Kept verbatim: the scout_visible gate (100), the show_country/show_club
-- per-athlete blanking, the occupation filter, the ban check, every
-- parameter filter, the ordering and the `least(coalesce(p_limit,10),25)`
-- cap. Signature and column list unchanged.
create or replace function search_players(
  p_sport text default null,
  p_position text default null,
  p_country text default null,
  p_grad_year int default null,
  p_gender text default null,
  p_recruiting_status text default null,
  p_limit int default 10
)
returns table (
  id uuid, full_name text, sport text, "position" text, country text,
  club_name text, grad_year int, gender text, recruiting_status text
)
language sql security definer set search_path to 'public' as $$
  select p.id, p.full_name, a.sport, a.position,
         case when a.show_country then a.country else null end,
         case when a.show_club then a.club_name else null end,
         a.grad_year, a.gender, a.recruiting_status
  from athletes a
  join profiles p on p.id = a.id
  where a.sport is not null
    and a.scout_visible
    and (p.occupation is null or p.occupation = 'Player')
    and not is_banned(a.id)
    and (p_sport is null or a.sport ilike p_sport)
    and (p_position is null or a.position ilike '%' || p_position || '%')
    -- country filter must not leak an athlete who hid their country
    and (p_country is null or (a.show_country and a.country ilike p_country))
    and (p_grad_year is null or a.grad_year = p_grad_year)
    and (p_gender is null or a.gender = p_gender)
    and (p_recruiting_status is null or a.recruiting_status = p_recruiting_status)
  order by a.created_at desc nulls last
  limit least(coalesce(p_limit, 10), 25);
$$;

-- ---- 4f) get_public_passport() ---------------------------------------
-- Was: when p_user is null or is_restricted_minor(p_user) then null
-- Kept: the null-argument guard and — the one that matters — the
-- passport_public opt-in check, which is the athlete's own consent and is
-- the real access control on this function. Field list unchanged, including
-- identity_verified from 067.
create or replace function get_public_passport(p_user uuid)
returns jsonb language sql security definer set search_path to 'public' as $$
  select case
    when p_user is null then null
    when not coalesce((select passport_public from profiles where id = p_user), false) then null
    else (
      select jsonb_build_object(
        'full_name', p.full_name,
        'occupation', p.occupation,
        'verified_tier', p.verified_tier,
        'identity_verified', coalesce(p.identity_verified, false),
        'avatar_url', p.avatar_url,
        'sport', a.sport,
        'position', a.position,
        'club_name', a.club_name,
        'country', a.country,
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

-- ---- 4g) get_public_passport_by_token() ------------------------------
-- Was: if v_user is null or is_restricted_minor(v_user) then return null;
-- Kept: the token lookup, the `not revoked` check (078's whole point — a
-- revoked link must stop working), the last_accessed_at touch, and the same
-- field list.
create or replace function get_public_passport_by_token(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_user uuid;
begin
  select user_id into v_user from passport_share_tokens where token = p_token and not revoked;
  if v_user is null then return null; end if;
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
      'club_name', a.club_name,
      'country', a.country,
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

-- Both passport functions must stay reachable by a logged-out visitor —
-- that is the entire point of a shared passport link. Re-asserted here
-- because section 16 revokes anon EXECUTE broadly and these two are on its
-- skip-list; stating the grant in both places means neither can drift.
grant execute on function get_public_passport(uuid) to anon, authenticated;
grant execute on function get_public_passport_by_token(text) to anon, authenticated;

-- ---- 4h) athletes_read -----------------------------------------------
-- Deliberately NOT redefined here — it is rewritten in full in section 6,
-- which removes the same dead predicate along with its own changes. Doing it
-- twice would just mean two definitions of the same policy in one file, and
-- the second would win silently.


-- ============================================================
-- 126.5 — Like counts have been stuck at zero for everyone else's posts.
--
-- THE DEFECT
-- _post_likes_sync() is the AFTER INSERT/DELETE trigger on post_likes that
-- keeps posts.likes_count honest ("instead of trusting the client", as its
-- own comment says). It was declared `language plpgsql` with no `security
-- definer` — the only function in this entire schema without it.
--
-- So its `update posts set likes_count = ...` runs as the LIKER, and is
-- therefore filtered by the posts_update RLS policy, which only permits a
-- post's own author to update it. Result: liking your own post updates the
-- count; liking anyone else's updates zero rows. No error — RLS filters, it
-- does not raise — so the like row is inserted, the UI shows the like, and
-- the counter never moves. Every like on every post by anyone other than its
-- author has been silently dropped since the schema was written.
--
-- THE FIX
-- `security definer set search_path to 'public'`, matching every other
-- function in this codebase. The trigger binding is recreated too, so this
-- is correct on a database where the trigger was never created.
--
-- AND A BACKFILL, because the fix alone leaves the historical damage in
-- place: every existing likes_count is wrong and would stay wrong forever.
-- The statement below recomputes each post's count from the actual
-- post_likes rows. It is a one-off in intent but idempotent in fact — a
-- second run recomputes the same values — and the `where ... is distinct
-- from` guard means it only touches rows that are actually wrong.
-- ============================================================

create or replace function _post_likes_sync()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if (tg_op = 'INSERT') then
    update posts set likes_count = likes_count + 1 where id = new.post_id;
    return new;
  elsif (tg_op = 'DELETE') then
    update posts set likes_count = greatest(likes_count - 1, 0) where id = old.post_id;
    return old;
  end if;
  return null;
end $$;

drop trigger if exists post_likes_sync on post_likes;
create trigger post_likes_sync
  after insert or delete on post_likes
  for each row execute function _post_likes_sync();

-- Backfill. Truth is the post_likes table; likes_count is a cache of it.
-- LEFT JOIN so a post with zero likes is included and reset to 0 rather than
-- skipped (a post whose only likes were later unliked is wrong in the other
-- direction). posts has no other triggers, so this touches nothing else.
update posts p
   set likes_count = c.real_count
  from (
    select p2.id, count(l.post_id)::int as real_count
      from posts p2
      left join post_likes l on l.post_id = p2.id
     group by p2.id
  ) c
 where c.id = p.id
   and p.likes_count is distinct from c.real_count;


-- ============================================================
-- 126.6 — The athlete directory was readable logged-out, and ignored the
--         athlete's own "hide me" switch.
--
-- OWNER DECISION: "logged-in only + respect visibility flags." Columns are
-- deliberately NOT restricted — the owner considered and declined that.
--
-- THE DEFECT, TWO PARTS
-- 1. athletes_read had no `TO` clause. A policy with no role list applies to
--    PUBLIC, which includes `anon` — so the whole athlete directory (dob is
--    not on this table, but sport, position, club, country, grad_year, GPA,
--    height, weight, bio and recruiting status are) was readable by anyone
--    holding the public anon key, signed in or not. Note this is the same
--    class of finding as migration 038's public_profile_names leak, one
--    table over.
-- 2. Migration 100 added athletes.scout_visible so an athlete can take
--    themselves out of discovery, and wired it into search_players(). It was
--    never wired into the RLS policy — so "hide me" hid you from Scout's
--    search tool while leaving you fully readable by a direct
--    /rest/v1/athletes query. The switch did not do what its label says.
--
-- THE FIX
--   * `to authenticated` — anon loses the directory entirely.
--   * `and coalesce(scout_visible, true)` on the not-owner/not-admin branch,
--     so hiding yourself actually hides you, while you and an admin can
--     always still read your row (otherwise the Passport would go blank for
--     its own owner the moment they hid themselves).
--
-- WHY coalesce() DESPITE THE NOT NULL DEFAULT: migration 100 declares
-- `scout_visible boolean not null default true`, so on a correctly-migrated
-- database the coalesce never fires. It is kept as a fail-VISIBLE guard: if
-- this policy ever evaluates against a row where the column is somehow null,
-- `null` would make the whole AND null and the row would vanish from its own
-- owner's directory. Defaulting a null to `true` matches the column's own
-- declared default, so the failure mode is "still listed", not "disappeared".
--
-- ALSO REMOVED HERE: the dead `not is_restricted_minor(id)` predicate — see
-- section 4. The structure of the policy is deliberately unchanged: the new
-- scout_visible clause takes the exact structural place of the dead minor
-- clause, with the same `or id = auth.uid() or is_parent_of(id) or
-- is_admin()` exemptions, and the ban clause is carried over verbatim. So
-- the only behavioural differences from the policy as it stands today are
-- the two the owner asked for — anon loses access, and a hidden athlete is
-- hidden. In particular a parent is exempted from scout_visible (they must
-- see their linked child) but NOT from the ban check, which is exactly how
-- the original was written.
-- ============================================================

drop policy if exists athletes_read on athletes;
create policy athletes_read on athletes for select to authenticated using (
  -- Replaces `not is_restricted_minor(id) or ...` — same exemptions, live
  -- predicate. An athlete who hid themselves is hidden from everyone except
  -- themselves, their linked parent, and an admin.
  (coalesce(scout_visible, true) or id = auth.uid() or is_parent_of(id) or is_admin())
  -- Carried over verbatim from the current policy.
  and (not is_banned(id) or id = auth.uid() or is_admin())
);


-- ============================================================
-- 126.7 — search_events() leaked private events to Scout.
--
-- THE DEFECT
-- events.visibility ('public' | 'private') is the column behind the app's
-- personal "save this as an opportunity" list (migration 011) — a private
-- event is one user's own note-to-self, not a listing. The events_read RLS
-- policy enforces that correctly:
--
--     (visibility = 'public' or created_by = auth.uid() or is_admin())
--     and (not is_blocked or is_admin())
--
-- search_events() (055) is SECURITY DEFINER, which means it bypasses that
-- policy entirely, and it checks only `not e.is_blocked`. It never looked at
-- visibility. So Scout's DB-first event search — and anyone calling the RPC
-- directly, since PostgreSQL's default PUBLIC grant was still in place on
-- top of the explicit `authenticated` grant — could enumerate every private
-- event any user had ever saved: title, sport, location, level, date.
--
-- THE FIX
--   * `and e.visibility = 'public'` in the body. Deliberately NOT the full
--     events_read clause: this function is a SEARCH over public listings,
--     not a personal view, so "public only" is the right rule for it even
--     for the row's own owner. Their private events are still readable
--     through the normal events_read path.
--   * revoke EXECUTE from public and anon, keeping the explicit
--     `authenticated` grant from 055. `from public` is the operative half —
--     revoking from anon alone would do nothing (migration 102).
--
-- Signature, return columns, ordering and the 25-row cap are unchanged.
-- ============================================================

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
    and e.visibility = 'public'                          -- the fix
    and e.event_date >= coalesce(p_after_date, current_date)
    and (p_sport is null or e.sport ilike p_sport)
    and (p_location is null or e.location ilike '%' || p_location || '%')
    and (p_level is null or e.level ilike p_level)
  order by e.event_date asc
  limit least(coalesce(p_limit, 10), 25);
$$;

revoke execute on function search_events(text, text, text, date, int) from public, anon;
grant execute on function search_events(text, text, text, date, int) to authenticated;


-- ============================================================
-- 126.8 — A message recipient could rewrite the message they received.
--
-- THE DEFECT
-- messages_update exists for exactly one purpose: letting a recipient stamp
-- read_at on their own inbound message. But RLS is row-level, so
--
--     for update using (recipient_id = auth.uid())
--          with check (recipient_id = auth.uid())
--
-- permits a PATCH of ANY column on that row — including `body`. The
-- recipient of a message can rewrite what the sender said, keep the
-- sender_id and created_at intact, and then screenshot or report it. The
-- sender has no way to detect it and no record of the original. In a product
-- with a moderation queue, an appeals process and a trust score that both
-- feed off reported message content, that is an evidence-integrity problem,
-- not just a nuisance.
--
-- THE FIX
-- The same shape this codebase already uses twice — protect_profile_columns
-- (023) and protect_event_columns (023): a BEFORE UPDATE trigger that pins
-- the columns nobody may edit back to their previous values, exempting the
-- service role and direct SQL access.
--
-- Pinned: body, sender_id, recipient_id, created_at.
-- Left editable: read_at, which is the only reason this policy exists.
--
-- NOT exempted for is_admin(), unlike the profile/event equivalents: there
-- is no admin feature that edits message text, and an admin silently
-- rewriting a DM is the same integrity problem wearing a badge. Admins who
-- genuinely need to correct data still have SQL Editor access, which lands
-- in the `auth.role() is null` branch.
-- ============================================================

create or replace function protect_message_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  -- Direct SQL (auth.role() null) and the service role are exempt, matching
  -- protect_profile_columns / protect_event_columns.
  if auth.role() is null or auth.role() = 'service_role' then
    return new;
  end if;
  new.body         := old.body;
  new.sender_id    := old.sender_id;
  new.recipient_id := old.recipient_id;
  new.created_at   := old.created_at;
  return new;
end;
$$;

drop trigger if exists protect_message_columns_trigger on messages;
create trigger protect_message_columns_trigger
  before update on messages
  for each row execute function protect_message_columns();


-- ============================================================
-- 126.9 — The RLS helper functions were VOLATILE, and therefore re-ran per
--         row.
--
-- is_admin(), is_parent_of(), is_banned(), can_message() and
-- is_restricted_minor() are all `language sql` with no volatility marker.
-- PostgreSQL's default for a function with no marker is VOLATILE, which
-- tells the planner the result may change between calls within a single
-- statement — so it cannot hoist the call out of a scan and must re-evaluate
-- it for every candidate row.
--
-- These five appear in the USING/WITH CHECK clause of most policies in this
-- schema. is_admin() alone does a `select is_admin from profiles where id =
-- auth.uid()` — that is one extra index lookup per row scanned, on a policy
-- that gates a table scan. On a directory query that is the difference
-- between one lookup and one lookup per athlete.
--
-- All five are STABLE by nature: they read only committed table data and
-- auth.uid()/auth.role(), and cannot change within a single statement.
-- Marking them `stable` lets the planner evaluate them once. Bodies are
-- reproduced exactly as they stand today — this section changes volatility
-- and NOTHING else. Note in particular:
--   * is_parent_of() keeps its `approved_at is not null` requirement, which
--     is the migration-005-era compliance fix and must not be lost.
--   * can_message() is the migration-037 request/accept version (the
--     original follow-based one from 007 was superseded), including the
--     block check and both directions of the accepted/pending rules.
--   * is_restricted_minor() stays the `select false` stub — see section 4.
-- ============================================================

create or replace function is_admin()
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false);
$$;

create or replace function is_banned(p_user uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce((select is_banned from profiles where id = p_user), false);
$$;

create or replace function is_parent_of(child uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1 from parent_links
    where parent_id = auth.uid() and athlete_id = child and approved_at is not null
  );
$$;

create or replace function is_restricted_minor(p_user uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select false;
$$;

-- can_message()'s current body is long; rather than re-transcribe it and
-- risk dropping a clause, alter only the volatility marker in place. This is
-- exactly equivalent to a create-or-replace with `stable` added, and cannot
-- change the body by construction.
alter function can_message(uuid, uuid) stable;


-- ============================================================
-- 126.10 — Missing indexes on RLS-predicate and foreign-key columns.
--
-- An RLS predicate is not a filter applied after the fact — it is part of
-- the query, evaluated per candidate row. A policy like `user_id =
-- auth.uid()` on an unindexed column turns every read of that table into a
-- sequential scan, and the cost grows with the table rather than with the
-- caller's own row count. The same applies to a foreign key with no index:
-- Postgres does NOT create one automatically for the referencing side, so
-- every `on delete cascade`/`set null` from the parent has to seq-scan the
-- child.
--
-- Each column below was checked to exist before being listed here, and each
-- was confirmed to have no covering index — a column that is the LEADING
-- column of a primary key or an existing composite index is deliberately
-- absent from this list (e.g. follows.follower_id and blocks.blocker_id lead
-- their PKs and are already covered; it is the second column of each pair
-- that is not).
--
-- All `if not exists`, so re-running is free.
-- ============================================================

-- Composite PK (post_id, profile_id) covers post_id only.
create index if not exists post_likes_profile_idx        on post_likes (profile_id);
-- RLS: push_subscriptions_rw uses user_id = auth.uid().
create index if not exists push_subscriptions_user_idx   on push_subscriptions (user_id);
-- RLS: events_read / events ownership, plus the FK to profiles.
create index if not exists events_created_by_idx         on events (created_by);
-- RLS: posts_write / posts_delete author checks, plus the FK.
create index if not exists posts_author_idx              on posts (author_id);
-- RLS: athlete_schedule is owner-scoped by user_id.
create index if not exists athlete_schedule_user_idx     on athlete_schedule (user_id);
-- RLS: verification_requests_own_read uses user_id = auth.uid().
create index if not exists verification_requests_user_idx on verification_requests (user_id);
-- RLS: moderation_appeals_own_read uses user_id = auth.uid().
create index if not exists moderation_appeals_user_idx   on moderation_appeals (user_id);
-- FK + the insert-side policy predicate.
create index if not exists content_reports_reporter_idx  on content_reports (reporter_id);
-- RLS: post_reports_read uses reporter_id = auth.uid().
create index if not exists post_reports_reporter_idx     on post_reports (reporter_id);
-- FK to posts; also the natural "reports on this post" lookup.
create index if not exists post_reports_post_idx         on post_reports (post_id);
-- Second column of the (follower_id, followed_id) PK — follower counts.
create index if not exists follows_followed_idx          on follows (followed_id);
-- Second column of the (blocker_id, blocked_id) PK — can_message() reads
-- both directions, so the reverse lookup needs its own index.
create index if not exists blocks_blocked_idx            on blocks (blocked_id);
-- Second column of the (user_id, other_id) PK.
create index if not exists hidden_conversations_other_idx on hidden_conversations (other_id);
-- FK to profiles; also the admin queue's "everything by this author" view.
create index if not exists moderation_queue_author_idx   on moderation_queue (author_id);
-- FK to profiles; the Errors tab groups by user.
create index if not exists error_log_user_idx            on error_log (user_id);
-- FK to profiles; the audit log is read by admin.
create index if not exists admin_action_log_admin_idx    on admin_action_log (admin_id);


-- ============================================================
-- 126.11 — Deleting your account erased the abuse reports you filed.
--
-- THE DEFECT
-- content_reports.reporter_id, post_reports.reporter_id and
-- moderation_appeals.user_id were all `not null references profiles(id) on
-- delete cascade`. A profiles row is deleted when an account is deleted
-- (api/admin-user-action.js, and Supabase's own auth delete cascades into
-- profiles).
--
-- So: report someone, then delete your own account, and every report you
-- filed against them disappears. Worse than the lost evidence, the reported
-- account's trust score is recomputed from the remaining reports —
-- recompute_trust_score() counts them — so deleting the reporter's account
-- actively RAISES the reported user's trust score. A harasser with a burner
-- account has a working procedure for cleaning their record: get reported,
-- delete the reporter... or simply wait for a victim to leave the platform,
-- which is exactly what a harassed user does.
--
-- This codebase already knows the right answer. admin_action_log.admin_id,
-- moderation_queue.author_id, error_log.user_id and
-- moderation_appeals.reviewed_by all use `on delete set null` precisely so
-- the record outlives the actor. These three were the outliers.
--
-- THE FIX
-- Drop NOT NULL, swap CASCADE for SET NULL. An orphaned report becomes an
-- anonymous report rather than no report: the accusation, the reason, the
-- timestamp and the target all survive.
--
-- The constraints are dropped by looking them up in pg_constraint rather
-- than by assuming the default `<table>_<column>_fkey` name. A drop-if-
-- exists on a guessed name that is wrong would silently do nothing and then
-- the add would create a SECOND foreign key, leaving the original CASCADE in
-- force while the migration reported success. That failure mode is the whole
-- reason this is a loop.
--
-- Idempotent: the loop finds nothing on a second run, and the add is guarded
-- by its own name check.
-- ============================================================

do $$
declare
  spec record;
  con  record;
begin
  for spec in
    select * from (values
      ('content_reports',    'reporter_id'),
      ('post_reports',       'reporter_id'),
      ('moderation_appeals', 'user_id')
    ) as t(tbl, col)
  loop
    -- Table might not exist on a partially-migrated database; skip quietly.
    if to_regclass('public.' || spec.tbl) is null then
      raise notice 'migration 126.11: table % not present, skipped', spec.tbl;
      continue;
    end if;

    -- 1. Drop every FK currently defined on that single column, whatever it
    --    is called.
    for con in
      select c.conname
        from pg_constraint c
        join pg_class      r on r.oid = c.conrelid
        join pg_namespace  n on n.oid = r.relnamespace
       where n.nspname = 'public'
         and r.relname = spec.tbl
         and c.contype = 'f'
         and c.conkey = array[
               (select a.attnum from pg_attribute a
                 where a.attrelid = r.oid and a.attname = spec.col and not a.attisdropped)
             ]::smallint[]
    loop
      execute format('alter table public.%I drop constraint %I', spec.tbl, con.conname);
      raise notice 'migration 126.11: dropped % on %.%', con.conname, spec.tbl, spec.col;
    end loop;

    -- 2. The column has to be nullable for SET NULL to be legal at all.
    execute format('alter table public.%I alter column %I drop not null', spec.tbl, spec.col);

    -- 3. Re-add with SET NULL, under a deterministic name so a re-run is a
    --    clean no-op rather than a duplicate.
    execute format(
      'alter table public.%I add constraint %I foreign key (%I) references profiles(id) on delete set null',
      spec.tbl, spec.tbl || '_' || spec.col || '_fkey', spec.col
    );
  end loop;
end $$;

comment on column content_reports.reporter_id is
  'Nullable on purpose (migration 126.11): on delete set null, so a report survives the reporter deleting their account. A null reporter is an anonymous report, not a missing one.';
comment on column post_reports.reporter_id is
  'Nullable on purpose (migration 126.11): on delete set null — see content_reports.reporter_id.';
comment on column moderation_appeals.user_id is
  'Nullable on purpose (migration 126.11): on delete set null, so an appeal record outlives the account that filed it.';


-- ============================================================
-- 126.12 — clubs had no RLS at all.
--
-- THE DEFECT
-- `clubs` predates this migration history (it is in the "tables already
-- exist" list at the top of supabase-schema.sql). There is no `alter table
-- clubs enable row level security` anywhere in this repository, and no
-- policy for it anywhere either. The schema's own closing note says only
-- "clubs has no write policy at all (read-only to every client)" — which is
-- true about writes but says nothing about whether RLS is on, and if RLS is
-- off then reads are unrestricted to anyone with the anon key and writes
-- depend entirely on table-level GRANTs nobody in this repo has audited.
--
-- The exposure is genuinely low: clubs is an empty, read-only directory
-- table (CLAUDE.md: "a separate, empty, read-only directory table (no insert
-- policy)"; the UI writes free text to athletes.club_name instead). But
-- "there is no policy and we are not sure what the grants are" is not a
-- state a pre-launch database should be in for any table, and this is the
-- last one in that state.
--
-- THE FIX
-- Enable RLS and add one explicit read policy for `authenticated`. Writes
-- get no policy, which with RLS enabled means writes are denied to every
-- client role and remain service-role only — the same posture as
-- scout_model_config and plan_config.
--
-- Guarded by to_regclass so this file still runs cleanly against a database
-- where clubs happens not to exist. `enable row level security` is itself
-- idempotent (a no-op if already enabled), and the policy is dropped before
-- being created.
-- ============================================================

do $$
begin
  if to_regclass('public.clubs') is null then
    raise notice 'migration 126.12: clubs table not present, skipped';
    return;
  end if;

  execute 'alter table public.clubs enable row level security';

  execute 'drop policy if exists clubs_read on public.clubs';
  -- Signed-in read of the club directory. No insert/update/delete policy is
  -- created on purpose: with RLS enabled, the absence of a write policy
  -- denies writes to anon and authenticated outright. Directory content is
  -- maintained with the service-role key only.
  execute 'create policy clubs_read on public.clubs for select to authenticated using (true)';
end $$;


-- ============================================================
-- 126.14 — The Admin Panel's "Reset Scout Intelligence" button could not
--          possibly have worked.
--
-- THE DEFECT
-- golsz-app.html calls sb.rpc("reset_scout_intelligence", ...) from the
-- signed-in admin's session, which PostgREST executes as the `authenticated`
-- role. Migrations 107 and 108 both end with
--
--     revoke execute on function reset_scout_intelligence(uuid)
--       from public, anon, authenticated;
--
-- and neither ever grants it back. So the button has been returning a
-- permission error to every admin who has ever pressed it, since 107.
--
-- THE FIX
-- Grant EXECUTE to `authenticated`, exactly as migration 109 did for
-- admin_scout_debug() after the same mistake. This is safe because the
-- function's FIRST statement is `if not is_admin() then raise exception
-- 'not authorized'; end if` — admin-ness is profiles.is_admin, not a
-- database role, so every authenticated user may call it and only an admin
-- gets past line one. That two-layer arrangement is the established pattern
-- here (see migration 122's banner).
--
-- The revoke from public and anon is restated first, so this grant cannot be
-- read as widening anything beyond signed-in users.
-- ============================================================

revoke execute on function reset_scout_intelligence(uuid) from public, anon;
grant execute on function reset_scout_intelligence(uuid) to authenticated;


-- ============================================================
-- 126.15 — A child could name any account as their approved parent.
--
-- THE DEFECT
-- parent_links_approve is the policy that lets the CHILD side approve a
-- pending link (its comment notes parent_id is "deliberately excluded" from
-- the USING clause so the parent cannot self-approve). But its WITH CHECK
-- constrains athlete_id only:
--
--     for update using (athlete_id = auth.uid())
--          with check (athlete_id = auth.uid())
--
-- Row-level, again. The child may therefore UPDATE the row's parent_id to an
-- arbitrary account and set approved_at in the same statement — producing an
-- approved parent link to someone who never requested it and never consented
-- to it. is_parent_of() then returns true for that account, which grants it
-- read AND write access to the child's profile and athletes row via
-- profiles_self and athletes_rw. The child can also point athlete_id at
-- themselves from a row that was never theirs, subject to the USING clause.
--
-- THE FIX
-- The same trigger pattern as sections 3 and 8: pin parent_id and athlete_id
-- to their previous values for non-service-role callers, so approved_at (and
-- relationship, which is a descriptive label the requester supplies) are all
-- an UPDATE can actually move. Establishing WHO is linked stays entirely
-- with request_parent_link(); this policy only decides WHETHER that link is
-- approved, which is what it was always supposed to do.
--
-- The policy itself is intentionally left as-is — it is correct about who
-- may approve; it was just incomplete about what "approve" is allowed to
-- touch. That is a column concern, and columns are a trigger's job here.
-- ============================================================

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
  return new;
end;
$$;

drop trigger if exists protect_parent_link_columns_trigger on parent_links;
create trigger protect_parent_link_columns_trigger
  before update on parent_links
  for each row execute function protect_parent_link_columns();


-- ============================================================
-- 126.16 — SECURITY DEFINER functions still carried the default PUBLIC
--          EXECUTE grant. Including one with no gate at all.
--
--          *** THIS SECTION MUST RUN LAST IN THIS FILE. ***
--
-- THE DEFECT
-- PostgreSQL grants EXECUTE to the pseudo-role PUBLIC on every newly created
-- function, and `create or replace` preserves the ACL. Migration 102 fixed
-- three functions by hand; migration 122 generalised the fix across
-- `admin_*`. Neither covered the non-admin SECURITY DEFINER surface, which
-- is most of it.
--
-- A SECURITY DEFINER function runs as its owner and therefore bypasses RLS
-- completely. A PUBLIC grant on one is not a small thing — it is an
-- RLS-bypassing entry point reachable by anyone holding the public anon key.
-- The clearest case is search_players(): it has NO internal authorization
-- check of any kind, and it returns name, sport, position, country, club,
-- graduation year, gender and recruiting status for the athlete directory.
-- Unauthenticated enumeration of a directory of athletes — many of them
-- minors, given the product — one anon-key POST at a time. Section 6 has
-- just closed the equivalent hole on the athletes TABLE; leaving the RPC
-- open would have made that fix cosmetic.
--
-- THE FIX: A LOOP, NOT A LIST
-- Modelled on migration 122, for its stated reason: a hand-written list is
-- stale the day someone adds a function. This re-derives the set from
-- pg_proc, so re-running this migration after new SECURITY DEFINER functions
-- ship re-secures those too. It borrows 122's escaping discipline as well —
-- `escape '@'` rather than a backslash, because a backslash survives one
-- round of string-escaping and silently matches nothing, which is how 122's
-- first run reported success while securing zero functions.
--
-- WHY IT PRESERVES GRANTS INSTEAD OF RE-GRANTING A FIXED SET
-- 122 could safely `grant execute ... to authenticated` on everything it
-- touched, because everything it touched was an admin_* function the Admin
-- Panel calls. This loop touches EVERY SECURITY DEFINER function, and some
-- of them are deliberately NOT callable by authenticated —
-- reserve_scout_question and reserve_free_ai_question (section 1),
-- reserve_signup_attempt (074), recompute_trust_score (103),
-- merge_scout_context (050), supersede_scout_memory and
-- rebuild_platform_insights (102). Blanket-granting to authenticated would
-- undo every one of those locks in a single statement.
--
-- So instead: for each function, read whether `authenticated` and
-- `service_role` can execute it TODAY, revoke from public and anon, then
-- re-grant only to whichever of those two already had access. The net effect
-- is precisely "anon and PUBLIC lose EXECUTE; nothing else changes". This is
-- also why the section must run last — it reads the grant state that
-- sections 1 and 14 established.
--
-- Note the service_role half in particular: several functions here
-- (increment_scout_usage, record_scout_usage_cost, the reserve/release
-- pairs) are called by api/scout.js with SUPABASE_SERVICE_KEY and reach
-- Postgres as role `service_role`. Some of them have an explicit
-- service_role grant; others were relying on the PUBLIC default. Revoking
-- PUBLIC without re-granting would have broken Scout's metering outright.
-- That is the single most dangerous thing this section could get wrong, and
-- it is the reason for the has_function_privilege() capture.
--
-- THE SKIP-LIST — VERIFIED AGAINST THE CLIENT, NOT GUESSED
-- Three functions must remain anon-callable. Each was confirmed by finding
-- the call site in golsz-app.html and checking that it runs with no session:
--
--   get_public_passport(uuid)
--   get_public_passport_by_token(text)
--       PublicPassport's load effect (golsz-app.html ~4388) fires from the
--       ?public=<uid> / ?t=<token> share URL, which is the one screen that
--       exists specifically for a logged-out visitor. Breaking these breaks
--       every passport link ever shared. Both already carry an explicit
--       `grant execute ... to anon` (migrations 046 and 078), re-asserted in
--       section 4g.
--
--   log_client_error(text, jsonb, text)
--       The window 'error' / 'unhandledrejection' handlers (~10512). Its own
--       comment in golsz-app.html states it "is granted to anon as well as
--       authenticated, since a crash can happen before someone's even signed
--       in (e.g. on the signup screen)". Revoking anon here would blind the
--       Admin Panel's Errors tab to exactly the crashes that matter most —
--       the ones that stop a signup from completing.
--
-- Every other RPC golsz-app.html calls (the admin_* set, create/revoke
-- _passport_share_token, ensure_message_request, respond_to_message_request,
-- request_parent_link, record_activity_ping, log_admin_action,
-- resolve_error_log_item, resolve_moderation_item, set_athlete_context_field,
-- reset_scout_intelligence) is reached only from inside the authenticated
-- app shell, behind Root's session check. Those keep their `authenticated`
-- grant and lose only anon/PUBLIC.
--
-- The loop matches on `p.proname || '(' || arg types || ')'` via
-- oid::regprocedure, so the skip-list is matched on NAME only — an overload
-- of a skip-listed name would also be skipped. None of the three has an
-- overload today; if one is ever added, tighten this to full signatures.
-- ============================================================

do $$
declare
  fn record;
  v_authed  boolean;
  v_service boolean;
  touched int := 0;
  skipped int := 0;
  -- Must stay reachable with no session. See the banner above — every entry
  -- here was traced to a real pre-login call site in golsz-app.html.
  v_anon_ok constant text[] := array[
    'get_public_passport',
    'get_public_passport_by_token',
    'log_client_error'
  ];
begin
  for fn in
    select p.oid                 as oid,
           p.proname             as name,
           p.oid::regprocedure   as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosecdef
       -- Trigger functions are not callable over PostgREST at all, and
       -- PostgreSQL checks EXECUTE on a trigger function when the TRIGGER is
       -- CREATED, not when it fires. Touching their ACL could therefore only
       -- ever cause harm, never prevent it. Excluded.
       and p.prorettype <> 'trigger'::regtype
       -- Anything owned by an installed extension belongs to that extension,
       -- not to this schema. Re-granting an extension's own ACL is not this
       -- migration's business and could break the extension on upgrade.
       and not exists (
         select 1 from pg_depend d
          where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e'
       )
     order by p.proname
  loop
    if fn.name = any (v_anon_ok) then
      skipped := skipped + 1;
      continue;
    end if;

    -- Capture the status quo BEFORE revoking. has_function_privilege()
    -- accounts for privileges held via PUBLIC, which is exactly what has to
    -- be preserved for the roles that legitimately rely on it.
    v_authed  := has_function_privilege('authenticated', fn.oid, 'execute');
    v_service := has_function_privilege('service_role',  fn.oid, 'execute');

    execute format('revoke execute on function %s from public', fn.sig);
    execute format('revoke execute on function %s from anon',   fn.sig);

    if v_authed then
      execute format('grant execute on function %s to authenticated', fn.sig);
    end if;
    if v_service then
      execute format('grant execute on function %s to service_role', fn.sig);
    end if;

    touched := touched + 1;
  end loop;

  raise notice 'migration 126.16: secured % security-definer functions, skipped % anon-callable', touched, skipped;
end $$;


-- ============================================================
-- 126 — Verification queries. Run these after the migration, not as part of
-- it. Each one should return the stated result.
-- ============================================================
--
-- 1) Usage limits actually deny. As service_role, on a throwaway user id:
--      select reserve_scout_question('<uuid>', 2);  -- allowed true,  used 1
--      select reserve_scout_question('<uuid>', 2);  -- allowed true,  used 2
--      select reserve_scout_question('<uuid>', 2);  -- allowed FALSE, used 3
--      delete from scout_daily_usage where user_id = '<uuid>';
--
-- 2) Profile leak closed. As user A, with only a PENDING link to user B:
--      select count(*) from profiles where id = '<B>';   -- expected 0
--      select * from pending_parent_link_names();        -- B's name only
--
-- 3) Privileged columns denied. As a normal signed-in user:
--      update profiles set ai_unlimited = true where id = auth.uid();
--      select ai_unlimited from profiles where id = auth.uid();  -- false
--      update profiles set full_name = 'New Name' where id = auth.uid();
--      select full_name from profiles where id = auth.uid();     -- 'New Name'
--
-- 4) No live call sites left. The CTE must be MATERIALIZED: without the
--    fence the planner is free to evaluate pg_get_functiondef() before the
--    nspname filter, and it raises on aggregates in pg_catalog, so the naive
--    one-statement version of this query errors out instead of answering.
--      with fns as materialized (
--        select p.oid, p.proname from pg_proc p
--          join pg_namespace n on n.oid = p.pronamespace
--         where n.nspname = 'public' and p.prokind = 'f'
--           and p.proname <> 'is_restricted_minor'
--      )
--      select proname from fns
--       where pg_get_functiondef(oid) like '%is@_restricted@_minor(%' escape '@';
--      -- expected: 0 rows
--      select polname from pg_policy
--       where coalesce(pg_get_expr(polqual, polrelid), '') like '%is_restricted_minor%'
--          or coalesce(pg_get_expr(polwithcheck, polrelid), '') like '%is_restricted_minor%';
--      -- expected: 0 rows
--      select pg_get_viewdef('public_profile_names'::regclass) like '%is_restricted_minor%';
--      -- expected: f
--
-- 5) Like counts correct:
--      select count(*) from posts p
--       where p.likes_count <> (select count(*) from post_likes l where l.post_id = p.id);
--      -- expected: 0
--
-- 6) athletes directory closed to anon: a plain curl with the anon key and
--    no Authorization header against /rest/v1/athletes?select=id returns [].
--
-- 7) Private events invisible to search:
--      select count(*) from search_events() s
--        join events e on e.id = s.id where e.visibility <> 'public';
--      -- expected: 0
--
-- 9) Helpers are stable:
--      select proname, provolatile from pg_proc
--       where proname in ('is_admin','is_parent_of','is_banned','can_message','is_restricted_minor');
--      -- expected: provolatile = 's' for all five
--
-- 16) Anon surface is exactly the skip-list:
--      select p.oid::regprocedure from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public' and p.prosecdef
--         and has_function_privilege('anon', p.oid, 'execute')
--       order by 1;
--      -- expected: get_public_passport, get_public_passport_by_token,
--      --           log_client_error, and nothing else.
--
-- 17) No secret left in the repo — grep for the old literal (it is
--     deliberately not reproduced here) and expect no matches:
--      grep -rn "x-webhook-secret" . | grep -v REPLACE_WITH_SUPABASE_WEBHOOK_SECRET
--      -- expected: no matches
--     Then ROTATE the value in Vercel and re-run migration 026 with the new
--     one. This migration cannot do that, and removing the literal from the
--     working tree does NOT un-leak it — git history still has it.
-- ============================================================
