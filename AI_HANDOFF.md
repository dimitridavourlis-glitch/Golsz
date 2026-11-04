# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
Claude Code (AVA job 144, task t9), 2026-11-03. Before that: Claude Code, 2026-10-28.

## Current Branch
`main`. `scout-day-awareness` (af28c32) was fast-forwarded into `main` on 2026-10-28 at the owner's
request and is live: golsz.com `/api/geo` reported `af28c32f5154` 64 s after the push; check.yml green on
22.x and 24.x. (`landing-glow-path` before it: merged 2026-10-27.)

## Last Completed Work
- AVA job 168 t2 (2026-11-04): app libraries `defer`red, `js/app.js` preloaded, loader gated on DOMContentLoaded
  (`tests/test_boot_nonblocking.cjs`). AFTER figures (same tool, 150 ms / 1.6 Mbps, 390 px, signed out, one run;
  baseline in brackets): dark boot 827 [755], mounted 2916 [3717-3749], lcp 3028 [3840-3888]; light boot 477,
  mounted 2548. No console errors. `--fail-app` shows "Something stopped GOLSZ loading." + Reload; shared Passport
  `fixture=a` at 390 px renders. Not run: 1280 px, real phone CPU.
- AVA job 168 t1 (2026-11-04): `tools/time-first-screen.cjs` serves the repo at 150 ms RTT / 1.6 Mbps and prints
  `timing page=... fcp lcp boot mounted` per page load (run it with "$AVA_BROWSER" --serve, see its header).
  BEFORE figures (ms, 390 / 1280 px, two runs): home page LCP 648-760 / 552-648; app boot visible 755 / 748;
  app mounted (Auth screen) 3717-3749 / 3697-3727; app LCP ~3.85 s. All inside the budgets (home LCP 3000,
  boot 2500, mounted 5000) in this simulation: no real phone CPU, no Google Fonts. supabase-js keeps no
  integrity in the served copy (npm build differs from jsdelivr's); React/ReactDOM keep theirs.
- Job 144 t6, Scout history / Settings privacy / VerificationRequest load errors. Recorded browser run
  2026-11-03 (throwaway harness: served in-memory copy mounts the real component, stubbed Supabase fails the
  chosen tables). 390 and 1280 px, dark and light: Scout restore failure shows LoadError above the greeting,
  Retry clears it; after a failed restore, opening a chat from History removes the banner and shows THAT chat
  (reviewer's bug, fixed: newChat/loadConversation now clear restoreFailed); History list failure shows
  LoadError, not "no past chats"; Settings privacy failure shows LoadError, all 5 privacy toggles disabled
  (opacity 0.6), Retry re-enables them; VerificationRequest failure shows only LoadError + Retry. No sideways
  scroll anywhere. New chat after a failed restore was not clicked in the browser (button needs 2+ messages);
  the suite pins it.
- Job 144 t9, crash run. `tools/preview-public-passport.cjs` `&fixture=crash` makes PublicPassport throw in an
  in-memory copy; `&reload=1` presses Reload. Real browser, 390/1280 px, dark and light: "Something went wrong /
  Reload" screen readable, no blank page; server printed one `log_client_error auth=anon-key` per load and a second
  after Reload. Pinned in test_preview_public_passport.cjs (disk file unchanged). Not run: the admin Errors tab
  itself (needs an admin session). Read-failure rule and field-error helpers now documented in CLAUDE.md/AGENTS.md.
- Job 144 t8, Passport editor field errors (`profileFieldErrors`, golsz-app.html). Recorded browser run
  2026-11-03 (throwaway harness: a served in-memory copy mounts the real ProfileEditor with stubbed Supabase,
  presses Save, measures the DOM). 390 and 1280 px, dark and light, 3 cases: (a) empty name, (b) Player with
  height 1.8, GPA 7, grad year 2099, (c) Coach with no team. All 12: each message directly under its field, not
  clipped, no sideways scroll; focus on the first invalid field (name / grad year / club), below the sticky
  Save bar; field has aria-invalid and aria-describedby pointing at the message, which is read when focus lands;
  editing the field clears only its message. FOUND + FIXED: field messages (editor and sign-up) used C.amber,
  3.0:1 on the light sheet; now C.limeText (5.8:1 light, 9.4:1 dark), pinned in test_profile_field_errors.cjs.
  Not run: a real screen reader (VoiceOver); the sign-up form after the colour change (style-only change).
  Seen in passing (pre-existing, unchanged): a legacy Coach shows "Select..." in the I am a... dropdown,
  since OCCUPATIONS is ["Player"] only.
- ADS Phase 6, items 1, 2, 3 and 6 (`api/scout.js`; one-line client change in `golsz-app.html` + `js/app.js`):
  - `getAthleteState` reads are one `Promise.all` round (they were ten sequential round trips while the
    header claimed parallel). The sports lookup stays chained after the athletes read; failures are still
    named per table, in a fixed order.
  - Scout is told the athlete's day: the app sends `today` (its local `isoDay()`); `resolveAthleteDay()`
    accepts it only as a real date within one day of UTC, else uses UTC. `dayBuckets()` gives Home's
    numbers (due today, this week Mon-Sun, late) by Home's rules. New prompt line "TODAY FOR THEM"; the
    model is told to use only dates in its context. `due_in_days` now counts from that same day.
  - "Missed" uses the athlete's day and Home's resting rule (resting: only recovery steps can be late).
  - `responseCacheFingerprint` carries the day and a step digest (no replaying yesterday's reply).
  - Benchmark lines carry who measured them and the recorded protocol (`benchmarkProvenance()`).
- Suites: `test_scout_today.cjs`, `test_scout_benchmark_provenance.cjs` (new), plus three extended.

## Current Work
None in progress.

## Remaining Tasks
- OWNER (OWNER-RUNBOOK.md): one real Basic purchase; send LEGAL-REVIEW-BRIEF.md to counsel.
- OWNER: admin MFA, OWNER-RUNBOOK.md section 8: enrol an authenticator in the Admin Panel, test a
  password-only sign-in, THEN run migration 162 (an agent can run it once the owner confirms).
- OWNER/dashboard (commercial audit backlog): Vercel Hobby is non-commercial -> Pro (also fixes the monitor,
  below); Supabase plan/backups/PITR + a restore drill; plan switching in the Stripe portal (config
  bpc_1UBZUwRtNFWlwsi4HXthKxbz), then drop "email us to switch"; confirm the Payment Link redirect is
  /golsz-app.html?checkout=success; external uptime probe + email alerts; a real Elite benefit; French
  marketing pages (Quebec); legal entity name/address, then remove the "not reviewed" banners.
- Agent-doable: ADS Phase 6 items 4 (new Scout action kinds: reschedule/drop/standalone) and 5 (readers for
  `athlete_schedule` / `athlete_diary_entries`); Reschedule/Drop from Home; `removed_at` on stages;
  self-host fonts + the two CDN libraries (CSP change); an admin RPC to list `stripe_pending_plans`.

## Important Architecture Decisions
- A push to `main` is a production deploy; the Vercel buildCommand (`npm run check` first) is the gate.
- JSX is compiled at author time into committed `js/app.js` (`npm run compile`); split/strip/unpublish run
  only on Vercel.
- Migrations are numbered files run by hand; supabase-schema.sql records live state (`NOT YET APPLIED`).
- 12-function Vercel ceiling: shared code goes in `_`-prefixed modules in `api/`.
- Adults only (18+); managed profiles for under-18s are switched off.
- Scout never writes a date: it sends `due_in_days`; the server resolves it from the athlete's day.

## Latest Test / Build Status
2026-11-03 (Claude Code, job 144 t8): `npm run check` 129/129 suites (6026 assertions).
Earlier, 2026-10-28: NOT verified, a live Scout reply for a signed-in athlete. Ask Scout "what should I do
today?" and compare with Home's Today tile and THIS WEEK count.

## Known Problems
- health-alert is NOT every 15 minutes: 60 runs (10-18..10-28) were 2.1-7.5 h apart, median 4.2 h, all
  green. Outages can go unseen for hours; a >6 h gap can raise a false "monitor dead" heartbeat push.
- Payments live but no real purchase yet; webhook signing secret unverified.
- Admin MFA: owner not enrolled; the Admin Panel shows the enrol screen; migration 162 must NOT run yet.
- Signup has NO bot protection (Supabase CAPTCHA off, `TURNSTILE_SITE_KEY` empty; enable both together).
- `api/*.js` source is readable as static files on golsz.com (deliberate; the repo is public anyway).
- The redesigned hero was checked by contrast maths only; nobody has run VoiceOver over it.

## Next Recommended Action
Owner: signed in, ask Scout "what should I do today?" and compare with Home's Today tile and THIS WEEK
count (the one check no suite can make). Agents: ADS Phase 6 items 4-5 next.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
