# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

GOLSZ — "the LinkedIn for sport" / AI sports-recruiting agent, pre-launch, Montreal-based. The repo is two
things glued together, not one app:

1. **A static marketing site** — `index.html`, `contact.html`, `terms.html`, `css/styles.css`, `js/main.js`,
   `assets/`. Plain HTML/CSS/JS, no build step, no framework, no package manager.
2. **The real product** — `golsz-app.html`, a single self-contained React SPA (mobile app shell: Feed,
   Discover, AI Scout, Events, Passport/Profile, Messages), backed by `api/scout.js` (Vercel serverless proxy
   to the Anthropic API) and `supabase-schema.sql` (Postgres schema + RLS for Supabase).

The marketing site links into the app via query param instead of sharing any code — see "Integration point"
below. There is no repo-level `package.json`, linter, or test suite; there is nothing to `npm install` or
build.

**⚠️ `supabase-schema.sql` describes the live database, not a design intent.** The live Supabase project
(ref `wachjqfhlbchcuovyewg`) was built up across several undocumented sessions before this file existed, and
drifted from earlier design docs (different column names, missing columns). Everything in `supabase-schema.sql`
today was written by introspecting the real database directly (`information_schema`, `pg_proc`, `pg_policies`)
— trust it over anything that sounds like a plausible Postgres schema from memory. In particular:
`profiles` has **no `email` column** and uses `dob`, not `date_of_birth`; `athletes`/`coaches`/`agents` use
`id` directly (equal to `profiles.id`) with **no separate `profile_id` column**; `scout_history` is
`(id, user_id, messages jsonb, created_at)`, not role/content columns. If you're about to write SQL against
assumptions instead of a fresh introspection, stop and check the live schema first — the drift is exactly how
this file's predecessor version broke a running migration mid-session.

## Commands

There is no build/lint/test tooling in this repo. Relevant commands:

- **Preview the static site locally:** serve the directory over HTTP (not `file://`, since `fetch`/module
  scripts and relative asset paths need a real origin) — e.g. `python3 -m http.server 8000` or `npx serve .`
  from the repo root, then open `index.html` / `golsz-app.html` in a browser.
- **Run the Scout serverless function locally:** `npx vercel dev` (requires the Vercel CLI and the env vars
  from "Backend config" below, either in `.env` or via `vercel env pull`). Plain static hosting will not
  execute `api/scout.js` — only Vercel (or an equivalent serverless platform) will.
- **Deploy:** push to a Vercel project (dashboard-connected or `vercel deploy`). Vercel auto-detects
  `api/scout.js` as a serverless function at `/api/scout` with zero config — no framework/build settings
  needed. Netlify/Cloudflare Pages work for the static pages but would need their own equivalent of a
  serverless function for `api/scout.js` (Netlify Functions / Pages Functions) if not deploying to Vercel.
- **Database migrations:** there's no migration tool — `supabase-schema.sql` is applied by pasting it into
  the Supabase project's SQL Editor and running it once. Any schema changes should be made as additive SQL
  appended to (or as a new file alongside) that script, since it also defines the `handle_new_user()` trigger
  and RLS policies that the app depends on.

## Architecture

### Static site (`index.html`, `contact.html`, `terms.html`)

- One shared stylesheet, `css/styles.css`, drives every page via CSS custom properties defined once in
  `:root` — the whole visual identity (pitch/turf/card backgrounds, lime accent, chalk/slate text, Archivo +
  Space Mono type) is expressed as `--navy`, `--charcoal`, `--surface`, `--gold`, `--gold-bright`, `--ink`,
  `--ink-muted`, `--font-display`, `--font-mono`, etc. The variable *names* are legacy from an earlier
  navy/gold brand pass — only their *values* were repointed to the current pitch/lime palette to avoid a
  464-usage rename across the stylesheet. When touching color, change the `:root` value, not individual
  selectors.
