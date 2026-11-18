# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
QA agent (AVA job 235, t4-r3-3: recorded the installed-app run, push cross-reference, UNVERIFIED list), 2026-11-18.
Before: QA agent (t4-r3-2, t4-r3-1, t3), Frontend engineer (t2, t1), 2026-11-16..18; Claude Code (job 216), 2026-11-14.

## Current Branch
`ava/235-every-step-works-comfortably-on-a-phone-` (from origin/main fc303bb); diff this job against origin/main.

## Last Completed Work
- **Job 235 t4: the installed app fills a 390x844 iPhone screen** (CLAUDE.md § "The installed app fills an iPhone
  screen"). `tests/test_installed_fullscreen.cjs` (38; 10/10 mutants failed), `tools/record-installed-fullscreen.cjs`,
  verdict `tools/_installed-fullscreen.cjs` + `tests/test_installed_fullscreen_verdict.cjs` (28). No app code changed.
- **Run 2026-11-18.** Step 2 (t4-r3-2) ran `"$AVA_RUN" --timeout 280 bash -c 'node tools/record-installed-fullscreen.cjs
  --no-sandbox; node tools/record-installed-fullscreen.cjs --no-sandbox --theme light'` (29 s, exit 0). t4-r3-3 ran the
  same two, then `node tools/record-ios-install-notice.cjs` and the suites, as `"$AVA_RUN" --timeout 400 bash
  node_modules/.cache/t4r33/run.sh`: `[ava-run: exit 0, 34 s]`, every command exit 0. Its output, dark and light the
  same (HeadlessChrome/141.0.7390.37, iPhone iOS 17.5 UA, insets 47/34; step 2 recorded the same numbers):
  - `standalone` pass: isStandaloneDisplay true (matchMedia false, navigator.standalone true); inner 390x844, doc
    390/390, root and shell 844/844; env 47/34; headerPadTop 59, navPadBottom 46; underTopInset [] of 14 checked.
  - control (label at top 8px + header padding 12px): failed with "header top padding 12px is less than the 47px top
    inset" and "9 visible item(s) start under the 47px top inset"; passed again once undone.
  - `tab` pass: isStandaloneDisplay false; env 0/0; paddings 12/12; doc 390/390; root and shell 844/844; 16 checked.
  - Screenshots opened: `node_modules/.cache/installed-fullscreen/1-standalone-390x844-{dark,light}.png` (59px top band).
- **Chrome 141 emulation:** supported `Emulation.setDeviceMetricsOverride` (mobile), `setUserAgentOverride` (iPhone),
  `setSafeAreaInsetsOverride` (env() 47/34). `Emulation.setEmulatedMedia` display-mode=standalone is accepted but NOT
  applied, so the tool sets `navigator.standalone=true` via `Page.addScriptToEvaluateOnNewDocument` and prints that.
- **Push, installed vs tab:** installed iPhone -> requestPermission, register /sw.js, subscribe
  (`tests/test_pwa_install_ios.cjs` lines 137-145, `tests/test_installed_fullscreen.cjs`); Safari tab ->
  `IOS_NEEDS_HOMESCREEN` first, shown as `notif_ios_homescreen` (en/fr/es/el). `tools/record-ios-install-notice.cjs`
  (real SettingsButton + guard, iOS UA): installMessageShown true, genericErrorShown false, calls [], RESULT: PASS.
  Push is proven in Node with stand-ins only; the Chrome run reads isStandaloneDisplay() and sends no push.
- **UNVERIFIED (t4):** real iOS Safari; a real iPhone "Add to Home Screen" and launch; real notch and home-indicator
  insets (47/34 are an iPhone 14's, emulated); status-bar styling (`black-translucent`: clock and battery over the page,
  which is cream in the light theme; readability unchecked); Apple's Web Push service; web fonts (no internet).
- **t3:** `tools/check-phone-main-path.cjs` (+ `_phone-measure.cjs`, `test_phone_main_path.cjs` 23), 2026-11-16, 390x844
  dark/light: all 7 main-path steps doc 390/390, 0 past the edge, 0 clipped; a 2000px bar flipped pass -> fail -> pass.
- **t2:** translated `aria-label`s on five Passport/Scout icon buttons; `test_a11y_three_screens.cjs` (52);
  `tools/record-a11y-focus.cjs` (390, 1280): Home/Passport/Scout focus shows a solid 2px gold :focus-visible outline.
- **t1:** manifest 192/512px icons; `notifErrorText` shared by the new header `NotificationBell` and `SettingsButton`;
  `test_pwa_install_ios.cjs` (60). Job 216 is on origin/main; its runs: CLAUDE.md § "Recorded run 2026-11-14 (t6)".

## Current Work
Job 235's build steps (t1-t4) are done; CHANGELOG.md has the job's 2026-11-18 entry.

## Remaining Tasks
- Job 235: security review, full regression run, final verification. UNVERIFIED across the job: a real phone, Safari,
  Firefox, Google Chrome (all runs: Chromium's headless shell), a screen reader, live Supabase rows, web fonts.
- Job 216, later: the card on a chat reopened from History; this week's other steps by name on Home (product question);
  wrap api/scout.js's prompt build (after the question is reserved) in the `try` that refunds it.
- OWNER: the daily check-in covers Home right after "Build my plan" (skip it that day?); migration 165 NOT YET APPLIED;
  one real Basic purchase; LEGAL-REVIEW-BRIEF.md; admin MFA; Vercel Pro; PITR drill; portal plan switching; uptime probe.
- Agent-doable: ADS Phase 6 4-5; Reschedule/Drop from Home; `removed_at` on stages; self-host fonts+CDN libs (CSP);
  admin RPC for `stripe_pending_plans`; Targets summary; other dialogs' focus ring; Scout timestamp/chip contrast.

## Important Architecture Decisions
- Push to `main` = production deploy; buildCommand `npm run check && npm run unpublish` (the suite is the gate). App JSX
  in golsz-app.jsx, compiled to committed js/app.js + js/i18n/*.js. Migrations run by hand. Adults only.

## Latest Test / Build Status
2026-11-18, t4-r3-3 (docs only, no compile needed), suites with `TMPDIR=/private/tmp`, again after the doc edits:
installed_fullscreen 38/38 + installed_fullscreen_verdict 28/28, pwa_install_ios 60/60, phone_main_path 23/23,
anchor_integrity 4/4, static_cache_headers 11/11 (reads CLAUDE.md). Full `npm run check` left to AVA's end-of-job run.

## Known Problems
- health-alert runs every 2.1-7.5 h, not 15 min. Payments live, no real purchase; webhook secret unverified. Admin MFA:
  owner not enrolled. Signup has NO bot protection (CAPTCHA off). Preview `&today=` fixes Date.now: no FAILED on a stall.
- UNVERIFIED (jobs 199, 216): live Anthropic model and Supabase; Scout's today card in fr/es/el; golsz.com itself.

## Next Recommended Action
AVA's security review, full regression run and final verification for job 235.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
