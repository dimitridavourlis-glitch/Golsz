-- 131 — profiles.full_access, RECONSTRUCTED. This file did not exist.
--
-- The column is live in production (verified 2026-09-17: boolean, default
-- false) and both the client and the Admin panel read and write it —
-- golsz-app.html's own comment at the grant button even cites "migration 131".
-- But no migration 131 was ever committed. It was applied by hand and the file
-- was never written, so the repo could not rebuild this schema from scratch,
-- and anyone standing up a fresh environment would get a database the app
-- immediately fails against: PostgREST rejects an ENTIRE select for one
-- unknown column, so a missing full_access does not degrade the profile read,
-- it destroys it.
--
-- WHAT IT IS. An admin comp: paid features without a paid plan, for a beta
-- athlete or a partner club. It does not change their plan, their billing, or
-- anything Stripe knows about — see admin_full_access_hint.
--
-- Written to match what is already there, so running it against production is
-- a no-op. Safe to re-run.
alter table public.profiles
  add column if not exists full_access boolean not null default false;

comment on column public.profiles.full_access is
  'Admin comp: unlocks paid features without a paid plan. Never set by the athlete, never read from a request body, and never a substitute for profiles.plan — billing and entitlement stay separate.';
