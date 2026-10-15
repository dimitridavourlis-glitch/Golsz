-- ============================================================
-- 150 — availability: the trigger the brief's rerouting hangs on
--
-- *** APPLIED 2026-10-14. Verified: 4 columns, 0 rows with a status set
--     (nothing backfilled), both CHECK constraints live, and
--     athlete_outcomes_outcome_type_check extended to accept
--     availability_changed. ***
--
-- WHY THIS IS NEEDED. The master brief asks that GOLSZ reroute like GPS when
-- circumstances change, and gives injury as the worked example: Recovery ->
-- Rehab -> Return to Play -> Retest -> Resume Development. It also asks that
-- Scout receive "injury/availability status" as structured context.
--
-- GOLSZ has no concept of availability anywhere today. Verified before writing
-- this: zero columns across every migration, zero references in the client.
-- Without it, "the athlete is injured" is something they can only type into a
-- chat, so nothing can route on it and Scout re-learns it every conversation.
--
-- WHAT THIS DELIBERATELY DOES NOT DO:
--
--   * It does not model a diagnosis, a body part, or a prognosis. GOLSZ is not
--     a medical system and must not look like one. 'out' and 'limited' are
--     what an athlete can honestly self-report and what a pathway can route on.
--   * It does not store an expected return date as a fact. expected_return is
--     the ATHLETE'S OWN estimate and the column name says so; nothing may
--     render it as a clinical prediction.
--   * It adds NO history table. athlete_outcomes (148) is already append-only,
--     dated, RLS'd and has zero writers — a reroute writes there, so pathway
--     history is never destroyed, which is the brief's explicit rule. This
--     migration only adds the outcome_type values that reroute needs.
--
-- NULL means NOT RECORDED and must never be backfilled to 'available'. An
-- athlete who has never answered is not an athlete who said they are fit;
-- that is the same rule 114 and 142 set for benchmark provenance.
-- ============================================================

alter table public.profiles
  add column if not exists availability_status text,
  add column if not exists availability_since date,
  add column if not exists availability_expected_return date,
  add column if not exists availability_note text;

alter table public.profiles drop constraint if exists profiles_availability_status_check;
alter table public.profiles add constraint profiles_availability_status_check
  check (availability_status is null or availability_status in ('available', 'limited', 'out'));

-- A date that exists without a status is a half-recorded state nothing can
-- read. The status is what routes; the dates only qualify it.
alter table public.profiles drop constraint if exists profiles_availability_dates_need_status;
alter table public.profiles add constraint profiles_availability_dates_need_status
  check (availability_status is not null
         or (availability_since is null
             and availability_expected_return is null
             and availability_note is null));

comment on column public.profiles.availability_status is
  'Self-reported by the athlete: available | limited | out. NULL means not recorded and must never be backfilled to available. Not a medical record.';
comment on column public.profiles.availability_expected_return is
  'The ATHLETE''S OWN estimate. Never render it as a clinical prediction or a commitment.';

-- Rerouting writes history here rather than mutating the pathway, so a route
-- the athlete used to be on is never lost. 148 created the table; these are
-- the two outcome types a reroute needs and the enum does not yet have.
alter table public.athlete_outcomes drop constraint if exists athlete_outcomes_outcome_type_check;
alter table public.athlete_outcomes add constraint athlete_outcomes_outcome_type_check
  check (outcome_type in (
    'trial_obtained','trial_unsuccessful','offer_received','college_commitment',
    'professional_contract','transfer_completed','scholarship_received',
    'position_changed','benchmark_improved',
    'availability_changed','pathway_rerouted'
  ));

-- ============================================================
-- AFTER APPLYING
--   1. Settings gains the availability control (athlete-owned, 3 states).
--   2. Scout's athleteState carries it, so it stops re-asking.
--   3. A change writes athlete_outcomes('availability_changed') — history,
--      never an overwrite.
--   4. Only then does the pathway react to it. Rerouting must never be built
--      before the history write exists, or the first reroute destroys the
--      route it replaced.
-- VERIFY:
--   select availability_status, count(*) from profiles group by 1;
--   -- every existing row must be NULL. A non-NULL row means something
--   -- backfilled a claim nobody made.
-- ============================================================
