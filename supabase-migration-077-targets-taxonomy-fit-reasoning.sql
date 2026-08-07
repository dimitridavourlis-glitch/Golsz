-- ============================================================
-- 077 — Fix Targets status taxonomy + add fit_reasoning (brief §8)
-- §8 lists the exact pipeline: researching, preparing, contacted,
-- responded, follow-up, opportunity/offer. The original build (072) had
-- researching/contacted/responded/follow_up/closed — missing "preparing"
-- and using "closed" instead of "opportunity". No live rows exist yet
-- (checked before writing this), so a straight constraint swap is safe —
-- no data migration needed.
-- fit_reasoning is new: §8's "fit reasoning" — why this target is a good
-- fit for the athlete, distinct from `notes` (the athlete's own working
-- notes) — this is meant to eventually be filled by Scout (task: wire
-- Scout persistent actions), so it's a separate column from day one.
-- ============================================================

alter table outreach_targets add column if not exists fit_reasoning text;

alter table outreach_targets drop constraint if exists outreach_targets_status_check;
alter table outreach_targets add constraint outreach_targets_status_check
  check (status in ('researching', 'preparing', 'contacted', 'responded', 'follow_up', 'opportunity'));
