# AGENTS.md: GOLSZ

Shared instructions for every coding agent working in this folder (OpenCode, Claude Code, others).
OpenCode loads this file automatically, and CLAUDE.md and AI_HANDOFF.md through opencode.json.
Claude Code loads CLAUDE.md, which imports this file and AI_HANDOFF.md.
If this file and CLAUDE.md ever disagree, CLAUDE.md wins: fix the drift here.

## Shared rules (Claude Code and OpenCode)

Claude Code and OpenCode take turns in this same folder. They share state through Git
(GitHub `origin` is the source of truth) and through AI_HANDOFF.md. Only one agent works
in this folder at a time.

1. Read CLAUDE.md, AGENTS.md and AI_HANDOFF.md before substantial work.
2. Run `git status` before making changes (and `git fetch` to see whether origin moved).
3. Never destroy another agent's uncommitted work: no `git reset --hard`, `git checkout -- .`,
   `git restore .`, `git clean` or `git stash drop` on changes you did not make. Commit only
   your own files (`git add <paths>`, then `git commit -- <paths>`).
4. Never force push (`--force`, `--force-with-lease`) without the owner's explicit permission.
5. Never commit secrets: .env files, API keys, tokens, private keys, credentials.
   Document variable names only, never values.
6. Never delete branches simply to resolve a conflict. Resolve it, or stop and ask the owner.
7. Run the appropriate tests/build checks after substantial changes (see Test commands and
   Build commands below).
8. Update AI_HANDOFF.md after meaningful development work: which agent, date, what changed,
   test status, next step.
9. Use descriptive Git commits: what changed and why.
10. GitHub is the shared source of truth between Claude Code and OpenCode: fetch before you
    start; commit and push when you stop, following the Git workflow section below.

## Project purpose
GOLSZ: an AI sports-passport and pathway app for athletes aged 18+ (under-18s cannot register: managed
profiles are switched off, `PARENT_ACCOUNTS_ENABLED = false`). Live at golsz.com. An athlete records sport, club and dated benchmarks,
names a goal, gets a route of dated steps; the assistant **Scout** answers in that context.
**The GitHub repo is PUBLIC: write nothing in code, docs, migrations or commits you would not
publish.** Full detail: CLAUDE.md § What this is; README.md.

## Architecture
- Two parts sharing no code (the site links into the app by query parameter). Marketing site:
  `index.html`, `about.html`, `contact.html`, `terms.html`, `privacy.html`, `css/`, `js/main.js`,
  `js/landing.js`, `assets/`. Plain HTML/CSS/JS.
- App: `golsz-app.html`, one React 18 SPA. Its JSX source is one `text/babel-deferred` block in
  that file, compiled at author time into `js/app.js`.
  The three CDN libraries in `<head>` are `defer`red and `js/app.js` is preloaded; the bottom loader waits for
  `DOMContentLoaded` before injecting it (`tests/test_boot_nonblocking.cjs`).
  The web fonts load from `<head>` too (non-blocking, same address as the `@import` in `CSS`), so the first screen
  is not redrawn when they arrive; layout shift budget 0.10 (`time-first-screen.cjs` prints `cls=`, `--late-font=<ms>`
  is its positive control; CLAUDE.md "The first screen holds still").
  Speed budgets (simulated phone connection): home LCP 3000 ms, boot screen 2500 ms, first screen 5000 ms;
  measure with `tools/time-first-screen.cjs` (CLAUDE.md "First-screen speed"). Real phone/cellular, signed-in
  Home and production-edge CDN latency are UNVERIFIED.
- Backend: Vercel serverless functions in `api/` and Supabase (Postgres + RLS, Auth, Realtime,
  Storage). Real Scout traffic goes through `api/scout.js`, which holds the AI key server-side.
- Full detail: CLAUDE.md § Architecture (one subsection per file or feature).

## Important directories
- `api/`: 12 Vercel functions, Vercel's ceiling (adding one means removing one). `_`-prefixed
  files are shared modules, not functions.
- `tests/`: `test_*.cjs`, `run-all.cjs`, `README.md`. `tools/`: the build scripts (`precompile`, `split-i18n`,
  `strip-jsx`, `unpublish-internal`) and local preview and timing tools (`preview-public-passport`,
  `preview-targets`, `preview-onboarding`, `run-onboarding-chrome`, `time-first-screen`, `time-pages`).
  `js/`: `main.js`, `landing.js`, `app.js` (generated); `js/i18n/` is gitignored build output.
