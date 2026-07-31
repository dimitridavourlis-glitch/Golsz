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
//
// Required env vars:
//   STRIPE_WEBHOOK_SECRET     from the Stripe Dashboard webhook you register
//   SUPABASE_URL              same value used by api/scout.js
//   SUPABASE_SERVICE_KEY      service role key (server-only; never ship to the browser)
//
// Attribution: golsz-app.html's Auth appends ?client_reference_id=<user.id>
// to the Payment Link redirect, so checkout.session.completed can identify
// who paid. Plan is inferred from the checkout amount (Pro=$29, Elite=$79,
// matching PLANS in golsz-app.html) since Payment Links don't carry
// arbitrary metadata via URL — if those prices ever change, update the
// thresholds below to match.
// ============================================================

export const config = { api: { bodyParser: false } };

import crypto from "crypto";

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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const profileId = session.client_reference_id;
      const customerId = session.customer;
      const amount = session.amount_total || 0;
      const plan = amount >= 7900 ? "elite" : amount >= 2900 ? "pro" : null;
      if (profileId && UUID_RE.test(profileId) && plan) {
        await patchProfile(supaUrl, serviceKey, `id=eq.${profileId}`, { plan, stripe_customer_id: customerId || null });
      }
    } else if (event.type === "customer.subscription.deleted") {
      const customerId = event.data.object.customer;
      if (customerId) {
        await patchProfile(supaUrl, serviceKey, `stripe_customer_id=eq.${customerId}`, { plan: "starter" });
      }
    }
    // other event types are ignored — Stripe expects a 200 regardless
    return res.status(200).json({ received: true });
  } catch (e) {
    return res.status(500).json({ error: "Webhook handling failed", detail: String(e) });
  }
}
