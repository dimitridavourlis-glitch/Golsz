-- ============================================================
-- 165 — outreach_targets: length limits + updated_at (database backstop)
-- Mirrors TARGET_LIMITS in golsz-app.html so a direct REST call cannot store a
-- blank name or a huge text, and makes updated_at move on every update.
-- Additive only. The app does NOT depend on this file: targetFieldErrors()
-- already enforces the same caps client-side. No RLS policy is touched.
-- Constraints are NOT VALID: they check new and changed rows only, so rows
-- that already exist cannot block this run.
--
-- PRE-RUN CHECK (rows that break a rule; they stay, but can't be re-saved
-- unchanged-over-limit until shortened):
--   select count(*) from outreach_targets
--   where char_length(btrim(name)) = 0 or char_length(name) > 120
--      or char_length(contact_name) > 120 or char_length(contact_email) > 200
--      or char_length(notes) > 2000 or char_length(fit_reasoning) > 2000
--      or char_length(draft_email) > 10000;
--
-- POST-RUN CHECK:
--   select conname, convalidated from pg_constraint
--   where conrelid = 'outreach_targets'::regclass and conname like 'outreach_targets_%_len'
--      or conname = 'outreach_targets_name_not_blank';   -- 6 rows, convalidated = false
--   select tgname from pg_trigger
--   where tgrelid = 'outreach_targets'::regclass and tgname = 'outreach_targets_touch_updated_at';
--
-- ROLLBACK (exact SQL, safe to run any time):
--   alter table outreach_targets drop constraint if exists outreach_targets_name_not_blank;
--   alter table outreach_targets drop constraint if exists outreach_targets_name_len;
--   alter table outreach_targets drop constraint if exists outreach_targets_contact_name_len;
--   alter table outreach_targets drop constraint if exists outreach_targets_contact_email_len;
--   alter table outreach_targets drop constraint if exists outreach_targets_notes_len;
--   alter table outreach_targets drop constraint if exists outreach_targets_fit_reasoning_len;
--   alter table outreach_targets drop constraint if exists outreach_targets_draft_email_len;
--   drop trigger if exists outreach_targets_touch_updated_at on outreach_targets;
--   drop function if exists outreach_targets_touch_updated_at();
-- ============================================================

alter table outreach_targets drop constraint if exists outreach_targets_name_not_blank;
alter table outreach_targets add constraint outreach_targets_name_not_blank
  check (char_length(btrim(name)) > 0) not valid;

alter table outreach_targets drop constraint if exists outreach_targets_name_len;
alter table outreach_targets add constraint outreach_targets_name_len
  check (char_length(name) <= 120) not valid;

alter table outreach_targets drop constraint if exists outreach_targets_contact_name_len;
alter table outreach_targets add constraint outreach_targets_contact_name_len
  check (char_length(contact_name) <= 120) not valid;

alter table outreach_targets drop constraint if exists outreach_targets_contact_email_len;
alter table outreach_targets add constraint outreach_targets_contact_email_len
  check (char_length(contact_email) <= 200) not valid;

alter table outreach_targets drop constraint if exists outreach_targets_notes_len;
alter table outreach_targets add constraint outreach_targets_notes_len
  check (char_length(notes) <= 2000) not valid;

alter table outreach_targets drop constraint if exists outreach_targets_fit_reasoning_len;
alter table outreach_targets add constraint outreach_targets_fit_reasoning_len
  check (char_length(fit_reasoning) <= 2000) not valid;

alter table outreach_targets drop constraint if exists outreach_targets_draft_email_len;
alter table outreach_targets add constraint outreach_targets_draft_email_len
  check (char_length(draft_email) <= 10000) not valid;

create or replace function outreach_targets_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists outreach_targets_touch_updated_at on outreach_targets;
create trigger outreach_targets_touch_updated_at
  before update on outreach_targets
  for each row execute function outreach_targets_touch_updated_at();
