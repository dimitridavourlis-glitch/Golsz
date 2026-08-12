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
// Required table: stripe_events (migration 127) — the replay guard. Without
// it every event is still handled, but each one writes an error_log row
// saying it ran unprotected; see claimStripeEvent() below.
//
// Attribution: golsz-app.html's Auth appends ?client_reference_id=<user.id>
// to the Payment Link redirect, so checkout.session.completed can identify
// who paid. Which plan they receive is resolved from a TRUSTED STRIPE
// IDENTIFIER (Price id, lookup_key, or explicit metadata) by
// api/_plan-catalog.js — never from the amount paid. Currency and unit
// amount are then validated separately against the catalogue. See that
// file's header for why amount-inference was wrong. Prices are changed by
// repointing the STRIPE_PRICE_* env vars at the new Stripe Price ids — this
// file has no amount thresholds of its own to keep in step, which is the
// point of moving that decision into the catalogue. Free never reaches this
// file at all since it has no Stripe link and never goes through checkout.
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
  // Stripe's `Stripe-Signature` header is a comma-separated list of key=value
  // pairs in which the SAME key can legitimately appear more than once:
  // during a signing-secret ROTATION Stripe signs each event with both the
  // old and the new secret and sends TWO `v1=` entries.
  //
  // This used to be parsed with Object.fromEntries(), which silently keeps
  // only the LAST value for a repeated key. So whichever secret happened to
  // come second was the only one that could ever verify, and every genuine
  // event signed under the other one was rejected with a 400 for the whole
  // rotation window — with Stripe's retries burning against an endpoint that
  // would never accept them, i.e. lost upgrades and lost cancellations.
  // Collect EVERY v1 candidate and accept if ANY of them matches.
  let timestamp = null;
  const provided = [];
  for (const part of sigHeader.split(",")) {
    // Split on the FIRST "=" only: splitting on all of them would corrupt any
    // value that contains one (base64 padding, future scheme versions).
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") { if (timestamp === null) timestamp = v; }
    else if (k === "v1" && v) provided.push(v);
  }
  if (!timestamp || !provided.length) return false;
  // reject stale signatures (5 min tolerance) to blunt replay attacks.
  // The Number() must be checked explicitly: NaN > 300 is FALSE, so a
  // non-numeric `t` would sail straight past a bare comparison.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected);
  // Each candidate is compared in constant time, and the length is checked
  // first because timingSafeEqual throws on a length mismatch. some() short-
  // circuits on the first match, which reveals only how many attacker-
  // supplied candidates were tried — never a byte of the real HMAC.
  return provided.some((sig) => {
    try {
      const buf = Buffer.from(sig);
      return buf.length === expectedBuf.length && crypto.timingSafeEqual(expectedBuf, buf);
    } catch {
      return false;
    }
  });
}

