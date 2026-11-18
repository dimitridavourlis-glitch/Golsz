# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
QA agent (AVA job 235, t4-r3-1: Node suite for standalone detection + full-screen rules), 2026-11-18.
Before: QA agent (job 235, t3: prove every main step fits a 390px phone), 2026-11-16;
Frontend engineer (job 235, t2: accessible names + visible focus on Home/Passport/Scout), 2026-11-16;
Frontend engineer (job 235, t1: PWA install + iPhone notification copy), 2026-11-16;
Claude Code (job 216, final verification), 2026-11-14.

## Current Branch
`ava/235-every-step-works-comfortably-on-a-phone-` (branched from origin/main, fc303bb). Jobs 216 and earlier are
merged to origin/main; diff this job against origin/main.

## Last Completed Work
- **Job 235 t4-r3-1 — the installed app's full-screen rules, pinned in Node (no browser).** New
  `tests/test_installed_fullscreen.cjs` (38 assertions) lifts the REAL isIOSDevice/isStandaloneDisplay/pushSupported/
  urlBase64ToUint8Array/enablePushNotifications/notifErrorText and `I18N` out of golsz-app.jsx and runs them on an
  iPhone stand-in: `(display-mode: standalone)` matching or `navigator.standalone === true` = installed, a Safari tab
  (`standalone` false) is not; installed -> requestPermission, register /sw.js, subscribe, store; tab -> throws
  IOS_NEEDS_HOMESCREEN with 0 of those calls, and that thrown error reads as `notif_ios_homescreen` in en/fr/es/el.
  Source pins: viewport-fit=cover; manifest display standalone; `#root` min-height and `.app-shell` height END UP
  100dvh (last declaration of a top-level rule); the one `.app-shell` element (in GolszApp, no inline height) has a
  `<header>` padded by env(safe-area-inset-top) and a `<nav>` by env(safe-area-inset-bottom). No app code changed.
  **Mutant run 2026-11-18** (`node_modules/.cache/fs-mutant/run.cjs`, one edit per copy of jsx/html/manifest):
  unedited control 38/38; each of 10 mutants failed: viewport-fit removed 37/38; #root 100dvh removed 37/38;
  .app-shell 100vh after 100dvh 37/38; header inset removed 37/38; nav inset removed 37/38; manifest minimal-ui
  37/38; display-mode ignored 32/38; tab counted as installed 24/38; iOS guard removed 26/38; notifErrorText's iOS
  branch broken 30/38. **UNVERIFIED here:** a real iPhone launch from the Home Screen (t4-r3-2 records a headless run).
- **Job 235 t3 — every main step fits a 390px phone, and the detector can fail.** Added `tools/_phone-measure.cjs`
  (pure, DOM-free rules: `pastRightEdge`, `clippedButtons`, `screenVerdict`, `browserMeasure`, `measureExpression`),
  `tests/test_phone_main_path.cjs` (23 assertions: good fixture passes; a 2000px bar + a button clipped by its scroll
  container are flagged; the Node suite also runs the exact expression injected into Chrome), and
  `tools/check-phone-main-path.cjs`. The checker starts the three existing preview servers (onboarding, targets,
  shared Passport — stand-in auth/store, nothing live), walks the whole brief in order in headless Chrome at 390x844,
  and requires per screen: document scrollWidth == innerWidth, zero visible elements past the right edge, zero buttons
  clipped by an overflow ancestor. It waits for each screen's own content (the targets preview expands "Schools &
  clubs" asynchronously; Auth and PublicPassport render outside `<main>`, so readiness reads `#root`).
  **Recorded run 2026-11-16**, Chromium 141 headless shell, 390x844, dark and light (one fresh server set per theme):
  all 7 steps in both themes — Sign up (Auth), Passport after sign-up, Goal setup, Home with the dated plan,
  Scout with the "From your plan" card (TODAY 0/1, THIS WEEK 0/3), target clubs (3 rows expanded), signed-out shared
  Passport — read `doc 390/390`, `pastCount 0`, `clippedCount 0`, pass=true. Screenshots in
  `node_modules/.cache/phone-main-path/`. Positive control: a real 2000px bar injected into the live page flips the
  verdict pass -> fail ("1 visible element(s) past the right edge") and back to pass on removal, in both themes.
  No golsz-app.jsx / CSS change was needed — no overflow was found. Bar injected inside an `overflow:hidden` wrapper
  so Chrome's mobile layout viewport stays 390 (a body-level bar widens `innerWidth` under mobile emulation).
  **UNVERIFIED:** a real phone; Safari/Firefox/Google Chrome (headless shell only); live Supabase rows (preview store);
  web fonts (no internet, fallback metrics); a screen reader; geometry only — tiny text/contrast are other suites.