- `js/main.js` is a single IIFE with no external deps: `initMobileNav()`, `initActiveNav()` (matches each
  nav link's `data-page` attribute against `location.pathname` to highlight the current page — only
  Home/Contact links carry `data-page` now, since Feed/Discover/Profile nav links point off-site into the
  app), `initScrollReveal()` (IntersectionObserver adding `.is-visible` to `.reveal` elements),
  `initForms()` (front-end-only waitlist form validation + fake success state; nothing is actually
  submitted anywhere — see the NOTE comment at the top of the file for the two ways to wire a real
  endpoint).
- `index.html` is a single long page: How It Works, Features, and About are all sections on this one page
  (`#how-it-works`, `#features-section`, `#about-section`) rather than separate pages — an earlier
  consolidation collapsed a 5+ page site down to this plus Contact/Terms.

### The app (`golsz-app.html`)

- Fully self-contained: React 18 + ReactDOM (UMD builds) and `@supabase/supabase-js` loaded from CDN
  `<script>` tags, JSX transpiled in-browser via Babel standalone (`<script type="text/babel">`). No JSX
  build step — edit the file directly and reload.
- Component tree lives under one `<script>` block: `Feed`, `Discover`, `Events`, `Messages`, `Passport`
  (the "Digital Sports Passport" profile UI), `Scout` (AI chat), assembled by `GolszApp` (the bottom
  tab-bar shell with Scout as the raised center button) and mounted via `Root`, which decides between
  `Auth` and `GolszApp` based on Supabase session state.
- **Mock data lives at the top of the script** — `PASSPORT`, `FEED`, `PLAYERS`, `EVENTS`, `THREADS` are
  hardcoded arrays. **Feed, Discover, and Events now fetch real Supabase data when `sb` is configured**,
  falling back to these arrays only when the real query returns zero rows (so the app still looks populated
  pre-launch) or when `sb` is null (preview mode). `Passport` and `Messages` are still fully hardcoded —
  nobody has wired those to real tables yet. When touching Feed/Discover/Events, look for the `mapPost` /
  `mapAthlete` / `mapEvent` helpers and the `loadFeed()`-style fetch effects, not the arrays themselves.
