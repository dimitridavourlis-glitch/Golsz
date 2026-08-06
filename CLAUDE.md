# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

GOLSZ — "the LinkedIn for sport" / AI sports-recruiting agent, pre-launch, Nicosia (Cyprus)-based. The repo is two
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
- **Language (i18n) — English/French/Spanish/Greek, full app coverage.** `I18N` (a plain object of
  `{en, fr, es, el}` dictionaries, ~150 keys each) + `LangContext`/`LangProvider`/`useLang()` live right after
  `useTheme()`. `LangProvider` wraps the entire app once, at the `ReactDOM.createRoot(...).render(...)` call —
  any component can call `const { t } = useLang();` and immediately get working translations with zero extra
  plumbing. Persisted to `localStorage["golsz-lang"]`, same pattern as theme. Language selection lives inside
  the existing `SettingsButton` modal (a "LANGUAGE" section under "BACKGROUND"), not a separate button.
  Every screen (nav, `Auth`, `Feed`, `Discover`, `Messages`, `Scout`, `Passport` + its sub-components
  `FamilyAccess`/`Highlights`/`ProfileEditor`/`FollowListCard`/`BlockedAccounts`, `Events`/`AddToEventsModal`,
  `AdminPanel`, `ResetPassword`) is translated. **Deliberately left in English, by design, not oversight:**
  literal data values stored as-is in the DB (sport/position names in `SPORT_POSITIONS`/`POSITIONS`,
  `recruiting_status` option values, `SPORT_PREFERENCE` labels/options like "Left"/"Right") — translating the
  label without translating what's actually stored would create a display/data mismatch; plan tier names
  ("Starter"/"Pro"/"Elite", a brand label like Spotify's "Premium"); and a handful of rare edge-case fallback
  strings ("Unknown" reporter name, "(post deleted)", "Not signed in.") that aren't worth a translation key.
  `PLANS` sources `tag`/features from `plan_<id>_tag` / `plan_<id>_featN` keys via `featKeys` — if you add a
  plan or change its features, add the matching keys to all four languages or `t()` will silently fall back to
  the key name in fr/es/el. The "MOST POPULAR" ribbon is keyed off `pl.id === "pro"`, not an English string
  match — don't revert that to `pl.tag === "Most popular"`, `tag` isn't English text anymore.
  **`toPassport()` and `scoutGreetingFor()` are plain functions, not components** — they can't call `useLang()`
  themselves (hooks rule), so they take `t` as an explicit parameter from the calling component instead; if you
  add another helper like this that needs translated text, follow the same pattern rather than trying to call
  `useLang()` outside a component.
  **Watch for `t` shadowing**: several `.map()` callbacks in this codebase used `t` as a loop variable before
  `t` meant "translate" (e.g. Messages' conversation list) — `(t) => t.who` inside a component that also
  destructures `const { t } = useLang()` shadows the translator with the loop item, and `t("some_key")` inside
  that scope throws `t is not a function`. Already renamed the real collision (conversation `t` → `conv` in
  `Messages`); if you add a new `.map()` in a translated component, don't name the item `t`.
  **Scout's AI replies are language-aware too**, not just the UI chrome: the client sends `lang` in the
  `/api/scout` request body; `api/scout.js` validates it against `LANG_NAMES` (never interpolates the raw
  client string) and appends a "Respond in {language}" instruction to the real `SYSTEM_PROMPT` when it isn't
  English. This only affects the real server-side prompt — `golsz-app.html`'s `SYS` fallback constant (the
  unsupported direct-browser path, see the dual-system-prompt warning above) was deliberately left alone since
  it isn't what production actually uses.
- **Feed posts support a photo and links** (migration 016): `posts.image_url` is set client-side after a
  successful upload to the `post-images` Storage bucket (public read; write/delete restricted by RLS to files
  under the uploader's own `${uid}/...` path prefix — see `storage.foldername(name))[1] = auth.uid()::text` in
  the migration). No dedicated "link" field or UI — `Linkify` auto-detects any `http(s)://` URL typed into a
  post's body text and renders it as a real link at display time, both in Feed and anywhere else `p.body` is
  shown. `URL_RE_SPLIT` (has the `g` flag, used for `.split()`) and `URL_RE_TEST` (no `g` flag, used for
  `.test()`) are deliberately two separate `RegExp` objects — reusing one global-flagged regex for both would
  corrupt `lastIndex` between calls and silently drop every other match.
  **Post-images access, precisely**: every non-restricted-minor real account can upload (no plan/tier gate) —
  migration 017 added `not is_restricted_minor(auth.uid())` to `post_images_write` to match `posts_write`'s
  posture exactly, since the original migration 016 policy only checked the uploader's own uid-prefixed path,
  not whether they were restricted at all. Migration 017 also moved the 8MB size / image-only type check from
  client-side-only (`pickImage()`'s courtesy check) to real enforcement via the bucket's `file_size_limit` /
  `allowed_mime_types` columns — before that, anyone calling the Storage API directly with their own
  credentials could've uploaded a larger or non-image file. Uploaded images are publicly readable by anyone
  with the URL, signed in or not — consistent with `posts_read using (true)`, not a new category of exposure.
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
- **Messages** (migration 007, request model replaced in migration 037): real DMs, gated by `can_message()`
  — originally required a follow relationship, now an Instagram-style request/accept flow instead (see the
  dedicated section below); neither has blocked the other; restricted minors (see below) can't send or
  receive DMs either. `messages_delete` lets a sender unsend their own messages. The header's unread-message
  dot reflects a real `read_at is null` count now, refetched on every `page` change — it is not
  realtime/pushed.
- **Backend config is one block near the bottom of the file**: `SUPABASE_URL` / `SUPABASE_ANON_KEY` are set
  to the live project; `SCOUT_ENDPOINT` is `"/api/scout"` (relative — works on any Vercel deploy without
  hardcoding a domain); `STRIPE_LINKS` holds real (currently sandbox/test-mode) Stripe Payment Link URLs for
  Pro/Elite — swap these to Live-mode links (and rotate `STRIPE_WEBHOOK_SECRET` to the Live webhook's signing
  secret) before accepting real payments. `sb` (the Supabase client) is `null` whenever
  `SUPABASE_URL`/`SUPABASE_ANON_KEY` are blank, and
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
  `increment_scout_usage` Postgres RPC (defined in `supabase-schema.sql`). **Four tiers, all capped — Elite
  is a higher ceiling, not unlimited**: Free at `FREE_DAILY_LIMIT` (default 3/day), Starter at
  `STARTER_DAILY_LIMIT` (default 8/day), Pro at `PRO_DAILY_LIMIT` (default 15/day), Elite at
  `ELITE_DAILY_LIMIT` (default 20/day) — matches `PLANS`' pricing in `golsz-app.html` ($0/$6/$14/$30). If you
  touch these limits again, update the marketing copy in the same commit rather than letting it drift out of
  sync with reality — this has bitten this file before (a card claiming "Unlimited" when the code no longer
  guaranteed it). **`plan_tier` now genuinely has a `'free'` value** (migration 048, added this session) —
  before that, `'starter'` did double duty as the free/default tier, and before migration 008, this file
  compared against a `'free'` string the enum didn't even contain yet, so the daily limit silently never
  fired for any user. If you ever add another plan tier, add it to the Postgres enum first
  (`alter type plan_tier add value ...`) and confirm it live before referencing it anywhere in code — don't
  assume a string is a valid enum value just because it appears in `PLANS`.
- `meter()` also reads `profiles.is_admin`; the daily-limit check is skipped entirely when `isAdmin` is
  true, regardless of `plan`. Admins are exempt from Scout's rate limit no matter their plan — being
  admin doesn't otherwise change `plan`, so without this check an admin account would get capped like
  anyone else.
- **`search_golsz_players` (migration 022)**: a second tool alongside `web_search_20250305`, but a *client-side*
  one from Anthropic's perspective — Anthropic only tells us the model wants to call it; this file has to
  actually run it and send a `tool_result` back, which is why the single Anthropic `fetch` became a loop
  (`MAX_TOOL_TURNS = 4`) that keeps turning the conversation over to Anthropic and back until `stop_reason`
  stops being `"tool_use"` for this tool. If it's still mid-tool-call after 4 turns, one final no-tools call
  forces real reply text rather than returning an empty `content` array (the client only renders text blocks,
  so that would've reproduced the empty-bubble bug documented elsewhere in this file). `searchPlayers()` calls
  the `search_players()` Postgres function with the service-role key, which **bypasses RLS entirely** — all
  the "don't surface a restricted minor or a banned account" filtering lives inside that SQL function
  (`is_restricted_minor()`/`is_banned()`, same helpers `athletes_read` RLS already uses), not in this file.
  Also scoped to `occupation = 'Player'` (or unset) since every profile gets an `athletes` row regardless of
  occupation, so a Coach/Scout/Physio's own athletes row (sport set, if they filled one in) shouldn't turn up
  in a search for real players.

### `api/stripe-webhook.js` (Vercel serverless function)

- Verifies the Stripe signature by hand (`crypto.createHmac`, no `stripe` npm dependency — keeps this
  project dependency-free like `api/scout.js`). Needs `bodyParser: false` (exported via `config`) since
  signature verification requires the raw request bytes, not Vercel's auto-parsed JSON.
- Handles two event types: `checkout.session.completed` (sets `profiles.plan` + `stripe_customer_id`,
  identified via `client_reference_id` — see below) and `customer.subscription.deleted` (reverts to the real
  `'free'` tier — matched by `stripe_customer_id`). Everything else is acknowledged with 200 and ignored.
- **Plan is inferred from `amount_total`** (Starter ≥ $6 → `'starter'`, Pro ≥ $14 → `'pro'`, Elite ≥ $30 →
  `'elite'`), because Stripe Payment Links don't carry arbitrary metadata through the URL — only
  `client_reference_id` and `prefilled_email`. **This file went stale once already**: pricing moved to
  $6/$14/$30 earlier in the same session this file was updated, but the thresholds here were left at the old
  $29/$79 values — every real Starter/Pro payment silently mapped to `plan=null` (no upgrade applied at all)
  and every Elite payment mapped to `'pro'` instead, until caught and fixed while unrelated free-tier work
  touched this same plan logic. If Starter/Pro/Elite pricing ever changes, update the thresholds here in the
  **same commit**, not a follow-up — `PLANS` in `golsz-app.html` is the other half of this pair and they must
  never drift apart. Free never reaches this file — it has no Stripe link and never goes through checkout.
- **Attribution**: `Auth`'s checkout redirect in `golsz-app.html` appends
  `?client_reference_id=<user.id>&prefilled_email=<email>` to `STRIPE_LINKS[plan]` right after signup, so
  the webhook can identify who paid. If you ever change how/where checkout is triggered, keep that query
  param — it's the only link between a Stripe payment and a GOLSZ account.
- Register the deployed URL in the Stripe Dashboard (Developers → Webhooks), subscribed to
  `checkout.session.completed` and `customer.subscription.deleted`; the signing secret it gives you is
  `STRIPE_WEBHOOK_SECRET`.
- **`client_reference_id` (→ `profileId`) is validated as a real UUID (`UUID_RE`) before being interpolated
  into a PostgREST filter string.** Found during a full app audit: this value is whatever query param
  someone puts on the Payment Link URL when they start checkout — this app's own redirect always appends a
  real UUID, but anyone can open that same Payment Link by hand with an arbitrary value there. Without the
  UUID check, a crafted value (e.g. containing a URL-encoded `&` to smuggle in an extra filter clause) could
  have targeted a different row's `plan`/`stripe_customer_id` than the one actually paying. `customerId`
  isn't given the same treatment — it's Stripe's own generated `cus_...` id, not something the person
  initiating checkout can set directly, so it doesn't carry the same risk.

### `api/send-push.js` (Vercel serverless function)

- Real OS-level push notifications (phone lock screen / laptop notification center), not an in-app-only
  bell. Two moving parts: the client (in `golsz-app.html`) subscribes the browser via the Push API and
  stores the subscription in `push_subscriptions` (migration 014); this function is what actually sends.
- **Not triggered by a client request.** It's called by two Postgres triggers (migration 026,
  `notify_new_message` on `messages` and `notify_new_follower` on `follows`, both `AFTER INSERT`), sharing one
  trigger function (`notify_send_push()`) that calls `net.http_post()` (the `pg_net` extension) to POST
  `{ type, table, schema, record, old_record }` at this endpoint — this reads who to notify from `record` and
  looks up their `push_subscriptions` rows with the service role key. Older docs/UIs call this pattern
  "Database Webhooks"; some Supabase dashboard versions expose a wizard for it under Database → Webhooks,
  others only show Database → Triggers and have no such wizard — either way it's the same underlying
  mechanism, and migration 026 sets it up directly in SQL so it doesn't depend on which UI your project has.
  `net.http_post()` is async (queued by `pg_net`'s background worker, not awaited inline), so this doesn't add
  latency to a real message/follow insert.
- **Uses the `web-push` npm package** (the one deliberate exception to the "no npm dependency" pattern
  `api/scout.js`/`api/stripe-webhook.js` follow) — hand-rolling VAPID JWT signing + RFC 8291 payload
  encryption (ECDH/HKDF/AES-128-GCM) is real cryptography with no live device to test failures against; a
  maintained library is the safer call here. `package.json` at the repo root pulls it in; Vercel installs it
  automatically at deploy time, same as any Node serverless project.
- Requires a shared secret (`SUPABASE_WEBHOOK_SECRET`) checked against the `x-webhook-secret` header — the
  same value is embedded as a literal string inside `notify_send_push()`'s function body (a Postgres trigger
  has no way to read a Vercel env var at runtime, so this is unavoidable, and it's the same trade-off the
  old Dashboard-generated Webhook UI had). **If you ever rotate `SUPABASE_WEBHOOK_SECRET` in Vercel, re-run
  migration 026 with the new value too** — `create or replace function` makes that safe to redo any time.
- `VAPID_PUBLIC_KEY` is duplicated in `golsz-app.html` (client-safe, it's public by design) and in Vercel's
  env vars (server needs it too, to pair with `VAPID_PRIVATE_KEY` when signing). If you ever regenerate the
  VAPID keypair (`npx web-push generate-vapid-keys`), update both places or push sends will fail silently.
- Stale subscriptions (endpoint gone — uninstalled PWA, permission revoked, etc.) return 404/410 from the
  push service; this function deletes them from `push_subscriptions` on that response instead of retrying.
- **iOS only supports Web Push from an installed Home Screen app, never regular Safari/Chrome browsing** —
  true even on iOS 16.4+. `PushManager` can be feature-detected as present in regular mobile Safari and still
  throw the moment `pushManager.subscribe()` actually runs, which used to surface as a generic "something went
  wrong" with no way to self-diagnose. `isIOSDevice()` + `isStandaloneDisplay()` (both in `golsz-app.html`,
  next to `pushSupported()`) check for this upfront in `enablePushNotifications()` and throw a
  `{ code: "IOS_NEEDS_HOMESCREEN" }` error instead, which `NotificationBell` and `SettingsButton` both catch
  and turn into real instructions (`notif_ios_homescreen`, translated) — "Share → Add to Home Screen" — rather
  than a dead-end error. This is also why `<head>` now has the `apple-mobile-web-app-capable` meta tags and a
  `manifest.json`: without those, "Add to Home Screen" on iOS just makes a bookmark that still opens inside
  Safari's UI chrome (not standalone), so `isStandaloneDisplay()` would never actually pass even after
  installing.

### `api/admin-user-action.js` (Vercel serverless function)

- Backs the Admin Panel's ban/unban/delete buttons (migration 027) — the one place in the app that needs the
  real Supabase Admin API (service role key), so it can't be a client-callable RPC. Verifies the caller's JWT
  and checks `profiles.is_admin` itself (same `getUserId()` pattern as `api/scout.js`) before doing anything.
- `ban`/`unban` set `ban_duration` on the real `auth.users` row via the Admin API (`"876000h"` ≈ forever,
  `"none"` to lift it) in addition to the existing `profiles.is_banned` flag — the flag alone only ever gated
  app-level RLS/UI, not whether the account could actually log in.
- `delete` calls `admin_delete_profile_data(p_target uuid)` (`security definer`, granted to `service_role`
  only) to clean up the tables that don't cascade from `profiles`, then deletes the real `auth.users` row via
  the Admin API, which cascades to `profiles` and everything already cascading from it.
- Client calls this via `fetch("/api/admin-user-action", ...)` with a real `Authorization: Bearer` header
  (`AdminPanel`'s `callAdminUserAction()` in `golsz-app.html`) — not `sb.rpc()`, since there's no RPC to call
  anymore for these two actions.

### Real-time security alerts (`alertAdmins()` in `api/admin-user-action.js` and `api/moderate.js`)

- The founder asked for an immediate alert "if ever there is a hack or a security breach" rather than only
  finding out by opening the Admin Panel later. `alertAdmins(supaUrl, serviceKey, title, body)` — duplicated
  into both files, matching this codebase's existing per-file-helper convention rather than a shared module
  — pushes a real Web Push notification (same VAPID keys/`push_subscriptions` machinery as
  `api/send-push.js`) to every admin's registered device the moment either of these fires:
  1. **`api/admin-user-action.js`** — a signed-in but non-admin caller gets rejected (403) trying to
     ban/unban/delete a user. This is the clearest signal this endpoint can produce of someone actually
     probing for unauthorized admin access, as opposed to a normal user simply never hitting this endpoint.
  2. **`api/moderate.js`** — the classifier returns `minor_safety_triggered: true` on a `review`/`block`
     decision. Arguably the single most urgent thing this app can detect given who uses it, so it gets a
     push immediately rather than only showing up passively next time someone opens the Moderation tab.
- Triggered from inside these functions' own logic, not a Supabase Database Webhook — "a caller was
  rejected" or "the classifier flagged this" aren't row `INSERT`s on any table a webhook could hook into,
  they only ever happen inside this code. Awaited (not fire-and-forget) so Vercel doesn't tear the function
  down mid-send; wrapped in `try/catch` so a push failure can never block the real 401/403/200 response the
  endpoint always still returns regardless of whether the alert itself succeeds.
- **Honest scope, not full intrusion detection.** This does not (and structurally cannot, without a lot more
  work) catch: raw RLS-rejected REST calls made directly against Supabase bypassing these two endpoints
  entirely (those never reach this code at all — see the audit's live RLS testing elsewhere in this file),
  repeated failed login attempts (Supabase Auth's own login attempts aren't exposed to this app's tables),
  or a compromised admin account behaving suspiciously but still passing the `is_admin()` check. It's a
  real, working alert for the two concrete signals above — not a general security monitoring system. General
  application error visibility (not just these two security signals) is covered separately below.

### Application error log (migration 036, "Errors" tab)

- A lightweight, self-hosted stand-in for a third-party error tracker (Sentry etc.) — asked for right after
  the security alerts above, but broader: this is about the app just *breaking*, not a security signal.
  `error_log` (`source`, `message`, `detail jsonb`, `url`, `user_id`, `created_at`, `resolved_at`) captures
  two kinds of failures:
  1. **Client-side** — `golsz-app.html` registers global `window.addEventListener("error", ...)` and
     `("unhandledrejection", ...)` handlers (right after `sb` is defined, so they're active app-wide
     regardless of which screen is showing) that call `log_client_error(p_message, p_detail, p_url)`, a
     `security definer` RPC granted to **both** `anon` and `authenticated` — a crash can happen before
     someone's even signed in (e.g. on the signup screen), so restricting this to authenticated-only would
     silently lose exactly the crashes happening at the most fragile point (first-time visitors). Always
     stamps `user_id` from `auth.uid()` itself (null for anon), never trusts anything the client claims.
  2. **Server-side** — every `api/*.js` file (`scout.js`, `stripe-webhook.js`, `send-push.js`,
     `admin-user-action.js`, `moderate.js`) has its own small `logError(source, message, detail)` helper
     (duplicated per file, same convention as `alertAdmins()` above) called from its existing catch-all
     failure path, writing via the service role. `moderate.js`'s call sits in its fail-open catch block —
     that path deliberately still returns `{ decision: "allow" }` to the caller (see the moderation section
     above), but the underlying failure (e.g. Anthropic's API being down) is still worth an admin knowing
     about even though it doesn't block the user-facing action.
  3. Surfaced in a new 6th Admin Panel tab, "Errors" (`loadErrorLog()`/`resolveErrorLogItem()` in
     `AdminPanel`) — same list-with-dismiss pattern as the Moderation and Audit Log tabs.
- **Known trade-off, not an oversight:** `log_client_error` being open to `anon` means a bad actor could
  spam junk rows into `error_log` (no rate limiting on it, unlike `api/moderate.js`'s
  `increment_moderation_usage`). Accepted for now given this is an internal debugging tool at pre-launch
  scale, not hardened against abuse — revisit if it's ever actually exploited.
- **Passive, not push-alerted.** Unlike the two security signals above, entries here don't trigger a push
  notification — they're meant to be checked in the Errors tab, not paged for immediately. If genuinely
  urgent failure classes (e.g. every Stripe webhook failing) turn out to need immediate paging too, that's
  a reasonable follow-up, not something this migration does today.

### Admin action audit log (migration 030)

- `admin_action_log` (`admin_id`, `action`, `target_id`, `detail jsonb`, `created_at`) records every
  ban/unban/delete/plan-change/verify/report-moderation/event-management action taken from the Admin Panel.
  Built so it stays trustworthy even if an admin account itself is compromised: there is **no `authenticated`
  insert/update/delete policy at all** — the only two ways a row can be written are (a) `service_role` from
  `api/admin-user-action.js` (bypasses RLS, used for ban/unban/delete since those already need the service
  key for the real Auth API calls), or (b) `log_admin_action(p_action, p_target_id, p_detail)`, a
  `security definer` RPC that always stamps `admin_id` as `auth.uid()` itself, ignoring whatever the caller
  passes — so a compromised admin session can log real actions under its own name but can never forge an
  entry blaming someone else or blank out its own trail. Reads are admin-only (`is_admin()`), same as every
  other admin-only table here.
- Client side, `AdminPanel`'s `logAdmin(action, targetId, detail)` (`golsz-app.html`) fire-and-forgets the RPC
  after every action that doesn't already log server-side — `resolveReport`, `deleteReportedPost`,
  `setUserAdmin`, `setUserPlan`, `setUserVerifiedTier`, `deleteEvent`, `setEventBlocked`, `createEvent`.
  `setUserBanned`/`deleteUser` do **not** also call `logAdmin()` — those go through
  `api/admin-user-action.js`, which already writes the log entry server-side via a direct service-role
  insert (not the RPC — a service-role caller has no `auth.uid()`, so the RPC's `is_admin()` check would
  reject it); calling `logAdmin()` for those too would just duplicate the entry.
- New 4th "Audit log" tab in `AdminPanel`, alongside Reports/Users/Analytics — `loadAuditLog()` fetches the
  last 100 rows plus admin names (via `public_profile_names`) and renders them as simple cards (admin name,
  action, JSON detail, target id, time-ago). No new charting/UI dependency, same style as the other tabs.

### Content moderation (`api/moderate.js`, `moderateContent()`, migration 033)

- GOLSZ includes minors as users, many linked to a parent account, so user-generated text gets a
  defense-in-depth safety check before it can reach anyone else or get saved: Feed posts (headline+body),
  DMs, Passport bio, highlight titles, and anything typed into Scout. `moderateContent({ text, contentType,
  mediaDescription, recipientId, surface })` (`golsz-app.html`, right after `timeAgo()`) posts to
  `api/moderate.js`, which runs a detailed classifier system prompt (a small/fast Claude model,
  `MODERATION_MODEL`, defaults to `claude-haiku-4-5-20251001`) — a real classifier rather than a keyword
  blocklist, since blunt or creative phrasing trivially defeats keyword lists.
- **The BLOCK list includes plain profanity** (`PROFANITY` reason code) — deliberately stricter than a pure
  safety classifier would be, since GOLSZ is used by minors. This was added on top of a much more detailed
  trust-and-safety prompt supplied directly by the founder (minor-safety rules, reason codes, confidence,
  rationale) after testing showed a bare swear word with no sexual/harassing content correctly fell through
  every other BLOCK/REVIEW category and got allowed — that's expected behavior for a safety-only classifier,
  it just wasn't the actual policy wanted here, so the rule was added explicitly rather than left implicit.
- **Three-way decision, not just yes/no**: `allow` (publish/send immediately, no record kept), `review`
  (flagged as risky/uncertain — see below), `block` (rejected). Only `block` actually stops the content —
  the call site shows `moderation_blocked` inline and does not save/send it (input stays in place so the
  person can edit and retry). See `createPost()`, `Messages.send()`, `ProfileEditor.save()`,
  `Highlights.addHighlight()`, and `Scout.send()`.
- **`review` still publishes/sends immediately.** This was a deliberate product decision, not a shortcut:
  actually holding a DM or a Scout reply until an admin happens to check a queue would make real-time
  messaging unusable — there's no reliable "someone's watching the queue right now" guarantee on a small
  team. Instead, `review` (and `block`) decisions get logged to `moderation_queue` (migration 033) for
  human follow-up after the fact, visible in the Admin Panel's new "Moderation" tab
  (`loadModerationQueue()`/`resolveModerationItem()` in `AdminPanel`) — same pattern as the existing
  Reports tab (content exists; an admin reviews/dismisses it, doesn't gate its existence). `block` gets
  logged too, since for `block` the content was never saved anywhere else — `moderation_queue` is the only
  record of what was rejected and why.
- **Author/recipient minor-status and verification are resolved server-side, never trusted from the
  client.** `api/moderate.js` looks up the real caller's (and, for DMs, the recipient's) `profiles.occupation
  /is_minor/verified_tier` directly via the service key before ever calling the classifier — a client that
  could just claim "I'm not a minor" or "I'm verified" would trivially defeat the minor-safety rules
  otherwise. `occupation` (Player/Coach/Scout/Agent/Physio/Other) gets mapped to the classifier's closed
  role enum (athlete/coach/scout/agent/...); Physio/Other have no honest equivalent and are left `null`
  (unknown) rather than guessed — the classifier's own prompt says to resolve unknowns toward the stricter
  outcome, which is the right behavior for an unmapped role too.
- **Fails open on error** (network hiccup, Anthropic API down, malformed classifier response all return
  `{ decision: "allow" }` rather than blocking) — same trade-off as `profileComplete`'s fail-open check
  elsewhere in this file: a moderation-service hiccup shouldn't lock someone out of posting/messaging
  entirely. This is a layer on top of the existing report/block moderation tools, not the only safeguard.
- `api/moderate.js` requires a real signed-in user (same `getUserId()` pattern as `api/scout.js`) so it
  can't be hit as a free-standing endpoint by someone with no account at all.
- **Rate limited per user, per day** (migration 035) — `MODERATION_DAILY_LIMIT`, defaults to 300 — same
  shape as Scout's metering: `increment_moderation_usage(p_user)` is a `security definer` RPC granted only
  to `service_role` (never `authenticated`, so a client can't call it directly with someone else's id to
  falsely max out their count), incrementing a per-user-per-day counter in `moderation_check_usage`.
  Checked *before* the paid Anthropic call happens — once over the limit, `api/moderate.js` returns 429
  without ever calling the classifier, so the limit actually bounds cost, not just request count. Admins
  are exempt, matching Scout. Found missing during a full app audit — being signed in alone didn't stop a
  scripted account from calling this directly, outside the app's UI, to run up the bill.
- Only text is checked — **uploaded images (Feed post photos, avatars) are not moderated** by this. That
  would need a separate vision-based check and is a known gap, not an oversight.
- Scout gets a second, independent layer: its own system prompt (`SYSTEM_PROMPT` in `api/scout.js`, and the
  matching-but-currently-unused `SYS` constant in `golsz-app.html` — see the note under `api/scout.js` below
  about why that client copy doesn't actually control anything) now explicitly instructs it to stay on
  sports/recruiting topics and refuse 18+/sexual content regardless of framing (roleplay, "hypothetically,"
  etc.), on top of the pre-send `moderateContent()` check on the user's own message. Scout has no human
  recipient, so it's classified as `content_type: "direct_message"` with `recipient: null` — the closest
  honest fit in the classifier's schema, which doesn't have a dedicated AI-chat category.
- `moderation_queue` has the same trust shape as `admin_action_log` (migration 030): **no `authenticated`
  write policy at all** — the only write path is `api/moderate.js` itself via the service key, the only
  update path is `resolve_moderation_item()` (`security definer`, admin-gated). Reads are admin-only.

### Instagram-style message requests (migration 037)

- Replaces the original follow-gated messaging model (migration 007: could only message someone you followed
  or who followed you) with a request/accept flow, at the founder's explicit request to match Instagram's
  actual behavior. `message_requests` (`sender_id`, `recipient_id`, `status`) tracks exactly one thing per
  pair: has the recipient accepted messages from that specific sender. No `authenticated` insert/update
  policy on it at all — the only ways a row changes are two `security definer` RPCs:
  - `ensure_message_request(p_recipient)` — called by the client (`Messages.send()` in `golsz-app.html`)
    right before every message send; idempotent (a second call for the same pair is a no-op), always stamps
    `sender_id` as `auth.uid()` itself. This is what actually gates the system: `can_message()` requires a
    `message_requests` row to already exist, so skipping this call means the subsequent `messages` insert
    gets rejected by RLS — there's no way to bypass the request flow by writing to `messages` directly.
  - `respond_to_message_request(p_sender, p_accept)` — only ever updates a row where `recipient_id =
    auth.uid()`; `p_sender` just selects *which* pending request, it can never be used to accept/decline on
    someone else's behalf.
  - `can_message(a, b)` (same name/signature as migration 007, so `messages_write`'s RLS text needed zero
    changes) now returns true when: not blocked, AND (`a` originally requested `b` — status pending or
    accepted, so the original requester can keep sending while waiting, matching real Instagram — OR `b`
    originally requested `a` and `a` has accepted it, so once accepted either side can message freely).
- Client (`Messages` in `golsz-app.html`): `loadConversations()` also fetches `message_requests` and tags
  each conversation `isPendingReceived` (someone else messaged me first, I haven't decided yet) — those
  float to the top of the list with a "MESSAGE REQUEST" badge and inline Accept/Decline buttons, no separate
  screen needed. `loadThread()` derives `threadReqStatus` (`'pending_received' | 'pending_sent' | 'accepted'
  | null`): opening a still-pending-received thread replaces the text input with an Accept/Decline banner
  instead of letting you type (matching the founder's explicit ask that the recipient has to confirm before
  a conversation continues); a still-pending-sent thread shows a small "waiting for them to accept" hint but
  the input stays enabled, since the original requester can keep messaging while waiting. Declining reuses
  the existing `hideConversation()`/`hidden_conversations` mechanism — `can_message()` already stops that
  sender from reaching this person again once declined, so there's nothing left to reveal by un-hiding it.
- **The content moderation classifier (migration 033) is completely unaffected and still runs on every
  message regardless of request state** — `moderateContent()` is called in `send()` before
  `ensure_message_request`/the actual insert, exactly as it already was. Its own minor-safety rules (adult-
  to-minor DMs outside a parent-linked thread are at minimum "review", off-platform/secrecy/contact-
  solicitation attempts are blocked, etc.) apply identically whether this is someone's first-ever message to
  a stranger or message #500 in a long-running accepted conversation — nothing about the request/accept
  system weakens or bypasses it.
- **Known, considered trade-off, not an oversight:** this genuinely does expand who can send a *first*
  message to anyone, including an approved (non-restricted) minor — previously that required an existing
  follow relationship first; now it requires only an explicit accept from the minor themselves, backed by
  the moderation classifier's minor-safety rules on the message content itself. Unapproved minors are
  unaffected either way — `is_restricted_minor()` still blocks them from sending or receiving *any* message
  at all (see migration 005), request or otherwise, completely independent of this change.
- **View passport from a chat thread** (no migration — pure client change): the thread header's
  avatar+name is now a `<button onClick={() => onViewProfile(thread)}>` instead of static text, so tapping
  it while in a conversation navigates to that person's Passport — letting the recipient look the sender up
  before deciding whether to keep talking to them, at the founder's explicit request. Reuses the exact same
  `viewProfile(id)`/`onViewProfile` prop pattern already wired through `Feed`, `Discover`, and
  `FollowListCard`; `Messages` just gained the same `onViewProfile` prop, passed down from `GolszApp` as
  `onViewProfile={viewProfile}` at both render call sites (desktop and mobile).
- **Profile-view return stack** (`GolszApp`'s `profileStack` state, `golsz-app.html`): fixes the above so
  "Back" out of a viewed Passport actually returns you to wherever you came from — a chat thread, Feed,
  Discover, or a nested profile-within-a-profile — instead of always landing on your own profile. Every call
  to `viewProfile(id)` pushes a `{ page, viewProfileId }` snapshot of *where you were* onto `profileStack`
  before switching to `page="profile"`; `backFromProfile()` (now what both `Passport` render sites pass as
  `onBack`) pops the top snapshot and restores it. This stacks correctly for nested cases too — e.g. open
  someone's passport, tap into their followers list to view a different profile, back once returns to the
  first profile, back again returns to whatever page you started from (the thread/Feed/Discover stays intact
  the whole time since nothing clears `thread` while merely viewing a profile). `go(id)` (direct nav-bar
  taps) and `openThread(id)` (opening a conversation) both reset `profileStack` to `[]`, so a stray leftover
  "back" target can never survive a real, intentional navigation elsewhere.

### Time-on-app tracking (migration 031)

- No session-duration data existed anywhere before this — `daily_activity` (`user_id`, `activity_date`,
  `minutes`, one row per user per day) fills that gap with a lightweight heartbeat instead of a real session
  log. `GolszApp` (`golsz-app.html`) runs a `setInterval` every 60s, and if `document.visibilityState ===
  "visible"` it calls `record_activity_ping()`, which increments today's row for that user by 1 minute. No
  precise session start/stop is tracked — a real "session ended" event doesn't exist reliably on mobile
  Safari/PWAs (tabs get killed, phones lock), so accumulating minutes while visibly open is the practical
  substitute. This also means: **usage is only measured from when this shipped onward** — there's no
  historical backfill, so Admin Panel numbers start at zero and grow as real usage happens.
- `daily_activity` has **no `authenticated` write policy at all** — the only write path is
  `record_activity_ping(p_minutes)`, `security definer`, always using `auth.uid()` (a user can only ever
  increment their own count, and it's a no-op if `auth.uid()` is null). Admin reads: see migration 032 below.
- Admin Panel → Analytics → new "Time on app" card computes **average hours per *active* user**, not per
  total signup (`avgHours()` in `golsz-app.html`, right above `AdminPanel`) — someone who never opened the
  app in a given window doesn't drag the average toward zero and mask how engaged actual users are. Each of
  the three numbers (week/month/year) also shows the active-user count it's averaged over, so the figure is
  legible rather than a bare number. This aggregate comes from `admin_analytics_counts()` (migration 028's
  RPC, extended here) — pre-aggregated `activity_minutes_*`/`activity_users_*` for 7/30/365-day windows.

### Per-user daily activity (migration 032)

- Migration 031 initially kept `daily_activity` admin-visible only in aggregate, mirroring how `messages`/
  `scout_history` stay hidden row-by-row. This migration adds a direct `daily_activity_admin_read` policy
  (`is_admin()`, same shape as `profiles_admin_read`) so admins can see a specific person's actual daily
  numbers — unlike DMs or Scout conversations, a row here is just "N minutes active on this date," no more
  sensitive than the plan/ban-status/joined-date fields already shown per user in the Users tab.
- Admin Panel → Users → each row now has a clock-icon (`History`) toggle (`toggleUserActivity(userId)` in
  `AdminPanel`) that fetches that one user's last 30 days from `daily_activity` on demand — not for the
  whole visible list, so opening the Users tab with 100 rows doesn't fire 100 activity queries. Shows a
  14-day `Bars` sparkline (the most recent half of the 30-day fetch) plus accurate today/7-day/30-day totals
  computed from the full 30-day window (the 30-day fetch exists specifically so "last 30d" is a real
  30-day sum, not just whatever the 14-day sparkline happens to cover).

### Content-Security-Policy header (`vercel.json`)

- Static response headers (CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`) applied via
  Vercel's `headers` config, scoped to everything except `/api/*` (serverless functions set their own CORS
  headers programmatically — a blanket static rule would conflict). Only takes effect on an actual Vercel
  deployment, not local static preview.
- `script-src` deliberately still includes `'unsafe-inline'` and `'unsafe-eval'` — this app has no build
  step, and Babel-standalone transpiles/executes JSX at runtime in the browser, which needs eval-like
  execution. A stricter `script-src` isn't achievable without rebuilding how the app is served (a real build
  step). This is an accepted, documented trade-off, not an oversight — the policy still meaningfully
  restricts which *origins* scripts/styles/images/connections can come from (cdnjs/jsdelivr/fonts/Supabase/
  Anthropic only), it just can't fully sandbox the eval'd JSX itself.

### Signup bot protection (honeypot)

- `Auth`'s signup form (`golsz-app.html`) has a hidden `website` field (off-screen via inline style, plus
  `tabIndex={-1}`/`aria-hidden="true"`/`autoComplete="off"`) that no real user can see or tab into, but that
  generic form-filling bots commonly fill in anyway. `submit()` checks it first and silently returns (no
  error, no signup attempt) if it has any value — giving an automated script no signal that its submission
  was rejected, rather than a real error it could learn from. Real signups never touch this path since the
  field stays empty for anyone actually looking at the form.

### Logo mark (`assets/logo-mark.png`)

- The founder supplied the real brand mark as a JPEG (`assets/golsz.jpeg`, white background, full lockup
  with the "GOLSZ" wordmark and tagline baked in). `assets/logo-mark.png` is a processed derivative — cropped
  to just the circular icon (Python/Pillow: found the icon's row/column bounding box by scanning for non-
  white content, cropped with a small pad), background made transparent (alpha derived from distance-from-
  white per pixel, not a hard threshold, so anti-aliased edges stay smooth), and recolored so every opaque
  pixel is exactly `#C8F135` (this app's primary lime) regardless of the JPEG's original compression-shifted
  color. `golsz.jpeg` itself is kept as the source, not deployed-and-referenced anywhere.
- Shown two places: above the "GOLSZ." wordmark on the Auth screen (`Auth`, `golsz-app.html`), and next to
  the wordmark in both in-app headers (`GolszApp`'s desktop sidebar and mobile top bar) — not on
  `ResetPassword`/`BannedScreen`, which still show text-only, matching what was actually asked for.
- Only the dark-theme lime (`#C8F135`) is baked into the PNG — if the light theme (`--lime: #6B9C1F`, see
  the CSS variables) should ever show a different-colored mark, this flat PNG can't adapt the way a
  currentColor-based inline SVG could; revisit if that distinction ever actually matters in practice.

### Stored-URL XSS guard (`safeHref()`) and the root `ErrorBoundary`

Both found during a full app audit (browser crash-testing plus a systematic pass over `golsz-app.html`/`api/`).

- **Real, exploitable stored XSS, now fixed.** `Highlights.addHighlight()` validates a highlight's URL is
  http(s) client-side before inserting — but that's the app's own UI, not a real barrier. `posts_write`
  (RLS) only ever checked `author_id = auth.uid()`, and the owner-update policy on `athletes` (predates this
  schema file, not fully re-documented here) is the same shape — neither constrained the actual field
  content. Any signed-in user could bypass the client entirely with a direct REST call — e.g.
  `POST /posts { kind: 'clip', body: 'javascript:...' }` — and it would later render as a real, clickable
  `<a href>` in Feed, the post-detail viewer, and the Highlights list, for every user who saw it, not just
  the person who posted it. `safeHref(url)` (`golsz-app.html`, right after `initials()`) is a render-time
  guard — only renders as a real link if the value is actually `http(s)://...`, otherwise falls back to
  plain text — applied at all four render sites regardless of how the stored value got there. Migration 034
  additionally adds a `posts_clip_body_is_http` CHECK constraint so a bad row can't even be inserted for
  `posts` in the first place; `athletes.highlights` (a jsonb array) isn't given an equivalent DB-level
  constraint — validating every array element needs a trigger, not a plain CHECK — but the render-time guard
  already neutralizes the actual rendering risk there too.
- **No React error boundary existed at all** — a single component throwing during render (a bad API
  response shape, an unexpected null, etc.) unmounted the entire tree, leaving a blank screen with no
  recovery short of the person thinking to reload manually. The root render is now wrapped in an
  `ErrorBoundary` class component (right before the final `ReactDOM.createRoot(...).render(...)` call) that
  shows a "Something went wrong — Reload" screen instead. It only logs to the console — no error-tracking
  service (Sentry etc.) is wired up, see the known-gaps list below.

### `PostsGrid` — Instagram-style posts grid on the Passport

- Same `viewUserId` convention as `Highlights` right above it in `golsz-app.html` (`null` = own profile) —
  shown on both your own Passport and anyone else's. Fetches that person's own `posts` rows (already
  public-read via `posts_read`, no new RLS) and lays them out as a 3-column square grid.
- Image posts show the photo (`image_url`); text-only or `clip` (video-link) posts show a clean truncated-
  text tile instead of a blank square, so the grid never has empty-looking cells. Tapping any tile opens the
  full post (headline/body/image/likes/timestamp) in a bottom-sheet, same modal chrome as `ProfileEditor`.
- No new database objects — this only reads a table that was already fully public-read for Feed.

### Profile photo upload (migration 029)

- Same shape as post-images (migrations 016/017): its own Storage bucket (`avatars`, public read, owner-only
  write — `(storage.foldername(name))[1] = auth.uid()::text`), size/type limits baked into the bucket from
  the start (8MB, common image MIME types) instead of a follow-up hardening migration.
  `profiles.avatar_url` holds the public URL; `Passport`'s `pickAvatar()` (`golsz-app.html`) uploads via the
  exact same validate-then-upload-as-`ArrayBuffer` pattern Feed's post-image compose already uses (raw
  `File` uploads can arrive empty on some mobile browsers).
- `avatar_url` is on `public_profile_names` (same reasoning as `occupation`/`verified_tier`) so viewing
  someone *else's* Passport shows their photo too, not just your own. It's a normal self-editable profile
  field — not in `protect_profile_columns()`'s protected set, same bucket as `full_name`.
- Upload affordance (small camera-icon button overlaid on the initials/photo box, plus a short "use a sports
  photo, not a casual selfie" tip) only shows on your own Passport, never `viewingOther`.
- **Removable back to initials** — `removeAvatar()` (`golsz-app.html`, right after `pickAvatar()`) just sets
  `avatar_url` back to `null`; the Passport avatar box already falls back to showing initials whenever
  `avatarUrl` is falsy, so no separate "no photo" UI state needed. Shown as a small amber X button (top-right
  of the avatar box, opposite the lime camera button) only when a photo is actually set. Doesn't delete the
  file out of the `avatars` bucket — harmless, since it's keyed under that user's own folder and never
  linked from anywhere once the column is cleared, and a future re-upload always writes a fresh
  timestamped filename regardless. No migration needed — `avatar_url` was already nullable.

### Verified badge available for every occupation, including Player

- The verified-tier system (migration 025) was originally scoped to non-Player occupations only (Coach/
  Scout/Agent/Physio/Other) — the idea being that only those accounts make a professional claim worth
  verifying, while a Player is just an athlete describing themselves. The Admin Panel's Users tab tier
  buttons, and the checkmark badge next to a name on the Passport (`golsz-app.html`, both previously gated
  on `p.occupation !== "Player"`), have both been unlocked for every user regardless of occupation.
- `setUserVerifiedTier(id, tier)` already only ever updated `profiles.verified_tier` — it never touched
  `plan` (the paid subscription tier), so "verify someone without changing their payment plan" was already
  true architecturally; the actual gap was that the button (and the badge it controls) were invisible for
  Player accounts, not that verifying someone had a plan side effect.
- The Users-tab list now shows a small "✓ Pro/Elite" pill for verified Player accounts (next to their name),
  separate from the existing occupation+verification pill shown for non-Players — so an admin can see
  verification status for everyone at a glance, not just recruiters/scouts/agents.
- The "unverified" warning banner shown to viewers of an unverified profile (`passport_unverified_warning`,
  still gated to non-Player occupations) was deliberately left alone — that's a distinct concern (warning
  a viewer that an occupation *claim* like "I'm a licensed agent" hasn't been verified), not the verified
  badge itself, and doesn't read sensibly for a Player ("this account says it's a Player" isn't a claim
  needing verification the same way).

### Admin Panel "Analytics" tab (migration 028)

- Replaced the old standalone "Events" tab — event management (create/block/delete) didn't go away, it moved
  into a collapsed "▾ Manage events" sub-view within Analytics (`showEventsManager` state in `AdminPanel`),
  reusing the exact same `loadEvents`/`createEvent`/`deleteEvent`/`setEventBlocked` logic unchanged.
- `loadAnalytics()` in `AdminPanel` fetches `profiles`/`posts`/`follows`/`athletes` directly (all already
  admin-or-public readable — `profiles_admin_read`, `posts_read`, `follows_read`, `athletes_read` all bypass
  for `is_admin()`) and aggregates signups/posts-per-day (last 14 days), plan/occupation/verified-tier/sport/
  gender mix, total follows, a top-5-most-followed leaderboard, and a top-5-countries leaderboard **in JS**
  against a capped row set (`.limit(2000)` per table) — fine at today's scale, but would need real SQL
  aggregation (views, not client-side reduction) if the user base grows a lot. This is a known, deliberate
  scaling ceiling, not an oversight. Sport/gender/country all live on `athletes` (set by any occupation, not
  just Player — see `ProfileEditor`), not `profiles`. `country` is free text (a `<datalist>` only suggests
  values, doesn't restrict), so unlike sport/gender it's tallied as a top-5 leaderboard rather than a small
  fixed set of categories.
- **`messages` and `scout_history` are never read row-by-row for this** — both hold real private content (DM
  text, AI Scout conversations) and have no admin-read policy (`messages_read` is sender/recipient-only;
  `scout_history` has no admin policy at all). Instead, `admin_analytics_counts()` (`security definer`,
  `is_admin()`-gated, same pattern as every other admin RPC in this schema) returns only pre-aggregated
  numbers — total/7-day message counts, Scout conversation/user counts, push subscriber count — never a raw
  row or any message/conversation content.
- `Bars` and `BreakdownBar` (both in `golsz-app.html`, right above `AdminPanel`) are the only "charting" —
  plain `<div>`s sized by percentage, no charting library, consistent with this project's zero-extra-
  dependency client (same spirit as the hand-rolled `svg()` icon helper).

### Security audit — `public_profile_names` privacy leak + `api/moderate.js` filter injection (migration 038)

- **Real, live, confirmed-via-curl finding, now fixed:** `public_profile_names` (the view every cross-user
  name lookup in the app uses — Feed authors, Discover, Messages, Passport, follower lists) was a plain
  `select id, full_name, occupation, verified_tier, avatar_url from profiles` with no `where` clause, granted
  to `anon`. Postgres views run as their owner by default (no `security_invoker`), which bypasses the
  underlying table's RLS entirely — so unlike every other read path in this app (`profiles_read`,
  `athletes_read`, Discover), this view was never subject to `is_restricted_minor()`'s gating. Combined with
  the `anon` grant, **any completely unauthenticated request could read every real user's full name,
  occupation, verification tier, and avatar photo URL — including a restricted minor**, whose whole point is
  to be invisible outside their own session and their linked parent's. Confirmed live: a plain curl with the
  public anon key against the base `profiles` table correctly returned `[]`, but the same curl against
  `public_profile_names` returned every row with real names attached. Fixed by adding the exact
  `not is_restricted_minor(id) or id = auth.uid() or is_parent_of(id) or is_admin()` shape already used
  elsewhere in this schema to the view itself, and dropping the `anon` grant entirely (every real call site in
  `golsz-app.html` only ever queries this view from inside the authenticated app — no logged-out screen needs
  it; `api/send-push.js`'s usage is via the service-role key and is unaffected either way).
- **Real finding, now fixed:** `api/moderate.js`'s `body.recipientId` (client-supplied — this endpoint is a
  plain HTTP route reachable by anyone signed in, not only through the app's own UI) was interpolated
  unchecked into a PostgREST filter string inside `getProfileContext()`, the same filter-injection shape
  already identified and closed with a `UUID_RE` check in `api/stripe-webhook.js` and
  `api/admin-user-action.js` — but that treatment was never applied here. A crafted `recipientId` could widen
  or reroute that filter to resolve a *different* profile's minor/verified status than the one actually
  intended, undermining the minor-safety rule this whole endpoint exists to enforce. Fixed with the same
  `UUID_RE` check used in the other two files.
- Also reviewed and confirmed still solid (no changes needed): all 15 tables have RLS enabled (the naive
  `grep` for `enable row level security` under-counts due to this file's multi-space alignment — re-verified
  with a whitespace-tolerant regex); `protect_profile_columns()`/`protect_event_columns()` triggers (migration
  023) still correctly block self-privilege-escalation via `profiles_self`'s broad self-UPDATE policy;
  `increment_scout_usage`/`increment_moderation_usage` are both `service_role`-only (revoked from
  `authenticated`), so neither can be called directly by a client to grief another user's daily count;
  `message_requests`/`can_message`/`ensure_message_request`/`respond_to_message_request` (migration 037) all
  correctly scope to `auth.uid()`, never trusting a client-supplied identity; the Stripe webhook's signature
  verification is timing-safe and replay-guarded; `npm audit` reports zero dependency vulnerabilities.
- **Flagged, not fixed — a judgment call, not an oversight:** `log_client_error` is granted to both `anon` and
  `authenticated` with no rate limit at all, unlike every other metered endpoint in this app. This was a
  deliberate, already-documented tradeoff (crashes can happen pre-login, so anon needs to be able to log them;
  low abuse risk at pre-launch scale) rather than a bug — but it does mean a scripted flood could fill
  `error_log` and bury real errors under noise in the Admin Panel's Errors tab. Worth adding a coarse rate
  limit (per-IP or similar) before or shortly after real public launch, once there's actual traffic to weigh
  the cost against.

### Scout AI routing + "AI Model Usage"/cost analytics (migrations 039-043)

- `api/scout.js` classifies every Scout message (cheap Haiku call, taxonomy in `CLASSIFIER_SYSTEM`) and routes
  low-stakes, no-tool-needed intents (`simple_knowledge`, `player_comparison`, `agent_workflow`,
  `profile_assist`, `off_topic`) to a real Haiku reply instead of Sonnet; everything else (`career_advice`,
  `scouting_analysis`, `web_lookup`, `db_lookup`, low confidence, or a classifier failure/timeout) falls
  through to the original Sonnet + tool-loop path unchanged. Classification is capped at a 3.5s timeout
  (`withTimeout`) so a stuck classifier call can never block the real answer — it just falls through to Sonnet.
  If Haiku unexpectedly wants a tool despite being routed there, that response is discarded and the request
  escalates to Sonnet rather than returning a broken `tool_use` response with no tool-handling behind it.
- `scout_routing_log` records which model actually answered each real reply (`haiku`/`sonnet`/`database` —
  the last one is a placeholder that stays at 0 until DB-first club/coach/opportunity search, still unbuilt,
  replaces some of Sonnet's tool-use calls with a direct query and no LLM at all), plus the classifier's
  intent/confidence. **Deliberately never stores the question or answer text** — same "never expose real
  conversation content" boundary as `scout_history`/`messages` — so it's safe to read in aggregate. The only
  read path is `admin_scout_model_mix()` (`security definer`, `is_admin()`-gated, same pattern as
  `admin_analytics_counts()`), which the Admin Panel's Analytics tab uses for a new "AI Model Usage"
  `BreakdownBar` card (haiku/sonnet/database as a percentage of total real replies).
- The Haiku path deliberately still declares the same `tools` (`web_search` + `search_golsz_players`) even
  though those low-stakes intents shouldn't need them — dropping tools shrank the cacheable system-prompt
  block below Haiku 4.5's 4,096-token cache minimum (confirmed against real production traffic: every Haiku
  call was silently paying full input price with zero cache benefit until this was added back).
- Migration 040 extends `scout_routing_log` with real per-reply token counts and `estimated_cost_usd`,
  computed server-side in `api/scout.js` (`estimateCost()`) from Anthropic's own `usage` numbers using the
  same pricing math verified against real production traffic this session (per-1M input/output rates, cache
  reads at ~10% of input price, cache writes at ~1.25x). This is an estimate for planning/budgeting, not a
  bill — Anthropic's own invoice is always the source of truth. `admin_scout_cost_summary()` (same
  `security definer`/`is_admin()` pattern) aggregates this calendar month's total cost, average cost per
  message, and message count, shown on the Analytics tab's "AI Model Usage" card alongside the haiku/sonnet/
  database breakdown.
- Migration 041 makes the `database` bucket real: `scout_faq` holds pre-written answers to common athlete
  questions (seeded via migration 042, ~106 entries from a general + per-sport recruiting/development FAQ).
  Matching is **not** the trigram (`pg_trgm`/`match_scout_faq()`) approach 041 originally shipped with — real
  requirement was matching by meaning ("even if they don't write the question exactly the same... but it is
  the same context"), which plain text similarity can't do (a paraphrase like "how does a player get scouted
  onto an academy team" shares almost no trigrams with a stored "What is MLS NEXT?" despite meaning the same
  thing). Superseded same day: the classifier call `api/scout.js` already makes on every message
  (`classifyIntent()`) is handed the full FAQ id/question list (`getFaqList()`, cached in memory per language,
  5-minute TTL) via `buildClassifierSystem()`, and asked to return a `faq_id` if the message means the same
  thing as a listed question — genuine language understanding, not string matching, and it costs only the
  extra (cached) prompt tokens on a call that was happening anyway, not a second API call. A match returns the
  stored answer directly, logged as `answered_by='database'` with `estimated_cost_usd: 0`. The classifier is
  told explicitly to prefer `null` over guessing — a missed match just costs a normal answer; a wrong match
  serves the wrong information as if it were the real answer. `match_scout_faq()`/the trigram index from 041
  are left in place (harmless) but are no longer called by the app. `lang` still scopes the FAQ list fetched
  per request to the athlete's own language.
- Migration 043 adds `scout_faq_misses` and the Analytics tab's 4th sub-nav pill, "Common Questions" — real
  questions Scout couldn't match to `scout_faq`, so the FAQ list can grow from actual gaps over the next 1-6
  months instead of guessing (more real matches = more `database`-bucket traffic = lower monthly AI cost).
  **A deliberate, narrow exception** to this app's otherwise-consistent rule that admins never see real
  Scout/DM conversation content (`scout_history`/`messages` have no admin-read policy;
  `scout_routing_log` stores routing metadata only, never question/answer text — see migration 038's privacy
  audit): `logFaqMiss()` in `api/scout.js` only writes a row when a message did NOT match any FAQ (`faq_id`
  was null) AND its intent is one that could plausibly become a static FAQ answer
  (`simple_knowledge`/`career_advice`/`scouting_analysis`/`player_comparison` — never `off_topic`,
  `profile_assist`, `agent_workflow`, or `db_lookup`, which are personal, action-oriented, or not
  FAQ-shaped). No `user_id` or any identifying column is stored at all, and the question is truncated to 500
  characters. The Admin Panel reads it directly (`sb.from("scout_faq_misses")`), same pattern as `error_log`.

### AI Scout architecture — Phase 2 MVP (migrations 049-051)

The user handed over a 28-item "Master Intelligence & Multi-Model Protocol" spec: a persistent,
model-agnostic Athlete Context as real memory, an AI Manager/router, named specialists sharing one Scout
persona, and provider-swappable models. The spec's own instruction was to audit what exists first and
propose the smallest change before writing code — that audit + the approved MVP plan live at
`/Users/dimitriosdavourlis/.claude/plans/rosy-doodling-toast.md` (kept for reference; not part of the repo).
Six pieces shipped, all additive, no existing behavior removed:

- **Bounded conversation context (migration 049, `scout_conversation_summaries`)**: `Scout()`'s `send()`
  used to resend the *entire* transcript to `/api/scout.js` on every turn, growing unbounded within a
  conversation — directly against the spec's "don't repeatedly send enormous conversation histories." Now
  it sends only the last `RECENT_TURNS` (6) messages plus a running summary string embedded in the same
  `PROFILE SO FAR: ...` prefix trick the last message already used for hard facts. The summary itself costs
  no extra model call — `classifyIntent()`'s existing per-turn Haiku call (already firing regardless) now
  also returns `summary_so_far` in its structured output, folding in the prior summary (read from the
  message text it already parses) plus the new turn. Persisted server-side only via
  `persistScoutSummary()` (service-role, upsert on `conversation_id`); the client holds its own copy in
  `summary` state, refreshed from `data.scout_summary` on every reply and re-hydrated on mount/history-load
  from the table. RLS: owner-scoped `SELECT` only — nothing but `api/scout.js`'s service-role key writes it.
- **Structured Athlete Context (migration 050, `athletes.scout_context` jsonb)**: holds the "softer"
  qualification facts the spec's Athlete Context describes that had no column before — `dream_outcome`,
  `target_level`, `target_country`, `timeline`, `perceived_strengths`, `perceived_weaknesses`, `main_gap`,
  `urgency`, `confidence`, `professional_interest`, `college_interest`, `trial_interest` — plus an `ai_meta`
  sub-object (below). Existing Passport columns (`sport`, `position`, `club_name`, etc.) are untouched; this
  is purely additive. Each field is `{value, source: 'athlete_stated'|'ai_inferred', confidence, updated_at}`
  — **never `'verified'`**, which is reserved for a real future verification pathway the model can't
  self-assign. `SYSTEM_PROMPT`'s JSON contract gained a second output key, `scout_context_updates` (alongside
  the existing `profile_updates`), extracted by `extractScoutContextUpdates()` and written via
  `merge_scout_context(p_user, p_updates)` — a `security definer` RPC granted only to `service_role` (same
  revoke-from-anon/authenticated pattern as `increment_scout_usage`) that does `scout_context = scout_context
  || p_updates`, so a partial update never clobbers fields it didn't touch. The client keeps its own
  flattened `{field: value}` mirror in `scoutContext` state (seeded on mount from the same column, updated
  from each reply's `scout_context_updates`) and includes it in the prompt as `SCOUT CONTEXT SO FAR: {...}`
  — this is what gives the classifier something real to judge "missing information" against below.
- **AI Manager fields (migration 051, `scout_routing_log.provider`/`.specialist`)**: `classifyIntent()`'s
  output grew two more fields — `missing_information` (up to 3 `scout_context` field names worth asking
  about next, validated against the same allowlist `persistScoutContext()` uses) and `recommended_specialist`
  (`college`/`pro_pathway`/`development`/`eligibility`, or `null` for the default Scout persona). Both are
  written into `scout_context.ai_meta` via `persistAiMeta()` — deliberately a **full replace** of that one
  key (not an accumulating merge like the fact fields above), since it's a live per-turn routing snapshot,
  not a fact that should persist once stale. `scout_routing_log` gained matching `provider` (hardcoded
  `"anthropic"` for now — see the model registry below) and `specialist` columns, both nullable/additive.
- **Named specialists (`SPECIALIST_FRAMING`, `buildSystemPrompt()`)**: rather than duplicating
  `SYSTEM_PROMPT` per specialist (a real maintenance/safety-drift risk — every rule, the JSON contract, and
  the occupation-branching logic would need to stay in sync across copies), `buildSystemPrompt(basePrompt,
  specialist)` layers ONE extra paragraph into the existing prompt via a string anchor
  (`"Everything in PROFILE SO FAR is already known"`), selected by `recommendedSpecialist` from the
  classifier. Falls back to the unmodified generalist prompt for `null`/unrecognized specialists. The
  hand-off is just: one natural acknowledgment clause on the first reply after a switch, never a "Connecting
  you to..." announcement, and never re-asking anything already in `profile`/`scoutContext`.
- **Provider-agnostic model registry (`MODEL_REGISTRY`, `callAnthropic()`)**: `api/scout.js` now has one
  `MODEL_REGISTRY = { FAST_CHAT: {...}, DEEP_SCOUT: {...} }` object instead of a standalone `HAIKU_MODEL`
  constant and an inline `process.env.SCOUT_MODEL || "claude-sonnet-5"` repeated at every call site.
  Anthropic-only in this pass (deliberately — the spec's own sequencing calls for a benchmark before picking
  a second real provider, not guessing) but every model reference in the file now reads
  `MODEL_REGISTRY.FAST_CHAT.model` / `.DEEP_SCOUT.model`, so swapping which model answers a role is a one-line
  registry edit, not a hunt through the file. `callAnthropic(apiKey, {model, system, messages, tools,
  thinking, maxTokens, stopSequences})` also consolidates what used to be three near-identical raw `fetch`
  blocks (the classifier call, the Haiku reply, the final forced no-tools Sonnet reply) into one helper — the
  Sonnet tool-loop still calls it directly per turn rather than through a higher-level abstraction, since it
  needs to inspect `stop_reason`/push new turns between calls, which a generic "messages in, reply out"
  signature can't express.
- **Explicitly deferred** (see the plan file): a second live model provider, the full Dream→Current
  Position→Gap→Pathway→Action discovery state machine, Media/Film AI (needs real video-content
  understanding, not just link storage), the formal 50-100-scenario model benchmark, and per-athlete cost
  tables. None of these were needed to prove out "one Scout, real memory, real routing, provider-swappable."

### Multi-Model AI Scout & Cost-Control System (migrations 052-056)

A second, much larger spec followed the Phase 2 MVP above: provider-agnostic cost tiers, deterministic
complexity scoring, per-plan tier caps, atomic daily-limit enforcement, a generic response cache,
database-first event search, rate limiting/idempotency, emergency kill switches, and an admin cost/margin
dashboard — written in generic TypeScript/Next.js SaaS vocabulary (`PLAN_MODEL_ACCESS`, `AiProviderAdapter`,
`ai_daily_usage`, a Jest-style test list) that doesn't match this repo's real stack (single-file JSX,
Babel-standalone, no build step, no TypeScript, no test framework). The plan translating the spec onto the
real stack lives at `/Users/dimitriosdavourlis/.claude/plans/rosy-doodling-toast.md` (overwritten from the
Phase 2 plan above — not part of the repo). Extends the Phase 2 MVP's real infrastructure rather than
building a parallel `ai_*` schema next to it.

- **`scout_model_config` (migration 052)**: provider/model/tier/pricing as an admin-editable table instead
  of hardcoded constants — `api/scout.js` reads it (service-role, 5-minute in-memory cache) to pick which
  model answers a tier and to estimate cost before calling it, falling back to hardcoded
  `ANTHROPIC_DEFAULTS` if a tier has no enabled row. Seeded with the real Haiku/Sonnet rows (economy/standard
  → Haiku, advanced/premium → Sonnet) plus Gemini/Grok/OpenAI rows seeded `enabled: false` — real,
  ready-to-flip placeholders, not live: no API keys exist for those providers in this project, and turning
  one on for live traffic needs a benchmark pass first, same reasoning as the Phase 2 MVP's deferral.
  Admin-only reads/writes via `admin_get_model_config()`/`admin_update_model_config()`.
- **`scout_daily_usage` + atomic reservation (migration 053)**: fixes a real, previously-unfixed race in
  `increment_scout_usage()` (migration ~008) — that function inserted a `scout_history` marker row
  unconditionally, then counted same-day markers, with the actual limit check happening *after* the insert
  in `api/scout.js`; two concurrent requests near a plan's limit boundary could both pass. `reserve_scout_question(p_user, p_plan_limit)`
  does the increment-and-check as one atomic `insert ... on conflict ... do update`, row-locked by Postgres
  for its duration — no check-then-act window. `release_scout_question()` gives the slot back when a
  reservation succeeded but no real answer was produced (provider failure); `record_scout_usage_cost()` adds
  real token/cost numbers once a reply completes. `api/scout.js`'s `meter()` was split into `getProfileMeta()`
  (plan/admin/unlimited lookup only) + these three RPC callers.
- **Complexity scoring + 4-tier routing (`complexityScore()`, `selectModelTier()`)**: a deterministic 0-100
  score (text length, classifier intent, `needs_tool`, strategic/multi-year phrasing) maps to
  economy/standard/advanced/premium, layered on top of the existing, production-validated
  `shouldRouteToHaiku()` gate rather than replacing it — the score only picks which tier within whichever
  side of that gate a message already falls on. `PLAN_MODEL_ACCESS` (free→standard, starter/pro→advanced,
  elite→premium) then caps the result — the one genuinely new behavior: a Free-plan user's non-tool-requiring
  Sonnet-bound question (career_advice, scouting_analysis) now gets capped down to Haiku instead of reaching
  Sonnet. Tool-requiring questions (db_lookup/web_lookup) are never capped by plan — search correctness isn't
  a discretionary luxury. Verified against the spec's own worked examples (Elite simple question → economy;
  Elite 3-year-strategy question → premium; Pro/Starter complex question → advanced, never premium) in a
  one-off Node test harness (no test framework exists to hang a permanent suite off of).
- **Cost budget gate (`budgetGate()`, `TARGET_COSTS`/`HARD_MAX_COST_PER_REQUEST`)**: downgrades (never
  upgrades) a tier if its own worst-case cost — using that tier's `max_output_tokens` as the ceiling —
  would exceed an env-overridable per-plan hard limit.
- **`AiProviderAdapter` (`anthropicAdapter`, `unconfiguredAdapter()`)**: one shared `{provider, generate()}`
  shape; the handler calls `adapterFor(provider).generate(...)` without ever branching on provider name.
  Gemini/xAI/OpenAI adapters are code-complete stubs that throw if ever reached — never invoked while their
  `scout_model_config` rows stay disabled.
- **Response cache (migration 054, `scout_response_cache`)**: a plain TTL'd cache of actual answers Scout
  has already produced, distinct from the curated `scout_faq` — only for `simple_knowledge` (the one intent
  that's non-personalized by definition), keyed by intent+text+lang+tier, and never written if the response
  carried `profile_updates`/`scout_context_updates`.
- **`search_events()` (migration 055)**: mirrors `search_players()` for the `events` table — a second
  database-first tool (`search_golsz_events`) so "trials near me" gets a real, verified GOLSZ listing instead
  of falling through to general web search or an invented one.
- **Rate limiting + idempotency**: in-memory, scoped to one warm serverless instance (`isRateLimited()`,
  `isDuplicateRequest()`) — an honest, documented limitation, not a distributed guarantee; the daily-limit
  atomicity above is the real guarantee, this is a best-effort second layer against a double-click/retry-storm
  landing on the same instance. Client sends a `requestId` (UUID) per send.
- **Emergency switches**: `SCOUT_GLOBAL_ENABLED`/`SCOUT_PREMIUM_ENABLED`/`SCOUT_DAILY_SPEND_LIMIT_USD`/
  `SCOUT_MONTHLY_SPEND_LIMIT_USD` env vars, checked before any model call or DB write; a tripped switch
  returns the same graceful message an ordinary outage would.
- **Client "questions remaining" UI**: `Scout()`'s header shows `{remaining} QUESTIONS LEFT TODAY` once a
  `scout_usage` field arrives on any response (present on success and on a 402 limit-reached response);
  never shown for admin/unlimited accounts (server omits the field).
- **Admin dashboard (migration 056)**: extends the existing Analytics → "AI Model Usage" card —
  `admin_scout_cost_by_plan()`, `admin_scout_cache_stats()`, `admin_scout_top_cost_users()` (dollar figures +
  call counts only, never question content — same metadata-yes/content-no boundary as `scout_faq_misses`),
  `admin_scout_margin_summary()` (AI cost as % of that plan's monthly revenue, with a ⚠ badge past the
  spec's own thresholds: Starter/Pro >10%, Elite >15%).
- **Explicitly not done**: no TypeScript/Jest/build-step introduced (verification instead: `node --check`,
  a full-file Babel syntax check, and a one-off Node harness for the tier-selection logic); no live
  Gemini/Grok/OpenAI traffic (no API keys in this project, deferred pending a benchmark); `scout_routing_log`'s
  anonymity (no `user_id`, migration-038 privacy audit) is unchanged — per-user cost visibility lives only in
  `scout_daily_usage`, which carries `user_id` + dollar figures, never conversation content.

### Scout double-reply fix — `sendingRef` re-entrancy guard

- **Real bug, not a formatting issue:** users reported Scout sometimes answering with two replies back-to-back
  for one question. Root cause: `Scout.send()` in `golsz-app.html` only guarded re-entrancy with the `busy`
  React state, but `setBusy(true)` didn't happen until *after* `await moderateContent(...)` — a real network
  round-trip. A fast double-click/double-Enter within that window fired `send()` twice; both calls read
  `busy` as still `false` (React hadn't re-rendered yet) and both went on to hit Scout's API independently,
  producing two separate user bubbles and two separate assistant replies.
- Fixed with `sendingRef` (a plain `useRef(false)`, not state) checked and set to `true` synchronously at the
  very top of `send()`, before the moderation-check await — refs update immediately, not on the next render,
  so a second call arriving mid-request is blocked regardless of network timing. Reset in the outer `finally`.
- Verified with a mock harness reproducing the exact race (two `.click()` calls fired synchronously, a mocked
  network delay simulating the moderation-check round-trip): the pre-fix shape produced 2 API calls and 2
  duplicate user/assistant bubbles; the fixed shape produced exactly 1 of each.
- **Follow-up (separate bug, opposite symptom):** users then reported needing to press send *multiple times*
  before anything seemed to happen. Cause: `setBusy(true)` — which drives the send button's `disabled` state —
  still didn't run until after `moderateContent()`'s await resolved, same gap as above. A real first press
  left the button looking completely normal for the whole moderation round-trip, so it looked unresponsive
  and got pressed again (the re-entrancy guard silently swallowed those extra presses, but with no visible
  feedback either way). Fixed by moving `setBusy(true)` to fire immediately alongside `sendingRef.current =
  true`, before the moderation await — the two finally blocks were consolidated into one so `busy` resets
  correctly on every exit path, including a moderation block.

### `supabase-schema.sql`

**Read the warning at the top of this repo's README section above before touching this file** — it's a
reference/documentation concatenation of the migrations that actually ran (002, 004, 005) against the live
project, not a from-scratch bootstrap script. The real tables:

- `profiles` — root identity, 1:1 with `auth.users`. Real columns: `id, full_name, role, plan, dob,
  created_at, is_minor, pending_parent_email, is_admin, stripe_customer_id, is_banned, occupation`. **No
  `email` column** — look it up via `auth.users` inside a `security definer` function if you ever need it,
  same pattern as `request_parent_link()`. **`occupation`** (migration 020) is a separate, purpose-built
  `check`-constrained text column (`'Scout' | 'Agent' | 'Coach' | 'Physio' | 'Other'`) — deliberately not
  reusing the pre-existing `role` column, since this file's own header warning says `role`'s enum values were
  never confirmed live. Captured at signup (`handle_new_user()` reads it from `raw_user_meta_data`, same as
  `date_of_birth`/`parent_email`/`plan`), editable later via `ProfileEditor`, and shown on the Passport header
  for both your own profile and anyone else's — which is why it's also added to `public_profile_names` (the
  narrow view that exists so Feed/Discover/Passport can show someone else's name without a blanket public-read
  policy on `profiles` itself, which would also leak `dob`/`plan`/`is_admin`).
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
- **Admin moderation (migration 019, ban/delete moved to the real auth layer in migration 027)**:
  `profiles.is_banned` (gates `posts_write`/`athletes_read` the same shape as `is_restricted_minor`, and the
  client force-signs a banned user out — see `Root()`'s ban check in `golsz-app.html`) and `events.is_blocked`
  (hides an event from everyone but admins via `events_read`, without deleting it) are still the app-level
  flags. But ban/unban/delete from the Admin Panel now go through `api/admin-user-action.js` instead of a
  direct client-side `profiles` update or RPC call — that endpoint verifies the caller is really an admin
  (via their JWT + a `profiles.is_admin` lookup, using the service role key), then calls the **Supabase Admin
  API** to do the real thing: `ban` sets `ban_duration` on the `auth.users` row (Supabase has no literal
  "forever," so `"876000h"` — ~100 years — is the convention for "until an admin lifts it") in addition to
  `profiles.is_banned`, and `delete` calls `admin_delete_profile_data(p_target uuid)` (a `security definer`
  function, granted to `service_role` only — **not** `authenticated`, since unlike the RPC it replaces it has
  no `is_admin()` check of its own; the endpoint already did that check before ever calling it) to clean up
  `athletes`/`coaches`/`agents`/`parent_links`/`scout_history` (these don't cascade from `profiles`), then
  deletes the real `auth.users` row via the Admin API — which cascades to `profiles` and everything that
  already cascades from it (`posts`/`post_likes`/`post_reports`/`blocks`/`follows`/`messages`/
  `hidden_conversations`/`push_subscriptions`). A banned/deleted account's actual login credential is now
  really gone/locked, not just hidden from the app. One known residual gap: an already-active session's
  access token isn't force-invalidated, so a just-banned user could keep working until that token's natural
  expiry (short-lived, but not instant) — the ban still blocks any *new* session from that point on.
- **⚠️ RLS in this project is row-level, not column-level — don't assume "you can update your own row" also
  means "only the columns the UI exposes."** `profiles_self` (an undocumented base policy, see the file-level
  warning above) grants a broad self-row UPDATE on `profiles`, which — with no column-aware guard — would let
  any signed-in user set their own `plan` to `'pro'`/`'elite'` for free, or flip `is_admin`/`is_banned` on
  themselves, via the exact same client call shape Settings' legitimate "switch to Starter"
  (`profiles.update({ plan: "starter" })`) already uses. Found and closed in migration 023 via a
  `protect_profile_columns()` `BEFORE UPDATE` trigger (not RLS — RLS's `WITH CHECK` only sees the new row, not
  a column-by-column diff against the old one): `is_admin`/`is_banned`/`stripe_customer_id` are silently reset
  to their prior value, and `plan` may only ever self-change *to* `'starter'`, unless the caller is an
  existing admin, `service_role` (the Stripe webhook), or has no PostgREST role context at all (`auth.role()
  is null` — direct SQL, i.e. the Supabase SQL Editor, which is how the very first admin gets bootstrapped;
  see "flip your own `profiles.is_admin` to true once via SQL" below). The same shape applied to
  `events.is_blocked` (an event's own creator could otherwise un-block their own admin-blocked listing) —
  `protect_event_columns()`, same pattern. **If you add another admin-only or payment-derived column to a
  table a regular user can already UPDATE their own row of, add it to one of these triggers (or a new one) —
  don't assume the existing RLS policy already covers it.**
- **`increment_scout_usage(p_user uuid)` is server-only, not by RLS but by revoked grants** (migration 023) —
  it never checked that the caller *is* `p_user` (it's meant to only run inside `api/scout.js`, metering the
  real signed-in caller that function already verified via `getUserId()`), so any authenticated client could
  previously call it directly via `supabase.rpc()` with an arbitrary `p_user` and inflate a *different* user's
  daily count, locking them out of free-tier Scout early. `EXECUTE` is now revoked from `public`/`authenticated`
  and granted only to `service_role`, which is how `api/scout.js` always calls it — no behavior change for the
  real caller, just closes the direct-RPC path for everyone else.
- There is no `programs` table (an earlier iteration had one for an NCAA/NAIA/USPORTS school directory) —
  Scout's target-school suggestions come entirely from its live web-search tool call, not a seeded table.
- **`search_players()` (migration 022)**: `security definer` function backing Scout's `search_golsz_players`
  tool (see `api/scout.js` above) — filters by sport/position/country/grad_year/gender/recruiting_status,
  scoped to `occupation is null or occupation = 'Player'` and re-applying `is_restricted_minor()`/`is_banned()`
  by hand, since the service-role caller bypasses `athletes_read` RLS entirely. This is the only thing
  standing between Scout's search tool and surfacing someone Discover itself would never show.
- `handle_new_user()` reads `full_name` / `date_of_birth` / `parent_email` out of the signup JWT's
  `raw_user_meta_data` (populated by `Auth`'s `signUp({ options: { data: {...} } })`), computes `is_minor`
  from the DOB, and auto-creates a pending `parent_links` row if `parent_email` already has an account.
- **`profiles.is_verified` (migration 024, superseded by `verified_tier` in migration 025 — see below)**: the
  real problem this closed — `occupation` is entirely self-declared (anyone can pick Scout/Agent/Coach/Physio
  at signup, zero check), and it's shown as a trust-looking badge right next to the person's name on the
  Passport, which is exactly the setup for impersonating a recruiter to a minor. This didn't (and doesn't)
  verify anything by itself — an admin still does that manually (checks a coaching license, calls the
  claimed club/agency, etc.) — it just recorded the result and flipped the *default*: `golsz-app.html`'s
  Passport shows a distinct amber "UNVERIFIED {OCCUPATION}" badge plus a same-styled warning banner (never
  send money, involve a parent/guardian before meeting in person) for any non-Player occupation with no
  badge, instead of every occupation getting the same trusted-looking lime pill.
- **`profiles.verified_tier` (migration 025)**: replaces the plain `is_verified` boolean with a three-state
  column (`'none' | 'pro' | 'elite'`) so the Passport can show a *differently colored* check for Elite vs Pro
  (lime vs blue, see `C.elite`/`C.eliteBorder`) — deliberately **not** a self-service request workflow (an
  earlier draft of this migration built exactly that — a `verification_requests` table plus an admin
  approve/deny screen — but it was rewritten before ever being applied to the live database once the actual
  requirement turned out to be different; the drops at the top of
  `supabase-migration-025-verified-tier.sql` are defensive cleanup for that unused table, in case it was ever
  run). The real design has two independent ways `verified_tier` changes:
  1. **Automatic, on plan change**: `protect_profile_columns()` (migrations 023/024) now also syncs
     `verified_tier` to match `new.plan` — but *only* inside the `if new.plan is distinct from old.plan`
     branch, i.e. only when a write actually changes the plan value. Subscribing to Pro auto-grants the Pro
     check, Elite auto-grants the Elite check, and dropping to Starter (self-service cancel in Settings, an
     admin's manual plan change, or `api/stripe-webhook.js`'s `service_role` write on a real Stripe
     cancellation) auto-clears it. This one function body is the single place all three of those write paths
     go through, so none of them need to duplicate this logic.
  2. **Manual, admin override, independent of plan**: the Admin Panel's Users tab has three buttons per
     non-Player user (Unverified / Pro check / Elite check) that call
     `profiles.update({ verified_tier })` directly — this is the actual point of the feature. An admin can
     revoke a still-paying Pro/Elite account's check the moment they look "shady," without cancelling their
     subscription or touching `plan` at all (the update only ever writes `verified_tier`), and conversely can
     grant a badge to a Starter account as a courtesy with no payment involved. This survives indefinitely
     because rule 1 only fires on an actual plan *change* — a Stripe renewal writes the same plan value that
     was already there, so it can never silently overwrite an admin's manual revoke/grant.
  `verified_tier` is in `protect_profile_columns()`'s protected-column set for *non-admin, non-service-role*
  callers, same reasoning `is_admin`/`is_banned` are protected (a regular user could otherwise self-grant a
  check the same way plan/`is_admin` self-escalation was possible before migration 023). Also carried in
  `public_profile_names` (same reasoning as `occupation` in migration 020) so viewing someone *else's*
  profile shows their tier, not just your own.
- Any new table holding a minor's private data should gate access with the same
  `auth.uid() = owner_id OR is_parent_of(owner_id)` pattern `profiles`/`scout_history` already use.

## Current state

**Real when configured:** accounts, sessions, sign-out, per-user data isolation via RLS; Feed/Discover/
Events on real Supabase data with honest loading/empty states (every hardcoded demo array was removed —
there is no fake-content fallback anywhere in the app anymore); a working hosted Scout with the API key
protected server-side, free-tier metering (now correctly enum-safe, see `api/scout.js` above), and real
transcript persistence; parent verification (request/approve, RLS-enforced, not just UI); minor safety
(restricted posting/Discover/DM visibility until a parent approves); Feed post creation with report/block
moderation; follows (migration 006); real DMs with an Instagram-style request/accept flow (migration 007,
overhauled in 037) with live delivery via Realtime (migration 015 — an open thread updates the moment a
reply arrives, no manual refresh); a fully editable Passport with onboarding auto-opened right after signup
(migration 008); real Web Push notifications for new messages and new followers (migration 014,
`api/send-push.js`).

**The Message button shows for everyone now, not just people you follow.** Migration 037 replaced the
follow-based messaging gate with a request/accept model (see the dedicated section below), so
Feed/Discover/Passport's Message buttons no longer gate on `following`/`followedBy` at all — same
`p.id !== uid` (don't show it on your own content) check as before, just without the follow requirement. If
you add another place that surfaces a Message button, it doesn't need any follow-status check either.

**Not yet built / known gaps:**
- **No 2FA/MFA and no granular admin roles.** A security audit this session identified both as real gaps —
  every admin has the exact same full `is_admin` flag (no reduced-scope roles), and there's no second factor
  on login for anyone, admin or not. Deliberately deferred (not forgotten) in favor of shipping CSP, the
  admin audit log, and signup bot protection first — see those sections above.
- **Legal review.** The parent-verification flow is mutual in-app consent, not identity-verified
  COPPA/GDPR-K parental consent. `terms.html` also still contains a placeholder line stating real
  moderation/content terms "will be published before real accounts go live." Both need a lawyer's pass
  before this is genuinely launch-ready with real minors as users. `terms.html`'s governing-law clause was
  also updated to "the laws of the Republic of Cyprus" (from Québec/Canada) to match the company's real
  location — that's a substantive legal change made on the founder's direct instruction to update location
  references everywhere, not something a lawyer has actually reviewed; flag this specifically when the
  legal pass happens.
- **Stripe is still in Sandbox/test mode.** `STRIPE_LINKS` holds real test-mode Payment Links and the webhook
  is registered against the sandbox, so checkout works end-to-end — but no real money moves yet. Before
  accepting real payments: create Live-mode Payment Links, register a Live webhook endpoint, and rotate
  `STRIPE_WEBHOOK_SECRET` to that webhook's signing secret.
- **`golsz.com`'s DNS still points at a domain-parking page, not Vercel** — the app is fully deployed and
  working at `https://golsz.vercel.app`, but the real custom domain won't serve it until its DNS/nameserver
  configuration (currently GoDaddy) is fixed to point at Vercel. Nothing will be reachable at the real domain
  — including Stripe/Supabase webhooks registered against it — until this is resolved.
- **Email deliverability is resolved** — Resend's `golsz.com` domain verification completed and Supabase's
  SMTP sender now sends from a real `@golsz.com` address, confirmed working by the founder. (Note this is
  independent of `golsz.com`'s web-hosting DNS above — domain email records and the domain's nameserver/A
  records are separate DNS concerns; email can work while the site itself is still parked, as it is here.)
- **`contact.html`'s waitlist form has the same problem the home page's did.** The home page's non-
  functional waitlist section (fake "you're on the list" message, nothing ever actually saved — found
  during a home-page rewrite) was removed at the founder's request, but "Join the waitlist" buttons
  elsewhere on the home page (the three journey sections, the footer) still link to `contact.html`, whose
  waitlist form uses the exact same client-only fake-success `data-waitlist-form` handling in `js/main.js`.
  Flagged, not yet fixed — needs a decision (wire it to a real backend, or remove it there too).
- **Pricing is $6/$14/$30 (Starter/Pro/Elite), each gated by a real AI Scout daily question limit** — 8/15/20
  respectively, enforced in `api/scout.js` and led with as the first bullet on each plan card (not vague
  marketing language). Stripe Payment Links were re-created in test/sandbox mode for these exact prices
  (2026-08-05) — Starter now has its own link too, since it moved from free to paid. Still true, though:
  secondary bullets like "full verified passport" or "priority visibility" aren't backed by any distinct
  mechanic anywhere in the app beyond the question limit — gating those further needs a product decision
  on what they mean first.
- **`coaches`/`agents` now have real RLS (migration 027)** — owner-only (`id = auth.uid()`), same simple
  shape as `push_subscriptions`. Still unused by the app today (every occupation's extra fields live in
  `athletes` — see `ProfileEditor` — so nothing actually writes to these two tables yet), but they're no
  longer fully locked the moment something does.
- Production monitoring/alerting (e.g. Sentry) — nothing wired up yet.
- **Push notifications are fully wired (migration 026)** — `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
  `VAPID_SUBJECT`, and `SUPABASE_WEBHOOK_SECRET` are set as Vercel env vars, and the two triggers that call
  `api/send-push.js` (see above) are created directly in SQL rather than the Dashboard Webhooks wizard, since
  not every Supabase project's dashboard still shows that wizard.
