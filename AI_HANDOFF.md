# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
Claude Code (AVA job 199, task t1, attempt 3), 2026-11-08. Before that: Claude Code (job 184, Targets, all steps).

## Current Branch
`ava/199-a-brand-new-athlete-goes-from-sign-up-to` (AVA job 199; AVA commits each step, then merges). Branched
from 3188dc1, where job 184 (Targets) was merged as #14.

## Last Completed Work
- AVA job 199 t1: `starterPathwaySteps({ sport, pathwayType, timeline, today, athlete, benchmarks, targets,
  pathwayRow, t })` in golsz-app.html, next to normalizeMilestone/suggestedDate, with `starterTimelineDays()`, the
  `STARTER_*` constants and ten `starter_step_*` keys in en/fr/es/el. Pure (no clock, randomness, network or AI):
  5-8 steps in normalizeMilestone's shape with `due_src: "scout"` (never late until the athlete changes a step).
  The first three fall in today's Monday-Sunday week, the first one today. Later steps come one a week, the retest
  at least 14 days after the benchmark, and a check-in on the goal's timeline (12 weeks when there is no usable
  date, never more than 540 days). Steps for evidence already on file are skipped by the gap engine's own rules. No
  screen calls it yet: t2 does. Suite: `tests/test_starter_pathway.cjs`.
- Job 184 (Targets) is merged; its recorded browser runs are in CLAUDE.md § Target clubs/coaches and outreach drafts.

## Current Work
AVA job 199 (a new athlete gets from sign-up to a dated plan in one sitting): t1 done. Still to do: t2 (ask for the
goal right after the Passport is saved), t3 (local rehearsal without the live database), t4 (browser run on phone
and desktop), then the security review, regression run and final verification.

## Remaining Tasks
- Migration 165 (job 184, now merged) is NOT YET APPLIED as far as the repo records: run it in the SQL Editor
  (checks + rollback in its header).
- OWNER: one real Basic purchase; send LEGAL-REVIEW-BRIEF.md to counsel; admin MFA (OWNER-RUNBOOK.md section 8:
  enrol, test a password-only sign-in, THEN migration 162, which an agent can run once the owner confirms).
- OWNER/dashboard: Vercel Hobby -> Pro (also fixes the monitor); Supabase backups/PITR + a restore drill; Stripe portal
  plan switching (bpc_1UBZUwRtNFWlwsi4HXthKxbz), then drop "email us to switch"; Payment Link redirect
  /golsz-app.html?checkout=success; uptime probe; a real Elite benefit; French marketing pages; legal entity details.
- Agent-doable: ADS Phase 6 items 4-5; Reschedule/Drop from Home; `removed_at` on stages; self-host fonts + the CDN
  libraries (CSP); an admin RPC for `stripe_pending_plans`; "Draft with Scout" on a target; Targets summary (below).

## Important Architecture Decisions
- A push to `main` is a production deploy; the Vercel buildCommand (`npm run check` first) is the gate.
- JSX is compiled at author time into committed `js/app.js` (`npm run compile`); split/strip/unpublish run on Vercel.
- Migrations are numbered files run by hand; supabase-schema.sql records live state (`NOT YET APPLIED`).
- 12-function Vercel ceiling (`_`-prefixed `api/` files are shared modules). Adults only. Scout sends `due_in_days`.

## Latest Test / Build Status
2026-11-08 (job 199 t1 attempt 3), via "$AVA_RUN": `node tests/run-all.cjs starter_pathway` 56/56; `npm run compile`
left js/app.js byte-identical (git status clean), then `compiled_artifact` 14/14. Full `npm run check` left to AVA.
2026-11-06 (job 184): outreach 270/270, preview_targets 49/49, migration_165 47/47. 2026-11-03: 129/129 suites.

## Known Problems
- health-alert runs every 2.1-7.5 h, not 15 min: outages can go unseen for hours; a >6 h gap fakes "monitor dead".
- Payments live but no real purchase yet; webhook signing secret unverified. Admin MFA: owner not enrolled.
- Signup has NO bot protection (Supabase CAPTCHA off, `TURNSTILE_SITE_KEY` empty; enable both together).
- Not verified: a live Scout reply for a signed-in athlete (vs Home's Today tile); VoiceOver on the redesigned hero.
- Older than job 184, Targets: the summary line says "No schools or clubs yet" on a failed read (and while loading);
  the row chevron lacks aria-label/aria-expanded; light LoadError text + Retry (#B58A1A) are 3.17:1, under 4.5:1.

## Next Recommended Action
AVA job 199 t2: after the Passport save, ask for the goal and write `starterPathwaySteps({ ..., today: isoDay(new
Date()), t })` to pathway_plan.milestones. Then migration 165. Agents: ADS Phase 6 items 4-5.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
