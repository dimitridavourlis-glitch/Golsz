# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
OpenCode, 2026-10-23: landing hero redesigned to the owner-approved mock "G1" (F1-style glow hero
from a ten-option round shown in a review page; the owner picked G1 and said "implement it exactly").
The earlier uncommitted "glow path" attempt on this branch was rebuilt over.

## Current Branch
`landing-glow-path`, pushed to origin. Built on top of `main` (8c34983); not yet merged — asking the
owner to merge into `main` is a production deploy (see Important Architecture Decisions).

## Last Completed Work
- Hero G1 (`index.html`, `css/styles.css`, `js/landing.js`): near-black `#0A0F0D` hero with two
  static glow pools (gold low-left, mint high-right, exact mock values), 84px headline with the
  gold→mint gradient, outlined-pill secondary CTA, 8 goal chips on one row (hero container widened
  to 1328px so the chip row matches the mock's 1280px content; the header container is untouched).
- The route is no longer a boxed card: a light-up track directly on the hero background — 4px line,
  gold nodes with glow, mint destination, connector gradients restart per segment so only the last
  stretch goes mint (vertical gradient on the stacked mobile layout), honesty fine print as small
  mono centred text ("Standard route · not yours yet · no times, no odds" + the "Scout builds the
  real route from your Passport — and says so when it doesn't have the data." line).
- Removed from the hero: kicker, lane head ("Standard route / NCAA D1") and the "Where most athletes
  stall" box (the stall copy survives in `js/landing.js` ROUTES data, deliberately kept).
- Free-text goal row preserved behind a progressive chip-row toggle: with JS on the hero hides the
  row and shows "OR TYPE YOUR OWN GOAL" (`form.is-live`, button opens + focuses, chips collapse it
  again); without JS the row is simply visible and the button is display:none. Honest unknown-goal
  branch kept (test in a browser: type an unrecognised goal — it answers with the no-preset-route
  node and "No preset route for that goal · GOLSZ says so rather than guess").
- Honesty rules intact: routes still curated/deterministic, nothing calls Scout or any API;
  "aged 18 and over" x2 and no "parent" on index.html (both asserted by `npm run check`).
- Verified by screenshot against the mock: desktop 1440 and mobile 390 (chips one row desktop,
  route stacks with descriptions mobile), chip-switch (Pro contract) and unknown-goal states.

## Current Work
None in progress.

## Remaining Tasks
- OWNER: review the branch, then merge `landing-glow-path` into `main` (main deploy) or open the
  branch preview and say what to adjust.
- OWNER (OWNER-RUNBOOK.md): one real Basic purchase; send LEGAL-REVIEW-BRIEF.md to counsel.
- OWNER: admin MFA rollout, OWNER-RUNBOOK.md section 8. DONE: TOTP enabled in Supabase; 161 applied;
  code merged and deployed. LEFT: enrol an authenticator in the Admin Panel (only the owner can scan
  the QR), test a password-only sign-in, THEN run 162 (an agent can run it once the owner confirms).
- COMMERCIAL AUDIT BACKLOG STILL OPEN. Owner/dashboard: Vercel Hobby is non-commercial -> move to Pro;
  Supabase plan/backups/PITR undocumented, do a restore drill; enable plan switching in the Stripe portal
  (config bpc_1UBZUwRtNFWlwsi4HXthKxbz) and drop the "email us to switch" route; confirm the Payment Link
  after-payment redirect is /golsz-app.html?checkout=success; external uptime probe + email alerts
  (health-alert is push-only); define a real Elite benefit (Pro +5 questions/day today); French marketing
  pages (Quebec); legal entity name/address, then remove the "not reviewed" banners. Agent-doable:
  self-host fonts and the two CDN libraries (needs a CSP change); an admin RPC to list
  `stripe_pending_plans` (service-role only table).
- Agent-doable gaps from the ADS reconciliation (ADS-BUILD-ORDER.md STATUS): parallel `getAthleteState`
  reads; a server "today" line for Scout and a date digest in `responseCacheFingerprint`; `measured_by` /
  `protocol` in Scout's benchmark select; Reschedule/Drop from Home; `removed_at` on stages.
- Stale cross-references listed in the ADS STATUS block (150's "(148)", the `weekReview` comment).

## Important Architecture Decisions
- A push to `main` is a production deploy; the Vercel buildCommand (`npm run check` first) is
  the gate, and check.yml only reports alongside it.
- JSX is compiled at author time into committed `js/app.js`; `split`, a second `compile`, `strip` and
  `unpublish` run only on Vercel (buildCommand order asserted by test_served_bundle.cjs and
  test_unpublish_internal.cjs).
- Database changes are numbered migration files run by hand; supabase-schema.sql records live state,
  including migrations NOT YET APPLIED (marker `*** NOT YET APPLIED ***`).
- 12-function Vercel ceiling: shared code goes in `_`-prefixed modules in `api/`.
- Adults only (18+) contract and pay; managed profiles for under-18s are switched off.
- Landing hero honesty contract (do not regress): curated routes only, labelled "standard route /
  not yours yet", no timelines or odds, unrecognised goals answered rather than guessed, all-hero
  content visible with JS off (the free-text row hides ONLY behind JS, never by default).

## Latest Test / Build Status
2026-10-23 (OpenCode, branch landing-glow-path): `npm run check` 118/118 suites (5707 assertions).
Rendered and reviewed: desktop 1440 and mobile 390 hero screenshots match the approved G1 mock;
Pro-contract chip route and the honest unknown-goal branch exercised in a real headless Chrome.
Not yet live (branch not merged): index.html on golsz.com is still the old hero.

## Known Problems
- Payments live but no real purchase has completed; webhook signing secret rotated 2026-10-22 (dead in history).
- Admin MFA: owner has not enrolled an authenticator yet, so the Admin Panel shows the enrol screen and
  the API refuses admin actions (`mfa_required`); migration 162 must NOT run until they have enrolled.
- Signup has NO bot protection: Supabase CAPTCHA is DISABLED (2026-10-22) and `TURNSTILE_SITE_KEY` is
  empty. They agree, so signup works and privacy.html ("not active") is accurate; enabling takes the key
  in the client AND the Supabase setting together, or signup breaks.
- `api/*.js` source is still readable as static files on golsz.com (deliberate: deleting `api/` at build
  time would break the functions; the repo is public).
- The new hero's small print and labels were checked by contrast maths only (tokens clear 4.5:1 on
  `#0A0F0D`); nobody has been heard running VoiceOver over the redesigned hero.

## Next Recommended Action
Owner: review `landing-glow-path` (local preview: `python3 -m http.server` and open index.html), then
merge to `main` if it looks right. Agents: ROADMAP/court backlog above; report/regressions on the hero
against the G1 mock are welcome as screenshot diffs, not text.

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
