# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
Claude Code (AVA job 199, task t2, attempt 2), 2026-11-08. Before that: Claude Code (job 199 t1; job 184, Targets).

## Current Branch
`ava/199-a-brand-new-athlete-goes-from-sign-up-to` (AVA job 199; AVA commits each step, then merges). Branched
from 3188dc1, where job 184 (Targets) was merged as #14.

## Last Completed Work
- AVA job 199 t2: `GoalSetup` (golsz-app.html, above GolszApp) opens after the onboarding Passport save and from
  Home's new `SetGoalCard` (sport, no steps). How it works: CLAUDE.md § Onboarding, "The goal step". Attempt 2 fixed
  attempt 1's three red suites at the cause: GoalSetup now resolves `actingFor || user.id` like GoalCard (it read
  `user.id`: parent_authorization), reads the whole pathway row (`stages, current_stage_id`: pathway_milestones),
  and action_mirror counts it as the 5th syncing write path with its own success-branch check. Home offers the card
  in manage mode too (GoalSetup writes the managed athlete's rows; the suite proves child-1, never u1).
  Browser look 2026-11-08 (throwaway wrapper around tools/preview-targets.cjs, not committed): `?page=home` with no
  pathway row at 390/1280, dark, shows the card; tapping it opens GoalSetup (fields 96/48/48 px, no dialog button
  under 44 px, Soccer preselects "Professional pathway"); light theme, Build with an empty goal shows "Write your
  goal first." under the field with aria-invalid and focus on it. No sideways scroll, no console errors. Not driven:
  a successful build, the alert, Skip (t3/t4).
- t1: `starterPathwaySteps()` (pure, 5-8 dated steps); suite `tests/test_starter_pathway.cjs`.
- Job 184 (Targets) is merged; its recorded browser runs are in CLAUDE.md § Target clubs/coaches and outreach drafts.

## Current Work
AVA job 199 (a new athlete gets from sign-up to a dated plan in one sitting): t1, t2 done. Still to do: t3 (local
rehearsal without the live database), t4 (browser run on phone and desktop), then the security review, regression
run and final verification. Open for t4: on Free, Home's Today view still hides the Today/This Week NUMBER tiles
(`canTargets`, they open the locked Plan page); the Today tile and the next-step card do show the steps.

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
2026-11-08 (job 199 t2 attempt 2), via "$AVA_RUN" after `npm run compile`: goal_setup 91/91, action_mirror 56/56,
parent_authorization 75/75, pathway_milestones 248/248, read_failures_shown 61/61, i18n_keys_resolve 4/4,
compiled_artifact 14/14, launch_p0 104/104, starter_pathway 56/56, and 38 more suites that read GolszApp, Home or
pathway_plan, all green; `node --check` on api/*.js, js/*.js, sw.js clean. Full `npm run check` left to AVA.
2026-11-06 (job 184): outreach 270/270, preview_targets 49/49, migration_165 47/47. 2026-11-03: 129/129 suites.

## Known Problems
- health-alert runs every 2.1-7.5 h, not 15 min: outages can go unseen for hours; a >6 h gap fakes "monitor dead".
- Payments live but no real purchase yet; webhook signing secret unverified. Admin MFA: owner not enrolled.
- Signup has NO bot protection (Supabase CAPTCHA off, `TURNSTILE_SITE_KEY` empty; enable both together).
- Not verified: a live Scout reply for a signed-in athlete (vs Home's Today tile); VoiceOver on the redesigned hero.
- Older than job 184, Targets: the summary line says "No schools or clubs yet" on a failed read (and while loading);
  the row chevron lacks aria-label/aria-expanded; light LoadError text + Retry (#B58A1A) are 3.17:1, under 4.5:1.

## Next Recommended Action
AVA job 199 t3: a local preview of the first visit (sign-up -> Passport -> GoalSetup -> Home) whose stand-in stores
pathway_plan, so a built plan shows on Home. Then migration 165. Agents: ADS Phase 6 items 4-5.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