- **Job 235 t2 — every icon-only control on Home/Passport/Scout is named, Tab shows a ring.** Added translated
  `aria-label` to the five title-only icon buttons on those screens: Passport remove-photo (`passport_photo_remove`),
  Scout History (`scout_history_title`), Scout attach-photo (`scout_attach_photo`), Scout attached-photo remove
  (`feed_remove_photo`), Scout Send (`a11y_send`). All five keys already exist in en/fr/es/el — reused them rather than
  adding duplicate keys; no raw English introduced. Extended tests/_app_mount.cjs with stand-in useCallback/useMemo
  (HomeTab's React.useCallback) — harmless to the two suites that already use it.
- New `tests/test_a11y_three_screens.cjs` (52 assertions): mounts the REAL HomeTab/Passport/Scout through
  `_app_mount.cjs` in loading, loaded/empty and error states, recursively mounts nested component elements, and asserts
  every rendered `<button>`/`[role=button]` has a name from aria-label / aria-labelledby target / visible text — NOT
  title (a title-only control fails). Covers ProfileEditor + both goal cards mounted directly, and Scout's history
  panel with its two-tap delete row driven through the real History button. Also pins the global `:focus-visible`
  rule (covers a/button/input/select/textarea/[role=button]/[tabindex], excludes tabindex=-1, both declarations
  `!important`, uses `${C.lime}`), and checks the five keys resolve in all four dictionaries. Negative control:
  removing one aria-label made 7 assertions fail; restored.
- Recorded browser check `tools/record-a11y-focus.cjs` (headless Chromium 141 shell, preview-onboarding stand-in
  store, one server per width, `--no-sandbox`): 390x844 and 1280x800, dark. Seeded with `drive=goal`, then Tab through
  Home (`drive=home`), Passport (`page=profile`), Scout (`page=scout`). All 6 screens: focused control inside `main`
  had `matches(':focus-visible')=true` and computed `outline: solid 2px rgb(212, 175, 55)` (gold) at 2px offset —
  390: "1 to doToday…" / "Share" / "Attach a photo"; 1280: "Back" / "Share" / "Attach a photo". Screenshots under
  `node_modules/.cache/a11y-focus/`. Chrome had no internet (web fonts not loaded) and no real Supabase.
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
Job 235 t4 in progress: t4-r3-1 done (Node suite test_installed_fullscreen + mutant run). Next: t4-r3-2 (recorded
headless run, one standalone page at 390x844), t4-r3-3 (record + cross-reference + UNVERIFIED), then
security/regression/final.

## Remaining Tasks
- Job 235: t4, security, regression, final. UNVERIFIED from t1: a real iPhone / Safari adding to Home Screen and
  the install-first notice in a browser. From t2: a real screen reader (the recording reads the browser's own
  :focus-visible + computed outline and the mounted tree's accessible names, not an AT); Safari/Firefox; web fonts
  (no internet in the recording); a real phone. From t3: a real phone; Safari/Firefox/Chrome; live Supabase rows;
  web fonts; a screen reader. The five aria-labels reuse existing translated keys rather than new a11y-specific
  keys — they are still translated in all four languages.
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
2026-11-18, job 235 t4-r3-1 tree (no JSX/CSS/HTML changed, so no compile): through AVA's runner with
`TMPDIR=/private/tmp`, `node tests/run-all.cjs installed_fullscreen` 38/38 and `node tests/run-all.cjs pwa_install_ios`
60/60. Full `npm run check` not run in this step (AVA runs it).
2026-11-16, job 235 t3 tree: no JSX/CSS changed, so no `npm run compile` needed (compiled artifacts still current).
Full `npm run check` GREEN: **147/147 suites, 7,634 assertions** (new `test_phone_main_path` 23/23) — run directly
with node (no `$AVA_RUN` in this session) with `TMPDIR=/private/tmp` (this shell's TMPDIR points inside the worktree and
test_unpublish_internal then copies the repo into itself; AVA's runner has a different TMPDIR). Recorded
`node tools/check-phone-main-path.cjs --width 390 --theme <dark|light> --no-sandbox`: 7/7 steps pass in both themes,
positive control pass -> fail -> pass; screenshots in node_modules/.cache/phone-main-path/.
2026-11-16, job 235 t2 tree: `npm run compile` run after the JSX edits (fresh js/app.js + js/i18n/*.js;
test_compiled_artifact 17/17). Full `npm run check` GREEN: 146/146 suites, 7,611 assertions — run directly with node
(no `$AVA_RUN` in this session) with `TMPDIR=/private/tmp` because this shell's TMPDIR points inside the worktree and
test_unpublish_internal then copies the repo into itself; AVA's runner has a different TMPDIR. Targeted suites also
green: test_a11y_three_screens 52/52, test_pwa_install_ios 60/60, test_anchor_integrity 4/4, test_boot_nonblocking
24/24, test_first_screen_design 78/78, test_scout_today_card 139/139, test_scout_limit_path 81/81.
`node tools/record-a11y-focus.cjs` at 390 and 1280: all 6 screen/width combinations showed a gold 2px :focus-visible
ring inside `main` (screenshots in node_modules/.cache/a11y-focus/).

## Known Problems
- health-alert runs every 2.1-7.5 h, not 15 min. Payments live, no real purchase; webhook secret unverified. Admin MFA:
  owner not enrolled. Signup has NO bot protection (CAPTCHA off). Preview `&today=` fixes Date.now: no FAILED on a stall.
- UNVERIFIED (jobs 199, 216): live Anthropic model (replies scripted) and live Supabase; Scout's today answer and card
  in fr/es/el (the drives read English labels); the new layout on a Vercel preview or golsz.com; AVA's own speed script
  (timed out 4/4 in attempt 3 at load ~40); a real phone; Safari, Firefox, Google Chrome; a screen reader; web fonts.

## Next Recommended Action
AVA verifies t4-r3-1 (test_installed_fullscreen + mutant run), then t4-r3-2 (headless standalone page at 390x844),
t4-r3-3, then the job's security/regression/final steps.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
