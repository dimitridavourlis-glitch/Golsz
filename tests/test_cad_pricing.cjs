// CAD pricing alignment (2026-08-10): Free C$0 · Basic C$10 · Pro C$24 ·
// Elite C$48, replacing USD 0/6/14/30.
//
// The load-bearing assertion in here is the LAST section: a currency change
// must not move a single entitlement. Price and access are separate concerns
// in this codebase (PLANS.price vs FEATURE_MIN_PLAN / PLAN_RANK / the daily
// allowances), and this suite exists to keep them separate.
//
// The second real risk is api/stripe-webhook.js: Payment Links carry no
// metadata, so the plan a customer gets is inferred from the amount they
// paid. Leave those thresholds at USD levels and a real C$24 payment grants
// Basic instead of Pro — or, at C$10, nothing at all.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const HOME = fs.readFileSync(REPO + "/index.html", "utf8");
const WEBHOOK = fs.readFileSync(REPO + "/api/stripe-webhook.js", "utf8");
const MIG = fs.readFileSync(REPO + "/supabase-migration-117-cad-pricing.sql", "utf8");

const slice = (from, to) => APP.slice(APP.indexOf(from), APP.indexOf(to));
// Direct eval LEAKS function declarations into this scope but not consts,
// so planPrice arrives on its own and only PRICE_CURRENCY needs extracting.
// Destructuring planPrice here too would collide with the leaked function.
eval(slice("const PRICE_CURRENCY =", "const VAPID_PUBLIC_KEY") +
  "\nfunction __c() { return { PRICE_CURRENCY }; }");
const { PRICE_CURRENCY } = __c();
eval(slice("const PLANS = [", "\n// Supabase client") + "\nfunction __p() { return PLANS; }");
const PLANS = __p();
eval(slice("const FEATURE_MIN_PLAN = {", "function hasFeature(") + "\nfunction __f() { return FEATURE_MIN_PLAN; }");
const FEATURE_MIN_PLAN = __f();
// planFromAmount lives in the webhook, not the client — pull it from there.
eval(WEBHOOK.slice(WEBHOOK.indexOf("function planFromAmount("), WEBHOOK.indexOf("async function patchProfile")));

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const EXPECTED = { free: 0, starter: 10, pro: 24, elite: 48 };

console.log("-- the official CAD prices --");
ck("PLANS carries exactly the four tiers", PLANS.map((x) => x.id), ["free", "starter", "pro", "elite"]);
for (const [id, price] of Object.entries(EXPECTED)) {
  ck(`${id} is C$${price}`, PLANS.find((x) => x.id === id).price, price);
}
ck("no old USD/EUR amount survives in PLANS",
   PLANS.map((x) => x.price).filter((v) => [6, 14, 15, 30].includes(v)), []);

console.log("\n-- one formatter owns the currency --");
ck("the symbol is C$", PRICE_CURRENCY, "C$");
ck("planPrice formats correctly", [planPrice(0), planPrice(10), planPrice(24), planPrice(48)],
   ["C$0", "C$10", "C$24", "C$48"]);
