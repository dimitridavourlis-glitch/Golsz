// api/stripe-webhook.js — the real handler, driven end to end.
//
// WHY THIS FILE WAS REWRITTEN RATHER THAN DELETED
//
// It used to open with:
//
//     function planFromAmount(amount) {
//       return amount >= 3000 ? "elite" : amount >= 1400 ? "pro" : ...
//     }
//
// and eleven assertions about it. That function does not exist in
// api/stripe-webhook.js and has not for months — that file's own header says
// the plan is resolved from a trusted Stripe identifier by
// api/_plan-catalog.js, "never from the amount paid", and
// tests/test_pricing.cjs asserts `planFromAmount is gone` in the SAME RUN.
// Two suites contradicted each other and eleven assertions reported green
// for billing logic that had never shipped. The thresholds it "verified"
// were wrong on their own terms too: Pro is 1500 minor units, not 1400.
//
// DELETE OR REWRITE? Checked first; the real path was NOT covered elsewhere:
//   - tests/test_pricing.cjs          exercises resolvePlanFromStripe and
//                                     readPriceFields thoroughly, then greps
//                                     this handler's SOURCE TEXT.
//   - tests/test_subscription_gate.cjs greps the same source text.
//   Neither ever runs the handler. Nothing asserted what
//   customer.subscription.updated actually DOES with a subscription status —
//   which is exactly what the mirror pretended to cover, and what decides
//   whether a paying account keeps its plan. So: rewritten.
//
// This drives the REAL exported handler with fetch mocked and genuine HMAC
// signatures, in the shape tests/README.md prescribes for
// test_handler_smoke.cjs: run the thing that ships, prove it got past auth,
// assert on the writes it actually issued.

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const REPO = path.join(__dirname, "..");

const SECRET = "whsec_test_current_secret_value";
const OLD_SECRET = "whsec_test_previous_secret_value";   // the rotation case

process.env.STRIPE_WEBHOOK_SECRET = SECRET;
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
// Fake Price ids. test_pricing.cjs asserts no live Stripe id is ever
// committed, so these must stay obviously synthetic.
process.env.STRIPE_PRICE_BASIC = "price_TESTbasic000000001";
process.env.STRIPE_PRICE_PRO = "price_TESTpro0000000001";
process.env.STRIPE_PRICE_ELITE = "price_TESTelite00000001";

const handler = require("../api/stripe-webhook.js").default;

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- harness -------------------------------------------------------------
// `profiles` is the stubbed database. Every GET on /rest/v1/profiles is
// answered from it, so the ownership check is driven by real state rather
// than by a boolean handed to the handler.
let calls = [];
let profiles = {};
// 0 = respond normally. Set to a status code to make the next profiles PATCH
// answer 4xx, the case `await fetch()` resolves rather than throwing on.
let patchHttpStatus = 0;

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String(opts.method || "GET").toUpperCase();
  let body = null;
  try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = opts.body; }
  calls.push({ url: u, method, body });
  if (method === "GET" && u.includes("/rest/v1/profiles")) {
    const m = /[?&]id=eq\.([^&]+)/.exec(u);   // anchored: see the PATCH branch below
    const row = m ? profiles[m[1]] : undefined;
    return { ok: true, json: async () => (row ? [row] : []) };
  }
  // PATCH now asks for Prefer: return=representation and REQUIRES a row back —
  // a PATCH matching zero rows is a real failure the old `return=minimal` form
  // could not distinguish from success. The mock has to model that or it tests
  // a contract the code no longer uses.
  if (method === "PATCH" && u.includes("/rest/v1/profiles")) {
    // ANCHORED to a query-string boundary on purpose: /id=eq\./ also matches
    // inside "stripe_customer_id=eq.", so an unanchored version captured the
    // CUSTOMER id, looked it up as a profile key, found nothing and reported
    // zero rows updated. A substring that looks specific and is not.
    if (patchHttpStatus) {
      return { ok: false, status: patchHttpStatus, text: async () => '{"message":"column does not exist"}',
               json: async () => ({ message: "column does not exist" }) };
    }
    // The mock HONOURS Prefer, because the header is half the contract. With
    // `return=minimal` PostgREST answers 204 with an EMPTY BODY — r.ok is
    // true and r.json() throws. Code that requires a row back would then
    // treat every SUCCESSFUL write as "matched no profile" and 500 forever,
    // which is worse than the bug it replaced. A mock that answers rows no
    // matter what Prefer says cannot see that, and this one could not: the
    // header was reverted during a CI dry-run and every assertion still
    // passed.
    const prefer = String((opts.headers || {}).Prefer || "");
    if (!prefer.includes("return=representation")) {
      return { ok: true, status: 204, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
               text: async () => "" };
    }
    const byId = /[?&]id=eq\.([^&]+)/.exec(u);
    const byCustomer = /stripe_customer_id=eq\.([^&]+)/.exec(u);
    let matched = [];
    if (byId) {
      const row = profiles[byId[1]];
      if (row) matched = [row];
    } else if (byCustomer) {
      matched = Object.values(profiles).filter((p) => p.stripe_customer_id === byCustomer[1]);
    }
    // Apply the patch so later assertions see the effect, then return the rows.
    for (const row of matched) Object.assign(row, body || {});
    return { ok: true, json: async () => matched };
  }
  return { ok: true, json: async () => [] };
};

