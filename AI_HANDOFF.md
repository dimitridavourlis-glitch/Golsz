# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
Frontend engineer (AVA job 235, t1: PWA install metadata + iPhone notification copy), 2026-11-16.
Before: Claude Code (job 216, final verification), 2026-11-14.

## Current Branch
`ava/235-every-step-works-comfortably-on-a-phone-` (branched from origin/main, fc303bb). Jobs 216 and earlier are
merged to origin/main; diff this job against origin/main.

## Last Completed Work
- **Job 235 t1 — installable on a phone, iPhone notification copy.** `manifest.json`: standalone, start_url in scope,
  name/short_name/description, 192px + 512px PNG icons generated from the committed 1024px art
  (`assets/icon-192.png`, `assets/icon-512.png`). JSX: added one `notifErrorText(e, t)` mapper and a `NotificationBell`
  header toggle (desktop sidebar + mobile top bar); SettingsButton's catch now uses the same mapper, so both surface
  `notif_ios_homescreen` on the iOS-non-standalone error. Four translations already present, unchanged. Head keeps
  viewport-fit=cover / apple-mobile-web-app-capable / apple-touch-icon / manifest link; sw.js registered before
  subscribe. `npm run compile` run; committed js/app.js + js/i18n/*.js refreshed (test_compiled_artifact 17/17).
- New `tests/test_pwa_install_ios.cjs` (60 assertions): manifest + head pinning, real push helpers run under iOS
  stand-ins (guard throws before requestPermission/subscribe; standalone passes), both components driven in
  `_app_mount.cjs`, translations checked. `tools/record-ios-install-notice.cjs` drives the real guard + real
  SettingsButton under an iOS UA: install message shown, 0 permission prompts/subscribes/registers.

- Job 216 (CLAUDE.md § Scout's today answer agrees with Home): t1-t5 built it, t6 recorded it. Final-verification
  restructure (270144e): AVA's speed check measured the repo's 1.5 MB page while Vercel split, compiled and stripped it at
  deploy; now the JSX is golsz-app.jsx, `npm run compile` writes the committed js/app.js and js/i18n/{fr,es,el}.js.
- Browser run on 9fd6819 (code unchanged since: `git diff --name-only 9fd6819 HEAD` lists .md only), Chromium 141 headless
  shell, ONE `"$AVA_RUN" --timeout 1200 bash node_modules/.cache/f4/drives.sh` (35 s): four runs side by side (390x844,
  1280x800; dark, light), each with its own server and Chrome profile: `node tools/run-onboarding-chrome.cjs --width <w>
  --theme <t> --no-sandbox --chrome ~/Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/headless_shell
  --out node_modules/.cache/f4/<w><t> "drive=goal" "drive=scouttoday&model=honest" "drive=scoutinvent&model=date"
  "drive=scoutinvent&model=step" "drive=scoutlast&last=1" "drive=scoutlimit&limit=1" "drive=signup" "drive=passport"
  "drive=full" "lang=fr"`. 36/36 `drive done`, every runner exit 0, all four the same:

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

  \* and `<step>`: "Ask Scout what to focus on this week". Every page doc = width/width, pastEdge 0; console errors only the
  app's own "GOLSZ scout send failed: ... More tomorrow." (scoutlimit); failed requests only Google Fonts (no internet).
- Languages, signed out: `"$AVA_BROWSER" --serve "node node_modules/.cache/f4/fr-server.cjs <port>" --port <port> --widths
  390,1280 /golsz-app.html?lang=fr ...?lang=es ...?lang=el` (preview-onboarding's handler, logging each request): 6/6 loaded,
  0 console errors, no overflow, each fetched only its own `js/i18n/<lang>.js` (200); French, Spanish, Greek, no raw keys.
- Speed (tools/time-first-screen.cjs via the browser tool, vs d7a6e8e): app mounted 390/1280 3347/2452 -> 1090-1107/
  1077-1124 ms (French 2487/2476 -> 1118/1152); LCP 2540-3404 -> 1128-1248; CLS 0. CLAUDE.md § First-screen speed.
- Security review of the whole job (AVA's own ran out of steps on part 3 of 6). `git diff -C -C 0b8e891 HEAD --
  golsz-app.html golsz-app.jsx` shows golsz-app.jsx as a 98% copy of the old page, 452 changed lines (a plain diff: 20,353
  new); js/app.js and js/i18n/*.js are generated and test_compiled_artifact.cjs fails on any drift. No finding: card and
  bubble are React text (step names via a replacer function); dictionary URL from a fixed four; requestId and lang
  validated; a today question skips the shared FAQ and cache; logs hold kinds only; `todayAnswer` is per request; the limit
  refuses before any write or model call and releases only a slot it took; no new endpoint; CSP unchanged; no secret
  shipped (VAPID public key only, as on main); preview server on 127.0.0.1, repo files only, stand-in keys, other hosts
  refused. Crafted input at the caps: isTodayQuestion <= 8.3 ms (4,000 chars), checkReplyAgainstPlan <= 73 ms (20,000).

## Current Work
Job 235 t1 done (PWA install + iOS notification copy). Next in this job: t2 (label Home/Passport/Scout buttons and show
focus), t3 (prove every main step fits a phone), t4 (installed app fills the phone screen), then security/regression/final.

## Remaining Tasks
- Job 235: t2, t3, t4, security, regression, final. UNVERIFIED from t1: a real iPhone / Safari adding to Home Screen and
  the install-first notice in a browser — this session had no AVA browser tool or iOS UA, so the recorded run drives the
  real guard + real component in Node instead. The install look itself still needs AVA's browser check on a phone size.
- Job 216, later: the card on a chat reopened from History; this week's other steps by name on Home (product question).
  api/scout.js reserves the question (t4) ~480 lines above the `try` whose catch refunds it; that stretch only builds
  the prompt (its one await catches its own errors), but an unexpected throw there would cost a question. Wrap it.
- OWNER: the daily check-in covers Home right after "Build my plan" (skip it that day?); migration 165 NOT YET APPLIED;
  one real Basic purchase; LEGAL-REVIEW-BRIEF.md; admin MFA; Vercel Pro; PITR drill; portal plan switching; uptime probe.
- Agent-doable: ADS Phase 6 4-5; Reschedule/Drop from Home; `removed_at` on stages; self-host fonts+CDN libs (CSP);
  admin RPC for `stripe_pending_plans`; Targets summary; other dialogs' focus ring; Scout timestamp/chip contrast.

## Important Architecture Decisions
- Push to `main` = production deploy; buildCommand `npm run check && npm run unpublish` (the suite is the gate). App JSX
  in golsz-app.jsx, compiled at author time to committed js/app.js + js/i18n/*.js. Migrations run by hand. 12-function
  Vercel ceiling (`_`-prefixed `api/` are shared modules). Adults only.

## Latest Test / Build Status
2026-11-16, job 235 t1 tree: `npm run compile` run (fresh js/app.js + js/i18n/*.js). Targeted suites, all green run
directly with node (no `$AVA_RUN` in this session): test_pwa_install_ios 60/60, test_compiled_artifact 17/17,
test_boot_nonblocking 24/24, test_first_screen_design 78/78, test_served_bundle 35/35, test_static_cache_headers 11/11.
`node tools/record-ios-install-notice.cjs`: PASS (install msg shown, 0 prompts/subscribes). Full `npm run check` still
to be run on the final tree by AVA; baseline was 144/144 suites, 7,499 assertions on 2026-11-14.

## Known Problems
- health-alert runs every 2.1-7.5 h, not 15 min. Payments live, no real purchase; webhook secret unverified. Admin MFA:
  owner not enrolled. Signup has NO bot protection (CAPTCHA off). Preview `&today=` fixes Date.now: no FAILED on a stall.
- UNVERIFIED (jobs 199, 216): live Anthropic model (replies scripted) and live Supabase; Scout's today answer and card
  in fr/es/el (the drives read English labels); the new layout on a Vercel preview or golsz.com; AVA's own speed script
  (timed out 4/4 in attempt 3 at load ~40); a real phone; Safari, Firefox, Google Chrome; a screen reader; web fonts.

## Next Recommended Action
AVA verifies t1, then t2 (button labels + focus) begins. Then t3/t4 and the job's security/regression/final steps.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
