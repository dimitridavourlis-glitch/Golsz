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

**Real:** accounts, sessions, sign-out, per-user data isolation, a working hosted Scout with your key protected and free-tier limits.

**Still mock (reads from hardcoded arrays):** Feed, Discover, Events, and the Passport display. Point each at its Supabase table when ready. The big one is seeding `programs` with real schools/coaches — that dataset is the moat.

**Compliance before real launch:** parent-linked accounts for under-18 users, and safeguards on any adult-to-minor messaging.
