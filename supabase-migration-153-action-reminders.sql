-- ============================================================
-- 153 — athlete_actions.last_reminded_at: so a step is nudged ONCE
--
-- *** APPLIED 2026-10-14. ***
--
-- WHY. Nothing in GOLSZ tells an athlete a step is due. The plan sits there,
-- the date passes, and the first they hear of it is the word "overdue" next
-- time they happen to open the app. The brief's loop asks the product to help
-- them ACT, and a plan that never speaks cannot.
--
-- One column, and the pattern is already proven: outreach_targets.last_reminded_at
-- (migration 079) is how the existing daily cron avoids re-nudging the same
-- target every morning. This is the same column on the same cadence, and it
-- goes into the SAME cron — api/target-followup-reminders.js, "0 13 * * *" in
-- vercel.json — because Vercel's function budget is full and a reminder does
-- not deserve a new route.
--
-- THE RULE THIS MUST NOT BREAK. GOLSZ does not call an athlete late on a date
-- it chose for them. due_src marks a date that came from Scout or from tapping
-- Retest; one tap on a confirm card is consent to a plan, not consent to
-- twelve individual deadlines. The client has enforced that since
-- suggestedDate() and every punitive surface asks it first. A reminder is the
-- most punitive surface there is — it arrives uninvited on their phone — so
-- the cron only ever nudges a step whose date the athlete set themselves,
-- which is due_src IS NULL. Enforced in the query, and asserted in
-- tests/test_action_reminders.cjs.
--
-- NULL means never reminded. It is never backfilled: an existing overdue step
-- must be eligible for its first nudge, not treated as already handled.
-- ============================================================

alter table public.athlete_actions
  add column if not exists last_reminded_at timestamptz;

-- The cron reads open, dated, athlete-chosen steps that have not been nudged.
-- Partial so it stays small: only open rows with a date can ever match.
create index if not exists athlete_actions_reminder_idx
  on public.athlete_actions (due_on, last_reminded_at)
  where status = 'open' and due_on is not null and due_src is null;

comment on column public.athlete_actions.last_reminded_at is
  'When this step was last pushed to the athlete. NULL means never. Never backfilled — an existing overdue step deserves its first nudge. Only steps with due_src IS NULL are ever reminded: GOLSZ does not call an athlete late on a date it chose for them.';

-- ============================================================
-- VERIFY AFTER APPLYING
--   select count(*) from information_schema.columns
--     where table_name = 'athlete_actions' and column_name = 'last_reminded_at';
--   -- expect 1
--   select count(*) from athlete_actions where last_reminded_at is not null;
--   -- expect 0 — nothing is backfilled
--   select indexname from pg_indexes where indexname = 'athlete_actions_reminder_idx';
--   -- expect one row
-- ============================================================
