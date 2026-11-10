# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
OpenCode (AVA job 199, task t4, second try), 2026-11-10: no code or tool change, browser run still not possible (below). Before that: Claude Code (job 199 t1, t2, t2-r1, t3).

## Current Branch
`ava/199-a-brand-new-athlete-goes-from-sign-up-to` (AVA job 199; AVA commits each step, then merges). Branched
from 3188dc1, where job 184 (Targets) was merged as #14.

## Last Completed Work
- AVA job 199 t4 (this step): improved `tools/preview-onboarding.cjs` for the required proof — `drive=home`; signup
  waits for the Passport editor; passport lands on GoalSetup; goal lands on Home; `reloadmid` detects the "set your
  goal" card, taps "Set my goal", completes GoalSetup and lands on Home (records `sawSetGoalCard=yes`); `fail=pathway`
  is one-shot in the stub (500 once, form kept, alert shown, `planCountAtFail=0`, then Retry clicks and succeeds to
  Home); plain/home reloads seed session from server state when a plan exists; drive titles report
  `screen/today/thisWeek/labels/alerts` (+ fail facts). `tests/test_preview_onboarding.cjs` still 24/24. Updated
  CLAUDE.md (§ First visit: sign-up to a dated plan), AGENTS.md, CHANGELOG.md.
- Browser run (AVA browser / `$AVA_BROWSER`) — **NOT RECORDED here: broker unavailable** in this agent environment
  (`$AVA_BROWSER` unset, no broker script under the agent TMPDIR; Chrome cannot start in the sandbox, confirmed:
  `ava.visual.run` -> "Chrome stopped"). No page titles/screenshots were produced; do not treat as passed.
  Checked again 2026-11-10: `$AVA_BROWSER` and `$AVA_RUN` are both unset in an OpenCode session. The preview server
  itself starts and answers 200 here; only the browser is missing. Run this step in a session that has the browser tool.

  | 4 combinations (one server per width/theme, store persists) | A: signup->Passport editor, passport->GoalSetup, goal->Home (Today>=1, This week>=3, step labels), plain reload same Home | B: reloadmid; fail=pathway (form kept, alert, nothing written; retry succeeds) |
  |---|---|---|
  | 390 dark | UNVERIFIED (no broker) | UNVERIFIED (no broker) |
  | 390 light | UNVERIFIED (no broker) | UNVERIFIED (no broker) |
  | 1280 dark | UNVERIFIED (no broker) | UNVERIFIED (no broker) |
  | 1280 light | UNVERIFIED (no broker) | UNVERIFIED (no broker) |

  Run with AVA browser, one server per combo, in order (example per combo):
  `"$AVA_BROWSER" --serve "node tools/preview-onboarding.cjs <port>" --port <port> --widths <w>`
  `"/golsz-app.html?theme=<t>&drive=signup" "/golsz-app.html?theme=<t>&drive=passport" "/golsz-app.html?theme=<t>&drive=goal" "/golsz-app.html?theme=<t>&drive=home"`
  plus separate runs: `?theme=<t>&drive=reloadmid` and `?theme=<t>&drive=goal&fail=pathway`. Verify: titles show the
  ordered screens/counts/labels (no console errors), `scrollWidth===innerWidth` at 390 px on GoalSetup and Home, reloadmid
  shows `sawSetGoalCard=yes` then Home, fail shows `failAlert=yes; planCountAtFail=0; goalKept=yes; retryOk=yes`.
  Screenshots to open: GoalSetup and Home.

## Current Work
AVA job 199 t4: docs/tooling done; the required real-browser proof is still pending an environment with the AVA browser
broker (`$AVA_BROWSER`). Security review, regression and final verification remain.

## Remaining Tasks
- Run the t4 browser proof (commands above) once `$AVA_BROWSER`/broker is available; record real titles/screenshots.
- Migration 165 (job 184, merged) NOT YET APPLIED: run in the SQL Editor (checks + rollback in its header).
- OWNER: one real Basic purchase; send LEGAL-REVIEW-BRIEF.md to counsel; admin MFA (OWNER-RUNBOOK.md section 8).
- OWNER/dashboard: Vercel Hobby->Pro (monitor); backups/PITR+restore drill; portal plan switching; checkout redirect;
  uptime probe; Elite benefit; French marketing; legal entity. Agent-doable: ADS Phase 6 4-5; Reschedule/Drop from
  Home; `removed_at` on stages; self-host fonts+CDN libs (CSP); admin RPC for `stripe_pending_plans`; Targets summary.

## Important Architecture Decisions
- Push to `main` = production deploy; Vercel buildCommand (`npm run check` first) is the gate.
- JSX compiled at author time to committed `js/app.js` (`npm run compile`). Migrations numbered, run by hand.
- 12-function Vercel ceiling (`_`-prefixed `api/` are shared modules). Adults only.

## Latest Test / Build Status
2026-11-09 (job 199 t4): `node tests/test_preview_onboarding.cjs` -> 24/24 passed (after tool changes). `node --check`
on `tools/preview-onboarding.cjs` ok. No JSX/app code changed (no `npm run compile` needed). Browser proof: NOT RUN
(broker unavailable). Full `npm run check` left to AVA.

## Known Problems
- t4 browser acceptance criteria (real titles/screenshots at 390/1280, dark/light) unverified: `$AVA_BROWSER` and `$AVA_RUN` are unset in OpenCode sessions (seen 11-09 and 11-10); Chrome blocked in sandbox.
- health-alert runs every 2.1-7.5 h, not 15 min. Payments live but no real purchase; webhook secret unverified.
- Admin MFA: owner not enrolled. Signup has NO bot protection (Supabase CAPTCHA off, `TURNSTILE_SITE_KEY` empty).
- UNVERIFIED (first visit): live Supabase (RLS/PostgREST/real upsert+auth), a real phone on cellular, a screen reader,
  fr/es/el in a browser. Also "My goal..." line on Free opens the locked Plan (older than job 199).

## Next Recommended Action
Run the t4 browser proof with `$AVA_BROWSER` (commands in Last Completed Work), record real page titles/screenshots in
the table, then proceed to security review, regression and final verification for job 199.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._