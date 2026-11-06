# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
Claude Code (AVA job 184, task t7, attempt 3), 2026-11-06. Before that: Claude Code (job 184 t1-t6, t7 attempts 1-2).

## Current Branch
`ava/184-an-athlete-can-track-target-clubs-or-coa` (AVA job 184, Targets; AVA commits each step, then merges).
`main` last moved 2026-10-28: `scout-day-awareness` (af28c32) fast-forwarded and live.

## Last Completed Work
- AVA job 184, Targets (Plan > "Schools & clubs"), t1-t6: rules in CLAUDE.md § Target clubs/coaches and outreach
  drafts. t7: this run, docs (CLAUDE.md, AGENTS.md, CHANGELOG.md); the preview's title now shows emails and drafts.
- t7 recorded run, done three times (attempts 2 and 3 redid it from scratch on fresh servers: identical results).
  AVA browser + `tools/preview-targets.cjs`, one server per width and theme, 8 page loads in order from `reset=seed`.
  Titles, the same in all four (N = Northfield College Soccer <rivera@example.edu>, L = Lakeside FC, M = Metro United
  Academy, MIA = Montreal Impact Academy): 1 add: "MIA | N | L | M"; 2 editgood: "MIA <coach@uni.edu> | N | L | M";
  3 look (reload): the same; 4 draft: the same + `draft: "Hello Coach Rivera, I would love a trial." (Saved)`; 5 expand
  (reload, panel open): the same draft; 6 arm: "MIA <coach@uni.edu> {Delete?}" + alert "Delete this and its draft
  email? Tap again to confirm."; 7 delete: "N | L | M"; 8 look (reload): "N | L | M". Server, each run: insert (1),
  update name/contact (2), update draft_email (4), delete (7), all one id; 3/5/6/8 wrote nothing.

  | 8 combinations | A: add, edit, reload | B: draft, save, reload, delete (warning + second tap), reload |
  |---|---|---|
  | 390 dark | pass: MIA + coach@uni.edu back on reload | pass: draft back on reload; MIA gone on reload, N/L/M kept |
  | 390 light | pass: MIA + coach@uni.edu back on reload | pass: draft back on reload; MIA gone on reload, N/L/M kept |
  | 1280 dark | pass: MIA + coach@uni.edu back on reload | pass: draft back on reload; MIA gone on reload, N/L/M kept |
  | 1280 light | pass: MIA + coach@uni.edu back on reload | pass: draft back on reload; MIA gone on reload, N/L/M kept |

  All 32 loads: no console errors; one request refused by the sandbox proxy (no internet); at 390 px scrollWidth =
  innerWidth; contrast: dark none, light only the older 3.02:1 (10 px, 390) and 2.75:1 (button, 1280) of t5/t6.
  Screenshots opened (attempt 3): 390 dark arm (warning on one unclipped line), 390 light expand (draft back under "To:
  coach@uni.edu"), 1280 light draft ("Saved"), 1280 dark last reload (N/L/M only). Both widths and themes, fail=select:
  no rows, "Couldn't load this. Check your connection and try again." + Retry (console: the app's own error line), but
  the summary says "No schools or clubs yet" (shot 1280 dark; Known Problems); fail=insert&drive=add: nothing added,
  form open with the typed name, "Couldn't add that. Try again." (shot 390 light). NOT run in t7: fail=update/delete,
  double taps, mid-save close (t4-t6 did); fr/es/el; real DB, RLS, migration 165; a real phone; a screen reader.

## Current Work
AVA job 184 (Targets): t1-t7 done on the branch; security review, regression and final verification still to run.

## Remaining Tasks
- Migration 165 is NOT YET APPLIED: once job 184 merges, run it in the SQL Editor (checks + rollback in its header).
- OWNER: one real Basic purchase; send LEGAL-REVIEW-BRIEF.md to counsel; admin MFA (OWNER-RUNBOOK.md section 8:
  enrol, test a password-only sign-in, THEN migration 162, which an agent can run once the owner confirms).
- OWNER/dashboard: Vercel Hobby -> Pro (also fixes the monitor); Supabase backups/PITR + a restore drill; Stripe portal
  plan switching (bpc_1UBZUwRtNFWlwsi4HXthKxbz), then drop "email us to switch"; Payment Link redirect
  /golsz-app.html?checkout=success; uptime probe; a real Elite benefit; French marketing pages; legal entity details.
- Agent-doable: ADS Phase 6 items 4-5; Reschedule/Drop from Home; `removed_at` on stages; self-host fonts + the CDN
  libraries (CSP); an admin RPC for `stripe_pending_plans`; "Draft with Scout" on a target; Targets summary (below).

## Important Architecture Decisions
- A push to `main` is a production deploy; the Vercel buildCommand (`npm run check` first) is the gate.
- JSX is compiled at author time into committed `js/app.js` (`npm run compile`); split/strip/unpublish run on Vercel.
- Migrations are numbered files run by hand; supabase-schema.sql records live state (`NOT YET APPLIED`).
- 12-function Vercel ceiling (`_`-prefixed `api/` files are shared modules). Adults only. Scout sends `due_in_days`.

## Latest Test / Build Status
2026-11-06 (job 184 t7 attempt 3): browser run above; via "$AVA_RUN", `node tests/run-all.cjs <name>`: outreach
270/270, preview_targets 49/49, migration_165 47/47. Full `npm run check` left to AVA. 2026-11-03: 129/129 suites.

## Known Problems
- health-alert runs every 2.1-7.5 h, not 15 min: outages can go unseen for hours; a >6 h gap fakes "monitor dead".
- Payments live but no real purchase yet; webhook signing secret unverified. Admin MFA: owner not enrolled.
- Signup has NO bot protection (Supabase CAPTCHA off, `TURNSTILE_SITE_KEY` empty; enable both together).
- Not verified: a live Scout reply for a signed-in athlete (vs Home's Today tile); VoiceOver on the redesigned hero.
- Older than job 184, Targets: the summary line says "No schools or clubs yet" on a failed read (and while loading);
  the row chevron lacks aria-label/aria-expanded; light LoadError text + Retry (#B58A1A) are 3.17:1, under 4.5:1.

## Next Recommended Action
AVA job 184: security review, regression, final verification; then migration 165. Agents: ADS Phase 6 items 4-5.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
