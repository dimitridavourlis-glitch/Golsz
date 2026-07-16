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
  (the "Digital Sports Passport" profile UI), `Scout` (AI chat), assembled by `GolszApp` (bottom tab bar on
  mobile, sidebar nav on desktop — see "Responsive layout" below) and mounted via `Root`, which decides
  between `Auth` and `GolszApp` based on Supabase session state.
- **All real data, no demo fallback anywhere** — `FEED`, `PLAYERS`, `EVENTS`, `THREADS` were all removed;
  the only hardcoded array left is `PASSPORT`, and it's used exclusively in the no-backend-at-all preview
  mode (`!sb`), never as a fallback for a real-but-empty query. Feed/Discover/Events/Passport/Messages all
  show an explicit "Loading…" state while their fetch is in flight and an honest empty state when it
  resolves to nothing — look for the `mapPost` / `mapAthlete` / `mapEvent` / `toPassport` helpers and the
  `load*()`-style fetch effects when touching any of these, not any hardcoded array.
- **Responsive layout** (`useIsDesktop()`, `min-width: 900px`): `GolszApp` renders two structurally
  different shells from the same page components/state — a sidebar-nav desktop layout and the original
  mobile bottom-tab-bar layout — branching on `isDesktop` before the final `return`. `Auth`'s plan cards
  (`.pricing-grid`) and `Discover`'s results (`.discover-grid`) go from 1/2 columns to 3 via CSS media
  queries in the shared `CSS` template string, not inline logic. **`<style>{CSS}</style>` must be included
  in every top-level screen** (`GolszApp`, `Auth`, `ResetPassword`) — `Auth` was missing it entirely until
  this was caught (no fonts, no focus-visible outlines, no responsive grid on the whole pre-login flow);
  if you add another top-level screen, don't forget it there too.
