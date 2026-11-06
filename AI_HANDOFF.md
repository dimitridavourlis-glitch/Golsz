# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
Claude Code (AVA job 184, task t6), 2026-11-06. Before that: Claude Code (AVA job 184, t5), same day.

## Current Branch
`ava/184-an-athlete-can-track-target-clubs-or-coa` (AVA job 184, Targets; AVA commits each step, then merges).
`main` last moved 2026-10-28: `scout-day-awareness` (af28c32) fast-forwarded and live.

## Last Completed Work
- AVA job 184 t6 (2026-11-06; attempt 3 ran and recorded the browser check, code unchanged from 51b4ffc): two-tap
  delete in Targets. Tap 1 arms the row: status select and chevron step aside, the X becomes `targetDeleteCopy`'s
  "Delete?", and a target with a draft (`targetHasDraft`) also gets a visible role=alert line under the row. Tap 2,
  500 ms or more later (`targetDeleteTap`), calls `removeTarget`, its only caller. Disarms after 6 s or when another
  row is armed; a refused delete puts the row back in its place with an error line.
  Recorded run: `tools/preview-targets.cjs` (port 8766) + AVA browser, one server per theme, pages in this order,
  each at 390 then 1280 px. Title "[drive done; ...]" and server lines, identical in all 4 (390/1280 x dark/light):
  1. reset=seed&drive=arm: "rows: Northfield College Soccer {Delete?} | Lakeside FC | Metro United Academy;
     alerts: Delete this and its draft email? Tap again to confirm." Server: the page line only, no delete.
  2. drive=armplain: "rows: Northfield College Soccer | Lakeside FC {Delete?} | Metro United Academy"; no alert.
  3. reset=seed&drive=delete: "rows: Lakeside FC | Metro United Academy". Server, once per load:
     `outreach_targets delete id=00000000-0000-4000-8000-000000000101 fields=`.
  4. drive=look (plain reload): "rows: Lakeside FC | Metro United Academy" (still gone).
  5. reset=seed&drive=delete&fail=delete: all three rows; "alerts: Couldn't delete this. It's still on your list.
     Try again." Server: `outreach_targets delete answered HTTP 500 on purpose`. Console: only the app's own
     "GOLSZ target delete error" line. No other page had a console error. Every page had one external request
     refused by the sandbox proxy (the run has no internet; most likely the Google Fonts CSS at golsz-app.html:18031).
  Also run (third server, both themes and widths, each from reset=seed; no delete logged): armother leaves only
  "Lakeside FC {Delete?}", no alert; armwait (6.5 s): nothing armed; deletedouble: still armed, warning shown.
  390 px: scrollWidth = innerWidth = 390 on every page. Screenshots of page 1 (390 dark, 390 light, 1280 light):
  the warning is one unclipped line under the row; page 5 (390 dark): Northfield first again, status "Contacted",
  X back, error under it. Low contrast: dark none; light only the 3.02:1 (10 px, 390) and 2.75:1 (button, 1280)
  flags t5 lists as older than its step, on every page, armed or not.
  NOT exercised: the real database/RLS (stand-in store); a real phone; a screen reader reading the alert.
- AVA job 184 t5 (2026-11-06, attempt 3): the target's draft email has an explicit "Save draft" (blur still saves)
  with a status line (Unsaved changes / Saving… / Saved / Not saved, try again), a ref guard, Save disabled while
  saving, a cap at TARGET_LIMITS.draft_email with a counter near it, and a "To: <contact_email>" hint. Attempt 3
  fixes the reviewer's finding: a box can close (chevron, another row, the section) while its blur-save is on the way,
  and a failure then had nowhere to show. Now `TargetTextArea` hands unsaved text to `onKeep` once it is gone and no
  save is pending; Targets keeps it in the module-level `TARGET_UNSAVED_TEXT` Map (survives a tab switch, not a
  reload), names the target in a role=alert line on the card and in the closed section's `note` (new Collapsible
  prop, shown only while closed), and the box starts from that text with "Not saved, try again" when reopened.
  `updateTarget` now rolls back only the fields it wrote. Recorded run (`tools/preview-targets.cjs` + AVA browser,
  one server per theme, pages in order), 390/1280 x dark/light, all with fail=update unless noted: drive=draftclose
  shows "Your changes to Northfield College Soccer weren't saved. Open it and try again." on the card, row closed;
  drive=draftreopen shows the typed text back in the box with "Not saved, try again"; drive=draftsection shows the
  same line under the closed "Schools & clubs" row; drive=draft keeps the text with "Not saved, try again";
  reset=seed&drive=draft (no fail) shows "Saved"; a reload with drive=expand shows the same text; drive=bigdraft
  shows 10000 / 10000. Server logged each refused write as `update answered HTTP 500 on purpose
  fields=draft_email,updated_at`. No sideways scroll anywhere. Light-theme contrast flags (3.17:1 gold fit line,
  3.02:1 gold on the page background outside the card, 2.75:1 disabled button) were there before this step; the
  new lines use --lime-text (about 6:1 on white). NOT exercised: the real database/RLS; a reload while text is
  unsaved loses it (memory only).
- AVA job 184 t4 (2026-11-06): Targets add/edit run `targetFieldErrors` (message under the field, aria-invalid/
  aria-describedby, C.limeText); edit stays open until the update succeeds; card error line sits outside the Add
  form; `addingRef` guard stops a double tap adding twice. Recorded run, `tools/preview-targets.cjs` + AVA browser,
  390 and 1280 px, dark and light (one server per width/theme, store kept between page loads): reset=1, drive=add,
  then a plain reload (`&open=schools`, no drive/reset) shows "Montreal Impact Academy" in all 4; drive=editbad
  shows "Enter an email like name@club.com..." under the field and the server logged no write; drive=editgood then a
  plain reload shows "coach@uni.edu" under the name in all 4 (one update logged each); drive=adddouble logged exactly
  one insert, reload shows one row, in all 4; fail=update keeps the form open with the typed "coach@uni.edu" (stored
  value rivera@example.edu) and shows "Couldn't save that. Your text is still here." (390 dark+light, 1280 dark+
  light). No horizontal scroll anywhere. NOT exercised: the real database/RLS (stand-in store only).
- Older entries (AVA jobs 144 and 168, ADS Phase 6) were trimmed 2026-11-06; their lasting facts are in CLAUDE.md
  (First-screen speed, Boot order, Verifying the shared Passport, Failures are shown, Scout knows the athlete's day).

## Current Work
AVA job 184 (Targets): t1-t6 done on the branch; t7 (end-to-end run + docs), security review, regression and final
verification still to run.

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
2026-11-06 (job 184 t6): browser run above; via "$AVA_RUN", `node tests/run-all.cjs <name>`: outreach_targets
270/270, preview_targets 49/49, compiled_artifact 14/14. Full `npm run check` not run by t6 (AVA runs it).
2026-11-03 (job 144 t8): `npm run check` 129/129 suites (6026 assertions).
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
- Targets rows: the expand chevron (the button before the delete X) has no aria-label or aria-expanded. It was
  like that on `main` before job 184; AVA's browser tool counts it as one unnamed icon button per row.

## Next Recommended Action
AVA job 184: t7 (recorded end-to-end run and documentation). Owner: signed in, ask Scout "what should I do
today?" and compare with Home's Today tile and THIS WEEK count. Agents: ADS Phase 6 items 4-5 next.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