// EVENT REPLAY PROTECTION (stripe_events, migration 127).
//
// The 5-minute timestamp tolerance above narrows the replay window but does
// not close it: a valid signature proves a request came FROM Stripe, not
// that this is the first time it has been delivered. Anyone who can capture
// a valid request (a proxy, a log, a mis-shared webhook payload) can re-POST
// it byte-for-byte inside that window and it verifies again. Most branches
// below are idempotent — the same PATCH written twice — but a replayed
// customer.subscription.deleted lands a second downgrade to free, and a
// replayed checkout.session.completed re-binds a customer id.
//
// THE INSERT IS THE CLAIM. Not "select the id, insert it if absent": two
// concurrent deliveries of the same event (Stripe's own retry racing the
// original, or a replay fired alongside the genuine POST) would both see
// nothing and both proceed, which is precisely the case this exists for.
// stripe_events.id is a primary key, so the database arbitrates inside a
// single statement — 2xx means this delivery owns the event, 409 (SQLSTATE
// 23505, unique violation) means another one already does.
//
// `Prefer: resolution=ignore-duplicates` is deliberately NOT used. It turns
// the conflict into a silent success, so "I claimed it" and "someone else
// already had it" become distinguishable only by asking for the inserted
// representation back and inspecting whether the array is empty — a subtler
// signal and a bigger response, for no gain. A raw conflict is unambiguous.
//
// Returns one of:
//   "claimed"   — first delivery of this event id; process it.
//   "duplicate" — already handled; ack 200 and change nothing.
//   "unknown"   — the claim could not be written at all (table not yet
//                 migrated, Supabase unreachable). See the fail-open note
//                 at the call site for why that is not treated as a refusal.
//
// An in-memory Set was deliberately NOT used as a stopgap: this runs on
// ephemeral, plural serverless instances, so it would only catch a replay
// that happened to land on the same warm instance as the original — the
// appearance of protection with none of the substance.
async function claimStripeEvent(supaUrl, serviceKey, eventId, eventType) {
  try {
    const res = await fetch(`${supaUrl}/rest/v1/stripe_events`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: "Bearer " + serviceKey,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ id: eventId, type: eventType || null }),
    });
    if (res.ok) return "claimed";
    // The SQLSTATE is read as well as the status because 409 is a general
    // conflict code. Treating some future unrelated conflict as "already
    // processed" would silently DROP a real event, and drop it invisibly:
    // Stripe would have its 200 and never retry.
    let code = null;
    try { const body = await res.json(); code = body && body.code; } catch { /* empty or non-JSON body */ }
    if (res.status === 409 || code === "23505") return "duplicate";
    console.error("GOLSZ stripe replay-guard write failed:", res.status, code || "");
    return "unknown";
  } catch (e) {
    console.error("GOLSZ stripe replay-guard unreachable:", e);
    return "unknown";
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

// Reads one profile row. Returns null on any error or no match, so callers
// can treat "I could not confirm this" the same as "this is not mine" and
// refuse — a lookup failure must never fall through into a write.
async function selectProfile(supaUrl, serviceKey, filterQuery, select) {
  try {
    const res = await fetch(`${supaUrl}/rest/v1/profiles?${filterQuery}&select=${select}`, {
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
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

  // ---- REPLAY GUARD ------------------------------------------------------
  // Position is load-bearing in both directions. AFTER signature
  // verification: an unsigned body must never be able to write a row here,
  // or anyone could pre-claim event ids and make Stripe's genuine
  // deliveries arrive looking like duplicates — a denial of service on
  // billing, built out of the protection itself. BEFORE every branch below:
  // the whole point is that a replay changes nothing, so the claim has to
  // settle before the first PATCH, not after it.
  const eventId = typeof event.id === "string" && event.id.length > 0 && event.id.length <= 255 ? event.id : null;
  if (!eventId) {
    // Every real Stripe event carries an `evt_...` id. Reaching here means
    // Stripe changed its payload shape — refusing would drop genuine billing
    // events over a diagnostic, so this one is processed unguarded. Said out
    // loud rather than assumed: for this delivery there is no protection.
    console.warn("GOLSZ stripe replay-guard SKIPPED: event carries no usable id", JSON.stringify({ eventType: event.type || null }));
  } else {
    const claim = await claimStripeEvent(supaUrl, serviceKey, eventId, event.type);
    if (claim === "duplicate") {
      // 200, never 4xx/5xx. A non-2xx makes Stripe retry, and a retry is the
      // one response an already-handled event must not provoke.
      console.log("GOLSZ stripe event already processed, replay ignored:", JSON.stringify({ eventId, eventType: event.type || null }));
      return res.status(200).json({ received: true, duplicate: true });
    }
    if (claim === "unknown") {
      // FAIL OPEN, LOUDLY.
      // The alternative is to 500 and let Stripe retry, which sounds safer
      // and is worse: an unapplied migration 127 or a Supabase blip would
      // then stop EVERY upgrade and cancellation from syncing until someone
      // noticed. That trades a narrow window an attacker can only use while
      // holding a captured, still-in-tolerance payload for a certain, total
      // billing outage.
      //
      // What must not happen is failing open QUIETLY, which is a guard that
      // has stopped working while every dashboard stays green. So this
      // writes to error_log: it surfaces in the Admin Panel's Errors tab,
      // and api/health-alert.js counts error_log rows as one of its two
      // outage signals (HEALTH_MAX_ERRORS, default 3), so a replay guard
      // that has quietly gone offline pages an admin within ~15 minutes
      // instead of never.
      await logError(
        "api/stripe-webhook.js",
        "Replay guard unavailable — event processed WITHOUT duplicate protection",
        { eventId, eventType: event.type || null }
      );
    }
  }

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
        // ---- ACCOUNT-TAKEOVER GUARD ------------------------------------
        // The UUID check above only proves client_reference_id is SHAPED
        // like a profile id. It does NOT prove the person paying has any
        // relationship to that profile — and client_reference_id is a plain
        // query parameter on a public Payment Link, so anyone can open
        //   https://buy.stripe.com/<link>?client_reference_id=<victim uuid>
        // and pay with their own card.
        //
        // Without this check the webhook then wrote the ATTACKER's
        // stripe_customer_id onto the VICTIM's profile. Because every later
        // subscription event is matched by stripe_customer_id alone, that
        // single write means: the victim's own renewals stop syncing (their
        // customer id is gone), and the attacker cancelling their own cheap
        // subscription fires customer.subscription.deleted against the
        // victim's row and downgrades a paying user to free.
        //
        // So: only bind a customer to a profile that is UNCLAIMED, or that
        // already belongs to this same customer (the ordinary repeat-
        // checkout case). Anything else is logged and refused — refusing is
        // safe, since the profile simply keeps the state it already had.
        const existing = await selectProfile(supaUrl, serviceKey, `id=eq.${profileId}`, "id,stripe_customer_id");
        const claimedBy = existing && existing.stripe_customer_id;
        const mayBind = !!existing && (!claimedBy || claimedBy === customerId);

        if (!existing) {
          // Well-formed UUID that matches no profile: either a typo or a
          // probe. Previously this was a PATCH matching zero rows — silent.
          console.warn("GOLSZ stripe checkout REFUSED: client_reference_id does not match any profile", JSON.stringify({
            context: "checkout.session.completed", profileId, customerId: customerId || null,
          }));
          await logError("api/stripe-webhook.js", "Checkout refused: client_reference_id matched no profile", { profileId, customerId: customerId || null });
        } else if (!mayBind) {
          console.warn("GOLSZ stripe checkout REFUSED: profile already belongs to a different Stripe customer", JSON.stringify({
            context: "checkout.session.completed", profileId,
            claimedBy, attemptedCustomerId: customerId || null,
          }));
          await logError(
            "api/stripe-webhook.js",
            "Checkout refused: client_reference_id targets a profile owned by another Stripe customer (possible takeover attempt)",
            { profileId, claimedBy, attemptedCustomerId: customerId || null }
          );
        } else {
          // Bind the Stripe customer to the profile ALWAYS, even when the plan
          // could not be resolved. Every subsequent subscription event is
          // matched by stripe_customer_id, so skipping this write would orphan
          // the customer and silently break the authoritative path below —
          // client_reference_id is only present on this one event.
          // ("ALWAYS" is with respect to plan resolution, which is the trap
          // this comment was written for. It is still gated on the ownership
          // check above; a plan that resolves cleanly for the wrong profile
          // is not a reason to write it.)
          const patch = { stripe_customer_id: customerId || null, payment_past_due: false };
          if (plan) patch.plan = plan;
          await patchProfile(supaUrl, serviceKey, `id=eq.${profileId}`, patch);
        }
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
