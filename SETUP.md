# GOLSZ — Backend Setup

Three files make the app real:
- `golsz-app.html` — the app, now wired for real auth + a real Scout backend
- `supabase-schema.sql` — your database (accounts, passports, programs, billing, usage)
- `api/scout.js` — serverless proxy that holds your API key and runs the Scout

The app still runs **as a preview with the config blank** — it only goes live once you fill in the four values at the top of the `<script>` in `golsz-app.html`.

---

## 1) Database + Auth (Supabase)

1. Create a project at supabase.com.
2. Open **SQL Editor**, paste all of `supabase-schema.sql`, run it once.
3. In **Authentication → Providers**, keep Email enabled. For a smoother demo you can turn *off* "Confirm email" (turn it back on before real launch).
4. In **Project Settings → API**, copy the **Project URL** and the **anon public** key.
5. In `golsz-app.html`, set:
   ```js
   const SUPABASE_URL = "https://xxxx.supabase.co";
   const SUPABASE_ANON_KEY = "eyJ...";   // anon public key (safe in the browser)
   ```

Signup/login now create real accounts. A `profiles` + `athlete_profiles` row is created automatically on signup, and Row Level Security means each user can only ever touch their own data.

---

## 2) Scout proxy (Vercel)

1. Put `api/scout.js` in a project and deploy to Vercel (a repo with an `/api` folder is enough — no framework needed).
2. In Vercel **Settings → Environment Variables**, add:
   - `ANTHROPIC_API_KEY` — your key (server-side only; never in the browser)
   - `SCOUT_MODEL` — optional; set to a model your account supports
   - `ALLOWED_ORIGIN` — your app's URL (e.g. `https://golsz.com`)
   - `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` — optional; enables sign-in check + free-tier metering
   - `FREE_DAILY_LIMIT` — optional; Scout calls/day on the free plan (default 8)
3. In `golsz-app.html`, set:
   ```js
   const SCOUT_ENDPOINT = "https://your-app.vercel.app/api/scout";
   ```

The app automatically attaches the signed-in user's token to Scout calls, so the proxy can verify them and meter usage. The key never leaves the server.

---

## 3) Payments (from earlier)

GOLSZ is a Nicosia (Cyprus) business and prices in **EUR**. Create the three
recurring Prices — €6 / €15 / €30 per month — and a Payment Link for each, set
each link's post-payment redirect to your app URL + `?checkout=success`, then
paste the links into `STRIPE_LINKS` in `golsz-app.html`.

Per-charge fees depend on the card's origin (EEA / UK / international) and are
not quoted here on purpose — a rate written into a README goes stale silently.
See [Stripe's pricing page](https://stripe.com/en-cy/pricing) for the current
Cyprus figures.

Three things that are easy to get wrong, each of which fails **silently**:

- **`golsz_plan` metadata on the Payment Link must be `starter`, not `basic`.**
  The display name is "Basic" but the DB enum — and `VALID_PLANS` in
  `api/_plan-catalog.js` — is `starter`. A link tagged `basic` resolves to no
  plan at all.
- **The links must be live, not test.** `isLiveStripeLink()` in
  `golsz-app.html` rejects any URL containing `/test_`, which is why checkout
  currently reads "not available yet".
- **`STRIPE_WEBHOOK_SECRET` is per-endpoint and per-mode.** A sandbox secret
  will not verify live events; every real payment would 400 and Stripe would
  retry it forever while the athlete gets nothing.

> The webhook that gates features **already exists** (`api/stripe-webhook.js`).
> It writes `profiles.plan` and resolves which plan was bought from the Price
> id, `lookup_key` or explicit metadata — never from the amount paid. Set
> `STRIPE_PRICE_BASIC` / `_PRO` / `_ELITE` in Vercel to the live Price ids.

---

## What's real now vs. next

Rewritten 2026-08-24. The previous version of this section described an app
that no longer exists — it listed Feed and Discover as "still mock" months
after the social model was retired outright, and called a `programs` dataset
"the moat" when no such table has ever existed. A stale status section is
worse than none: it is the thing a new contributor reads first.

**Real and live:** accounts and sessions, per-user data isolation via RLS,
parent-managed accounts for under-16s (`api/create-child-account.js`,
`parent_links`), the hosted AI Scout with the key server-side and per-plan
limits, the pathway planner with custom stages, Targets, Benchmarks, the
admin panel, AI moderation of profile text and Scout output
(`api/moderate.js`), and four languages at full key parity.

Six pages render today: home, scout, targets, profile, events, admin.

**Deliberately retired, not pending:** posts, the feed, follows, direct
messages and the whole social layer. GOLSZ is a growth and organiser app, not
a sports LinkedIn. Be precise about what "retired" means here, because the
code has not all been deleted:

- The **tables still exist and still hold their original rows.** Nothing an
  athlete wrote was destroyed. Reads are scoped and writes are closed at the
  RLS layer (migrations 129, 130, 132).
- Some **client components remain but are unreachable** — the Messages
  component still has send/delete/read code, and there is no `page ===
  "messages"` route to it and no nav entry. The closure does not depend on
  that UI being hidden: migration 130 DROPPED `messages_write` / `_update` /
  `_delete`, so with RLS enabled there is no policy permitting an insert at
  all. Admins keep DELETE, because the moderation queue still points at real
  rows and a queue whose entries cannot be actioned is not a queue.

Do not "finish" any of this. If it is ever genuinely dropped, the client code
is the safe part to delete; the tables are not, because they hold real
history.

**Never built:** there is no `programs` table. The idea of seeding real
schools and coaches remains just that — an idea, and still the most plausible
defensible asset if it is ever built.

**The actual blocker:** payments. No live Stripe account exists yet; see
section 3 above. Nothing can be charged, so nothing has been.

**Compliance, already in place rather than pending:** under-16s cannot self
register — a parent creates and manages the account
(`api/create-child-account.js`, `parent_links`, `profiles.parent_managed`).
Adult-to-minor direct messaging is closed at the database, not merely hidden:
no account can write to `messages` at all.
