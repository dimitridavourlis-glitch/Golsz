// P0-2 readiness, plus the entitlement bypass found while wiring it.
//
// Two separate things:
//
//  1. The Payment Links are still sandbox links. A test-mode Stripe page
//     shows a TEST MODE banner and rejects every real card; sending a
//     parent there is worse than saying checkout isn't ready. isLiveStripeLink
//     is the single gate that flips everything the moment real links land.
//
//  2. handle_new_user() took profiles.plan straight from client-supplied
//     signup metadata. Picking Elite — or calling signUp() directly with
//     { data: { plan: "elite" } } — granted Elite with no payment. Every
//     paywall and every AI cost control is downstream of profiles.plan, so
//     that was a complete bypass of both.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const MIG = fs.readFileSync(REPO + "/supabase-migration-116-signup-plan-is-not-a-claim.sql", "utf8");
const WEBHOOK = fs.readFileSync(REPO + "/api/stripe-webhook.js", "utf8");

const slice = (from, to) => APP.slice(APP.indexOf(from), APP.indexOf(to));
eval(slice("function isLiveStripeLink(", "const VAPID_PUBLIC_KEY"));
eval(slice("const STRIPE_LINKS = {", "// A Stripe Payment Link is test-mode") +
  "\nfunction __l() { return STRIPE_LINKS; }");
const STRIPE_LINKS = __l();
const stripeLinkForTest = (p) => (isLiveStripeLink(STRIPE_LINKS[p]) ? STRIPE_LINKS[p] : null);

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

console.log("-- the live/test gate --");
ck("a live Payment Link is accepted", isLiveStripeLink("https://buy.stripe.com/9B6cN79hvdG43i83BFbQY02"), true);
ck("a TEST Payment Link is refused", isLiveStripeLink("https://buy.stripe.com/test_9B6cN79hvdG43i83BFbQY02"), false);
ck("a non-Stripe URL is refused", isLiveStripeLink("https://example.com/pay"), false);
ck("a lookalike host is refused", isLiveStripeLink("https://buy.stripe.com.evil.tld/abc"), false);
ck("http is refused", isLiveStripeLink("http://buy.stripe.com/abc"), false);
ck("empty/null are refused", [isLiveStripeLink(""), isLiveStripeLink(null), isLiveStripeLink(undefined)], [false, false, false]);

console.log("\n-- link mode: all three must agree --");
const PAID = ["starter", "pro", "elite"];
for (const plan of PAID) {
  ck(`${plan} link is present`, typeof STRIPE_LINKS[plan], "string");
}

// THE FAILURE THIS EXISTS FOR IS THE SWITCHOVER, NOT THE CURRENT STATE.
// Going live means replacing three URLs by hand. Replace two and miss one, and
// the app does not break — stripeLinkFor() returns null for the straggler, so
// that single plan quietly shows "not available yet" while the other two sell.
// Nobody reports it, because the two they tried worked. A mixed state is the
// one arrangement that is always wrong, whichever direction it is mid-move.
const live = PAID.filter((p) => isLiveStripeLink(STRIPE_LINKS[p]));
const test = PAID.filter((p) => !isLiveStripeLink(STRIPE_LINKS[p]));
ck("no plan is left behind in the other mode", live.length === 0 || test.length === 0, true);
if (live.length && test.length) {
  console.log("   LIVE: " + live.join(", ") + "   |   STILL TEST: " + test.join(", "));
}
console.log("   current mode: " + (live.length ? "LIVE" : "test/sandbox"));

