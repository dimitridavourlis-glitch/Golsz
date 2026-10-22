-- ============================================================
-- 163 — Remember a plan that arrived before the customer was linked.
--
-- APPLIED to production 2026-10-22 (written the same day), in the Supabase SQL Editor.
-- Verified afterwards: the table exists, RLS is on, 0 policies, and neither anon nor
-- authenticated holds select or insert on it.
--
-- WHY. Stripe sends customer.subscription.created and
-- checkout.session.completed as two events with NO guaranteed order. Only the
-- checkout event carries our profile id (client_reference_id), so only it can
-- link a Stripe customer to a profile; only the subscription event reliably
-- carries the Price, and so the plan. If the subscription event lands first
-- its profile update matches nobody, the handler answers 500, and the paying
-- athlete stays on Free until Stripe's retry. This app holds no Stripe secret
-- key, so it cannot ask Stripe for the plan when the checkout event arrives.
--
-- WHAT IT DOES. One small table, written ONLY by the service role from
-- api/stripe-webhook.js: when a subscription event cannot find its customer,
-- the plan is stashed here (still answering 500, so Stripe keeps retrying and
-- the failure stays loud). When the checkout event then links the customer, the
-- stashed plan is applied at once and the row is deleted.
--
-- NO POLICIES ON PURPOSE. Row level security is on with no policy, so anon and
-- authenticated users can read and write nothing; the service role bypasses it.
-- A plan is a paid entitlement, so no client path may ever touch this table.
--
-- Safe to run before or after the code ships: until it exists the handler's
-- writes to it fail quietly and behaviour is exactly what it was.
--
-- HOW TO APPLY. Paste into the Supabase SQL Editor and run once. Idempotent.
-- ============================================================

begin;

create table if not exists stripe_pending_plans (
  customer_id text primary key,
  plan        text not null check (plan in ('starter', 'pro', 'elite')),
  created_at  timestamptz not null default now()
);

alter table stripe_pending_plans enable row level security;

revoke all on stripe_pending_plans from anon, authenticated;

comment on table stripe_pending_plans is
  'A paid plan seen on a subscription event before its Stripe customer was linked to a profile (163). Service role only; no policies. Applied and deleted by api/stripe-webhook.js when the checkout event links the customer.';

commit;


-- ============================================================
-- 163 — Verification. Run these AFTER the migration, separately.
-- ============================================================
--   select relrowsecurity from pg_class where oid = 'public.stripe_pending_plans'::regclass;
--   -- expected: true
--   select count(*) from pg_policy where polrelid = 'public.stripe_pending_plans'::regclass;
--   -- expected: 0   (no policies: only the service role can touch it)
--   select has_table_privilege('authenticated', 'public.stripe_pending_plans', 'select');
--   -- expected: false
-- ============================================================