- `golsz-guard/`: Claude Code plugin, four skills of project rules. Other agents: read
  `golsz-guard/skills/*/SKILL.md` before Supabase writes, measurements, athlete-facing claims.
- Repo root: `supabase-migration-NNN-*.sql`, `supabase-schema.sql`. `.github/workflows/`: CI.

## Technology stack
- Node >= 22 (`package.json` engines; CI runs 22.x and 24.x). ESM; tests are plain `.cjs`. No
  framework, no linter. Frontend: React 18 UMD + supabase-js from CDN, JSX compiled by
  `@babel/standalone` 7.23.2. Backend: Vercel functions (`web-push`), Supabase, Stripe (Payment
  Links, portal, webhook), Cloudflare Turnstile, Anthropic API. UI languages: en/fr/es/el.

## Development commands
```
npm ci                    # required: suites need @babel/parser and @babel/traverse
npx serve -l 5173 .       # static preview (.claude/launch.json); or: python3 -m http.server 8000
npx vercel dev            # run api/ locally; needs the Vercel CLI and env vars
```
Serve over HTTP, not `file://`. Full detail: CLAUDE.md § Commands.

## Build commands
- `npm run compile`: rebuilds `js/app.js` from the JSX in `golsz-app.html`. Run it after every JSX
  edit and commit `js/app.js` too; the gate fails if it is stale. Never hand-edit `js/app.js`.
- `npm run split`, `npm run strip`, `npm run unpublish`: deploy-time only. They rewrite or delete files (`golsz-app.html`: lift fr/es/el
  into `js/i18n/`, delete the JSX source). Never run them here; never commit their output.
- Vercel `buildCommand` (vercel.json): `npm run check && npm run split && npm run compile &&
  npm run strip && npm run unpublish`, `outputDirectory: "."`. No JSON comments in vercel.json (strict schema).
- Full detail: CLAUDE.md § THE DEPLOY GATE (vercel.json buildCommand).

## Test commands
```
npm run check                  # THE gate: node --check on api/*.js, js/*.js, sw.js, then all suites
npm test                       # suites only (node tests/run-all.cjs)
node tests/run-all.cjs <text>  # suites whose file name contains <text>
node tests/test_<name>.cjs     # one suite
```
- `npm run check` must pass before any push. Suites read real source and eval slices of it; never
  test a copy. Deterministic, no network, no secrets. They cannot see Stripe or Supabase config.
- Full detail: CLAUDE.md § What this is (Tooling paragraph); tests/README.md.

## Database architecture
- Supabase Postgres with RLS; `handle_new_user()` trigger creates the profile row; Storage buckets
  `avatars` and `post-images`.
- Schema change = new root file `supabase-migration-NNN-<name>.sql`, run BY HAND in the Supabase
  SQL Editor. No migration tool; a push never migrates the database.
- `supabase-schema.sql` is an append-only ledger of the live database, not a clean dump: never
  re-run it against live. Trust it over memory (e.g. `profiles` has no `email`, uses `dob`).
  Unapplied migrations are recorded there as NOT YET APPLIED.
- Full detail: CLAUDE.md § What this is; § Commands; § Architecture > `supabase-schema.sql`.

## APIs
- `/api/<name>`: `admin-user-action`, `create-child-account`, `delete-account`, `geo`,
  `health-alert`, `moderate`, `scout`, `send-push`, `signup-guard`, `stripe-webhook`,
  `target-followup-reminders`, `verify-turnstile`. `api/_plan-catalog.js` is the one server-side
  pricing definition. `/api/geo` returns the deployed commit SHA in `version`.
- CSP lives in vercel.json; a new external origin needs a CSP change. Full detail: CLAUDE.md
  § Architecture > `api/scout.js`, `api/stripe-webhook.js`, `api/send-push.js`, CSP header.

## Deployment architecture
- Vercel git integration: every push to `main` deploys production (golsz.com). A red
  `npm run check` in the Vercel build blocks the deploy; `check.yml` runs alongside, not before.
- `npm run deploy` (check, then `npx vercel --prod --yes`) is an out-of-band CLI deploy only.
- Schedules: Vercel cron `/api/target-followup-reminders` daily 13:00 UTC; `health-alert.yml`
  every 15 min calls `/api/health-alert` (repo secret `CRON_SECRET`, variable `PROD_BASE_URL`). The endpoint also
  pushes admins if its own check crashes.
