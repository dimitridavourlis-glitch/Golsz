-- ============================================================
-- 079 — Target follow-up reminders (brief §14, task: "follow-up/reminder
-- system for targets using existing push infrastructure")
-- last_reminded_at tracks the last time a stale-target push reminder was
-- sent, so api/target-followup-reminders.js (Vercel Cron, see vercel.json)
-- never re-notifies the same target every single day — only once it's
-- been stale (no status change) for a fresh reminder interval again.
-- ============================================================

alter table outreach_targets add column if not exists last_reminded_at timestamptz;
