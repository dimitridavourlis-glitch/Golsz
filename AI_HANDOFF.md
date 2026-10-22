# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
OpenCode, 2026-10-22 (second session): unpublish step, migration probe, owner runbook, counsel brief,
ADS-BUILD-ORDER reconciled. Before that: OpenCode comment fixes; Claude Code setup session.
Last real feature work: Claude Code, 2026-10-21, a review-fix round after the redesign merge (5bfb860).

## Current Branch
`main`, in sync with `origin/main` after this session's push (on top of 67df5cc).
The five `redesign/phase-*` branches are fully merged into `main`.

## Last Completed Work
- 2026-10-22 (OpenCode): `tools/unpublish-internal.cjs` + `npm run unpublish`, last step of the Vercel
  buildCommand: removes root `*.md`, `opencode.json`, `supabase-*.sql`, `tests/`, `tools/`, `golsz-guard/`,
  `.github/`, `.claude/` from the served tree (they were all public URLs, verified live). Never touches
  `api/`; refuses to run without `VERCEL=1` or an explicit dir. `tests/test_unpublish_internal.cjs`
  (52 assertions, mutation-checked). NOT YET VERIFIED LIVE: curl the paths after the deploy lands.
- `supabase-probe-migration-state.sql` (read-only; parses with pglast, never run against Postgres):
  one paste says which of 158/159/160/026 are applied. `OWNER-RUNBOOK.md`: the owner-only steps.
- `LEGAL-REVIEW-BRIEF.md`: facts and questions for counsel. CORRECTION: under-18s cannot register
  today (managed profiles off in client and API; DB gate once 158 is applied), so the live questions are
  French terms, Law 25, health information, AI providers, EU withdrawal at checkout.
- `ADS-BUILD-ORDER.md` STATUS block rewritten from the code: phases 0, 3, 4 done (4 minus the
  opportunity slot); 1, 2, 5, 6, 7, 8 partial; 9, 10 not started. Claims about "applied" come from
  headers, not the database.
- 2026-10-22 (earlier): header comments in `tools/precompile.cjs` and `api/health-alert.js` corrected.

## Current Work
Admin MFA + admin roles: see "Remaining Tasks". Not on `main`.

## Remaining Tasks
- OWNER, in order (OWNER-RUNBOOK.md): run the probe; run 158/159/160 as it says; rotate
  `SUPABASE_WEBHOOK_SECRET` and re-run 026 with the new value (never commit it); one real Basic purchase;
  check the Supabase CAPTCHA setting against the empty `TURNSTILE_SITE_KEY` (if CAPTCHA is on, signup is down).
- OWNER: send LEGAL-REVIEW-BRIEF.md to counsel (run its three count queries first).
- Admin MFA and roles (CLAUDE.md "No 2FA/MFA"): work lives on a feature branch if present, not `main`
  (a gate that can lock the only admin out must not ship before the owner has enabled TOTP).
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
2026-10-22 (OpenCode): `npm run check` 111/111 suites passed (5305 assertions) before the push.
Not verified: the Vercel build of this push, CI, the live removal of the internal paths.

## Known Problems
- Payments live but no real purchase has completed; webhook signing secret unverified.
- An old push-webhook secret is exposed in public git history until it is rotated.
- Migration 160 not applied; 158's status unconfirmed (159's header implies it ran).
- No MFA anywhere; every admin has the same full power (until the branch work merges).
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
