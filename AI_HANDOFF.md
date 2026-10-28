# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
Claude Code, 2026-10-28. Picked up after OpenCode (last OpenCode work: the G1 landing hero, 2026-10-23).

## Current Branch
`scout-day-awareness`, cut from `main` at 4fa247f. Committed locally; push and merge wait for the owner
(a merge to `main` is a production deploy). `landing-glow-path` WAS merged (fast-forward, 2026-10-27) and is
live: golsz.com `/api/geo` reports `4fa247ffb22b`.

## Last Completed Work
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
- New suites: `test_scout_today.cjs` (diffs `dayBuckets` against HomeTab's real code on 640 plans) and
  `test_scout_benchmark_provenance.cjs`. Extended: context_failures (concurrency check, validated against
  the old serial code: 1 read in flight vs 9), response_cache_key, scout_pathway_filing.
- Docs: stale facts fixed in this file, AGENTS.md (unfinished work), CLAUDE.md (MFA is merged; Scout's day;
  measured health-alert cadence), ADS-BUILD-ORDER.md STATUS (Phase 6/7 rows, migration list), plus the
  stale cross-references in migration 150's header and the `weekReview` comment.

## Current Work
None in progress.

## Remaining Tasks
- OWNER: review `scout-day-awareness`, then push + merge (deploys), or ask an agent to.
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
2026-10-28 (Claude Code, branch scout-day-awareness): `npm run check` 120/120 suites (5785 assertions).
NOT verified: a live Scout reply for a signed-in athlete (no signed-in session here). After deploy, ask
Scout "what should I do today?" and compare with Home's Today tile and THIS WEEK count.

## Known Problems
- health-alert is NOT every 15 minutes: 60 runs (10-18..10-28) were 2.1-7.5 h apart, median 4.2 h, all
  green. Outages can go unseen for hours; a >6 h gap can raise a false "monitor dead" heartbeat push.
- Payments live but no real purchase yet; webhook signing secret unverified.
- Admin MFA: owner not enrolled; the Admin Panel shows the enrol screen; migration 162 must NOT run yet.
- Signup has NO bot protection (Supabase CAPTCHA off, `TURNSTILE_SITE_KEY` empty; enable both together).
- `api/*.js` source is readable as static files on golsz.com (deliberate; the repo is public anyway).
- The redesigned hero was checked by contrast maths only; nobody has run VoiceOver over it.

## Next Recommended Action
Owner: approve pushing `scout-day-awareness` and merging it to `main`. Then check Scout's "today" answer
signed in. Agents: ADS Phase 6 items 4-5 next.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
