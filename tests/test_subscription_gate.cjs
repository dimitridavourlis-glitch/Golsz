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
// STRIPE_LINKS is keyed by currency first now — one Payment Link per
// (currency, plan), because a Stripe subscription is locked to the currency
// it was created in and links cannot be shared across them.
const LINKS_FOR = (cur) => STRIPE_LINKS[cur] || {};
const stripeLinkForTest = (p, cur = "eur") =>
  (isLiveStripeLink(LINKS_FOR(cur)[p]) ? LINKS_FOR(cur)[p] : null);

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

console.log("-- the live/test gate --");
console.log("\n-- cancelling must be possible, and downgrading must not fake it --");
// THE BUG THIS PINS
// choosePlan("free") wrote plan:"free" straight to profiles. That removes
// ACCESS and does not touch Stripe, so a subscriber ended up on a Free-tier
// account while still being charged full price — and a monthly renewal does
// not fire customer.subscription.updated, so nothing ever put it back. The
// only warning appeared AFTER the click, and pointed at a receipt email.
// index.html promises "Cancel any time" on the same page.
{
  ck("a live portal link is accepted",
     isLivePortalLink("https://billing.stripe.com/p/login/9B6cN79hvdG4"), true);
  ck("a TEST portal link is refused",
     isLivePortalLink("https://billing.stripe.com/p/login/test_9B6cN79hvdG4"), false);
  ck("a Payment Link is not a portal link",
     isLivePortalLink("https://buy.stripe.com/9B6cN79hvdG43i83BFbQY02"), false);
  ck("a lookalike host is refused",
     isLivePortalLink("https://billing.stripe.com.evil.tld/p/login/abc"), false);
  ck("http is refused", isLivePortalLink("http://billing.stripe.com/p/login/abc"), false);
  ck("empty is refused rather than treated as a link", isLivePortalLink(""), false);
  // Configured since 2026-09-03. This previously asserted the gate returned
  // null because no live account existed; now the fact worth holding is that
  // a real portal exists, because the downgrade path below refuses to run
  // without one — an empty portal link would silently block every cancellation.
  ck("a portal link is configured", isLivePortalLink(stripePortalLink()), true);
  ck("...and it is the login-link form, not a Payment Link",
     /^https:\/\/billing\.stripe\.com\/p\/login\/[A-Za-z0-9]+$/.test(stripePortalLink() || ""), true);

  // Ordering, not adjacency: the guard must stand BETWEEN entering the "free"
  // branch and the write. Asserting the two strings merely exist would pass
  // with the guard sitting uselessly after the update.
  const fn = APP.slice(APP.indexOf("async function choosePlan("), APP.indexOf("async function choosePlan(") + 2200);
  const guard = fn.indexOf("if (stripeCustomerId)");
  const write = fn.indexOf('update({ plan: "free" })');
  ck("the free branch still performs a plan write at all", write > -1, true);
  ck("...and the billing guard exists", guard > -1, true);
  ck("...and the guard comes BEFORE the write", guard > -1 && guard < write, true);
  ck("...and it can send the user to the real portal", /stripePortalLink\(\)/.test(fn), true);
  ck("...and refuses to downgrade when no portal is configured yet",
     /settings_plan_cancel_via_stripe/.test(fn), true);

  // The signal is a Stripe customer, NOT plan !== "free" — an admin-granted
  // paid plan has no subscription behind it and must stay downgradeable.
  ck("the guard keys on a Stripe customer, not on the plan name",
     /if \(stripeCustomerId\)/.test(fn) && !/plan !== "free"/.test(fn), true);

  // The Manage-billing affordance is what makes "Cancel any time" true.
  // Structural, not proximity. The first version of this used a 400-character
  // window between the conditional and the label and failed on the button's
  // own style block — a window is a guess about formatting, not a property.
  // This asks the real question: is the label INSIDE the guard's subtree?
  const parser = require("@babel/parser");
  const mm = /<script[^>]*type=["']text\/babel(?:-deferred)?["'][^>]*>/.exec(APP);
  const CODE = APP.slice(mm.index + mm[0].length, APP.indexOf("</script>", mm.index));
  const ast = parser.parse(CODE, { sourceType: "script", plugins: ["jsx"] });
  let guardedLabels = [];
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === "LogicalExpression" && n.operator === "&&" &&
        n.left.type === "Identifier" && n.left.name === "stripeCustomerId") {
      const src = CODE.slice(n.start, n.end);
      if (src.includes("settings_plan_manage_billing")) guardedLabels.push(true);
    }
    for (const k of Object.keys(n)) if (k !== "loc" && k !== "start" && k !== "end") walk(n[k]);
  })(ast.program.body);
  ck("Manage billing sits inside a stripeCustomerId guard", guardedLabels.length, 1);
  // ...and nowhere else, so it cannot also be rendered ungated somewhere.
  ck("...and the label is used exactly once",
     (CODE.match(/t\("settings_plan_manage_billing"\)/g) || []).length, 1);
  ck("...and every language has the cancel copy",
     (APP.match(/settings_plan_cancel_via_stripe:/g) || []).length, 4);
  ck("...and the manage-billing copy", (APP.match(/settings_plan_manage_billing:/g) || []).length, 4);
}

