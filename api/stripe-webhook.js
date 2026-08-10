// ============================================================
// GOLSZ — Stripe webhook (Vercel serverless function)
// Deploy target: /api/stripe-webhook.js (Vercel auto-detects it, same as
// api/scout.js — zero config, no npm dependency needed).
//
// Verifies the Stripe signature by hand (Node's built-in crypto) instead
// of pulling in the `stripe` npm package, to keep this project dependency
// -free like api/scout.js. Register this endpoint's URL in the Stripe
// Dashboard (Developers -> Webhooks) once deployed, subscribed to:
//   checkout.session.completed
//   customer.subscription.deleted
//   customer.subscription.updated
//   invoice.payment_failed
//
// Required env vars:
//   STRIPE_WEBHOOK_SECRET     from the Stripe Dashboard webhook you register
//   SUPABASE_URL              same value used by api/scout.js
//   SUPABASE_SERVICE_KEY      service role key (server-only; never ship to the browser)
//
// Attribution: golsz-app.html's Auth appends ?client_reference_id=<user.id>
// to the Payment Link redirect, so checkout.session.completed can identify
// who paid. Which plan they receive is resolved from a TRUSTED STRIPE
// IDENTIFIER (Price id, lookup_key, or explicit metadata) by
// api/_plan-catalog.js — never from the amount paid. Currency and unit
// amount are then validated separately against the catalogue. See that
// file's header for why amount-inference was wrong. To change prices,
// the thresholds below to match. Free never reaches this file at all since
// it has no Stripe link and never goes through checkout.
// ============================================================

export const config = { api: { bodyParser: false } };

import crypto from "crypto";

// See api/scout.js for the full rationale — writes a real failure to
// error_log (migration 036) so it surfaces in the Admin Panel's
// "Errors" tab. Self-contained, duplicated per file on purpose.
async function logError(source, message, detail) {
  try {
    const supaUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supaUrl || !serviceKey) return;
    await fetch(`${supaUrl}/rest/v1/error_log`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ source, message: String(message).slice(0, 2000), detail: detail || null }),
    });
  } catch (e) { console.error("GOLSZ error-log write failed:", e); }
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=")));
  const timestamp = parts.t;
  const provided = parts.v1;
  if (!timestamp || !provided) return false;
  // reject stale signatures (5 min tolerance) to blunt replay attacks
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

// client_reference_id is set by whoever initiates checkout — this app's
// own Payment Link redirect always appends a real profile UUID, but
// anyone can open that same Payment Link URL by hand with an arbitrary
// value in that query param. Interpolating it unchecked into a PostgREST
// filter string (id=eq.${profileId}) would let a crafted value inject
// extra filter clauses (e.g. a URL-encoded "&" introducing an "or"
// condition) targeting a different row than intended. Requiring a real
// UUID shape first closes that off, same pattern as the UUID check in
// api/admin-user-action.js.
import {
  resolvePlanFromStripe,
  readPriceFields,
  stripeCatalogConfigured,
} from "./_plan-catalog.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolves a Stripe subscription item to a GOLSZ plan, logging the reason
// whenever it refuses. Refusing is the safe outcome: the profile keeps
// whatever plan it already had rather than being granted or downgraded on
// a guess.
function resolvePlanOrLog(fields, context) {
  const result = resolvePlanFromStripe(fields);
  if (!result.plan) {
    console.warn("GOLSZ stripe plan NOT resolved:", JSON.stringify({
      context,
      reason: result.reason,
      problems: result.problems || null,
      expected: result.expected || null,
      // Price id is a Stripe object id, not a secret — safe to log and the
      // single most useful thing when diagnosing a misconfigured Price.
      sawPriceId: fields.priceId || null,
      sawLookupKey: fields.lookupKey || null,
      sawCurrency: fields.currency || null,
      sawUnitAmount: fields.unitAmount === undefined ? null : fields.unitAmount,
    }));
  }
  return result.plan;
}

