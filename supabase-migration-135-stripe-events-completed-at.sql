-- ============================================================
-- 135) The Stripe replay guard becomes two-phase.
--
-- THE BUG THIS FIXES, in the order it happens:
--   1. An athlete pays. customer.subscription.created arrives.
--   2. claimStripeEvent() INSERTs the event id — the mutex is taken.
--   3. patchProfile() hits a Supabase 500, or the function is killed at its
--      duration cap. The handler returns 500.
--   4. Stripe retries, correctly.
--   5. The retry calls claimStripeEvent() FIRST. The row is already there,
--      so it returns "duplicate", and the handler answers 200 with
--      {received:true, duplicate:true} and applies nothing.
--   6. Stripe marks the event delivered and never retries again.
--
-- The athlete has paid and stays on 'free', permanently. The only trace is
-- a log line reading "stripe event already processed, replay ignored",
-- which is indistinguishable from a genuine replay.
--
-- The claim was recording "I have seen this event", and the handler was
-- reading it as "I have applied this event". Those are different facts and
-- the gap between them is exactly where a paid upgrade can fall.
--
-- completed_at closes it: the INSERT still takes the mutex, and a second
-- column records that the work finished. A duplicate whose completed_at is
-- NULL is an interrupted attempt to re-run, not a replay to ignore.
--
-- Backfill: existing rows are stamped as completed. Every row written
-- before this migration comes from a delivery that reached the end of the
-- handler (the old code had no other way to write one), so treating them as
-- finished is accurate rather than convenient.
-- ============================================================

alter table stripe_events add column if not exists completed_at timestamptz;

update stripe_events set completed_at = received_at where completed_at is null;

-- An operator looking for stuck deliveries wants this query to be cheap.
create index if not exists stripe_events_incomplete_idx
  on stripe_events (received_at) where completed_at is null;

comment on column stripe_events.completed_at is
  'Set by api/stripe-webhook.js after the event has been APPLIED. A row with completed_at null is a delivery that was claimed and then failed or was killed mid-handler: a Stripe retry of that event must re-process it, not be dismissed as a replay. See migration 135.';