// Five render sites: settings picker, two upgrade sheets, the signup CTA
// and the signup plan card. A raw "$" + price anywhere means one of them
// drifted back.
ck("every render site goes through planPrice()", (APP.match(/planPrice\(/g) || []).length >= 6, true);
ck("no raw dollar concatenation remains", /"\$" \+ (pl|selected)\.price/.test(APP), false);
ck("...and no interpolated bare price", /\$\{pl\.price\}\/mo/.test(APP), false);

console.log("\n-- prices are fixed, never converted --");
ck("nothing does FX conversion", /exchange[_ ]?rate|convertCurrency|fx[Rr]ate|toLocaleString\(.*currency/i.test(APP), false);
ck("the constant says so", /NOT converted from|not converted from/.test(APP), true);

console.log("\n-- the webhook maps a CAD payment to the right plan --");
// Amounts are Stripe minor units (cents).
ck("C$10.00 -> starter", planFromAmount(1000), "starter");
ck("C$24.00 -> pro", planFromAmount(2400), "pro");
ck("C$48.00 -> elite", planFromAmount(4800), "elite");
ck("C$0 -> no plan", planFromAmount(0), null);
ck("below the Basic floor -> no plan", planFromAmount(999), null);
// The old USD thresholds would have mapped these wrongly; these assertions
// are the regression.
ck("C$24 is NOT downgraded to starter (the old 1400 threshold bug)", planFromAmount(2400) === "starter", false);
ck("C$48 is NOT downgraded to pro", planFromAmount(4800) === "pro", false);
ck("C$10 is no longer read as elite/pro", ["elite", "pro"].includes(planFromAmount(1000)), false);
// Tax or a small rise inside a tier must not drop someone a tier.
ck("C$27.12 (Pro + tax) still resolves to pro", planFromAmount(2712), "pro");
ck("bands are checked highest-first", planFromAmount(99999), "elite");

console.log("\n-- the homepage shows the same numbers --");
const prices = [...HOME.matchAll(/<p class="plan-price">([^<]*(?:<small>[^<]*<\/small>)?)/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, "").trim());
ck("four price labels", prices.length, 4);
ck("they read C$0 / C$10 / C$24 / C$48", prices, ["C$0", "C$10/mo", "C$24/mo", "C$48/mo"]);
ck("no EUR symbol survives on the homepage", /&euro;|€/.test(HOME), false);
ck("currency is labelled for international visitors", /All prices in Canadian dollars \(CAD\)/.test(HOME), true);
ck("...and repeated near the CTA", /All prices in CAD/.test(HOME), true);
ck("Pro is still the featured plan", /class="card plan is-featured/.test(HOME), true);

console.log("\n-- the in-app currency note is localised --");
for (const lang of ["en", "fr", "es", "el"]) {
  const i = APP.indexOf("\n  " + lang + ": {");
  ck(`${lang} defines prices_cad_note`, APP.slice(i, i + 60000).includes("prices_cad_note:"), true);
}
ck("it renders in the app (settings, upgrade sheets, signup)",
   (APP.match(/t\("prices_cad_note"\)/g) || []).length >= 4, true);

console.log("\n-- ENTITLEMENTS DID NOT MOVE --");
// This is the whole point of the exercise: currency and price only.
ck("feature gates unchanged", FEATURE_MIN_PLAN, {
  pdf_export: "starter", readiness: "pro", targets: "starter",
  benchmarks: "starter", development_plan: "pro", pathway_plan: "starter",
});
ck("plan ids unchanged (the DB enum depends on these)",
   PLANS.map((x) => x.id), ["free", "starter", "pro", "elite"]);
ck("display names unchanged", PLANS.map((x) => x.name), ["Free", "Basic", "Pro", "Elite"]);
ck("feature-key lists unchanged in length", PLANS.map((x) => x.featKeys.length), [4, 4, 6, 2]);
// Daily Scout allowances live in api/scout.js env defaults.
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
ck("Scout daily allowances unchanged (3/8/15/20)",
   /ELITE_DAILY_LIMIT \|\| 20[\s\S]{0,200}PRO_DAILY_LIMIT \|\| 15[\s\S]{0,200}STARTER_DAILY_LIMIT \|\| 8[\s\S]{0,200}FREE_DAILY_LIMIT \|\| 3/.test(SCOUT), true);
ck("free lifetime cap still exists", /reserve_free_ai_question/.test(SCOUT), true);

console.log("\n-- migration 117 is reporting-only --");
ck("it only replaces the margin summary", (MIG.match(/create or replace function/g) || []).length, 1);
ck("...which is admin-gated", /if not is_admin\(\) then/.test(MIG), true);
ck("revenue uses the new prices", /when 'starter' then 10 when 'pro' then 24 when 'elite' then 48/.test(MIG), true);
ck("no old amounts remain in the SQL body",
   /when 'starter' then 6 |when 'pro' then 14 |when 'elite' then 30 /.test(MIG.slice(MIG.indexOf("create or replace"))), false);
ck("it touches no profile row", /update profiles|insert into profiles|delete from profiles/.test(MIG), false);
ck("it grants no new privilege beyond the existing one",
   (MIG.match(/grant execute/g) || []).length, 1);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
