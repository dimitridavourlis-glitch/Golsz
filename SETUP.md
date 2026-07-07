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

Create Stripe Payment Links for Pro/Elite, set each link's post-payment redirect to your app URL + `?checkout=success`, then paste them into `STRIPE_LINKS`. Money is paid out to your connected bank; Stripe's Canadian rate is 2.9% + C$0.30 per charge.

> Note: Payment Links collect money but don't yet *gate* features. To lock Pro to paying members, add a Stripe **webhook** that writes to the `subscriptions` table — that's the next build.

---

## What's real now vs. next

**Real:** accounts, sessions, sign-out, per-user data isolation, a working hosted Scout with your key protected and free-tier limits.

**Still mock (reads from hardcoded arrays):** Feed, Discover, Events, and the Passport display. Point each at its Supabase table when ready. The big one is seeding `programs` with real schools/coaches — that dataset is the moat.

**Compliance before real launch:** parent-linked accounts for under-18 users, and safeguards on any adult-to-minor messaging.
