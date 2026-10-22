# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
OpenCode, 2026-10-22: verified the live deploy, fixed the two stale code comments (comments only).
Before that: Claude Code setup session, 2026-10-22 (AGENTS.md, AI_HANDOFF.md, opencode.json).
Last real development work: Claude Code, 2026-10-21, a review-fix round after the redesign merge (ends at commit 5bfb860).

## Current Branch
`main`, in sync with `origin/main` after the 2026-10-22 push (setup + doc fixes on top of 5bfb860).
The five `redesign/phase-*` branches are fully merged into `main` (0 commits ahead).

## Last Completed Work
- 2026-10-22 (Claude Code): Vercel deploys had failed since 3d585b7 (2026-10-21) with
  `[BUILD_FAILED] Unhandled type: "Identifier"`: Vercel reads api `config` statically and
  `maxDuration: MAX_SECONDS` was not a literal. Now `maxDuration: 60` (test keeps it equal to
  MAX_SECONDS). Until this deploy, golsz.com served e24faab.
- 2026-10-20: redesign phases 1 to 4b merged by PRs #3 to #7 (daily check-in, Home tiles, Plan as
  one road, Scout start screen, action cards).
- 2026-10-21: "the redesign is the app now" (old flags removed); deploy-time `split` (only English
  in the main bundle) and `strip` (JSX source not served); migration 159 applied; migration 160
  written; then a series of review fixes (Passport tile, erasure parity, photo removal, Scout
  spend guard, admin action logging).

## Current Work
None in progress. 2026-10-22 (OpenCode): confirmed golsz.com `/api/geo` reports version 15c6729d378f
(the maxDuration fix deployed). Rewrote the stale header comments in `tools/precompile.cjs` and
`api/health-alert.js`; no code changed.

## Remaining Tasks
- Owner, in the Supabase SQL Editor: run migration 160; confirm migration 158 ran, then update
  its "pending" note in supabase-schema.sql.
- One real Basic purchase to prove the Stripe webhook, then cancel it in the portal
  (CLAUDE.md § Current state). Until then payments are unproven.
- Rotate `SUPABASE_WEBHOOK_SECRET` and re-run migration 026 (CLAUDE.md § Current state).
- Stale docs and code comments: all fixed 2026-10-22.
- Owner decision: repo-root docs are publicly served (see Known Problems). Options: a `.vercelignore`
  (must be tested: the Vercel build needs tests/ and tools/) or moving the docs into a folder.
- ADS-BUILD-ORDER.md phases: status last updated 2026-10-13. Owner to confirm what remains.

## Important Architecture Decisions
- A push to `main` is a production deploy; the Vercel buildCommand (`npm run check` first) is
  the gate, and check.yml only reports alongside it.
- JSX is compiled at author time into committed `js/app.js`; `split`, a second `compile` and `strip`
  run only on Vercel (buildCommand order is asserted by test_served_bundle.cjs).
- Database changes are numbered migration files run by hand; supabase-schema.sql records live state,
  including migrations NOT YET APPLIED.
- 12-function Vercel ceiling: shared code goes in `_`-prefixed modules in `api/`.
- Adults only (18+) contract and pay; under-18s are managed profiles (CLAUDE.md § Current state).

## Latest Test / Build Status
Last recorded: `npm run check` 110/110 suites, 5,252 assertions (commit 5bfb860 message,
2026-10-21). Re-run 2026-10-22 (OpenCode, after the comment fixes): `npm run check` 110/110 suites passed
(5253 assertions). Vercel built 15c6729 successfully (live `/api/geo` version). CI result not checked.

## Known Problems
- Payments live but no real purchase has completed; webhook signing secret unverified.
- An old push-webhook secret is exposed in public git history until it is rotated.
- Migration 160 not applied; migration 158 status unconfirmed.
- VERIFIED 2026-10-22: `outputDirectory: "."` with no `.vercelignore` serves repo-root files:
  golsz.com/CLAUDE.md, /AGENTS.md, /AI_HANDOFF.md, /README.md and /opencode.json return 200
  (`.env.example` returns 404). The repo is public, so nothing new leaks, but keep these files
  free of anything private.

## Next Recommended Action
Owner: run migration 160 in the Supabase SQL Editor and confirm 158; decide how to stop serving
repo-root docs. Agents: nothing code-side is pending; do not call payments working until a real
purchase has completed.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
