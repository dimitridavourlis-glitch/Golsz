-- ============================================================
-- 164 — Show an athlete when their plan renews or ends.
--
-- APPLIED to production 2026-10-22 (written the same day), in the Supabase SQL Editor.
-- Verified afterwards: current_period_end is a nullable timestamptz, cancel_at_period_end
-- is a boolean not null default false, and no profile was flagged as cancelling.
--
-- WHY. Settings showed a plan name and nothing else: no renewal date, no
-- "cancels on ..." after a cancellation in Stripe's portal, so a cancelled
-- athlete could not see when access ends. And account deletion was blocked for
-- anyone with a paid plan and a Stripe customer, including someone who had
-- already cancelled and was only waiting out the period they paid for.
--
-- WHAT IT DOES. Two columns on profiles, written ONLY by the Stripe webhook
-- (service role), mirrored from customer.subscription.created / updated:
--   current_period_end    when the current paid period ends (a renewal date,
--                         or the end of access if cancel_at_period_end)
--   cancel_at_period_end  the subscription will not renew
--
-- THEY ARE NOT SELF-EDITABLE. protect_profile_columns() is default-deny: any
-- column not on its allowlist is pinned for a normal user, and these are not on
-- it. An athlete cannot mark their own subscription as cancelling.
--
-- Safe to run before or after the code: the webhook writes them as a separate
-- best-effort update, the Settings screen reads them in a query of their own,
-- and account deletion falls back to the old rule when they do not exist yet.
--
-- HOW TO APPLY. Paste into the Supabase SQL Editor and run once. Idempotent.
-- ============================================================

begin;

alter table profiles add column if not exists current_period_end timestamptz;
alter table profiles add column if not exists cancel_at_period_end boolean not null default false;

comment on column profiles.current_period_end is
  'End of the current paid period, mirrored from Stripe by api/stripe-webhook.js (164). Service role writes it; protect_profile_columns() pins it for everyone else.';
comment on column profiles.cancel_at_period_end is
  'True when the Stripe subscription will not renew (164). Service role writes it; pinned for everyone else. Lets an athlete who has cancelled delete their account.';

commit;


-- ============================================================
-- 164 — Verification. Run these AFTER the migration, separately.
-- ============================================================
--   select column_name, data_type, is_nullable, column_default
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'profiles'
--      and column_name in ('current_period_end', 'cancel_at_period_end');
--   -- expected: timestamptz nullable; boolean not null default false
--   select count(*) from profiles where cancel_at_period_end;
--   -- expected: 0 until a subscription event says otherwise
-- ============================================================
