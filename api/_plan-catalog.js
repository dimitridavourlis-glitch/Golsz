// ============================================================
// GOLSZ — plan catalogue and Stripe plan resolution
//
// WHY THIS EXISTS
// The webhook used to decide which plan a customer received by looking at
// how much they paid:
//
//     planFromAmount(amount) => amount >= 3000 ? "elite" : ...
//
// That is one input doing two jobs — identifying the product AND proving
// the price — and it breaks the moment reality is less tidy than a bare
// subscription:
//
//   * tax on top pushes the total past the next tier's floor;
//   * a coupon or first-month discount pushes it below its own floor;
//   * a proration or credit on an upgrade invoice bears no relation to the
//     plan price at all;
//   * a partial refund changes the amount after the fact;
//   * any future price change silently re-maps existing subscriptions;
//   * and because it reads unit_amount WITHOUT currency, 3000 of any other
//     currency would have granted Elite.
//
// The fix separates the two questions:
//
//   1. WHICH PLAN IS THIS?  Answered only from a trusted Stripe identifier
//      — the Price id, its lookup_key, or explicit metadata. Never from money.
//   2. IS THE CONFIGURATION WHAT WE EXPECT?  Currency must be EUR and the
//      unit amount must match the catalogue. Checked independently, and a
//      failure rejects rather than downgrades.
//
// Neither check can grant a plan on its own. Identity with a wrong currency
// is refused; a correct amount with an unknown identifier is refused.
//
// NO LIVE STRIPE VALUES ARE COMMITTED HERE. Price ids come from environment
// variables that are unset today, so resolution returns null and nothing is
// granted — which is the correct posture while checkout is deliberately
// disabled (isLiveStripeLink() in golsz-app.html).
//
// ---------------------------------------------------------------
// OWNER: when the live CAD Stripe configuration is created, set these in
// Vercel (Production). Values come from Stripe; do not invent them.
//
//   STRIPE_PRICE_BASIC   price_...   the recurring EUR 6.00/mo Price
//   STRIPE_PRICE_PRO     price_...   the recurring EUR 15.00/mo Price
//   STRIPE_PRICE_ELITE   price_...   the recurring EUR 30.00/mo Price
//
// Optionally also set each Price's `lookup_key` in Stripe to the value in
// LOOKUP_KEY below. A lookup_key survives Price recreation, so if a price
// ever changes you can move the key to the new Price and this keeps
// resolving without a redeploy.
// ---------------------------------------------------------------
// ============================================================

// The one place plan money is defined server-side. Mirrors PLANS in
// golsz-app.html; tests/test_cad_pricing.cjs diffs the two so they cannot
// drift. Amounts are Stripe minor units (cents).
const EXPECTED_CURRENCY = "eur";

const PLAN_CATALOG = [
  {
    plan: "starter",          // the DB enum value — NOT the display name
    displayName: "Basic",
    unitAmount: 600,          // EUR 6.00
    currency: EXPECTED_CURRENCY,
    lookupKey: "golsz_basic_eur_monthly",
    priceEnv: "STRIPE_PRICE_BASIC",
  },
  {
    plan: "pro",
    displayName: "Pro",
    unitAmount: 1500,         // EUR 15.00
    currency: EXPECTED_CURRENCY,
    lookupKey: "golsz_pro_eur_monthly",
    priceEnv: "STRIPE_PRICE_PRO",
  },
  {
    plan: "elite",
    displayName: "Elite",
    unitAmount: 3000,         // EUR 30.00
    currency: EXPECTED_CURRENCY,
    lookupKey: "golsz_elite_eur_monthly",
    priceEnv: "STRIPE_PRICE_ELITE",
  },
];

// "free" is deliberately absent: it is the absence of a subscription, never
// something Stripe grants. Nothing here can ever resolve to "free" — that
// transition is driven by subscription.deleted / canceled, not by a price.
const VALID_PLANS = PLAN_CATALOG.map((e) => e.plan);

// Reads the configured Price id at call time rather than module load, so a
// Vercel env change takes effect on the next invocation without a redeploy.
function configuredPriceId(entry, env) {
  const raw = (env || process.env)[entry.priceEnv];
  const v = typeof raw === "string" ? raw.trim() : "";
  // Guard against a half-filled env var ("", "price_...", a placeholder).
  return /^price_[A-Za-z0-9]+$/.test(v) ? v : null;
}

