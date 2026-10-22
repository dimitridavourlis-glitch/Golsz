# AI Development Handoff

## Project
GOLSZ (the owner calls it "GOLSZ 3"): AI sports-passport and pathway app, live at golsz.com.
Stable facts and commands: AGENTS.md. Long form, authoritative: CLAUDE.md.

## Last Agent
OpenCode, 2026-10-22 (second session): unpublish step, migration probe, owner runbook, counsel brief,
ADS-BUILD-ORDER reconciled; then, with the owner signed in to Supabase in the browser pane, ran the probe
and migration 160 against PRODUCTION (the owner's explicit go-ahead). Before that: OpenCode comment fixes; Claude Code setup session.
Last real feature work: Claude Code, 2026-10-21, a review-fix round after the redesign merge (5bfb860).

## Current Branch
`main`. The MFA branch `admin-mfa-roles` was merged into it 2026-10-22 and can be deleted by the owner.
The five `redesign/phase-*` branches are fully merged into `main`.

## Last Completed Work
- 2026-10-22 (OpenCode): commercial-readiness pass from a 27-finding audit. SHIPPED: branded `404.html`;
  right-sized icons (126 KB -> 13 KB / 2.5 KB); pricing footnote says taxes are extra + links refund terms;
  content visible with JS off; Permissions-Policy (denies camera/mic/geo/payment, not clipboard/share/push);
  /assets cache header; admin knowledge link via `safeHref`; `CheckoutReturnBanner` (waits for the plan to
  flip after paying, says who to write to when slow); "Update card" on the failed-payment notice; Help &
  support block in Settings; 9 strings x 4 languages. PAYMENTS: stripe-webhook now stashes a plan that
  arrives before its customer is linked (migration 163, APPLIED, service-role only) and applies it at the
  link; the event still answers 500 so Stripe keeps retrying. Suites: `test_commercial_polish.cjs` (67),
  `test_stripe_webhook_logic.cjs` (95), all mutation-checked. NOT exercised against real Stripe.
- 2026-10-22 (OpenCode, production, owner present): rotated SUPABASE_WEBHOOK_SECRET. Generated in the browser
  (never in the transcript or repo), set in Vercel (Production), redeployed (empty commit 9bdbd51), re-ran 026
  with comments stripped. Verified: /api/send-push 200 for the right secret and 401 for wrong, missing and
  one-character-off; SHA-256 of the secret in the DB function == SHA-256 of Vercel's. The SQL Editor snippet
  was blanked; its server copy no longer resolves (could not confirm whether one was ever stored).
- 2026-10-22 (OpenCode, production): probe read 158, 159 and 026 already true; 160.1 and 160.2 false.
  Ran migration 160 (whitespace/comment-stripped, verified statement-for-statement against the file and by
  SHA-1 in the editor; Supabase showed its "destructive operations" warning for `drop policy`, expected).
  Re-ran the probe: all 15 checks true. 160 file now also drops the new policy names first, so a second
  run is harmless (it was claimed idempotent but was not). Ledger and CLAUDE.md updated.
- 2026-10-22 (OpenCode): `tools/unpublish-internal.cjs` + `npm run unpublish`, last step of the Vercel
  buildCommand: removes root `*.md`, `opencode.json`, `supabase-*.sql`, `tests/`, `tools/`, `golsz-guard/`,
  `.github/`, `.claude/` from the served tree (they were all public URLs, verified live). Never touches
  `api/`; refuses to run without `VERCEL=1` or an explicit dir. `tests/test_unpublish_internal.cjs`
  (52 assertions, mutation-checked). NOT YET VERIFIED LIVE: curl the paths after the deploy lands.
- `supabase-probe-migration-state.sql` (read-only; parses with pglast, never run against Postgres):
  one paste says which of 158/159/160/026 are applied. `OWNER-RUNBOOK.md`: the owner-only steps.
- `LEGAL-REVIEW-BRIEF.md`: facts and questions for counsel. CORRECTION: under-18s cannot register
  today (managed profiles off in client and API; DB gate, 158 is applied), so the live questions are
  French terms, Law 25, health information, AI providers, EU withdrawal at checkout.
- `ADS-BUILD-ORDER.md` STATUS block rewritten from the code: phases 0, 3, 4 done (4 minus the
  opportunity slot); 1, 2, 5, 6, 7, 8 partial; 9, 10 not started. Claims about "applied" come from
  headers, not the database.
- 2026-10-22 (earlier): header comments in `tools/precompile.cjs` and `api/health-alert.js` corrected.

## Current Work
Admin MFA and roles are merged: migration 161 (owner/moderator roles,
trigger pins, last-owner guard), migration 162 (is_admin() requires aal2: RUN ONLY AFTER ENROLLING),
`api/admin-user-action.js` (aal2 required, delete owner-only, falls back to "every admin an owner" while
161 is unapplied), Admin Panel gate `AdminMfa` / `adminMfaState` (nothing loads before aal2), owner-only
controls, 15 strings x 4 languages, `tests/test_admin_mfa_roles.cjs` (100) and 132 in
`test_admin_user_action.cjs`, mutation-checked. NEVER exercised in a browser or against Supabase: the
enrol/verify screens and a real aal2 token are unproven until the owner runs OWNER-RUNBOOK.md section 8.

## Remaining Tasks
- OWNER (OWNER-RUNBOOK.md): one real Basic purchase. Runbook steps 1, 2, 3 and 5 are DONE.
- OWNER: send LEGAL-REVIEW-BRIEF.md to counsel (run its three count queries first).
- OWNER: admin MFA rollout, OWNER-RUNBOOK.md section 8. DONE: TOTP enabled in Supabase; 161 applied; code
  merged and deployed. LEFT: enrol an authenticator in the Admin Panel (only the owner can scan the QR),
  test a password-only sign-in, THEN run 162 (an agent can run it once the owner confirms).
- DONE from that backlog, in order: vercel.app -> golsz.com redirect (api excluded, push trigger posts there);
  shorter titles + manifest id/scope + honest sitemap lastmod; signup hardening (confirm-email on paid plans,
  password floor 8 in ONE constant AND in Supabase's own PASSWORD_MIN_LENGTH setting, signup errors mapped by
  code to translated text, 4 hard-coded notices translated; `test_signup_hardening.cjs`); first-visit language from
  the browser (loader `pickLang`, remembered choice always wins; `test_language_default.cjs`); billing visibility
  (migration 164 APPLIED: webhook mirrors period end + cancel flag as a separate best-effort write, Settings shows
  "renews on / ends on", a subscription set to END may delete the account, a deleted account's final
  subscription.deleted is a 200; `test_billing_visibility.cjs` + extended webhook/delete suites).
- COMMERCIAL AUDIT BACKLOG (2026-10-22, not done; HIGH first). Needs owner/dashboard: Vercel Hobby is
  non-commercial -> move to Pro; Supabase plan/backups/PITR undocumented, do a restore drill; enable plan
  switching in the Stripe portal (config bpc_1UBZUwRtNFWlwsi4HXthKxbz) and drop the "email us to switch"
  route; confirm the Payment Link after-payment redirect is /golsz-app.html?checkout=success; external
  uptime probe + email alerts (health-alert is push-only, owner phone); define a real Elite benefit (it is
  Pro +5 questions/day); French marketing pages + default app language from navigator.language (Quebec);
  legal entity name/address, then remove the visible "not reviewed" banners. Agent-doable: JSON-LD WebSite/SoftwareApplication; og tags on shared
  Passport links; minify js/app.js (1.18 MB) and self-host fonts/libs; keyboard-accessible span/div
  onClick controls; localise dates; "paid but no plan" list in the Admin Panel.
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

## Latest Test / Build Status
2026-10-22 (OpenCode): `npm run check` 111/111 suites (5305 assertions) at b873772; that deploy was
verified live (16 internal paths 404, site and functions up). Production DB: probe 15/15 true after 160.
Not verified: CI. Not exercised against the live database: the shared-Passport behaviour itself (only
catalog checks), i.e. nobody has loaded a `?public=<uuid>` link since 160.

## Known Problems
- Payments live but no real purchase has completed; webhook signing secret unverified.
- The OLD push-webhook secret is still in public git history but was rotated 2026-10-22 (verified), so it is dead.
- Admin MFA code is on `main` (merged 2026-10-22) and migration 161 is applied, but the owner has not yet
  enrolled an authenticator, so until they do the Admin Panel shows the enrol screen and the API refuses admin
  actions (`mfa_required`). Migration 162 is NOT applied and must not be until they have enrolled. The MFA
  screens have not been seen working in a browser.
- Signup has NO bot protection: Supabase CAPTCHA is DISABLED (read in the dashboard 2026-10-22) and
  `TURNSTILE_SITE_KEY` is empty. They agree, so signup works and privacy.html ("not active") is accurate.
  Turning it on needs the key in the client AND the Supabase setting together, or signup breaks.
- `api/*.js` source is still readable as static files on golsz.com (deliberate: deleting `api/` at build
  time would delete the functions; the repo is public).

## Next Recommended Action
Owner: OWNER-RUNBOOK.md steps 1 to 5. Agents: confirm the unpublish deploy with
`curl -I https://golsz.com/CLAUDE.md` (expect 404) and `/api/geo` (version = the pushed commit).

---
_How to update: overwrite the sections above (do not append a log); put the agent name
(Claude Code or OpenCode) and the date in Last Agent; keep this file under ~80 lines;
never put secrets here. Durable facts belong in AGENTS.md._
