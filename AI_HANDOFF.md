# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
Claude Code (AVA job 199, task t2-r1-1), 2026-11-09. Before that: Claude Code (job 199 t1, t2; job 184, Targets).

## Current Branch
`ava/199-a-brand-new-athlete-goes-from-sign-up-to` (AVA job 199; AVA commits each step, then merges). Branched
from 3188dc1, where job 184 (Targets) was merged as #14.

## Last Completed Work
- AVA job 199 t2: `GoalSetup` (golsz-app.html, above GolszApp) opens after the onboarding Passport save and from
  Home's new `SetGoalCard` (sport, no steps); CLAUDE.md § Onboarding, "The goal step". It resolves `actingFor ||
  user.id`, reads the whole pathway row and is action_mirror's 5th syncing write path (attempt 2's fixes). Attempt 3:
  TODAY / THIS WEEK number tiles show on Free too (plain cells, `go: null`; buttons into Plan from Basic up), and the
  Today tile's "N to do" badge is `C.pitch` (it was `C.ink`: black on black in the light theme).
- Browser run 2026-11-08 (t2 attempt 3), final bundle, plan FREE, AVA browser tool, one server per width and theme
  (390 dark, 390 light, 1280 dark, 1280 light), six loads each in order. Throwaway wrapper (node_modules/.cache/
  goal-flow.cjs, not committed; t3 builds the real tool) around tools/preview-targets.cjs that keeps `profiles` and
  `pathway_plan` in memory. Same result in all four: (1) no plan: Home shows "Set your goal to get your plan";
  (2) Set my goal, then Skip for now: back on Home with the card; (3) upsert answering HTTP 500: the form stays with
  the goal, "professional" and "Fall 2027" still typed (fields 96/48/48 px, no dialog button under 44 px), alert
  "Couldn't save your plan. Try again." with Retry; (4) build: GoalSetup closes, no card, Today tile "3 to do / Ask
  Scout what to focus on this week"; server log: one `pathway_plan upsert on_conflict=user_id` with exactly
  user_id, pathway_type, target_timeline, milestones, updated_at, 7 steps due 11-08 x3, 11-11, 11-18, 11-25,
  2027-09-01, then `rpc sync_athlete_actions`; (5) Today view: MY NEXT STEP with Mark done, TODAY 0/3 and THIS
  WEEK 0/3 as plain cells; (6) a reload keeps the plan. No sideways scroll anywhere; the only console error is the
  app's own log of the intentional 500. Screenshots opened: 390 dark (card, refused save, Home, Today view), 390
  light (Home: badge black on black before the fix, readable after), 1280 light (refused save). Light theme still
  flags older gold-on-cream text: bottom-nav active label 10 px 3.02:1, a desktop button 2.75:1, Back and Hide on
  the Today view 3.02:1. Scripted clicks also draw Chrome's default ring on the focused dialog panel, as on every
  `tabindex=-1` dialog in the app; a real tap does not.
- t2-r1-1 (review of GoalSetup's build, saveGoalText, goalSetupFieldErrors and GolszApp's flags): one fix. A new
  athlete who signs in after confirming the email (no `startOnboarding`) never got GoalSetup after the Passport save;
  GolszApp's profile-complete read now sets `onboarding` when it finds no sport (not on a failed read). 4 new asserts.
  Attempt 5 (test only): the editor's real save now drives Passport -> afterPassportSave -> GoalSetup; HEAD's
  suite stayed 103/103 with `onSaved()` (6726) or `onProfileSaved()` (7277) emptied, the new one fails both.
- t1: `starterPathwaySteps()` (pure, 5-8 dated steps); suite `tests/test_starter_pathway.cjs`.
- Job 184 (Targets) is merged; its recorded browser runs are in CLAUDE.md § Target clubs/coaches and outreach drafts.

## Current Work
AVA job 199 (a new athlete gets from sign-up to a dated plan in one sitting): t1, t2 done. Still to do: t3 (local
rehearsal without the live database), t4 (browser run on phone and desktop), then the security review, regression
run and final verification. Open for t4: the tiles view's "My goal: ..." line opens Plan, which is a FeatureLock on
Free (older than this job; every new athlete now has a goal, so it is seen more often).

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
2026-11-09 (job 199 t2-r1-1), via "$AVA_RUN" after `npm run compile`: goal_setup 105/105, action_mirror,
pathway_milestones, parent_authorization, i18n, compiled_artifact and 13 more suites reading GolszApp (19/19).
t2 attempt 3: 72/72 suites reading GolszApp, Home, Passport or pathway_plan. Full `npm run check` left to AVA.
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