- **Backend config is one block near the bottom of the file**: `SUPABASE_URL` / `SUPABASE_ANON_KEY` are set
  to the live project; `SCOUT_ENDPOINT` is `"/api/scout"` (relative — works on any Vercel deploy without
  hardcoding a domain); `STRIPE_LINKS` is still blank pending real Stripe Payment Links (see "Current
  state"). `sb` (the Supabase client) is `null` whenever `SUPABASE_URL`/`SUPABASE_ANON_KEY` are blank, and
  code throughout checks `if (sb)` before touching auth — preserve that guard pattern rather than assuming
  `sb` exists.
- **Scout fetch has a fallback**: if `SCOUT_ENDPOINT` is unset, `Scout()`'s `send()` calls
  `https://api.anthropic.com/v1/messages` directly from the browser. That path has no API key attached (it
  would fail/CORS in practice) and exists only as a demo placeholder — it is not a secondary supported
  production path. Real usage always goes through `api/scout.js`.
- **Scout persists its transcript** to `scout_history` (`{role, content}` objects packed into the
  `messages` jsonb column, one row per turn) and restores it on mount — see `logTurn()` in the `Scout`
  component. Rows with `messages = '[]'` are metering markers written server-side by
  `increment_scout_usage()`, not real turns — they flatten to nothing when the transcript is rebuilt client
  -side, so no special filtering is needed when reading them back.
- **Minor safety**: `Auth`'s signup requires a parent/guardian email when the athlete is under 18
  (`isMinor`), sent as `parent_email` in the signup metadata. `handle_new_user()` auto-creates a *pending*
  `parent_links` row if that email already belongs to an account — approval still has to happen explicitly
  (see `FamilyAccess` / `RestrictedBanner`). Until approved, `is_restricted_minor()` blocks the minor from
  posting to Feed and hides them from Discover, enforced in RLS (`posts_write`, `athletes_read`), not just
  the UI — `RestrictedBanner` is a same-state client-side mirror of that check, for display only. This is
  mutual in-app consent, not COPPA/GDPR-K verified parental consent — get legal review before relying on it
  for real minors in production.
- **Feed moderation**: `Feed`'s compose box inserts into `posts` directly (RLS-gated, see above). Each real
  post has inline **Report** (writes to `post_reports`) and **Block** (writes to `blocks`, then the poster's
  future posts are filtered out client-side) actions, hidden on your own posts. There's no moderation queue
  UI — review `post_reports` and delete rows from `posts` directly via the Supabase table editor;
  `posts_delete`'s RLS also allows any profile with `is_admin = true` to delete any post, so flip that once
  on your own `profiles` row via SQL to moderate from the app itself instead.
- **Integration point with the static site**: `GolszApp`'s `page` state initializes from
  `?page=` in the URL (validated against `feed|discover|scout|events|profile|messages`, default `feed`).
  This is the *only* thing connecting the two halves of the repo — the marketing site's nav links are
  plain `<a href="golsz-app.html?page=...">` tags, nothing more. Don't assume any shared state, routing, or
  build artifacts between `index.html`/`contact.html`/`terms.html` and `golsz-app.html`.

### `api/scout.js` (Vercel serverless function)

- Deliberately thin: owns the model name, the system prompt, and the tool config (`web_search_20250305`)
  server-side so a browser caller can't override any of them or run up the bill — the client only ever
  sends `{ messages }`.
- Auth + metering are conditionally skipped: the `getUserId`/`meter` calls only run `if
  (process.env.SUPABASE_URL)`. Without that env var set, the endpoint accepts unauthenticated requests
  with no rate limiting. This is intentional for early preview deploys, not a bug.
- `meter()` reads the caller's plan from the `profiles` table and increments usage via the
  `increment_scout_usage` Postgres RPC (defined in `supabase-schema.sql`); free-plan callers are capped at
  `FREE_DAILY_LIMIT` (default 8/day). This only starts being *correct* once `profiles.plan` reflects real
  payment — see `api/stripe-webhook.js` below.

### `api/stripe-webhook.js` (Vercel serverless function)

- Verifies the Stripe signature by hand (`crypto.createHmac`, no `stripe` npm dependency — keeps this
  project dependency-free like `api/scout.js`). Needs `bodyParser: false` (exported via `config`) since
  signature verification requires the raw request bytes, not Vercel's auto-parsed JSON.
- Handles two event types: `checkout.session.completed` (sets `profiles.plan` + `stripe_customer_id`,
  identified via `client_reference_id` — see below) and `customer.subscription.deleted` (reverts to
  `'free'`, matched by `stripe_customer_id`). Everything else is acknowledged with 200 and ignored.
- **Plan is inferred from `amount_total`** (Pro ≥ $29 → `'pro'`, Elite ≥ $79 → `'elite'`), because Stripe
  Payment Links don't carry arbitrary metadata through the URL — only `client_reference_id` and
  `prefilled_email`. If Pro/Elite pricing ever changes, update the thresholds in this file to match `PLANS`
  in `golsz-app.html`.
- **Attribution**: `Auth`'s checkout redirect in `golsz-app.html` appends
  `?client_reference_id=<user.id>&prefilled_email=<email>` to `STRIPE_LINKS[plan]` right after signup, so
  the webhook can identify who paid. If you ever change how/where checkout is triggered, keep that query
  param — it's the only link between a Stripe payment and a GOLSZ account.
- Register the deployed URL in the Stripe Dashboard (Developers → Webhooks), subscribed to
  `checkout.session.completed` and `customer.subscription.deleted`; the signing secret it gives you is
  `STRIPE_WEBHOOK_SECRET`.

### `supabase-schema.sql`

**Read the warning at the top of this repo's README section above before touching this file** — it's a
reference/documentation concatenation of the migrations that actually ran (002, 004, 005) against the live
project, not a from-scratch bootstrap script. The real tables:

- `profiles` — root identity, 1:1 with `auth.users`. Real columns: `id, full_name, role, plan, dob,
  created_at, is_minor, pending_parent_email, is_admin, stripe_customer_id`. **No `email` column** — look
  it up via `auth.users` inside a `security definer` function if you ever need it, same pattern as
  `request_parent_link()`.
- `athletes` / `coaches` / `agents` — 1:1 extensions of `profiles`, keyed by `id` (equal to `profiles.id`,
  **not** a separate `profile_id` column).
- `clubs` — standalone orgs, no write policy (read-only to every client today).
- `parent_links(id, parent_id, athlete_id, relationship, approved_at, created_at)` — `approved_at` null
  means pending. `is_parent_of(child)` requires an approved row; `is_restricted_minor(user)` is the inverse
  (true when the user is a minor with no approved link) and gates `posts_write` / `athletes_read`.
- `scout_history(id, user_id, messages jsonb, created_at)` — `messages` is a small jsonb array
  (`[{role, content}]`) per row, not separate role/content columns.
- `posts` / `post_likes` / `events` — added in migration 002; Feed/Discover/Events' real data source.
- `post_reports` / `blocks` — added in migration 005; minimum-viable moderation (report + block + admin
  delete via `is_admin()`, no queue UI).
- There is no `programs` table (an earlier iteration had one for an NCAA/NAIA/USPORTS school directory) —
  Scout's target-school suggestions come entirely from its live web-search tool call, not a seeded table.
- `handle_new_user()` reads `full_name` / `date_of_birth` / `parent_email` out of the signup JWT's
  `raw_user_meta_data` (populated by `Auth`'s `signUp({ options: { data: {...} } })`), computes `is_minor`
  from the DOB, and auto-creates a pending `parent_links` row if `parent_email` already has an account.
- Any new table holding a minor's private data should gate access with the same
  `auth.uid() = owner_id OR is_parent_of(owner_id)` pattern `profiles`/`scout_history` already use.

## Current state

**Real when configured:** accounts, sessions, sign-out, per-user data isolation via RLS; Feed/Discover/
Events on real Supabase data (falling back to demo content when empty); a working hosted Scout with the API
key protected server-side, free-tier metering, and real transcript persistence; parent verification
(request/approve, RLS-enforced, not just UI); minor safety (restricted posting/Discover visibility until a
parent approves); Feed post creation with report/block moderation.

**Still mock regardless of config:** `Passport` and `Messages` are fully hardcoded — nobody has wired those
to real tables (`athletes`/a real conversations table) yet.

**Not yet built / known gaps:**
- **Legal review.** The parent-verification flow is mutual in-app consent, not identity-verified
  COPPA/GDPR-K parental consent. `terms.html` also still contains a placeholder line stating real
  moderation/content terms "will be published before real accounts go live." Both need a lawyer's pass
  before this is genuinely launch-ready with real minors as users.
- **Stripe Payment Links themselves.** `STRIPE_LINKS` in `golsz-app.html` is still blank — the webhook and
  checkout attribution are built, but the actual Pro/Elite Payment Links need to be created in the Stripe
  Dashboard and pasted in.
- **Non-mechanical Pro/Elite features.** Only Scout's daily limit is actually gated by `profiles.plan`
  today. Marketing bullets like "full verified passport" or "priority visibility" aren't backed by any
  distinct mechanic anywhere in the app — gating those needs a product decision on what they mean first.
- **`coaches`/`agents`** have RLS enabled with zero policies (fully locked, even to their own owner) since
  nothing signs anyone up with those roles yet.
- **Deeper moderation** (a real review queue, automated detection) beyond report/block/admin-delete.
- Production monitoring/alerting (e.g. Sentry) — nothing wired up yet.
