# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
OpenCode (AVA job 199, task t4, fifth try), 2026-11-10. Before that: OpenCode (t4, tries 1-4), Claude Code (t1-t3).

## Current Branch
`ava/199-a-brand-new-athlete-goes-from-sign-up-to` (AVA job 199; AVA commits each step, then merges). Branched
from 3188dc1, where job 184 (Targets) was merged as #14.

## Last Completed Work
- AVA job 199 t4, fifth try: **the first visit ran in a real browser engine**, at 390 and 1280 px, dark and light.
  `$AVA_BROWSER`/`$AVA_RUN` were empty again (AVA sets them only for Claude Code), so the run used the new
  `tools/run-onboarding-chrome.cjs`: headless Chromium over a DevTools pipe, one fresh preview server and browser
  profile per width and theme. Google Chrome starts in the OpenCode sandbox but its page loads hang; Playwright's
  `chromium_headless_shell` (Chromium 141.0.7390.37, already on this Mac) works with `--no-sandbox`. Tries 1-4 never
  tested that and wrote "Chrome cannot start".
- The scroll reading was blind and is fixed: it measured the document, but Home scrolls inside `<main>` and GoalSetup
  inside a fixed sheet. It now measures the document, the screen and every box around it that scrolls or clips
  (`scrollBoxes`, `worstScroll`) and names the worst. `&overflow=1` is the positive control (a 2000 px bar).
- Defect found and fixed in `golsz-app.html` (+ `npm run compile`): after a key press, GoalSetup's sheet showed the
  browser's default focus ring around the whole screen. Its panel now has `outline: "none"`; fields and buttons keep
  the gold ring. The table below was run after the fix.

  Recorded run 2026-11-10, per row: `node tools/run-onboarding-chrome.cjs --width <w> --theme <t> --no-sandbox --chrome
  <headless_shell>`, pages in order. Titles were the same in all four rows; W is the row's width.

  | Page (in order) | Title ended (all 4: 390 dark, 390 light, 1280 dark, 1280 light) | Scroll readings | Console errors |
  |---|---|---|---|
  | `drive=signup` | `path: Auth > Passport editor; screen: Passport editor` | `W/W (document)` | none |
  | `drive=passport` | `path: Passport editor > GoalSetup; screen: GoalSetup; goalSetupFrom: the Passport save` | GoalSetup `W/W (document)` | none |
  | `drive=goal` | `path: Daily check-in > Home (set-goal card) > GoalSetup > Home; today: 0/1; thisWeek: 0/3; badge: 1 to do; next: Ask Scout what to focus on this week; labels: 1/7 on screen; checkin: skipped` | Home, GoalSetup, Today view: each `W/W (document)` | none |
  | `drive=home` (reload) | `path: Home; today: 0/1; thisWeek: 0/3`, same badge and step | Home, Today view `W/W (document)` | none |
  | `drive=reloadmid` | `path: Home (set-goal card) > GoalSetup > Home; sawSetGoalCard=yes; today: 0/1; thisWeek: 0/3` | all three `W/W (document)` | none |
  | `drive=goal&fail=pathway` | `failAlert="Couldn't save your plan. Try again."; formKept=yes; goalKept=yes; plansAtFail=0; goalTextAtFail=saved; retry=ok`, then Home 0/1, 0/3 | all three `W/W (document)` | only the app's own `GOLSZ goal setup save error` |
  | `drive=full` | `path: Auth > Passport editor > GoalSetup > Home; goalSetupFrom: the Passport save; today: 0/1; thisWeek: 0/3` | all three `W/W (document)` | none |
  | `drive=today` | `path: Home; today: 0/1; thisWeek: 0/3` (stays in the Today view) | `W/W (document)` | none |
  | `drive=goal&overflow=1` (control) | `drive done; ...; overflow=on purpose` | 390: `2016/390 (div.gz-home)`, `2020/390 (div)`, `2012/390 (div.gz-home)`; 1280: `2016/976`, `2020/480`, `2012/976` | none |

  The runner's own reading on each page's last screen: document 390/390 (1280/1280) and 0 elements past the window's
  edge on every page; on the control page 1 element past the edge while the document still read 390/390 (so the old
  reading could not have seen it). `drive=full` alone in a fresh profile (390 dark): `Auth > Passport editor > GoalSetup >
  Daily check-in > Home`, 0/1, 0/3. Screenshots opened: GoalSetup 390 dark, 390 light, 1280 dark, 1280 light; Home 390
  dark, 390 light, 1280 light; Today view 390 dark. They read correctly, nothing clipped. The only failed request on
  every page was the Google Fonts stylesheet (no internet): text was drawn in the system fallback font.
- With `fail=pathway` the goal sentence is already saved when the plan write is refused (it is written first); no
  `pathway_plan` row exists; Retry writes it.
- **For the owner (product):** right after "Build my plan", and on the day's first open, the daily check-in "How do
  you feel today?" covers Home until the athlete answers or taps "Skip for today". Decide whether to skip it that day.

## Current Work
AVA job 199 t4 done in this session. Next: security review, regression, final verification.

## Remaining Tasks
- Migration 165 (job 184, merged) NOT YET APPLIED: run in the SQL Editor (checks + rollback in its header).
- OWNER: one real Basic purchase; send LEGAL-REVIEW-BRIEF.md to counsel; admin MFA (OWNER-RUNBOOK.md section 8).
- OWNER/dashboard: Vercel Hobby->Pro (monitor); backups/PITR+restore drill; portal plan switching; checkout redirect;
  uptime probe; Elite benefit; French marketing; legal entity. Agent-doable: ADS Phase 6 4-5; Reschedule/Drop from
  Home; `removed_at` on stages; self-host fonts+CDN libs (CSP); admin RPC for `stripe_pending_plans`; Targets summary;
  the browser's default focus ring on the other dialogs' panels (Settings, Passport editor: `useModalFocus`).

## Important Architecture Decisions
- Push to `main` = production deploy; Vercel buildCommand (`npm run check` first) is the gate.
- JSX compiled at author time to committed `js/app.js` (`npm run compile`). Migrations numbered, run by hand.
- 12-function Vercel ceiling (`_`-prefixed `api/` are shared modules). Adults only.

## Latest Test / Build Status
2026-11-10 (job 199 t4, try 5), in the agent's own shell (`$AVA_RUN` unset): `npm run compile` ok;
`node tests/test_preview_onboarding.cjs` 94/94 (was 85); `node tests/test_goal_setup.cjs` 105/105;
`node tests/test_compiled_artifact.cjs` 14/14. Full `npm run check` left to AVA.

## Known Problems
- The run above is Chromium's headless shell, not Google Chrome, Safari or Firefox, and not AVA's browser tool.
- health-alert runs every 2.1-7.5 h, not 15 min. Payments live but no real purchase; webhook secret unverified.
- Admin MFA: owner not enrolled. Signup has NO bot protection (Supabase CAPTCHA off, `TURNSTILE_SITE_KEY` empty).
- UNVERIFIED (first visit): the web fonts (Archivo, Space Mono; the widths measured are the fallback font's), live
  Supabase (RLS/PostgREST/real upsert+auth), a real phone on cellular, a screen reader, fr/es/el in a browser. Also
  "My goal..." line on Free opens the locked Plan (older than job 199).

## Next Recommended Action
Security review, regression and final verification for job 199. To repeat the browser run: the command above the table.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
