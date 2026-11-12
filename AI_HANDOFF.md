# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
Claude Code (AVA job 216 t5: rehearse Home and Scout side by side without live services), 2026-11-13. Job 216's
t1-t4 were Claude Code too. Before job 216: OpenCode (job 199, final verification), 2026-11-10.

## Current Branch
`ava/216-scout-s-what-should-i-do-today-agrees-wi` (AVA job 216; AVA commits each step, then merges). Branched from
0b8e891, where job 199 (sign-up to a dated plan) was merged as #15.

## Last Completed Work
- Job 216, "Scout's what should I do today? agrees with Home" (CLAUDE.md, under `api/scout.js`): t1 today helpers, t2
  the handler's card/override, t4 the limit path ("0 of N left today"), t3 the "From your plan" card.
- t5 (this step): `tools/preview-onboarding.cjs` answers `/api/scout` with the REAL `api/scout.js` handler against the
  preview's store and a scripted model (`&model=honest|date|step|count`, `&limit=1`, `&last=1`); drives `scouttoday`,
  `scoutinvent`, `scoutlimit`, `scoutlast` (code from attempt 1, 0f9ed7d). Attempt 2 ran them in a browser and fixed
  what that showed: (1) the store stamps `created_at` on insert like Postgres's `default now()` (without it
  `?page=scout` reopened the chat answer-first; the app is right); (2) a drive step gives up after 30 s, not 12 s
  (`full`'s sign-up once reached the editor after 12-14 s on a busy Mac; 6 timed sign-ups since took ~0.5 s, with no
  supabase-js lock warning); (3) the runner prints each page's `ms`. Suite 196 (+3); 4 mutants each fail only the new
  assertions that guard them.
- Browser runs 2026-11-13, fresh servers, nothing sent out (only the Google Fonts stylesheet failed: no internet):
  1. AVA's browser tool, the criterion's command: `"$AVA_BROWSER" --serve "node tools/preview-onboarding.cjs 8770 >
     node_modules/.cache/scout-run.log 2>&1" --port 8770 --widths 390 "/golsz-app.html?drive=scouttoday&model=honest"
     "/golsz-app.html?page=scout"` (1st try "Chrome did not start within 45 s", rerun passed). Title: `[drive done;
     home today: 0/1; home week: 0/3; card today: 0/1; card week: 0/3; card steps: Ask Scout what to focus on this week;
     override: no; usage: 2 left; limitCard: no; reply: "Today: "Ask Scout what to focus on this week". This week you
     have done 0 of 3."; box: open; path: Daily check-in > Home (set-goal card) > GoalSetup > Home > Scout; ...]` (it
     built the plan first). 0 console errors, 390/390. `?page=scout`: question, then answer. Flags: 1 unlabeled control
     with and without the card; the 2 extra tiny texts and 1 low contrast (10 px, 3.76:1) are the two 9.5 px message
     times (golsz-app.html:10931, since 2026-08-08), not the card.
  2. Runner: `"$AVA_RUN" node tools/run-onboarding-chrome.cjs --width 390 --theme dark --no-sandbox --chrome
     ~/Library/Caches/ms-playwright/chromium_headless_shell-1194/chrome-mac/headless_shell`: 15/15 `drive done`,
     1.1-6.0 s a page, 390/390. The scout drives again at `--width 1280`: 4/4, 1280/1280. Every scout page: home 0/1,
     0/3; card (when drawn) 0/1, 0/3, "Ask Scout what to focus on this week". scouttoday: `override: no; usage: 2 left;
     limitCard: no; box: open`. scoutinvent date|step|count: `override: yes; usage: 2 left`, bubble `Today: "Ask Scout
     what to focus on this week". This week: 0 of 3 done.` (replaced "...done by 2027-02-06." | "Run a 10 km time
     trial" | "0 of 4"). scoutlimit: `card today: none; usage: 0 left; limitCard: yes; box: closed`, "You've used
     today's Scout questions. 0 of 3 left today. More tomorrow." scoutlast: card, `0 left; limitCard: yes; box: closed`.
     Server: `scout 200 model=honest card=today 0/1, week 0/3 override=no usage=2/3 calls: 29 store, 2 model, 0
     refused`; date/step/count the same with `override=yes`; `scout 402 model=honest limit card=none override=no
     usage=0/3 calls: 18 store, 0 model, 0 refused`; `scout 200 model=honest last ... usage=0/3 calls: 28 store, 2
     model, 0 refused`. Console errors: only the app's own logs ("GOLSZ scout send failed: ... More tomorrow." on
     scoutlimit, "GOLSZ goal setup save error" on `fail=pathway`). Files: `node_modules/.cache/onboarding-run/`
     (390-dark-01..15, 1280-dark-01..04 .png, server-*.log). Opened, all read right: 390 scouttoday, scoutinvent count,
     scoutlimit, scoutlast, today; 1280 scoutinvent; both browser-tool pages.

## Current Work
Job 216: t6 (recorded run: Scout and Home agree, phone and desktop), then security review, regression and final
verification.

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
2026-11-13 (job 216 t5), through `$AVA_RUN`: `node tests/run-all.cjs preview_onboarding` 196/196; `node --check` on
both tools. The browser runs above. Full `npm run check`: AVA's run.

## Known Problems
- health-alert runs every 2.1-7.5 h, not 15 min. Payments live but no real purchase; webhook secret unverified.
- Admin MFA: owner not enrolled. Signup has NO bot protection (Supabase CAPTCHA off, `TURNSTILE_SITE_KEY` empty).
- Preview tool: with `&today=` the page's `Date.now` is fixed, so a stuck drive never says FAILED (the runner then
  reports "no drive result"). The scout drives are run without it.
- UNVERIFIED (job 216): the real model and live Supabase; light theme and fr/es/el in a browser; Safari, Firefox; a
  screen reader; the web fonts. Job 199: real fonts and live Supabase on a real phone.

## Next Recommended Action
Job 216 t6: the runner (or AVA's browser tool) at 390 and 1280, dark and light, one server per width and theme.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
