# Owner runbook: the steps only you can do

Everything here needs a login an agent does not have (Supabase, Vercel, Stripe). Each step says how
to confirm it worked. Names only: never paste a secret into this file, a commit or a chat.

This file is removed from the served site at deploy time (`tools/unpublish-internal.cjs`).

## 1. Find out what is actually applied (DONE 2026-10-22: 158, 159, 160 and 026 all read true)

Paste `supabase-probe-migration-state.sql` into the Supabase SQL Editor and run it. One row per
check, with an `applied` column. It writes nothing.

- Any `false` in the 158, 159 or 160 rows: run those migrations, **in numeric order**
  (158, then 159, then 160). 160 re-creates `get_public_passport(uuid)`, which 158 also defines;
  running 158 after 160 silently undoes 160.1.
- All `true`: edit `supabase-schema.sql` (the 158 "pending" note near line 6447, and the 160 block
  at the end) to say so, then commit.

## 2. Run migration 160 (DONE 2026-10-22, confirmed by the probe)

Paste `supabase-migration-160-passport-parity-and-append-only.sql` and run it once. It is one
transaction and idempotent. Then run the probe again: rows 160.1 and 160.2 must read `true`.
The file's own verification block (bottom of the file) has the manual checks.

## 3. Rotate the push-webhook secret (the old one is in public git history)

The old value is dead once rotated, so the history stops mattering. Do steps a to d within a
couple of minutes: between b and c, new pushes are rejected (notifications only, nothing is lost
from the database).

a. Make a new value locally: `openssl rand -hex 32`. Keep it in your password manager.
b. Vercel, Project, Settings, Environment Variables: set `SUPABASE_WEBHOOK_SECRET` (Production) to
   the new value, then redeploy (a variable change takes effect only on a new deployment).
c. Open `supabase-migration-026-push-webhook-triggers.sql` locally, replace
   `REPLACE_WITH_SUPABASE_WEBHOOK_SECRET` with the new value, paste into the SQL Editor, run.
   **Do not save or commit the substituted file.**
d. Prove it: from one test account send a message to another and confirm the push arrives.
   Then run the probe: row 41 must be `true`. (It cannot tell you the secret *matches*; only
   step d does.)

## 4. Prove payments with one real purchase

Per `CLAUDE.md` § Current state: buy Basic (about CA$9), then in Stripe check the webhook
destination's Event deliveries show Total 1 / Failed 0, confirm `profiles.plan` flips, then cancel
in the customer portal to exercise the downgrade. Until then, payments are unproven.

## 5. Settle the signup bot-check state (2 minutes, a read)

The code supports Cloudflare Turnstile but `TURNSTILE_SITE_KEY` in `golsz-app.html` is empty.
Supabase dashboard, Authentication, Attack Protection (CAPTCHA): is it on?

- **Off, and the key empty:** consistent. `privacy.html` ("not active") is correct.
- **On, and the key empty:** every signup is rejected for lack of a token. That is an outage;
  fix it first.
- **Off, but you want it:** set the key and Supabase's CAPTCHA together, and update `privacy.html`.

## 6. Counsel

Send `LEGAL-REVIEW-BRIEF.md` and run its three read-only count queries first. Under-18 managed
profiles are switched off today, so the live-product questions (French terms, Law 25, health
information, AI providers, withdrawal at checkout) matter more than parental consent.

## 7. Moderation queue (a launch blocker the guard skill still lists)

`select count(*) from moderation_queue where resolved_at is null;` Real reported content on a
platform that once admitted minors waits there until someone reviews it.