// bodyParser is disabled for this route, so the handler reads the raw body by
// async-iterating the request. The fixture has to be that shape, not a
// pre-parsed object — see tests/README.md on fixtures matching production.
const mkReq = (raw, sigHeader) => ({
  method: "POST",
  headers: { "stripe-signature": sigHeader },
  async *[Symbol.asyncIterator]() { yield Buffer.from(raw, "utf8"); },
});

const mkRes = () => {
  const r = { statusCode: null, payload: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.payload = b; return r; };
  return r;
};

const hmac = (secret, ts, raw) => crypto.createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex");
const signWith = (raw, secrets, ts) =>
  `t=${ts},` + secrets.map((s) => `v1=${hmac(s, ts, raw)}`).join(",");

async function post(event, opts = {}) {
  calls = [];
  const raw = JSON.stringify(event);
  const ts = opts.ts !== undefined ? opts.ts : Math.floor(Date.now() / 1000);
  const sig = opts.sig !== undefined ? opts.sig : signWith(raw, opts.secrets || [SECRET], ts);
  const res = mkRes();
  await handler(mkReq(raw, sig), res);
  const patches = calls.filter((c) => c.method === "PATCH" && c.url.includes("/rest/v1/profiles"));
  return {
    status: res.statusCode,
    payload: res.payload,
    patches,
    patch: patches.length === 1 ? patches[0].body : null,
    filter: patches.length === 1 ? (patches[0].url.split("?")[1] || "") : null,
    errorLogs: calls.filter((c) => c.url.includes("/rest/v1/error_log")),
    lookups: calls.filter((c) => c.method === "GET" && c.url.includes("/rest/v1/profiles")),
  };
}

const CUSTOMER = "cus_paying_customer";
const ATTACKER = "cus_attacker";
const VICTIM_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_ID = "33333333-3333-4333-8333-333333333333";

const subEvent = (status, price, type = "customer.subscription.updated") => ({
  id: "evt_" + Math.random().toString(16).slice(2),
  type,
  data: { object: { customer: CUSTOMER, status, items: { data: price ? [{ price }] : [] } } },
});
const PRO_PRICE = { id: process.env.STRIPE_PRICE_PRO, currency: "eur", unit_amount: 1500 };
const BASIC_PRICE = { id: process.env.STRIPE_PRICE_BASIC, currency: "eur", unit_amount: 600 };

