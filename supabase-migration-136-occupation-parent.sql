-- 136 — 'Parent' is a real occupation. Let the database say so.
--
-- OCCUPATIONS in golsz-app.html has offered "Parent" in the dropdown since
-- migration 048's comment first noted the gap, but profiles.occupation has
-- always carried:
--     check (occupation in ('Player','Scout','Agent','Coach','Physio','Other'))
-- Only the signup TRIGGER's in-memory allowlist was ever widened (048, 063,
-- 116); the column constraint never was. So a parent who picks the one option
-- that describes them has their profile UPDATE rejected outright by Postgres.
--
-- WHY THAT MATTERED MORE THAN A REJECTED WRITE. profiles.occupation staying
-- null keeps isParentAccount false, which means FamilyAccess never renders,
-- which means the parent cannot reach the athlete they signed up for. And
-- because the app-wide gate reads athletes.sport — a column a parent has no
-- reason to fill — mustFinishProfile pins them on the Passport screen with no
-- way out. The product is sold to parents. Parents could not use it.
--
-- Additive and idempotent: widening a CHECK cannot reject a row that already
-- satisfies the narrower one, so there is nothing to backfill and nothing to
-- lose. Safe to re-run.
alter table public.profiles
  drop constraint if exists profiles_occupation_check;

alter table public.profiles
  add constraint profiles_occupation_check
  check (occupation is null or occupation in
    ('Player', 'Parent', 'Scout', 'Agent', 'Coach', 'Physio', 'Other'));
