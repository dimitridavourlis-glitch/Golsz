-- ============================================================
-- 081 — Stripe payment-past-due flag (corrected pre-launch directive §4)
-- api/stripe-webhook.js previously only handled checkout.session.completed
-- and customer.subscription.deleted, silently ignoring invoice.payment_failed
-- and customer.subscription.updated entirely — a failed renewal charge left
-- a paid profile row completely unchanged (Stripe would keep retrying for
-- days with the account showing nothing amiss anywhere in GOLSZ).
--
-- payment_past_due is a soft flag, not a plan downgrade — Stripe's own
-- Smart Retries already re-attempts a failed invoice several times before
-- giving up, and giving up is what customer.subscription.deleted (already
-- handled) or a canceled/unpaid customer.subscription.updated event is for.
-- Cutting access on the very first failed charge would punish a expired
-- card that gets updated the same day. The flag exists so the client can
-- show a "update your payment method" notice and Admin can see who's at
-- risk, while access stays intact until Stripe actually cancels/unpays the
-- subscription. Set true on invoice.payment_failed; cleared back to false
-- the moment customer.subscription.updated reports status "active" again
-- (covers a successful retry) or the subscription is deleted (profile goes
-- to free anyway, so the flag is moot but cleared for cleanliness).
-- ============================================================

alter table profiles add column if not exists payment_past_due boolean not null default false;

-- Done.
-- ============================================================