(async () => {
  console.log("-- the harness actually reaches the handler --");
  // The first version of test_handler_smoke.cjs silently 401'd on every
  // scenario and reported 6/6 while testing nothing. Same trap here: with a
  // bad signature or missing env, every assertion below would "pass" by
  // writing nothing. So prove a good request gets a 200 AND a real write
  // before believing anything else in this file.
  // The profile this customer belongs to must EXIST for the write to land.
  // Before 2026-08-13 these fixtures had none and still passed, because a PATCH
  // matching zero rows returned 204 and the handler discarded the result — the
  // suite was asserting a write that never happened. patchProfile now requires
  // a row back, which is what surfaced it.
  profiles = { [OWNER_ID]: { id: OWNER_ID, stripe_customer_id: CUSTOMER } };
  let r = await post(subEvent("active", PRO_PRICE));
  ck("a correctly signed event is accepted", r.status, 200);
  ck("...and the body says so", r.payload, { received: true });
  ck("...and it actually wrote to profiles", r.patches.length, 1);

  console.log("\n-- customer.subscription.updated: the real decision path --");
  ck("active + Pro price -> syncs plan, clears past_due", r.patch, { payment_past_due: false, plan: "pro" });
  ck("...matched by stripe_customer_id, never by profile id",
     r.filter, `stripe_customer_id=eq.${CUSTOMER}`);

  r = await post(subEvent("past_due", PRO_PRICE));
  ck("past_due + resolvable price -> flags past_due AND keeps the plan in sync",
     r.patch, { payment_past_due: true, plan: "pro" });

  r = await post(subEvent("past_due", { id: "price_not_configured", currency: "eur", unit_amount: 1500 }));
  ck("an UNKNOWN price id -> past_due still recorded, plan deliberately absent",
     r.patch, { payment_past_due: true });
  // The billing state is independently true; refusing to write it would leave
  // a failing subscription looking healthy.

  r = await post(subEvent("active", null));
  ck("no price info at all -> writes the status, never guesses a plan",
     r.patch, { payment_past_due: false });

  for (const status of ["canceled", "unpaid", "incomplete_expired"]) {
    r = await post(subEvent(status, PRO_PRICE));
    ck(`${status} -> hard downgrade to free, past_due cleared`,
       r.patch, { plan: "free", payment_past_due: false });
  }

  r = await post(subEvent("trialing", BASIC_PRICE));
  ck("trialing -> not past_due, and Basic maps to the 'starter' DB enum value",
     r.patch, { payment_past_due: false, plan: "starter" });

  r = await post(subEvent("active", PRO_PRICE, "customer.subscription.created"));
  ck("subscription.created takes the same path (it is the event carrying the Price)",
     r.patch, { payment_past_due: false, plan: "pro" });

  r = await post({ id: "evt_del", type: "customer.subscription.deleted", data: { object: { customer: CUSTOMER } } });
  ck("subscription.deleted -> free", r.patch, { plan: "free", payment_past_due: false });
  r = await post({ id: "evt_inv", type: "invoice.payment_failed", data: { object: { customer: CUSTOMER } } });
  ck("invoice.payment_failed -> past_due only", r.patch, { payment_past_due: true });
  r = await post({ id: "evt_nocust", type: "customer.subscription.updated", data: { object: { status: "active" } } });
  ck("an event with no customer id writes nothing", r.patches.length, 0);

  console.log("\n-- MONEY CANNOT NAME A PLAN (what the deleted mirror got wrong) --");
  // The removed planFromAmount() would have called 1400 "pro". Pro is 1500.
  r = await post(subEvent("active", { currency: "eur", unit_amount: 1400 }));
  ck("an amount with no price id grants nothing", r.patch, { payment_past_due: false });
  r = await post(subEvent("active", { currency: "eur", unit_amount: 3000 }));
  ck("even an exactly-Elite amount grants nothing on its own", r.patch, { payment_past_due: false });
  r = await post(subEvent("active", { id: process.env.STRIPE_PRICE_PRO, currency: "eur", unit_amount: 3000 }));
  ck("Pro's price id carrying Elite's money is refused, not upgraded", r.patch, { payment_past_due: false });
  r = await post(subEvent("active", { id: process.env.STRIPE_PRICE_PRO, currency: "usd", unit_amount: 1500 }));
  ck("the right price in the wrong currency is refused", r.patch, { payment_past_due: false });
  const WEBHOOK = fs.readFileSync(REPO + "/api/stripe-webhook.js", "utf8");
  ck("...and the amount-inference function is still absent from the source",
     /planFromAmount/.test(WEBHOOK), false);

  console.log("\n-- checkout.session.completed: client_reference_id is not proof of ownership --");
  const checkout = (profileId, customerId, line) => ({
    id: "evt_co", type: "checkout.session.completed",
    data: {
      object: {
        client_reference_id: profileId, customer: customerId,
        metadata: { golsz_plan: "pro" },
        ...(line ? { line_items: { data: [{ price: line }] } } : {}),
      },
    },
  });

  profiles = { [OWNER_ID]: { id: OWNER_ID, stripe_customer_id: null } };
  r = await post(checkout(OWNER_ID, CUSTOMER));
  // Stripe does NOT expand line_items in a webhook payload, so the usual
  // checkout event carries metadata but no Price — and metadata alone cannot
  // validate the money, so no plan resolves. Binding the customer is the
  // whole job of this event; customer.subscription.created follows with the
  // real Price and sets the plan. Asserting the plan here would have been
  // asserting a shape Stripe never sends.
  ck("an UNCLAIMED profile is bound, with no plan guessed from metadata alone",
     r.patch, { stripe_customer_id: CUSTOMER, payment_past_due: false });
  ck("...by profile id, since this is the only event carrying one", r.filter, `id=eq.${OWNER_ID}`);
  ck("...after actually reading the row first", r.lookups.length, 1);

  profiles = { [OWNER_ID]: { id: OWNER_ID, stripe_customer_id: null } };
  r = await post(checkout(OWNER_ID, CUSTOMER, PRO_PRICE));
  ck("...and when a Price IS present, the plan is set alongside the binding",
     r.patch, { stripe_customer_id: CUSTOMER, payment_past_due: false, plan: "pro" });

  profiles = { [OWNER_ID]: { id: OWNER_ID, stripe_customer_id: CUSTOMER } };
  r = await post(checkout(OWNER_ID, CUSTOMER));
  ck("the same customer checking out again is still allowed (renewal / upgrade)",
     r.patch, { stripe_customer_id: CUSTOMER, payment_past_due: false });

  // THE ATTACK: open the public Payment Link with someone else's uuid in
  // ?client_reference_id and pay with your own card. Before the ownership
  // check this wrote the attacker's customer id over the victim's profile —
  // after which the victim's renewals no longer matched anything, and the
  // attacker cancelling their own cheap subscription fired
  // customer.subscription.deleted straight at the victim's row.
  profiles = { [VICTIM_ID]: { id: VICTIM_ID, stripe_customer_id: CUSTOMER } };
  r = await post(checkout(VICTIM_ID, ATTACKER));
  ck("a profile owned by ANOTHER Stripe customer is not written to", r.patches.length, 0);
  ck("...the attempt is recorded rather than swallowed", r.errorLogs.length, 1);
  ck("...and Stripe still gets its 200 (a 500 would only make it retry)", r.status, 200);
  ck("...the victim's binding is untouched", profiles[VICTIM_ID].stripe_customer_id, CUSTOMER);

  profiles = {};
  r = await post(checkout(UNKNOWN_ID, CUSTOMER));
  ck("a well-formed uuid matching no profile writes nothing", r.patches.length, 0);
  ck("...and is logged, rather than being a silent zero-row PATCH", r.errorLogs.length, 1);

  r = await post(checkout("not-a-uuid&select=*", CUSTOMER));
  ck("a non-UUID client_reference_id never reaches a query at all", r.lookups.length, 0);
  ck("...and writes nothing", r.patches.length, 0);

  console.log("\n-- signature verification --");
  // Same reason as above: these care about the SIGNATURE being accepted, but
  // acceptance now requires the write to succeed, and the write needs a target.
  profiles = { [OWNER_ID]: { id: OWNER_ID, stripe_customer_id: CUSTOMER } };
  const good = subEvent("active", PRO_PRICE);
  r = await post(good, { secrets: [SECRET] });
  ck("a single correct v1 is accepted", r.status, 200);

  // SECRET ROTATION. Stripe signs with BOTH secrets and sends two v1 entries.
  // Object.fromEntries() kept only the LAST, so whichever secret happened to
  // land second was the only one that could verify, and every genuine event
  // signed under the other was 400'd for the whole rotation window.
  r = await post(good, { secrets: [SECRET, OLD_SECRET] });
  ck("rotation: current secret first, old one second -> accepted", r.status, 200);
  r = await post(good, { secrets: [OLD_SECRET, SECRET] });
  ck("rotation: old secret first, current second -> accepted", r.status, 200);
  r = await post(good, { secrets: [OLD_SECRET, OLD_SECRET, SECRET] });
  ck("three candidates, only the last correct -> accepted", r.status, 200);
  r = await post(good, { secrets: [SECRET, OLD_SECRET] });
  ck("...and a rotation event still performs its write", r.patches.length, 1);

  r = await post(good, { secrets: [OLD_SECRET] });
  ck("a wrong secret is still rejected", r.status, 400);
  ck("...with nothing written", r.patches.length, 0);
  r = await post(good, { secrets: [OLD_SECRET, "whsec_also_wrong"] });
  ck("two wrong candidates are still rejected", r.status, 400);

  r = await post(good, { ts: Math.floor(Date.now() / 1000) - 3600 });
  ck("a signature older than the 5-minute tolerance is rejected", r.status, 400);
  r = await post(good, { sig: "" });
  ck("a missing signature header is rejected", r.status, 400);
  const rawGood = JSON.stringify(good);
  r = await post(good, { sig: `v1=${hmac(SECRET, 0, rawGood)}` });
  ck("a signature with no timestamp is rejected", r.status, 400);
  r = await post(good, { sig: `t=notanumber,v1=${hmac(SECRET, "notanumber", rawGood)}` });
  ck("a non-numeric timestamp is rejected (NaN > 300 is false, so this needed an explicit check)", r.status, 400);
  r = await post(good, { sig: `t=${Math.floor(Date.now() / 1000)}` });
  ck("a timestamp with no v1 at all is rejected", r.status, 400);
  r = await post(good, { sig: `t=${Math.floor(Date.now() / 1000)},v1=` });
  ck("an empty v1 value is rejected", r.status, 400);

  // Tampering: a valid signature over a DIFFERENT body.
  {
    calls = [];
    const ts = Math.floor(Date.now() / 1000);
    const sig = `t=${ts},v1=${hmac(SECRET, ts, JSON.stringify(subEvent("active", PRO_PRICE)))}`;
    const res = mkRes();
    await handler(mkReq(JSON.stringify(subEvent("canceled", PRO_PRICE)), sig), res);
    ck("a signature that does not cover THIS body is rejected", res.statusCode, 400);
    ck("...and no downgrade was written", calls.filter((c) => c.method === "PATCH").length, 0);
  }

  console.log("\n-- method and unknown event types --");
  {
    const res = mkRes();
    await handler({ method: "GET", headers: {} }, res);
    ck("GET is refused", res.statusCode, 405);
  }
  r = await post({ id: "evt_x", type: "customer.updated", data: { object: {} } });
  ck("an unsubscribed event type is a clean 200 with no writes", [r.status, r.patches.length], [200, 0]);
  r = await post(good, { sig: `t=${Math.floor(Date.now() / 1000)},v1=${hmac(SECRET, Math.floor(Date.now() / 1000), "{not json")}` });
  ck("a body that is not JSON is rejected", r.status, 400);

  console.log("\n-- a write that does not land must not be reported as success --");
  // The audit's headline finding, in two parts. Both ended with an athlete
  // paying and not getting their plan, and neither produced a log line:
  //   (1) `await fetch()` RESOLVES on 4xx/5xx - it only rejects on a network
  //       failure. patchProfile ignored r.ok, so a rejected write returned 200
  //       to Stripe, and Stripe never retries a 200.
  //   (2) `Prefer: return=minimal` answers 204 for a PATCH matching ZERO rows,
  //       which is indistinguishable from 204 for a successful one. An event
  //       for a customer with no linked profile updated nothing, silently.
  // The 500 is the whole point: the handler's catch already returned 500, and
  // Stripe already retries a 500. That machinery existed and was unreachable
  // because nothing ever threw.
  {
    // Positive control FIRST, so a 500 below means "the write failed" and not
    // "this fixture was broken all along" - which is exactly how (2) hid here.
    profiles = { [OWNER_ID]: { id: OWNER_ID, stripe_customer_id: CUSTOMER } };
    r = await post(subEvent("active", PRO_PRICE));
    ck("control: with the profile present the event is a 200", r.status, 200);

    profiles = {};
    r = await post(subEvent("active", PRO_PRICE));
    ck("a PATCH matching zero rows is a 500, so Stripe retries", r.status, 500);

    profiles = { [OWNER_ID]: { id: OWNER_ID, stripe_customer_id: CUSTOMER } };
    patchHttpStatus = 400;
    r = await post(subEvent("active", PRO_PRICE));
    ck("a 4xx from PostgREST is a 500, not a swallowed 200", r.status, 500);
    patchHttpStatus = 0;

    // Both failures above are only meaningful if the hook actually turned off:
    // a stuck hook would make every later assertion in this file "pass" by
    // failing, which is the same shape as the bug being tested.
    r = await post(subEvent("active", PRO_PRICE));
    ck("...and a 200 returns once the failure is removed", r.status, 200);
  }

  console.log("\n-- this suite tests the shipping handler, not a copy --");
  // Anchored to column 0 so the quoted snippet in this file's header (which
  // is indented inside a comment, and is the whole point of the header) does
  // not count as the suite having reintroduced a copy.
  ck("no local reimplementation of the decision path",
     /^function (decideSubscriptionUpdatePatch|planFromAmount)\(/m.test(fs.readFileSync(__filename, "utf8")), false);
  ck("the handler under test is the real export", typeof handler, "function");

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error("FAIL  suite threw:", e); process.exit(1); });