- `outputDirectory: "."`: assume any repo-root file can be served publicly.
- Full detail: CLAUDE.md § THE DEPLOY GATE; § Current state.

## Coding conventions
- Edit by owning function, never by first text match: guard lines repeat byte-identically.
- No JSX comment between `&& (` / `? (` and its element; no hooks below a state-gated early return.
- supabase-js resolves with `{ error }`: check every write. Keep the `if (sb)` guard.
- Every top-level screen includes `<style>{CSS}</style>`. No client-only success states, no
  demo-data fallback. New strings need all four languages, appended at the END of each dictionary line.
- Prices are mirrored in `api/_plan-catalog.js`, `PLANS` (golsz-app.html) and `CURRENCIES`
  (js/main.js); tests diff them. Enum `starter` displays as Basic: do not rename it.
- A failed read is `LoadError` + Retry, never the empty state: wrap reads in `must()`, and register every new
  loader in `tests/test_read_failures_shown.cjs`.
- Form errors come from pure helpers, `signupFieldErrors` and `profileFieldErrors` (golsz-app.html), shown under the field.
- Crash proof: `tools/preview-public-passport.cjs` `&fixture=crash` (+ `&reload=1`); run 2026-11-03 passed (CLAUDE.md).
- First visit (sign-up -> Passport editor -> GoalSetup -> Home, AVA job 199): `starterPathwaySteps()` (pure, 5-8 dated
  `starter_step_*` milestones) writes a starter plan to `pathway_plan` (upsert `onConflict: "user_id"`, only
  pathway_type/target_timeline/milestones/updated_at) via `GoalSetup` (no AI, no plan gate; `planHasSteps` never
  overwrites; a refused save keeps the form with `role=alert` + Retry). `SetGoalCard` shows on Home for a sport with
  no steps. Preview: `tools/preview-onboarding.cjs` (stand-in auth/store, `drive=signup|passport|goal|home|today|reloadmid|full`,
  one-shot `fail=pathway`, `overflow=1` (positive control), `__store`; the title reports the screens in order,
  TODAY/THIS WEEK as done/total and the worst scroll box of each screen, `390/390 (document)` when it fits).
  `tools/run-onboarding-chrome.cjs --width <w> --theme <t>` runs the drives in headless Chrome when there is no
  browser tool. After the plan is built the daily check-in covers Home until answered or skipped.
  Run 2026-11-10 (Chromium 141 headless shell, 390/1280, dark/light) passed: CLAUDE.md has it.
  **UNVERIFIED:** the web fonts (no internet in the run, fallback font), Google Chrome/Safari/Firefox, live
  Supabase/RLS, real phone, screen reader, fr/es/el.
  Detail: CLAUDE.md § First visit: sign-up to a dated plan.
- Targets (Plan > "Schools & clubs", table `outreach_targets`): the caps in `TARGET_LIMITS` (golsz-app.html) are
  repeated by migration 165's check constraints, and `tests/test_migration_165.cjs` diffs them: change both, through a
  new migration. 165 is NOT YET APPLIED, so today the caps are client-side only. Deleting a target takes two taps and
  warns when its draft email goes too. Browser runs: `tools/preview-targets.cjs` (stand-in store, seeded rows,
  `drive=`/`fail=`/`reset=`), one server per width and theme; run 2026-11-06 passed. Rules, fixtures, what is
  UNVERIFIED: CLAUDE.md § Target clubs/coaches and outreach drafts.
- Site and sign-in share one look (job 199 design review, 2026-11-10): `--navy` = the app's `--pitch`, one wordmark,
  one flat-gold primary button (`--radius-btn`), captions 11px or more, the sign-in column capped at `AUTH_COLUMN`,
  visible field labels, `404.html` with the shared header and a no-script `<details>` menu.
  `tests/test_first_screen_design.cjs` pins it (CLAUDE.md § Static site).
- The 18+ threshold lives in four places that must not drift (CLAUDE.md § Current state).
- Full detail: CLAUDE.md § Architecture; README.md § Things that will bite you.