// STEP 1 — identity. Returns a catalogue entry or null. Money is not an
// input to this function on purpose.
function identifyPlan({ priceId, lookupKey, metadataPlan }, env) {
  // Most trusted first. A Price id is unique to one Price object in one
  // Stripe account and cannot be spoofed by a customer.
  if (priceId) {
    const byId = PLAN_CATALOG.find((e) => configuredPriceId(e, env) === priceId);
    if (byId) return { entry: byId, matchedBy: "price_id" };
  }
  // lookup_key is owner-controlled in Stripe and stable across Price
  // recreation, which is exactly what a currency or price change forces.
  if (lookupKey) {
    const byKey = PLAN_CATALOG.find((e) => e.lookupKey === lookupKey);
    if (byKey) return { entry: byKey, matchedBy: "lookup_key" };
  }
  // Explicit metadata set by us on the Payment Link / Checkout Session.
  // Last because it is the easiest to set wrongly by hand — but it is still
  // an explicit declaration, not an inference from an amount.
  if (metadataPlan && VALID_PLANS.includes(metadataPlan)) {
    const byMeta = PLAN_CATALOG.find((e) => e.plan === metadataPlan);
    if (byMeta) return { entry: byMeta, matchedBy: "metadata" };
  }
  return null;
}

// STEP 2 — validation, independent of identity. Currency and amount are
// checked against the catalogue, not against each other.
//
// unitAmount is compared to the Price's OWN unit_amount, which is the
// recurring list price and is tax-exclusive. Tax, coupons, proration and
// credits all move the invoice total but never the Price's unit_amount, so
// this stays exact rather than needing a tolerance band. Callers must pass
// price.unit_amount — never amount_total / amount_paid.
function validateConfiguration(entry, { currency, unitAmount }) {
  const problems = [];
  const cur = typeof currency === "string" ? currency.toLowerCase() : null;
  if (cur !== entry.currency) problems.push(`currency:${cur || "missing"}`);
  // A missing amount is a problem, not a pass — silence must not validate.
  if (typeof unitAmount !== "number" || !Number.isFinite(unitAmount)) problems.push("amount:missing");
  else if (unitAmount !== entry.unitAmount) problems.push(`amount:${unitAmount}`);
  return { ok: problems.length === 0, problems };
}

// The public entry point. Returns { plan, matchedBy } on success, or
// { plan: null, reason } on any failure. Never throws, never guesses, and
// never falls back to an amount-based inference.
function resolvePlanFromStripe(input, env) {
  const found = identifyPlan(input || {}, env);
  if (!found) return { plan: null, reason: "unknown_price_or_plan" };
  const check = validateConfiguration(found.entry, input || {});
  if (!check.ok) {
    return {
      plan: null,
      reason: "configuration_mismatch",
      expected: { plan: found.entry.plan, currency: found.entry.currency, unitAmount: found.entry.unitAmount },
      problems: check.problems,
      matchedBy: found.matchedBy,
    };
  }
  return { plan: found.entry.plan, matchedBy: found.matchedBy };
}

// Pulls the fields this module needs out of a Stripe subscription item.
// Kept here so the webhook doesn't have to know Stripe's nesting, and so
// both the checkout and subscription.updated paths read it identically.
function readPriceFields(price) {
  if (!price || typeof price !== "object") return {};
  return {
    priceId: typeof price.id === "string" ? price.id : null,
    lookupKey: typeof price.lookup_key === "string" ? price.lookup_key : null,
    currency: typeof price.currency === "string" ? price.currency : null,
    unitAmount: typeof price.unit_amount === "number" ? price.unit_amount : null,
  };
}

// True once at least one real Price id is configured. The webhook logs
// loudly when it is false, because in that state no paid plan can ever be
// granted — correct while checkout is disabled, a silent outage after go-live.
function stripeCatalogConfigured(env) {
  return PLAN_CATALOG.some((e) => configuredPriceId(e, env) !== null);
}

export {
  PLAN_CATALOG,
  EXPECTED_CURRENCY,
  VALID_PLANS,
  identifyPlan,
  validateConfiguration,
  resolvePlanFromStripe,
  readPriceFields,
  stripeCatalogConfigured,
  configuredPriceId,
};
