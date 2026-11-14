# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
Claude Code (AVA job 216 t6: recorded run, Scout and Home agree, phone and desktop), 2026-11-14. Job 216's t1-t5 were
Claude Code too. Before job 216: OpenCode (job 199, final verification), 2026-11-10.

## Current Branch
`ava/216-scout-s-what-should-i-do-today-agrees-wi` (AVA job 216; AVA commits each step, then merges). Branched from
0b8e891, where job 199 (sign-up to a dated plan) was merged as #15.

## Last Completed Work
- Job 216, "Scout's what should I do today? agrees with Home" (CLAUDE.md § Scout's today answer agrees with Home): t1
  today helpers, t4 the limit path, t2 the handler's card/override, t3 the "From your plan" card, t5 the rehearsal
  (`tools/preview-onboarding.cjs` runs the REAL `api/scout.js` handler against its store and a scripted model; drives
  `scouttoday`, `scoutinvent`, `scoutlimit`, `scoutlast`; browser runs of 2026-11-13 at 390/1280 dark, in git history).
- t6 (this step), 2026-11-14: four runs side by side (390x844 and 1280x800, dark and light), each with its own fresh
  preview server and Chrome profile, in one `"$AVA_RUN" --timeout 1200` call (71 s, load average 43-48). Each run:
  `node tools/run-onboarding-chrome.cjs --width <390|1280> --theme <dark|light> --no-sandbox --chrome
  ~/Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/headless_shell --out
  node_modules/.cache/t6r3/shots "drive=goal" "drive=scouttoday&model=honest" "drive=scoutinvent&model=date"
  "drive=scoutinvent&model=step" "drive=scoutlast&last=1" "drive=scoutlimit&limit=1"` (Chromium 141 headless shell).
  24/24 `drive done`, every runner exited 0, and every width and theme gave the same result:

  | page | what the title and server log showed | ms 390d/390l/1280d/1280l |
  |---|---|---|
  | goal | Check-in > Home (set-goal card) > GoalSetup > Home; TODAY 0/1, THIS WEEK 0/3 | 8749/8783/8799/8750 |
  | scouttoday honest | home 0/1, 0/3 = card 0/1, 0/3; card step = Home's Today step*; override: no; 2 left; box open | 13585/13592/13591/13586 |
  | scoutinvent date | override: yes; bubble `Today: "<step>". This week: 0 of 3 done.` (model added "Have it done by 2027-02-07.") | 7826/7710/7787/7866 |
  | scoutinvent step | override: yes; the same bubble (model said `Today: "Run a 10 km time trial"...`) | 4963/5025/4980/4735 |
  | scoutlast last=1 | answer + card 0/1, 0/3; then usage: 0 left; limitCard: yes; box closed | 5603/5578/5004/5227 |
  | scoutlimit limit=1 | 402, 0 model calls, no card; "You've used today's Scout questions. 0 of 3 left today. More tomorrow."; 0 left; limitCard: yes; box closed | 6524/6680/5105/6478 |

  \* and `<step>`: "Ask Scout what to focus on this week". Home's Today tile, its Today view (`labels: 1/7 on screen`)
  and the card all name it. Every page: `doc` = width/width and `pastEdge` 0, the 390 Scout screen with the card too.
  The only console error was the app's own "GOLSZ scout send failed: ... More tomorrow." on scoutlimit. The only failed
  request was Google Fonts (no internet). Server: `scout 200 model=honest card=today 0/1, week 0/3 override=no
  usage=2/3 calls: 29 store, 2 model, 0 refused`; date and step the same with `override=yes`; last `usage=0/3`; limit
  `scout 402 ... card=none ... 0 model`. The handler's warning names kinds only (`{"kinds":["date"],...}`), never the
  reply. Screenshots opened, all right: 390 dark and light scouttoday, 390 dark scoutinvent date, 390 light scoutlimit.
  Attempt 2's sequential run failed 4/24 pages whose first screen took over 30 s; `BOOT_MS` (90 s, 319be00) fixed that.
- AVA's browser tool, the same day, one call and one server per theme, from the plain shell: `"$AVA_BROWSER" --serve
  "node tools/preview-onboarding.cjs <port> > <log> 2>&1" --port <port> --widths 390 "/golsz-app.html?theme=<t>&drive=goal"
  "/golsz-app.html?theme=<t>&drive=scouttoday&model=honest"`. Both themes: `drive done`, home = card (0/1, 0/3, the
  same step), `override: no`, 390/390, no overflow, 0 console errors; the light screenshot reads right. The card page's
  flags are all older parts. Dark: 1 low contrast (10 px message time, 3.76:1) and 1 unlabeled control (t5 saw it
  without the card too). Light: the message time (3.1:1), the three reply chips (12 px, 3.02:1), and a 10 px span at
  3.02:1 that light Home shows too.

## Current Work
Job 216: AVA's security review, regression run and final verification (t1-t6 done).

## Remaining Tasks
- Job 216, saved for later: keep the card when a chat is reopened from History (scout_history keeps text only);
  list this week's other steps by name on Home (open product question from job 199).
- OWNER (product, from job 199): right after "Build my plan", and on the day's first open, the daily check-in covers
  Home until the athlete answers or taps "Skip for today". Decide whether to skip it that day.
- Migration 165 (job 184, merged) NOT YET APPLIED: run in the SQL Editor (checks + rollback in its header).
- OWNER: one real Basic purchase; send LEGAL-REVIEW-BRIEF.md to counsel; admin MFA (OWNER-RUNBOOK.md section 8).
- OWNER/dashboard: Vercel Hobby->Pro (monitor); backups/PITR+restore drill; portal plan switching; checkout redirect;
  uptime probe; Elite benefit; French marketing; legal entity. Agent-doable: ADS Phase 6 4-5; Reschedule/Drop from
  Home; `removed_at` on stages; self-host fonts+CDN libs (CSP); admin RPC for `stripe_pending_plans`; Targets summary;
  the default focus ring on the other dialogs' panels; Scout's timestamp and light-theme chip contrast.

## Important Architecture Decisions
- Push to `main` = production deploy; Vercel buildCommand (`npm run check` first) is the gate.
- JSX compiled at author time to committed `js/app.js` (`npm run compile`). Migrations numbered, run by hand.
- 12-function Vercel ceiling (`_`-prefixed `api/` are shared modules). Adults only.

## Latest Test / Build Status
2026-11-14 (job 216 t6), through `$AVA_RUN`: `node tests/run-all.cjs preview_onboarding` 198/198,
`node tests/run-all.cjs static_cache_headers` 11/11, `node --check` on both tools. The browser run above. Full
`npm run check`: AVA's run.

## Known Problems
- health-alert runs every 2.1-7.5 h, not 15 min. Payments live but no real purchase; webhook secret unverified.
- Admin MFA: owner not enrolled. Signup has NO bot protection (Supabase CAPTCHA off, `TURNSTILE_SITE_KEY` empty).
- Preview tool: with `&today=` the page's `Date.now` is fixed, so a stuck drive never says FAILED (the runner then
  reports "no drive result"). The scout drives are run without it.
- UNVERIFIED (job 216): the live Anthropic model (replies were scripted) and live Supabase; fr/es/el in a browser; a
  real phone; Safari, Firefox, Google Chrome itself; a screen reader; the web fonts. Job 199: real fonts and live
  Supabase on a real phone.

## Next Recommended Action
Job 216: AVA's security review, regression and final verification. Then the saved-for-later items above.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
