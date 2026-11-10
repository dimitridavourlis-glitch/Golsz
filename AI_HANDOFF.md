# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
OpenCode (AVA job 199, task t4, third try), 2026-11-10. Before that: OpenCode (t4, tries 1-2), Claude Code (t1-t3).

## Current Branch
`ava/199-a-brand-new-athlete-goes-from-sign-up-to` (AVA job 199; AVA commits each step, then merges). Branched
from 3188dc1, where job 184 (Targets) was merged as #14.

## Last Completed Work
- AVA job 199 t4, third try. **The real-browser run is still NOT done** (first table). Cause, found this time: AVA
  starts its browser broker (`$AVA_BROWSER`, `$AVA_RUN`) only in its Claude Code engine (`ava/engine/claude_cli.py`);
  its OpenCode engine starts none, and Chrome cannot start in the sandbox. All three t4 tries ran in OpenCode.
- Instead, the drives were executed for the first time, against the real `js/app.js`, in jsdom (a DOM with no layout
  or paint: NOT a browser, no screenshots, no scroll widths). The tool as committed could not have produced the
  proof, so `tools/preview-onboarding.cjs` was rewritten: the old sign-up drive never filled the date of birth (wrong
  ids) and never left Auth; the old title read stray digits ("today: 7; thisWeek: 4" with no plan) and now reads the
  TODAY and THIS WEEK cells as done/total after opening the Today view and "Show my progress"; the stand-in ignored
  `lt`/`order`/`limit`/`on_conflict`, which made the app log "GOLSZ home reads failed: snapshot"; a stuck drive now
  ends `[drive FAILED: timed out waiting for <what>]`; the title carries `scroll: <scrollWidth>/<innerWidth>` (last
  screen, GoalSetup, Today view); `reloadmid2` is gone, `today` is new, each drive sets the store it starts from.
- Seen while executing the flow (app behaviour, not changed): an unfinished Passport keeps its editor open by itself
  (`editing || incomplete`); GoalSetup opens from the Passport save only within one page (`drive=full`), after a
  reload it opens from Home's set-goal card (what `drive=goal` does); with `fail=pathway` the goal sentence is
  already saved when the plan write is refused (it is written first), no `pathway_plan` row exists, Retry writes it.
- **For the owner (product):** right after "Build my plan", and on the day's first open, the daily check-in "How do
  you feel today?" covers Home until the athlete answers or taps "Skip for today". One tap, not a dead end, but it
  sits between a new athlete and the plan they just built. Decide whether to skip it that day.

  Real browser (the acceptance criteria), AVA browser + `tools/preview-onboarding.cjs`, one server per width and theme:

  | 4 combinations | A: signup -> passport -> goal -> home (reload) | B: reloadmid; goal&fail=pathway |
  |---|---|---|
  | 390 dark | UNVERIFIED: not run (no browser tool) | UNVERIFIED: not run |
  | 390 light | UNVERIFIED: not run (no browser tool) | UNVERIFIED: not run |
  | 1280 dark | UNVERIFIED: not run (no browser tool) | UNVERIFIED: not run |
  | 1280 light | UNVERIFIED: not run (no browser tool) | UNVERIFIED: not run |

  jsdom execution, 2026-11-10 (same drives, one server per row, pages in order; "390"/"1280" only pick the phone or
  desktop shell; `scroll` read 0/390 and 0/1280 because jsdom has no layout, so it proves nothing about overflow):

  | jsdom, 2 runs | A: titles, in order | B: titles |
  |---|---|---|
  | phone shell, dark | signup: `path: Auth > Passport editor`. passport: `Passport editor > GoalSetup; goalSetupFrom: the Passport save`. goal: `Daily check-in > Home (set-goal card) > GoalSetup > Home; today: 0/1; thisWeek: 0/3; badge: 1 to do; next: Ask Scout what to focus on this week; labels: 1/7 on screen; checkin: skipped`. home: `Home; today: 0/1; thisWeek: 0/3`, same badge and step | reloadmid: `Home (set-goal card) > GoalSetup > Home; sawSetGoalCard=yes; today: 0/1; thisWeek: 0/3`. fail: `failAlert="Couldn't save your plan. Try again."; formKept=yes; goalKept=yes; plansAtFail=0; goalTextAtFail=saved; retry=ok`, then Home 0/1, 0/3 |
  | desktop shell, light | the same four titles, word for word | the same two titles |

  Both rows also ran `drive=full`: `Auth > Passport editor > GoalSetup > (Daily check-in >) Home; goalSetupFrom: the
  Passport save; today: 0/1; thisWeek: 0/3`. Console: nothing, except the app's own "GOLSZ goal setup save error"
  line in the fail run. Home shows one step label (the next step), on the Today tile and in the Today view.

## Current Work
AVA job 199 t4: tool, tests and docs done; the real-browser run is open. Then security review, regression, final.

## Remaining Tasks
- Run t4's browser proof in a session that has `$AVA_BROWSER` (Claude Code). Per width (390, 1280) and theme, a
  fresh server: `"$AVA_BROWSER" --serve "node tools/preview-onboarding.cjs <port>" --port <port> --widths <w>` then, in
  order, `/golsz-app.html?theme=<t>&drive=` signup, passport, goal, home, reloadmid, `goal&fail=pathway`, full, today.
  Record titles, console errors and the three `scroll` pairs (equal at 390); open the passport (GoalSetup) and home shots.
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
2026-11-10 (job 199 t4, try 3): `node tests/test_preview_onboarding.cjs` -> 85/85 (was 24; 7 hand-made mutants of
the new rules each fail it). `node --check tools/preview-onboarding.cjs` ok. No app code changed, so no `npm run compile`.
Run in the agent's own shell (`$AVA_RUN` unset). Full `npm run check` left to AVA.

## Known Problems
- t4's browser criteria (titles, console, 390 px scroll widths, screenshots) are unmet: no browser tool in OpenCode.
- jsdom is not in the repo (scratch install under `.ava-tmp/`, ignored): the drive run above is not repeatable by a suite.
- health-alert runs every 2.1-7.5 h, not 15 min. Payments live but no real purchase; webhook secret unverified.
- Admin MFA: owner not enrolled. Signup has NO bot protection (Supabase CAPTCHA off, `TURNSTILE_SITE_KEY` empty).
- UNVERIFIED (first visit): live Supabase (RLS/PostgREST/real upsert+auth), a real phone on cellular, a screen reader,
  fr/es/el in a browser. Also "My goal..." line on Free opens the locked Plan (older than job 199).

## Next Recommended Action
Give t4 to a Claude Code session (it has the browser tool) and run the commands under Remaining Tasks; put the real
titles and scroll widths in the first table. Then security review, regression and final verification for job 199.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
