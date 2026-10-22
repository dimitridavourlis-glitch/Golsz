# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
OpenCode, 2026-10-22 (second session): unpublish step, migration probe, owner runbook, counsel brief,
ADS-BUILD-ORDER reconciled; then, with the owner signed in to Supabase in the browser pane, ran the probe
and migration 160 against PRODUCTION (the owner's explicit go-ahead). Before that: OpenCode comment fixes; Claude Code setup session.
Last real feature work: Claude Code, 2026-10-21, a review-fix round after the redesign merge (5bfb860).

## Current Branch
Work is on `admin-mfa-roles` (pushed, NOT merged). `main` is at 3f1bd74, live and verified; this branch has main merged in (conflict-free to merge).
The five `redesign/phase-*` branches are fully merged into `main`.

## Last Completed Work
- 2026-10-22 (OpenCode, production): probe read 158, 159 and 026 already true; 160.1 and 160.2 false.
  Ran migration 160 (whitespace/comment-stripped, verified statement-for-statement against the file and by
  SHA-1 in the editor; Supabase showed its "destructive operations" warning for `drop policy`, expected).
  Re-ran the probe: all 15 checks true. 160 file now also drops the new policy names first, so a second
  run is harmless (it was claimed idempotent but was not). Ledger and CLAUDE.md updated.
- 2026-10-22 (OpenCode): `tools/unpublish-internal.cjs` + `npm run unpublish`, last step of the Vercel
  buildCommand: removes root `*.md`, `opencode.json`, `supabase-*.sql`, `tests/`, `tools/`, `golsz-guard/`,
  `.github/`, `.claude/` from the served tree (they were all public URLs, verified live). Never touches
  `api/`; refuses to run without `VERCEL=1` or an explicit dir. `tests/test_unpublish_internal.cjs`
  (52 assertions, mutation-checked). NOT YET VERIFIED LIVE: curl the paths after the deploy lands.
- `supabase-probe-migration-state.sql` (read-only; parses with pglast, never run against Postgres):
  one paste says which of 158/159/160/026 are applied. `OWNER-RUNBOOK.md`: the owner-only steps.
- `LEGAL-REVIEW-BRIEF.md`: facts and questions for counsel. CORRECTION: under-18s cannot register
  today (managed profiles off in client and API; DB gate, 158 is applied), so the live questions are
  French terms, Law 25, health information, AI providers, EU withdrawal at checkout.
- `ADS-BUILD-ORDER.md` STATUS block rewritten from the code: phases 0, 3, 4 done (4 minus the
  opportunity slot); 1, 2, 5, 6, 7, 8 partial; 9, 10 not started. Claims about "applied" come from
  headers, not the database.
- 2026-10-22 (earlier): header comments in `tools/precompile.cjs` and `api/health-alert.js` corrected.

## Current Work
Branch `admin-mfa-roles`, ready for the owner's review and merge: migration 161 (owner/moderator roles,
trigger pins, last-owner guard), migration 162 (is_admin() requires aal2: RUN ONLY AFTER ENROLLING),
`api/admin-user-action.js` (aal2 required, delete owner-only, falls back to "every admin an owner" while
161 is unapplied), Admin Panel gate `AdminMfa` / `adminMfaState` (nothing loads before aal2), owner-only
controls, 15 strings x 4 languages, `tests/test_admin_mfa_roles.cjs` (100) and 132 in
`test_admin_user_action.cjs`, mutation-checked. NEVER exercised in a browser or against Supabase: the
enrol/verify screens and a real aal2 token are unproven until the owner runs OWNER-RUNBOOK.md section 8.

## Remaining Tasks
- OWNER (OWNER-RUNBOOK.md): rotate `SUPABASE_WEBHOOK_SECRET` and re-run 026 with the new value (never
  commit it); one real Basic purchase; check the Supabase CAPTCHA setting against the empty
  `TURNSTILE_SITE_KEY` (if CAPTCHA is on, signup is down). Runbook steps 1 and 2 are DONE.
- OWNER: send LEGAL-REVIEW-BRIEF.md to counsel (run its three count queries first).
- OWNER: admin MFA rollout, OWNER-RUNBOOK.md section 8 (enable TOTP, run 161, merge, enrol, test, run 162).
  Review the branch first: `git diff main...admin-mfa-roles --stat`.
- Agent-doable gaps from the ADS reconciliation (ADS-BUILD-ORDER.md STATUS): parallel `getAthleteState`
  reads; a server "today" line for Scout and a date digest in `responseCacheFingerprint`; `measured_by` /
  `protocol` in Scout's benchmark select; Reschedule/Drop from Home; `removed_at` on stages.
- Stale cross-references listed in the ADS STATUS block (150's "(148)", the `weekReview` comment).

## Important Architecture Decisions
- A push to `main` is a production deploy; the Vercel buildCommand (`npm run check` first) is
  the gate, and check.yml only reports alongside it.
- JSX is compiled at author time into committed `js/app.js`; `split`, a second `compile`, `strip` and
  `unpublish` run only on Vercel (buildCommand order asserted by test_served_bundle.cjs and
  test_unpublish_internal.cjs).
- Database changes are numbered migration files run by hand; supabase-schema.sql records live state,
  including migrations NOT YET APPLIED (marker `*** NOT YET APPLIED ***`).
- 12-function Vercel ceiling: shared code goes in `_`-prefixed modules in `api/`.
- Adults only (18+) contract and pay; managed profiles for under-18s are switched off.

## Latest Test / Build Status
2026-10-22 (OpenCode): `npm run check` 111/111 suites (5305 assertions) at b873772; that deploy was
verified live (16 internal paths 404, site and functions up). Production DB: probe 15/15 true after 160.
Not verified: CI. Not exercised against the live database: the shared-Passport behaviour itself (only
catalog checks), i.e. nobody has loaded a `?public=<uuid>` link since 160.

## Known Problems
- Payments live but no real purchase has completed; webhook signing secret unverified.
- An old push-webhook secret is exposed in public git history until it is rotated.
- No MFA live and every admin has the same full power, until `admin-mfa-roles` merges and 161/162 run.
  The MFA screens have not been seen working in a browser.
- Privacy policy says Turnstile is not active; Supabase CAPTCHA state unknown (owner-only fact).
- `api/*.js` source is still readable as static files on golsz.com (deliberate: deleting `api/` at build
  time would delete the functions; the repo is public).

## Next Recommended Action
Owner: OWNER-RUNBOOK.md steps 1 to 5. Agents: confirm the unpublish deploy with
`curl -I https://golsz.com/CLAUDE.md` (expect 404) and `/api/geo` (version = the pushed commit).

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