- **Theming (dark/light background, Settings button)**: every color in `C` (`C.pitch`, `C.chalk`, `C.lime`,
  etc.) is a CSS custom property string (`"var(--pitch)"`, ...), not a hardcoded hex value — the actual hex
  values live in the `CSS` template string's `:root { ... }` (dark, default) and `html[data-theme="light"]
  { ... }` (light) blocks. `useTheme()` toggles the `data-theme` attribute on `<html>` and persists to
  `localStorage["golsz-theme"]`; a tiny synchronous script in `<head>` reads that key before React even loads
  so there's no flash of the wrong background on reload. `SettingsButton` (header/sidebar, next to
  `NotificationBell`) is the only UI for it today. **`C.ink` is a deliberate exception** — a plain fixed hex
  (`#0D1210`), not a var — used for dark text sitting on top of lime buttons/chips (`background: C.lime,
  color: C.ink`); it must stay dark in both themes, since lime itself gets darkened for the light theme and
  theme-following text on top of it would go illegible. **Any new color must be added as a CSS var**, not a
  raw hex literal in a `style={{}}` object — a hardcoded hex will render correctly in dark mode (since that
  matches the old palette) but silently stay dark-mode-only forever once someone's on the light theme. Two
  CSS vars (`--lime-border`, `--amber-border`) exist specifically because `${C.lime}66`-style hex-alpha-suffix
  concatenation doesn't work once `C.lime` is a `var()` string (`var(--lime)66` isn't valid CSS) — use those
  instead of trying to append alpha digits to any `C.*` value.
- **Passport is a real, editable profile** as of migration 008: `toPassport()` merges `profiles.full_name`
  with the full `athletes` row (sport, position, gender, grad_year, gpa, height_cm, weight_kg, foot,
  recruiting_status, country, club_name, bio) into the passport-shaped display object, showing "—" for
  unset fields rather than demo values. `ProfileEditor` is the edit form (owner-only writes, already covered
  by the pre-existing `athletes_rw`/`profiles_self` policies — no new RLS was needed). The "Trust Stamps" and
  "Career Timeline" sections are demo-only flourishes with no backing data model — they're hidden entirely
  once a real profile loads (`{!real && ...}`), not faked with real data. `club_id`/`clubs` is a separate,
  empty, read-only directory table (no insert policy) — `athletes.club_name` is the real free-text field the
  UI actually writes to; don't wire new features to `club_id` without adding real directory-management first.
- **Onboarding**: a fresh signup that gets an immediate session (`Auth`'s `onDone(true)`) is routed straight
  to the Passport tab with the profile editor auto-opened (`GolszApp`'s `startOnboarding` prop → initial
  `page` state → `Passport`'s `autoEdit` prop, consumed once via `onAutoEditConsumed` so revisiting the tab
  later doesn't reopen it). Existing users with an incomplete profile (`!athletes.sport`) instead see a
  dismissible "Finish building your profile" banner — not force-interrupted.
- **Follows** (migration 006): `follows(follower_id, followed_id)`, public read, insert/delete restricted to
  `follower_id = auth.uid()`. Feed and Discover both maintain their own `following` state/`toggleFollow()` —
  not shared, each fetches independently.
- **Messages** (migration 007): real DMs, gated by `can_message()` — two profiles can message only if one
  follows the other (either direction) and neither has blocked the other; restricted minors (see below)
  can't send or receive DMs either. `messages_delete` lets a sender unsend their own messages. The header's
  unread-message dot reflects a real `read_at is null` count now, refetched on every `page` change — it is
  not realtime/pushed.
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
  `messages` jsonb column, one row per turn) — see `logTurn()` in the `Scout` component. Rows with
  `messages = '[]'` are metering markers written server-side by `increment_scout_usage()`, not real turns —
  they flatten to nothing when a transcript is rebuilt client-side, so no special filtering is needed.
- **Scout has real conversation threads** (migration 010, `scout_history.conversation_id`), like Claude/
  ChatGPT: "New chat" (the `+` button) starts a fresh `conversation_id` client-side and resets `msgs`;
  "History" (the clock-arrow button) lists every past `conversation_id` for the user (grouped/previewed
  client-side from `scout_history`, not a separate table) and reopens one on tap. On mount, only the most
  recent conversation is restored — **this is a behavior change**: before migration 010, every turn a user
  had ever sent was flattened into one ever-growing chat on load; now older turns are only reachable through
  History. `conversationId` lives in component state, read via closure inside `send()`/`logTurn()` — if you
  add new call sites that log turns, make sure they're inside the component (not a ref) so a "New chat"
  mid-request doesn't retroactively mislabel an in-flight reply's conversation.
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
  future posts are filtered out client-side) actions, hidden on your own posts.
- **Admin panel** (migration 009): there's no separate admin login — it's the same auth, gated by
  `profiles.is_admin`. `AdminPanel` (reached via a button on Passport, only rendered when the signed-in
  user's own profile has `is_admin = true`) has three tabs: **Reports** (resolve or delete the underlying
  post for anything in `post_reports`, now trackable via `resolved_at` instead of only being visible in the
  raw table), **Users** (search `profiles`, toggle `is_admin`, override `plan`), **Events** (create or delete
  any event — previously nobody could create a real event from the UI at all, only demo data existed).
  Every capability is enforced server-side by `is_admin()` in RLS, not just hidden in the UI — the component
  re-checks `is_admin` itself on mount too, so it fails closed (shows "Admins only") regardless of how it's
  reached. `profiles_admin_write`'s RLS is row-level, not column-level — it technically lets an admin update
  any column on any profile, not just `is_admin`/`plan`; the UI just doesn't expose more than that. There is
  no admin ability to delete an account or view/moderate DMs (`messages`) — both would need a server-side
  Supabase Admin API call (service-role, not the anon client) and were deliberately left out of this pass.
- **Personal opportunities** (migration 011): `events.visibility` (`'public'` | `'private'`) reuses the one
  `events` table for two different things — the admin-curated public directory (still exists, still visible
  in the admin panel and via `events_read` RLS) and a private, per-user "save this as an opportunity" list.
  `AddToEventsModal` (used from Feed's per-post button, a per-message button in `Messages` for messages
  *from* the other person, and a manual "Add opportunity" button on the Events page) always inserts
  `visibility: 'private'` — there's no UI path to create a public event outside the admin panel.
  `Events()` (the athlete-facing page) only queries and renders `visibility = 'private'` rows — the public
  directory has no UI surface of its own right now beyond the admin panel's Events tab; it isn't shown to
  athletes. Real data only, no demo fallback (the old `EVENTS` array was removed).
- **Deleting a DM conversation is a per-user hide, not a real delete** (migration 013,
  `hidden_conversations`): `messages_delete` RLS only lets you delete messages you sent, so a true "delete
  the whole conversation" would either leave the other person's messages behind or require letting either
  side delete the other's messages (silently wiping the thread for both people). Instead, hitting delete on
  a conversation just upserts a `hidden_conversations(user_id, other_id, hidden_at)` row; `loadConversations()`
  filters out any thread whose last message is older than `hidden_at`. Nothing is destroyed, the other
  participant's view is untouched, and the thread reappears automatically the moment a new message arrives
  after the hide — same behavior as most DM apps' delete/archive.
- **Integration point with the static site**: `GolszApp`'s `page` state initializes from
  `?page=` in the URL (validated against `feed|discover|scout|events|profile|messages|admin`, default `feed`).
  This is the *only* thing connecting the two halves of the repo — the marketing site's nav links are
  plain `<a href="golsz-app.html?page=...">` tags, nothing more. Don't assume any shared state, routing, or
  build artifacts between `index.html`/`contact.html`/`terms.html` and `golsz-app.html`.

### `api/scout.js` (Vercel serverless function)

- Deliberately thin: owns the model name, the system prompt, and the tool config (`web_search_20250305`)
  server-side so a browser caller can't override any of them or run up the bill — the client only ever
  sends `{ messages }`.
- ⚠️ **`api/scout.js`'s `SYSTEM_PROMPT` and `golsz-app.html`'s `SYS` are two separate, hand-duplicated
  strings that must be kept in sync manually.** `golsz-app.html`'s `SYS` is only used by `Scout()`'s
  unsupported direct-browser fallback (when `SCOUT_ENDPOINT` is unset) — real production traffic always
  goes through `api/scout.js`'s `SYSTEM_PROMPT`. This already caused one real bug: an instruction (Scout
  must never confirm it's Claude/Anthropic-powered) was added only to `golsz-app.html`'s copy and had zero
  effect in production because `api/scout.js` never saw it. When editing Scout's behavior/instructions,
  **edit `api/scout.js`'s `SYSTEM_PROMPT` first** (it's the one that matters), then mirror the change into
  `golsz-app.html`'s `SYS` for consistency — not the other way around.
- Auth + metering are conditionally skipped: the `getUserId`/`meter` calls only run `if
  (process.env.SUPABASE_URL)`. Without that env var set, the endpoint accepts unauthenticated requests
  with no rate limiting. This is intentional for early preview deploys, not a bug.
- `meter()` reads the caller's plan from the `profiles` table and increments usage via the
  `increment_scout_usage` Postgres RPC (defined in `supabase-schema.sql`); free-plan callers are capped at
  `FREE_DAILY_LIMIT` (default 8/day). **The free-tier plan value is `'starter'`, not `'free'`** — the live
  `plan_tier` enum only allows `'starter' | 'pro' | 'elite'` (confirmed 2026-07-15 via direct write attempts;
  `'free'` errors with `invalid input value for enum plan_tier`). Before migration 008, this check compared
  against `'free'` and `handle_new_user()` never applied the signup's chosen plan at all, so the daily limit
  silently never fired for any user — real cost exposure. If you ever add a new plan tier, add it to the
  Postgres enum first (`alter type plan_tier add value ...`) and confirm it live before referencing it
  anywhere in code — don't assume a string is a valid enum value just because it appears in `PLANS`.
- `meter()` also reads `profiles.is_admin`; the daily-limit check is skipped entirely when `isAdmin` is
  true, regardless of `plan`. Admins are exempt from Scout's rate limit even on the Starter plan — being
  admin doesn't otherwise change `plan`, so without this check an admin account would get capped like
  anyone else.

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

### `api/send-push.js` (Vercel serverless function)

- Real OS-level push notifications (phone lock screen / laptop notification center), not an in-app-only
  bell. Two moving parts: the client (in `golsz-app.html`) subscribes the browser via the Push API and
  stores the subscription in `push_subscriptions` (migration 014); this function is what actually sends.
- **Not triggered by a client request.** It's called by two Supabase Database Webhooks you configure by
  hand in the Dashboard (Database → Webhooks): one on `messages` INSERT, one on `follows` INSERT. Supabase
  POSTs `{ type, table, record, old_record }`; this reads who to notify from `record` and looks up their
  `push_subscriptions` rows with the service role key.
- **Uses the `web-push` npm package** (the one deliberate exception to the "no npm dependency" pattern
  `api/scout.js`/`api/stripe-webhook.js` follow) — hand-rolling VAPID JWT signing + RFC 8291 payload
  encryption (ECDH/HKDF/AES-128-GCM) is real cryptography with no live device to test failures against; a
  maintained library is the safer call here. `package.json` at the repo root pulls it in; Vercel installs it
  automatically at deploy time, same as any Node serverless project.
- Requires a shared secret (`SUPABASE_WEBHOOK_SECRET`) checked against the `x-webhook-secret` header — set
  that same value as a custom header on both Database Webhooks in the Supabase Dashboard, so this endpoint
  can reject anything that isn't actually Supabase.
- `VAPID_PUBLIC_KEY` is duplicated in `golsz-app.html` (client-safe, it's public by design) and in Vercel's
  env vars (server needs it too, to pair with `VAPID_PRIVATE_KEY` when signing). If you ever regenerate the
  VAPID keypair (`npx web-push generate-vapid-keys`), update both places or push sends will fail silently.
- Stale subscriptions (endpoint gone — uninstalled PWA, permission revoked, etc.) return 404/410 from the
  push service; this function deletes them from `push_subscriptions` on that response instead of retrying.

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
Events on real Supabase data with honest loading/empty states (every hardcoded demo array was removed —
there is no fake-content fallback anywhere in the app anymore); a working hosted Scout with the API key
protected server-side, free-tier metering (now correctly enum-safe, see `api/scout.js` above), and real
transcript persistence; parent verification (request/approve, RLS-enforced, not just UI); minor safety
(restricted posting/Discover/DM visibility until a parent approves); Feed post creation with report/block
moderation; follows (migration 006); real DMs gated by follow relationship (migration 007) with live delivery
via Realtime (migration 015 — an open thread updates the moment a reply arrives, no manual refresh); a fully
editable Passport with onboarding auto-opened right after signup (migration 008); real Web Push notifications
for new messages and new followers (migration 014, `api/send-push.js`).

**Message-button visibility matches `can_message()` exactly.** `can_message(a, b)` allows messaging when
either profile follows the other, not just when the current viewer is the follower. Feed/Discover/Passport
each track both `following` (who I follow) and `followedBy`/`followedByThem` (who follows me) and show the
Message button on `following || followedBy` — showing it only for `following` (an earlier version of this)
meant someone who follows you but you haven't followed back had no way to see they *could* message you, even
though the backend allowed it. If you add another place that surfaces a Message button, gate it the same way.

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
- **Push notifications need one-time manual setup** before they'll actually fire: `VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, and `SUPABASE_WEBHOOK_SECRET` set as Vercel env vars, plus two
  Database Webhooks created by hand in the Supabase Dashboard (see `api/send-push.js` above). The
  client-side subscribe/unsubscribe UI (`NotificationBell` in `golsz-app.html`) works regardless, but
  nothing actually gets sent until that server-side wiring is done.
