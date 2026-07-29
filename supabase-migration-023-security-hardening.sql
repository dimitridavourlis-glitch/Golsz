-- ============================================================
-- 023 — Security hardening: close the plan/admin self-escalation gap
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 +
-- 012 + 013 + 014 + 015 + 016 + 017 + 018 + 019 + 020 + 021 + 022.
--
-- Found during a security review: RLS in this project is documented (see
-- CLAUDE.md's warning on profiles_admin_write) as ROW-level, not COLUMN-
-- level — a policy that allows "you can update your own row" does not by
-- itself stop you from setting *any* column on that row, including ones
-- that were only ever meant to change through payment (plan), admin action
-- (is_admin, is_banned), or the Stripe webhook (stripe_customer_id).
-- profiles_self (an undocumented base policy predating this file's
-- history — see the file-level warning above) grants exactly that kind of
-- broad self-row UPDATE, and golsz-app.html itself already relies on it for
-- a legitimate case (Settings' "switch to Starter" downgrade,
-- `sb.from("profiles").update({ plan: "starter" })`). Without a column-
-- aware guard, the exact same client call with `plan: "elite"` instead
-- would work too — a real, live payment-bypass and privilege-escalation
-- path, not a theoretical one.
--
-- RLS can't easily express "this column only, unless X" on its own (a
-- WITH CHECK clause only sees the new row, not a column-by-column diff
-- against the old one), so this uses a BEFORE UPDATE trigger instead —
-- the standard Postgres way to enforce field-level write rules. The
-- trigger:
--   - Lets service_role (the Stripe webhook, called with
--     SUPABASE_SERVICE_KEY) through untouched — it's already fully
--     trusted server-side and never subject to RLS restrictions anyway.
--   - Lets anything with NO api/PostgREST role context through untouched
--     (auth.role() is null) — i.e. direct SQL, like the Supabase SQL
--     Editor. This matters because bootstrapping the very first admin
--     account is documented (CLAUDE.md) as "flip your own
--     profiles.is_admin to true once via SQL" — a trigger that didn't
--     account for this would silently undo that.
--   - Lets an existing admin (is_admin() true) change anything, on any
--     row — this is exactly what the admin panel's Users tab already
--     does (make/revoke admin, override plan, ban), unaffected.
--   - Otherwise (a plain signed-in user, not an admin): is_admin,
--     is_banned, and stripe_customer_id are always reset back to their
--     prior value; plan may only ever change *to* 'starter' (the
--     legitimate self-downgrade), never to 'pro'/'elite'.
--
-- A parallel gap existed on events.is_blocked: events_update's RLS lets
-- an event's own creator update any column on their event (needed for
-- editing title/location/etc.), which meant a creator could silently
-- un-block their own admin-blocked listing just by setting is_blocked
-- back to false themselves. Same trigger pattern, scoped to that one
-- column.
--
-- Also: increment_scout_usage(p_user uuid) never checked that the caller
-- IS p_user — it's meant to only ever be called server-side (api/scout.js,
-- with the service-role key, metering the real signed-in caller it just
-- verified), but nothing stopped any authenticated client from calling it
-- directly via supabase.rpc() with an arbitrary p_user, artificially
-- inflating a *different* user's daily usage count and locking them out
-- of free-tier Scout early. Restricting EXECUTE to service_role only
-- closes that without changing its behavior for the one caller that's
-- supposed to use it.
-- ============================================================

create or replace function protect_profile_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.role() is null or auth.role() = 'service_role' or is_admin() then
    return new;
  end if;
  new.is_admin := old.is_admin;
  new.is_banned := old.is_banned;
  new.stripe_customer_id := old.stripe_customer_id;
  if new.plan is distinct from old.plan and new.plan <> 'starter' then
    new.plan := old.plan;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_columns_trigger on profiles;
create trigger protect_profile_columns_trigger
  before update on profiles
  for each row execute function protect_profile_columns();

create or replace function protect_event_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.role() is null or auth.role() = 'service_role' or is_admin() then
    return new;
  end if;
  new.is_blocked := old.is_blocked;
  return new;
end;
$$;

drop trigger if exists protect_event_columns_trigger on events;
create trigger protect_event_columns_trigger
  before update on events
  for each row execute function protect_event_columns();

-- Supabase grants EXECUTE on every new public-schema function directly to
-- both anon and authenticated by default (not merely inherited through the
-- "public" pseudo-role) — revoking only from public/authenticated leaves
-- the anon grant untouched, confirmed live when this was first applied
-- (the anon key could still call it after that revoke). All three have to
-- be revoked explicitly.
revoke execute on function increment_scout_usage(uuid) from anon;
revoke execute on function increment_scout_usage(uuid) from authenticated;
revoke execute on function increment_scout_usage(uuid) from public;
grant execute on function increment_scout_usage(uuid) to service_role;

-- ============================================================
-- Done.
-- ============================================================