// The assertion the owner asked for, and it can only be meaningful once the
// switch has happened: with live links in place, NOTHING may still be test.
// Written as a conditional rather than a hard `=== false` so the suite stays
// truthful in both states instead of going red on the day payments start.
if (live.length) {
  ck("with live links in place, no test_ link survives",
     PAID.filter((p) => /\/test_/.test(STRIPE_LINKS[p])), []);
  ck("...and every live link is a real Stripe Payment Link",
     PAID.filter((p) => !/^https:\/\/buy\.stripe\.com\/[A-Za-z0-9]/.test(STRIPE_LINKS[p])), []);
} else {
  // Still pre-launch. Record it as a verified fact rather than letting
  // "the code exists" read as "payments work".
  ck("checkout is deliberately dark: every link is still sandbox",
     PAID.every((p) => /\/test_/.test(STRIPE_LINKS[p])), true);
  ck("...and the gate refuses all of them", PAID.map((p) => stripeLinkForTest(p)), [null, null, null]);
}
ck("every checkout entry point goes through the gate",
   (APP.match(/stripeLinkFor\(/g) || []).length >= 8, true);
ck("no entry point reads STRIPE_LINKS directly any more",
   APP.split("\n").filter((l) => /STRIPE_LINKS\[/.test(l) && !/const url = STRIPE_LINKS\[planId\]/.test(l)).length, 0);
ck("signup refuses a paid plan while checkout is dark",
   /if \(isSignup && selected\.price > 0 && !stripeLinkFor\(plan\)\) \{\s*\n\s*setErr\(t\("settings_plan_checkout_unavailable"\)\);/.test(APP), true);

console.log("\n-- migration 116: a signup cannot grant itself a plan --");
// Scoped to executable SQL only. Both the header and an in-body comment
// deliberately quote the removed line so the next reader can see what was
// wrong — those must not count as the code still doing it.
const MIG_BODY = MIG.slice(MIG.indexOf("create or replace function"));
const MIG_CODE = MIG_BODY.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
ck("the metadata plan is no longer read", /raw_user_meta_data->>'plan'/.test(MIG_CODE), false);
ck("...and the variable is gone entirely", /v_plan/.test(MIG_CODE), false);
ck("every new account is created on free", /'free'::plan_tier,/.test(MIG), true);
ck("the reason is recorded in the migration", /never an entitlement/.test(MIG), true);
// Everything else in the trigger must be untouched — a security fix that
// quietly drops minor detection or parent linking would be a worse bug.
for (const kept of [
  "v_is_minor := (date_part('year', age(v_dob)) < 18)",
  "v_occupation := nullif(new.raw_user_meta_data->>'occupation', '')",
  "v_honeypot := nullif(new.raw_user_meta_data->>'hp', '')",
  "v_trust_score := 0",
  "insert into athletes (id) values (new.id)",
  "insert into parent_links (parent_id, athlete_id, relationship)",
]) {
  ck(`preserved: ${kept.slice(0, 46)}...`, MIG.includes(kept), true);
}
ck("existing accounts are NOT silently demoted", /update profiles\s+set plan/.test(MIG), false);
ck("...and the audit query is provided instead", /where plan <> 'free' and stripe_customer_id is null/.test(MIG), true);

console.log("\n-- the webhook remains the only writer of a paid plan --");
ck("it verifies the Stripe signature first", /verifyStripeSignature\(rawBody, req\.headers\["stripe-signature"\], webhookSecret\)/.test(WEBHOOK), true);
ck("...and refuses without a secret", /Server missing STRIPE_WEBHOOK_SECRET/.test(WEBHOOK), true);
// Reworded for the plan-catalogue refactor: the checkout handler now
// always binds stripe_customer_id and adds `plan` only when a trusted
// Stripe identifier resolved one. See api/_plan-catalog.js.
ck("it binds the Stripe customer on a completed checkout",
   /patchProfile\(supaUrl, serviceKey, `id=eq\.\$\{profileId\}`, patch\)/.test(WEBHOOK), true);
ck("...and sets the plan only when one resolved", /if \(plan\) patch\.plan = plan;/.test(WEBHOOK), true);
ck("it drops back to free on cancellation", /\{ plan: "free", payment_past_due: false \}/.test(WEBHOOK), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