ck("a live Payment Link is accepted", isLiveStripeLink("https://buy.stripe.com/9B6cN79hvdG43i83BFbQY02"), true);
ck("a TEST Payment Link is refused", isLiveStripeLink("https://buy.stripe.com/test_9B6cN79hvdG43i83BFbQY02"), false);
ck("a non-Stripe URL is refused", isLiveStripeLink("https://example.com/pay"), false);
ck("a lookalike host is refused", isLiveStripeLink("https://buy.stripe.com.evil.tld/abc"), false);
ck("http is refused", isLiveStripeLink("http://buy.stripe.com/abc"), false);
ck("empty/null are refused", [isLiveStripeLink(""), isLiveStripeLink(null), isLiveStripeLink(undefined)], [false, false, false]);

console.log("\n-- link mode: all three must agree --");
const PAID = ["starter", "pro", "elite"];
for (const plan of PAID) {
  for (const cur of ["eur", "cad", "usd"]) ck(`${plan} link exists for ${cur}`, typeof LINKS_FOR(cur)[plan], "string");
}

// THE FAILURE THIS EXISTS FOR IS A PARTIAL SWITCHOVER, NOT THE CURRENT STATE.
// Going live meant filling in NINE URLs by hand. Fill eight and miss one and
// the app does not break — stripeLinkFor() returns null for the straggler, so
// that one plan quietly shows "not available yet" in that one currency while
// the other eight sell. Nobody reports it, because the ones they tried worked.
// A mixed state is the one arrangement that is always wrong.
//
// This used to sample EUR only, which would have missed exactly the bug it was
// written to catch once links went per-currency: a hole in CAD or USD was
// invisible to it. It now walks all nine cells.
const CELLS = ["eur", "cad", "usd"].flatMap((c) => PAID.map((p) => ({ c, p, url: LINKS_FOR(c)[p] })));
ck("nine cells, one per (plan, currency)", CELLS.length, 9);
const liveCells = CELLS.filter((x) => isLiveStripeLink(x.url));
const darkCells = CELLS.filter((x) => !isLiveStripeLink(x.url));
ck("no cell is left behind in the other mode", liveCells.length === 0 || darkCells.length === 0, true);
if (liveCells.length && darkCells.length) {
  console.log("   LIVE: " + liveCells.map((x) => `${x.p}/${x.c}`).join(", ") +
              "   |   NOT LIVE: " + darkCells.map((x) => `${x.p}/${x.c}`).join(", "));
}
console.log("   current mode: " + (liveCells.length ? "LIVE" : "dark"));

// Live since 2026-09-03, so this is now asserted outright rather than behind an
// `if (live.length)`. Going dark again would be a regression, and the suite
// should go red for it rather than quietly switching to congratulating itself
// on a pre-launch invariant that no longer describes the product.
ck("checkout is live in every currency", darkCells.map((x) => `${x.p}/${x.c}`), []);
ck("no test_ link survives anywhere",
   CELLS.filter((x) => /\/test_/.test(x.url || "")).map((x) => `${x.p}/${x.c}`), []);
ck("every link is a real Stripe Payment Link",
   CELLS.filter((x) => !/^https:\/\/buy\.stripe\.com\/[A-Za-z0-9]/.test(x.url || ""))
     .map((x) => `${x.p}/${x.c}`), []);
// Nine distinct URLs. Reusing one across two cells would bill in the wrong
// currency or grant the wrong plan, and every check above would still pass.
ck("all nine links are distinct", new Set(CELLS.map((x) => x.url)).size, 9);
// The gate is what the app actually calls, so assert through it too, not just
// against the raw table.
ck("...and the gate returns all nine",
   CELLS.map((x) => stripeLinkForTest(x.p, x.c)).filter(Boolean).length, 9);
ck("every checkout entry point goes through the gate",
   (APP.match(/stripeLinkFor\(/g) || []).length >= 8, true);
// The single permitted read is inside stripeLinkFor() itself, which now
// indexes by currency first.
ck("no entry point reads STRIPE_LINKS directly any more",
   APP.split("\n").filter((l) => /STRIPE_LINKS\[/.test(l) && !/const url = \(STRIPE_LINKS\[cur\]/.test(l)).length, 0);
ck("signup refuses a paid plan while checkout is dark",
   /if \(isSignup && selected\.price > 0 && !stripeLinkFor\(plan, currency\)\) \{\s*\n\s*setErr\(t\("settings_plan_checkout_unavailable"\)\);/.test(APP), true);

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
