# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
Claude Code (AVA job 216, final verification attempt 4: browser run on the final commit), 2026-11-14. Job 216's t1-t6
were Claude Code too. Before job 216: OpenCode (job 199, final verification), 2026-11-10.

## Current Branch
`ava/216-scout-s-what-should-i-do-today-agrees-wi` (AVA job 216; AVA commits each step, then merges). Branched from
0b8e891, where job 199 (sign-up to a dated plan) was merged as #15.

## Last Completed Work
- Job 216 (CLAUDE.md § Scout's today answer agrees with Home): t1-t5 built it, t6 recorded it in a browser before the
  restructure below (24/24 pages; table in d7a6e8e's AI_HANDOFF.md).
- Final-verification restructure (270144e, docs 9fd6819): AVA's speed check serves the repo as it is, and the repo's page
  was 1.5 MB (the app's JSX sat in it, inert) while Vercel split, compiled and stripped it at deploy, so the page measured
  was not the page served. Now the JSX is golsz-app.jsx; `npm run compile` writes the committed js/app.js (English only)
  and js/i18n/{fr,es,el}.js; buildCommand is `npm run check && npm run unpublish`. CLAUDE.md § The app, § THE DEPLOY GATE.
- Browser run on the final commit 9fd6819, Chromium 141 headless shell: ONE `"$AVA_RUN" --timeout 1200 bash
  node_modules/.cache/f4/drives.sh` (35 s, load average 3-5) ran four runs side by side (390x844 and 1280x800, dark and
  light), each with its own fresh preview server and Chrome profile: `node tools/run-onboarding-chrome.cjs --width <w>
  --theme <t> --no-sandbox --chrome ~/Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/headless_shell
  --out node_modules/.cache/f4/<w><t> "drive=goal" "drive=scouttoday&model=honest" "drive=scoutinvent&model=date"
  "drive=scoutinvent&model=step" "drive=scoutlast&last=1" "drive=scoutlimit&limit=1" "drive=signup" "drive=passport"
  "drive=full" "lang=fr"`. 36/36 drives `drive done`, every runner exited 0, all four widths/themes the same:

  | page | result | ms 390d/390l/1280d/1280l |
  |---|---|---|
  | goal | Check-in > Home (set-goal card) > GoalSetup > Home; TODAY 0/1, THIS WEEK 0/3; next: the step* | 3831/3565/3315/3359 |
  | scouttoday honest | home 0/1, 0/3 = card 0/1, 0/3; card step = Home's*; override: no; 2 left; box open | 2281/2024/2287/2279 |
  | scoutinvent date | override: yes; bubble `Today: "<step>". This week: 0 of 3 done.` replaced "...Have it done by 2027-02-07." | 2027/2032/2027/2043 |
  | scoutinvent step | override: yes; the same bubble replaced `Today: "Run a 10 km time trial"...` | 2275/2279/2027/2023 |
  | scoutlast last=1 | answer + card 0/1, 0/3, then 0 left, limit card, no text box | 2029/2025/2277/2026 |
  | scoutlimit limit=1 | 402, 0 model calls, no card; "You've used today's Scout questions. 0 of 3 left today. More tomorrow."; 0 left; limit card; no text box | 2289/2033/2039/2294 |
  | signup; passport; full | Auth > Passport editor; Passport editor > GoalSetup; Auth > Passport editor > GoalSetup > Home (0/1, 0/3) | 589-879; 528-770; 2851-3216 |
  | lang=fr, no drive | signed-in Home in French ("Salut Test !", "Aujourd'hui", "1 à faire", "Écoles", "Accueil") | load 253-256 |

  \* and `<step>`: "Ask Scout what to focus on this week". Every page: doc = width/width, pastEdge 0. Console errors:
  only the app's own "GOLSZ scout send failed: ... More tomorrow." on scoutlimit. Failed requests: only Google Fonts (no
  internet). Server lines identical in all four (`scout 200 model=honest card=today 0/1, week 0/3 override=no usage=2/3
  calls: 29 store, 2 model, 0 refused`; date, step `override=yes`; last `usage=0/3`; limit `scout 402 ... card=none ...
  0 model`); the handler's warnings name kinds only. Screenshots opened, all right: 390 dark scouttoday, scoutinvent
  date, lang=fr; 390 light scoutlimit; 1280 light scouttoday, lang=fr.
- Languages, AVA's browser tool from the plain shell (fresh server, signed out): `"$AVA_BROWSER" --serve "node
  node_modules/.cache/f4/fr-server.cjs <port> > node_modules/.cache/f4/lang.log 2>&1" --port <port> --widths 390,1280
  /golsz-app.html?lang=fr ...?lang=es ...?lang=el` (fr-server.cjs: preview-onboarding's handler + a line per request).
  6/6 loaded, 0 console errors, no overflow; each fetched `js/app.js?v=a62778635c825de4` and only its own
  `js/i18n/<lang>.js?v=a62778635c825de4`, all 200. Sign-up read French, Spanish, Greek (all six screenshots opened), no
  raw key names. Only flag: 1 unlabeled control, the sign-up honeypot (`name="website"`, aria-hidden, by design).
- Speed (tools/time-first-screen.cjs through the browser tool, back to back with d7a6e8e's tree): app mounted at 390/1280
  3347/2452 ms before (French 2487/2476), 1090-1107/1077-1124 after (French 1118/1152); LCP 2540-3404 -> 1128-1248; CLS 0.
  Commands and the caveat: CLAUDE.md § First-screen speed.

## Current Work
Job 216: final verification attempt 4 done (browser run, languages, speed, gate). AVA's checks and review next.

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
- Push to `main` = production deploy; buildCommand `npm run check && npm run unpublish` (the suite is the gate).
- App JSX in golsz-app.jsx, compiled at author time to committed js/app.js + js/i18n/*.js. Migrations run by hand.
- 12-function Vercel ceiling (`_`-prefixed `api/` are shared modules). Adults only.

## Latest Test / Build Status
2026-11-14, final commit 9fd6819, through `$AVA_RUN`: `npm run check` passed, 144/144 suites, 7,499 assertions (32 s).

## Known Problems
- health-alert runs every 2.1-7.5 h, not 15 min. Payments live but no real purchase; webhook secret unverified.
- Admin MFA: owner not enrolled. Signup has NO bot protection (Supabase CAPTCHA off, `TURNSTILE_SITE_KEY` empty).
- Preview tool: with `&today=` the page's `Date.now` is fixed, so a stuck drive never says FAILED.
- UNVERIFIED (jobs 199, 216): live Anthropic model (replies scripted) and live Supabase; Scout's today answer and card
  in fr/es/el (the drives read English labels); the new layout on a Vercel preview or golsz.com; AVA's own speed script
  (timed out 4/4 in attempt 3 at load ~40); a real phone; Safari, Firefox, Google Chrome; a screen reader; web fonts.

## Next Recommended Action
AVA's checks and review of job 216, then merge. Then the saved-for-later items above.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
