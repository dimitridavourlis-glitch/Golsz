# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
Claude Code (AVA job 216 t3: the "From your plan" card in Scout), 2026-11-12. Earlier job 216 steps (t1, t2, t4) were
Claude Code too and did not update this file. Before job 216: OpenCode (job 199, final verification), 2026-11-10.

## Current Branch
`ava/216-scout-s-what-should-i-do-today-agrees-wi` (AVA job 216; AVA commits each step, then merges). Branched from
0b8e891, where job 199 (sign-up to a dated plan) was merged as #15.

## Last Completed Work
- Job 216, "Scout's what should I do today? agrees with Home" (CLAUDE.md, under `api/scout.js`):
  - t1: pure helpers in `api/scout.js` (`isTodayQuestion`, `pickNextMilestone`, `todayCard`, `datesInContext`,
    `checkReplyAgainstPlan`); suites `test_scout_today_answer`, helper `tests/_day_parity.cjs`.
  - t2: the handler. A today question gets `today_card`; a reply naming a date, step or count not in the plan gets
    `today_override` (text untouched; only the kind is logged, `scout_today_guard`); an unreadable plan gets
    `today_unavailable`. Suite `test_scout_today_handler`.
  - t4: at the daily limit the bubble says "0 of N left today. More tomorrow." and the text box closes. Suite
    `test_scout_limit_path`.
  - t3 (this step), `golsz-app.html` + `js/app.js`: `ScoutTodayCard` under the reply; `scoutTodaySentence` in place
    of an overridden reply, and that sentence is what scout_history keeps; the offers that came with a replaced reply
    are dropped; `scout_today_unavailable` when there is no card. 7 new keys in en/fr/es/el. Suite
    `test_scout_today_card` (139). The mount harness moved verbatim from `test_scout_limit_path` into
    `tests/_app_mount.cjs`; `_day_parity.cjs` now also exports `runHome`.
- Browser look 2026-11-12 (AVA's browser tool, Chrome). This is a look, not t6's recorded run: a throwaway server in
  `node_modules/.cache` (deleted after) wrapped `tools/preview-onboarding.cjs`'s stand-in Supabase (signed in, plan
  pro), answered `/api/scout` with a card from `api/scout.js`'s own `dayBuckets`/`todayCard`, and typed "What should I
  do today?" in the page. Seven answers (keeps to the plan 0/1 + 0/3; replaced; 2 late; resting; 4 open with long
  names; nothing due; plan unreadable) x 375/1280 x dark/light = 28 loads: every one finished, 0 console errors,
  scroll 375/375 and 1280/1280, the only failed request the Google Fonts stylesheet (no internet, fallback font).
  Screenshots opened: dark 375 (keeps to plan, replaced, late), dark 1280 (replaced, keeps to plan), light 375 (late,
  resting, long names, nothing due, unreadable). All read correctly: the replaced one shows `Today: "Ask Scout what
  to focus on this week". This week: 0 of 3 done.` and nothing of the invented date. Found and fixed: at 1280 the
  card stretched to ~660 px, each number far from its label; it is now capped at 440 px.
- The tool's contrast/small-text flags were the same on the unreadable-plan page (no card): older Scout parts, the
  9.5 px timestamps (3.76:1 dark, 3.1:1 light) and light-theme reply chips (12 px, 3.02:1). Not changed here.

## Current Work
Job 216: t5 (rehearse Home and Scout side by side without live services), t6 (recorded run, phone and desktop),
then security review, regression and final verification.

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
  the default focus ring on the other dialogs' panels; Scout's timestamp and light-theme chip contrast (above).

## Important Architecture Decisions
- Push to `main` = production deploy; Vercel buildCommand (`npm run check` first) is the gate.
- JSX compiled at author time to committed `js/app.js` (`npm run compile`). Migrations numbered, run by hand.
- 12-function Vercel ceiling (`_`-prefixed `api/` are shared modules). Adults only.

## Latest Test / Build Status
2026-11-12 (job 216 t3), all through `$AVA_RUN`: `npm run compile` ok; `node --check` on api/*.js, js/*.js, sw.js ok;
`test_scout_today_card` 139/139; all 18 Scout suites (1,263 assertions); the 32 suites that pin code this step
touched (home_tiles, goal_setup, compiled_artifact, app_syntax, i18n_keys_resolve, ux_credibility, ...) all pass.
Eleven broken copies of golsz-app.html (one per rule: override, late at 0, numbers, card kept, hex, `$&`, offers,
repeated line, blank names, gold as C.lime, a card that does not add up) each fail it. Full `npm run check`: AVA's run.

## Known Problems
- health-alert runs every 2.1-7.5 h, not 15 min. Payments live but no real purchase; webhook secret unverified.
- Admin MFA: owner not enrolled. Signup has NO bot protection (Supabase CAPTCHA off, `TURNSTILE_SITE_KEY` empty).
- UNVERIFIED (job 216 card): the real model and live Supabase; Safari, Firefox; a screen reader; fr/es/el in a browser
  (the suite checks the dictionaries); the web fonts. Job 199: real fonts and live Supabase on a real phone.

## Next Recommended Action
Job 216 t5 (a committed preview of Home and Scout side by side, which replaces this step's throwaway server) and t6.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