async function patchProfile(supaUrl, serviceKey, filterQuery, body) {
  await fetch(`${supaUrl}/rest/v1/profiles?${filterQuery}`, {
    method: "PATCH",
    headers: {
      apikey: serviceKey,
      Authorization: "Bearer " + serviceKey,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!webhookSecret) return res.status(500).json({ error: "Server missing STRIPE_WEBHOOK_SECRET" });
  if (!supaUrl || !serviceKey) return res.status(500).json({ error: "Server missing SUPABASE_URL/SUPABASE_SERVICE_KEY" });

  const rawBody = await readRawBody(req);
  if (!verifyStripeSignature(rawBody, req.headers["stripe-signature"], webhookSecret)) {
    return res.status(400).json({ error: "Invalid Stripe signature" });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return res.status(400).json({ error: "Invalid JSON" }); }

  // No configured Price ids means no paid plan can be granted by any event.
  // That is correct today (checkout is deliberately disabled) but would be
  // a silent revenue outage after go-live, so say so on every event rather
  // than failing quietly.
  if (!stripeCatalogConfigured()) {
    console.warn("GOLSZ stripe catalog NOT configured: STRIPE_PRICE_BASIC/PRO/ELITE are unset, so no subscription event can grant a plan. Expected while checkout is disabled.");
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const profileId = session.client_reference_id;
      const customerId = session.customer;

      // NOTE ON line_items: Stripe does NOT include line_items in this
      // webhook payload — it is an expandable field, and webhooks never
      // expand. So the Price is usually unavailable here, and this event
      // alone often cannot identify the plan. That is fine, because the
      // customer.subscription.created event that follows DOES carry
      // items.data[0].price with id, lookup_key, currency and unit_amount,
      // and is handled below as the authoritative source.
      //
      // session.amount_total is deliberately never used: it carries tax,
      // discounts and proration and says nothing reliable about which
      // product was bought.
      const line = session.line_items && session.line_items.data && session.line_items.data[0];
      const fields = readPriceFields(line && line.price);
      // Metadata we set on the Payment Link ourselves. This is what makes
      // the checkout event able to resolve a plan at all in the normal
      // (unexpanded) case — see the OWNER note in api/_plan-catalog.js.
      fields.metadataPlan = (session.metadata && session.metadata.golsz_plan) || null;
      const plan = fields.metadataPlan || fields.priceId
        ? resolvePlanOrLog(fields, "checkout.session.completed")
        : null;

      if (profileId && UUID_RE.test(profileId)) {
        // Bind the Stripe customer to the profile ALWAYS, even when the plan
        // could not be resolved. Every subsequent subscription event is
        // matched by stripe_customer_id, so skipping this write would orphan
        // the customer and silently break the authoritative path below —
        // client_reference_id is only present on this one event.
        const patch = { stripe_customer_id: customerId || null, payment_past_due: false };
        if (plan) patch.plan = plan;
        await patchProfile(supaUrl, serviceKey, `id=eq.${profileId}`, patch);
      }
    } else if (event.type === "customer.subscription.deleted") {
      const customerId = event.data.object.customer;
      if (customerId) {
        await patchProfile(supaUrl, serviceKey, `stripe_customer_id=eq.${customerId}`, { plan: "free", payment_past_due: false });
      }
    } else if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated") {
      // Syncs plan changes and recovers/flags the past-due state as the
      // subscription's status transitions (e.g. active -> past_due after a
      // failed charge, or past_due -> active after Stripe's retry succeeds).
      // A hard cutoff to "free" only happens for a status Stripe uses to
      // mean the subscription is truly over — "canceled"/"unpaid"/
      // "incomplete_expired" — everything else (trialing, past_due) keeps
      // the account's paid plan intact while Stripe keeps retrying.
      const sub = event.data.object;
      const customerId = sub.customer;
      const status = sub.status;
      if (customerId) {
        if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") {
          await patchProfile(supaUrl, serviceKey, `stripe_customer_id=eq.${customerId}`, { plan: "free", payment_past_due: false });
        } else {
          const item = sub.items && sub.items.data && sub.items.data[0];
          const fields = readPriceFields(item && item.price);
          fields.metadataPlan = (sub.metadata && sub.metadata.golsz_plan) || null;
          const plan = resolvePlanOrLog(fields, event.type);
          // past_due is still recorded even when the plan can't be resolved
          // — the billing state is independently true, and refusing to
          // write it would leave a failing subscription looking healthy.
          const patch = { payment_past_due: status === "past_due" };
          if (plan) patch.plan = plan;
          await patchProfile(supaUrl, serviceKey, `stripe_customer_id=eq.${customerId}`, patch);
        }
      }
    } else if (event.type === "invoice.payment_failed") {
      const customerId = event.data.object.customer;
      if (customerId) {
        await patchProfile(supaUrl, serviceKey, `stripe_customer_id=eq.${customerId}`, { payment_past_due: true });
      }
    }
    // other event types are ignored — Stripe expects a 200 regardless
    return res.status(200).json({ received: true });
  } catch (e) {
    await logError("api/stripe-webhook.js", "Webhook handling failed", { detail: String(e), eventType: event && event.type });
    return res.status(500).json({ error: "Webhook handling failed", detail: String(e) });
  }
}
