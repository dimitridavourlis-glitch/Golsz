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
  hardcoded arrays. Feed/Discover/Events/Passport all render from these regardless of backend config; only
  Scout makes a real network call. Wiring a screen to Supabase means replacing its hardcoded array with a
  query against the matching table in `supabase-schema.sql`, not adding a parallel data path.
- **Backend config is one block near the bottom of the file**, all blank by default (preview/demo mode):
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SCOUT_ENDPOINT`, `STRIPE_LINKS`. `sb` (the Supabase client) is
  `null` whenever the first two are blank, and code throughout checks `if (sb)` before touching auth —
  preserve that guard pattern rather than assuming `sb` exists.
- **Scout fetch has a fallback**: if `SCOUT_ENDPOINT` is unset, `Scout()`'s `send()` calls
  `https://api.anthropic.com/v1/messages` directly from the browser. That path has no API key attached (it
  would fail/CORS in practice) and exists only as a demo placeholder — it is not a secondary supported
  production path. Real usage always goes through `api/scout.js`.
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
  `FREE_DAILY_LIMIT` (default 8/day).

### `supabase-schema.sql`

- Seven tables: `profiles` (root identity, 1:1 with `auth.users` — role, full_name, email, date_of_birth,
  plan), `athletes`/`coaches`/`agents` (1:1 role-specific extensions of `profiles`, keyed by `profile_id`),
  `clubs` (organizations, not 1:1 with any single profile — has its own `id` + `owner_profile_id`),
  `parent_links` (parent/child `profiles` pairs with a nullable `approved_at` — null means pending
  verification, not yet real access), and `scout_history` (append-only: `role in ('user','assistant',
  'usage')` — `'usage'` rows are written by `increment_scout_usage()` purely for metering; `'user'`/
  `'assistant'` rows would hold a real transcript if the client ever writes them, which it doesn't yet).
- `handle_new_user()` reads `role`/`full_name`/`date_of_birth` out of the signup JWT's
  `raw_user_meta_data` (populated by `golsz-app.html`'s `Auth` component via `signUp({ options: { data:
  {...} } })`) and creates the matching `profiles` row plus the role-specific extension row.
- `is_parent_of(child uuid)` checks `parent_links` for an approved row, not a `parent_id` column — any new
  table holding a minor's data should gate access with `auth.uid() = owner_id OR is_parent_of(owner_id)`,
  same as `profiles`/`scout_history` already do.
- Table creation order matters: `clubs` is created before `coaches` because `coaches.club_id` references
  it — don't reorder without checking FK dependencies if you add more tables.
- There is no `programs` table in this version of the schema (an earlier iteration had one for an
  NCAA/NAIA/USPORTS school directory) — Scout's target-school suggestions currently come entirely from
  its live web-search tool call, not from a seeded database table.

## Current state

**Real when configured:** accounts, sessions, sign-out, per-user data isolation via RLS, a working hosted
Scout with the API key protected server-side and free-tier metering (now counted via `scout_history` rows
with `role = 'usage'`, not a separate counter table).

**Still mock regardless of config:** Feed, Discover, and Events in `golsz-app.html` render from hardcoded
arrays (`FEED`, `PLAYERS`, `EVENTS`) — not wired to `athletes`/`coaches`/`clubs` yet even though those
tables exist. The Passport screen also doesn't read from `athletes` yet — it renders the hardcoded
`PASSPORT` object regardless of the signed-in user.

**Not yet built:** a Stripe webhook to write a subscription/plan update on payment (Payment Links collect
money today but don't gate any Pro/Elite feature — `profiles.plan` has to be updated some other way for
now); an actual verification step before a `parent_links` row's `approved_at` gets set (right now nothing
sets it, so `is_parent_of()` always returns false until that's built); and Scout transcript logging from
the client into `scout_history` (only the usage counter is wired, not the conversation itself).