## Important files
- `CLAUDE.md` (authoritative), `README.md`, `tests/README.md`, `AI_HANDOFF.md`, `ADS-BUILD-ORDER.md`
  (Athlete Direction System plan), `DESIGN-HANDOFF.md`, `SPEC-custom-pathway-stages.md`, `SETUP.md`.
- `golsz-app.html`, `js/app.js`, `api/scout.js`, `supabase-schema.sql`, `vercel.json`,
  `package.json`, `.github/workflows/check.yml`, `.env.example`.
- Doc drift fixed 2026-10-22: CLAUDE.md (§ Commands, § Architecture > The app and CSP, § THE DEPLOY
  GATE, monitoring), README.md (suite count, `STRIPE_PORTAL_LINK`: the link is correct), check.yml
  comments. Suite counts are quoted "as of 2026-10-22"; `node tests/run-all.cjs` prints the current one.
- The two stale code comments (`tools/precompile.cjs`, `api/health-alert.js`) were fixed 2026-10-22.
- Repo-root docs were served on golsz.com (verified 2026-10-22). `tools/unpublish-internal.cjs` now removes
  them at deploy time (never touches `api/`). Still keep them free of anything private: the repo is public.

## Environment variables (names only, never values)
- Template `.env.example`; production values live in Vercel. Full list:
  `grep -oh 'process\.env\.[A-Z0-9_]*' api/*.js | sort -u`.
- AI: `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GOOGLE_AI_API_KEY`, `SCOUT_MODEL`, `SCOUT_HAIKU_MODEL`,
  `SCOUT_FALLBACK_*`, `SCOUT_GLOBAL_ENABLED`, `SCOUT_PREMIUM_ENABLED`, `SCOUT_*_COST*`,
  `SCOUT_*_SPEND_LIMIT_USD`, `MODERATION_*`. Limits: `*_DAILY_LIMIT`, `FREE_LIFETIME_LIMIT`,
  `SIGNUP_DAILY_LIMIT_PER_IP`, `TARGET_REMINDER_DAYS`, `BENCH_MIN_*`, `HEALTH_*`, `HEARTBEAT_*`.
- Platform: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_WEBHOOK_SECRET`, `ALLOWED_ORIGIN`,
  `CRON_SECRET`, `TURNSTILE_SECRET_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`,
  `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_{BASIC,PRO,ELITE}_{CAD,USD,EUR}`, `VERCEL_*` (set by Vercel).

## Current unfinished work
Live detail: AI_HANDOFF.md, rewritten by whichever agent worked last. Standing items, as of 2026-10-28:
- Migrations: everything through 164 is applied EXCEPT 162 (admin MFA enforcement), which must not run
  until the owner has enrolled an authenticator (OWNER-RUNBOOK.md section 8). supabase-schema.sql marks it.
  165 (outreach_targets caps + `updated_at` trigger, AVA job 184, 2026-11-06) is NOT YET APPLIED: additive, the
  app does not depend on it, run it once job 184 is on `main`.
- Payments live, but no real purchase yet: the Stripe webhook signing secret is unverified. Do not
  call payments working (CLAUDE.md § Current state).
- Legal review: LEGAL-REVIEW-BRIEF.md (under-18 managed profiles are off; the live questions are French
  terms, Law 25, health information, AI providers).
- `ADS-BUILD-ORDER.md` STATUS (updated 2026-10-28) says, phase by phase, what is built and what is not.
- Done on 2026-10-22, no longer open: migrations 158/159/160 applied, `SUPABASE_WEBHOOK_SECRET` rotated
  and 026 re-run, admin MFA/roles merged to `main`.

## Git workflow
- Remote `origin` (GitHub, public), default branch `main`, one checkout (no extra worktrees).
- **A push to `main` is a production deploy to golsz.com.** `npm run check` must be green before
  every push. Any push or PR also runs `check.yml` (`npm ci`, `npm run check`).
- Most commits go straight to `main`; larger work used feature branches merged by GitHub PR
  (`redesign/phase-*`, PRs #3 to #7, 2026-10-20).
- Rule 10 here: push to `main` at session end only if the gate is green and the change is safe to
  ship; otherwise push a feature branch and say so in AI_HANDOFF.md. Branch naming: Not
  documented. Owner to confirm.
- No push runs migrations: they are applied by hand in the Supabase SQL Editor.
- Commit style: a headline saying what was wrong or changed, a body with the why, ending with the
  gate result (e.g. `npm run check: 110/110 suites, 5,252 assertions.`).
