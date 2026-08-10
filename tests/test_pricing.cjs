// EUR pricing alignment (2026-08-10): Free EUR 0 · Basic EUR 6 · Pro EUR 15
// · Elite EUR 30. This is the final pricing; it replaced a short-lived CAD
// 0/10/24/48 set, which had replaced USD 0/6/14/30.
//
// The load-bearing assertion in here is the LAST section: a currency change
// must not move a single entitlement. Price and access are separate concerns
// in this codebase (PLANS.price vs FEATURE_MIN_PLAN / PLAN_RANK / the daily
// allowances), and this suite exists to keep them separate.
//
// The second real risk is drift BETWEEN price locations. A plan price lives
// in four places, and the CAD change updated three of them: plan_config kept
// the original USD figures, and api/scout.js reads that table to build
// Scout's product knowledge, so the AI quoted "Basic ($6/mo)" to athletes
// while the homepage said C$10. Nothing caught it. The "ALL FOUR PRICE
// LOCATIONS AGREE" section below exists so that cannot happen again.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const HOME = fs.readFileSync(REPO + "/index.html", "utf8");
const WEBHOOK = fs.readFileSync(REPO + "/api/stripe-webhook.js", "utf8");
const MIG = fs.readFileSync(REPO + "/supabase-migration-120-eur-pricing.sql", "utf8");

const slice = (from, to) => APP.slice(APP.indexOf(from), APP.indexOf(to));
// Direct eval LEAKS function declarations into this scope but not consts,
// so planPrice arrives on its own and only PRICE_CURRENCY needs extracting.
// Destructuring planPrice here too would collide with the leaked function.
eval(slice("const PRICE_CURRENCY =", "const VAPID_PUBLIC_KEY") +
  "\nfunction __c() { return { PRICE_CURRENCY }; }");
const { PRICE_CURRENCY } = __c();
eval(slice("const STRIPE_LINKS = {", "// A Stripe Payment Link is test-mode") + "\nfunction __sl() { return STRIPE_LINKS; }");
const STRIPE_LINKS_LIVE = __sl();
eval(slice("const PLANS = [", "\n// Supabase client") + "\nfunction __p() { return PLANS; }");
const PLANS = __p();
eval(slice("const FEATURE_MIN_PLAN = {", "function hasFeature(") + "\nfunction __f() { return FEATURE_MIN_PLAN; }");
const FEATURE_MIN_PLAN = __f();

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const EXPECTED = { free: 0, starter: 6, pro: 15, elite: 30 };

console.log("-- the official EUR prices --");
ck("PLANS carries exactly the four tiers", PLANS.map((x) => x.id), ["free", "starter", "pro", "elite"]);
for (const [id, price] of Object.entries(EXPECTED)) {
  ck(`${id} is EUR ${price}`, PLANS.find((x) => x.id === id).price, price);
}
// 6 and 30 are now VALID EUR prices, so only the amounts that belong to no
// current tier can be treated as stale: the CAD set and USD's Pro.
ck("no superseded CAD/USD amount survives in PLANS",
   PLANS.map((x) => x.price).filter((v) => [10, 24, 48, 14].includes(v)), []);

console.log("\n-- one formatter owns the currency --");
ck("the symbol is the euro sign", PRICE_CURRENCY, "\u20AC");
ck("planPrice formats correctly", [planPrice(0), planPrice(6), planPrice(15), planPrice(30)],
   ["\u20AC0", "\u20AC6", "\u20AC15", "\u20AC30"]);
// Five render sites: settings picker, two upgrade sheets, the signup CTA
// and the signup plan card. A raw "$" + price anywhere means one of them
// drifted back.
ck("every render site goes through planPrice()", (APP.match(/planPrice\(/g) || []).length >= 6, true);
ck("no raw dollar concatenation remains", /"\$" \+ (pl|selected)\.price/.test(APP), false);
ck("...and no interpolated bare price", /\$\{pl\.price\}\/mo/.test(APP), false);

console.log("\n-- prices are fixed, never converted --");
ck("nothing does FX conversion", /exchange[_ ]?rate|convertCurrency|fx[Rr]ate|toLocaleString\(.*currency/i.test(APP), false);
ck("the constant says so", /NOT converted from|not converted from/.test(APP), true);

// The old "-- the webhook maps a CAD payment to the right plan --" block
// tested planFromAmount(), which no longer exists: deciding the plan from
// the amount paid was the fragility this refactor removed. Its replacement
// is the much stricter "PLAN IDENTITY COMES FROM STRIPE" section below,
// which covers the same ground and adds the currency and unknown-identifier
// cases amount-inference could never express.

console.log("\n-- the homepage shows the same numbers --");
const prices = [...HOME.matchAll(/<p class="plan-price">([^<]*(?:<small>[^<]*<\/small>)?)/g)]
  .map((m) => m[1].replace(/<[^>]+>/g, "").trim());
ck("four price labels", prices.length, 4);
ck("they read 0 / 6 / 15 / 30 in euro", prices.map((x) => x.replace(/&euro;/g, "\u20AC")),
   ["\u20AC0", "\u20AC6/mo", "\u20AC15/mo", "\u20AC30/mo"]);
ck("no CAD symbol survives on the homepage", /C\$\d/.test(HOME), false);
ck("currency is labelled for international visitors", /All prices in euro \(EUR\)/.test(HOME), true);
ck("Pro is still the featured plan", /class="card plan is-featured/.test(HOME), true);

console.log("\n-- the in-app currency note is localised --");
for (const lang of ["en", "fr", "es", "el"]) {
  const i = APP.indexOf("\n  " + lang + ": {");
  ck(`${lang} defines prices_currency_note`, APP.slice(i, i + 60000).includes("prices_currency_note:"), true);
}
ck("it renders in the app (settings, upgrade sheets, signup)",
   (APP.match(/t\("prices_currency_note"\)/g) || []).length >= 4, true);

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
// The cap value lives in api/scout.js as the FREE_LIFETIME_LIMIT env
// default, NOT in migration 068 (whose RPC takes it as a parameter). This
// is the number that actually gates a free athlete's 41st ever question.
ck("free lifetime cap is still 40",
   /const freeLifetimeLimit = Number\(process\.env\.FREE_LIFETIME_LIMIT \|\| 40\)/.test(SCOUT), true);
ck("...and scout.js still passes a lifetime limit through", /p_lifetime_limit/.test(SCOUT), true);

console.log("\n-- Admin MRR uses the EUR prices --");
// It hardcoded 6/14/30 and silently under-reported by ~60% after the
// currency move. It now derives from PLANS, so it cannot go stale again.
ck("MRR derives from PLANS, not literals",
   /PLANS\.reduce\(\(sum, pl\) => sum \+ pl\.price \* \(planCounts\[pl\.id\] \|\| 0\), 0\)/.test(APP), true);
ck("no hardcoded 6/14/30 remains in the MRR calc",
   /planCounts\.starter \* 6|planCounts\.pro \* 14|planCounts\.elite \* 30/.test(APP), false);
ck("MRR renders with the currency symbol", /PRICE_CURRENCY \+ analytics\.mrrEstimate/.test(APP), true);
// Same figures, computed independently, as a arithmetic check.
const counts = { free: 5, starter: 3, pro: 2, elite: 1 };
const mrr = PLANS.reduce((sum, pl) => sum + pl.price * (counts[pl.id] || 0), 0);
ck("3 Basic + 2 Pro + 1 Elite = EUR 78", mrr, 3 * 6 + 2 * 15 + 1 * 30);

console.log("\n-- migration 120 moves money, never entitlements --");
ck("it only replaces the margin summary", (MIG.match(/create or replace function/g) || []).length, 1);
ck("...which is admin-gated", /if not is_admin\(\) then/.test(MIG), true);
ck("revenue uses the new prices", /when 'starter' then 6 when 'pro' then 15 when 'elite' then 30/.test(MIG), true);
ck("no superseded amounts remain in the SQL body",
   /when 'starter' then 10 |when 'pro' then 24 |when 'pro' then 14 |when 'elite' then 48 /.test(MIG.slice(MIG.indexOf("create or replace"))), false);
ck("the mislabelled price_usd column is renamed", /rename column price_usd to price_eur/.test(MIG), true);
ck("...and plan_config is seeded with the same numbers",
   /set price_eur = 0  where plan_id = 'free'[\s\S]*set price_eur = 6  where plan_id = 'starter'[\s\S]*set price_eur = 15 where plan_id = 'pro'[\s\S]*set price_eur = 30 where plan_id = 'elite'/.test(MIG), true);
ck("it touches no profile row", /update profiles|insert into profiles|delete from profiles/.test(MIG), false);
ck("it grants no new privilege", (MIG.match(/grant execute/g) || []).length, 0);


console.log("\n-- PLAN IDENTITY COMES FROM STRIPE, NOT FROM MONEY --");
// The refactor: api/_plan-catalog.js resolves a plan from a trusted Stripe
// identifier, then validates currency and unit amount separately. Neither
// half can grant a plan alone.
const CAT = fs.readFileSync(REPO + "/api/_plan-catalog.js", "utf8");
const catalog = require(REPO + "/tests/_catalog-bridge.cjs");
const { resolvePlanFromStripe, PLAN_CATALOG, EXPECTED_CURRENCY, readPriceFields } = catalog;

// A fake env standing in for configured live Price ids. Nothing real is
// committed anywhere — the repo ships with these unset.
const ENV = {
  STRIPE_PRICE_BASIC: "price_TESTbasic0000000",
  STRIPE_PRICE_PRO:   "price_TESTpro00000000",
  STRIPE_PRICE_ELITE: "price_TESTelite000000",
};
const R = (o) => resolvePlanFromStripe(o, ENV);

ck("catalogue holds exactly the three paid tiers", PLAN_CATALOG.map((e) => e.plan), ["starter", "pro", "elite"]);
ck("catalogue amounts are the EUR prices in minor units", PLAN_CATALOG.map((e) => e.unitAmount), [600, 1500, 3000]);
ck("expected currency is EUR", EXPECTED_CURRENCY, "eur");
ck("'free' is never grantable from Stripe", PLAN_CATALOG.some((e) => e.plan === "free"), false);

console.log("\n-- a correct Price resolves --");
ck("Basic by price id", R({ priceId: ENV.STRIPE_PRICE_BASIC, currency: "eur", unitAmount: 600 }).plan, "starter");
ck("Pro by price id", R({ priceId: ENV.STRIPE_PRICE_PRO, currency: "eur", unitAmount: 1500 }).plan, "pro");
ck("Elite by price id", R({ priceId: ENV.STRIPE_PRICE_ELITE, currency: "eur", unitAmount: 3000 }).plan, "elite");
ck("...and reports how it matched", R({ priceId: ENV.STRIPE_PRICE_PRO, currency: "eur", unitAmount: 1500 }).matchedBy, "price_id");
ck("lookup_key resolves when the id is unknown",
   R({ priceId: "price_somethingElse", lookupKey: "golsz_pro_eur_monthly", currency: "eur", unitAmount: 1500 }).plan, "pro");
ck("explicit metadata resolves as a last resort",
   R({ metadataPlan: "elite", currency: "eur", unitAmount: 3000 }).plan, "elite");
ck("uppercase currency from Stripe is accepted",
   R({ priceId: ENV.STRIPE_PRICE_BASIC, currency: "EUR", unitAmount: 600 }).plan, "starter");

console.log("\n-- AN INCORRECT CURRENCY CANNOT GRANT A PLAN --");
for (const cur of ["usd", "cad", "gbp", "aud", "", null, undefined, 42]) {
  ck(`currency ${JSON.stringify(cur)} is refused`,
     R({ priceId: ENV.STRIPE_PRICE_PRO, currency: cur, unitAmount: 1500 }).plan, null);
}
ck("...and the reason names the mismatch",
   R({ priceId: ENV.STRIPE_PRICE_PRO, currency: "usd", unitAmount: 1500 }).reason, "configuration_mismatch");
ck("...naming the offending currency", R({ priceId: ENV.STRIPE_PRICE_PRO, currency: "usd", unitAmount: 1500 }).problems, ["currency:usd"]);
// The old bug in one line: 3000 units of anything used to mean Elite.
ck("3000 USD does NOT grant Elite", R({ priceId: ENV.STRIPE_PRICE_ELITE, currency: "usd", unitAmount: 3000 }).plan, null);
ck("...and 3000 CAD does not either", R({ priceId: ENV.STRIPE_PRICE_ELITE, currency: "cad", unitAmount: 3000 }).plan, null);

console.log("\n-- AN INCORRECT AMOUNT CANNOT GRANT A PLAN --");
for (const amt of [0, 1, 599, 601, 1499, 1501, 2999, 100000, -1500]) {
  ck(`Pro price at ${amt} is refused`, R({ priceId: ENV.STRIPE_PRICE_PRO, currency: "eur", unitAmount: amt }).plan, null);
}
for (const amt of [null, undefined, NaN, "1500"]) {
  ck(`non-numeric amount ${JSON.stringify(amt)} is refused`,
     R({ priceId: ENV.STRIPE_PRICE_PRO, currency: "eur", unitAmount: amt }).plan, null);
}
ck("a missing amount is a problem, not a pass",
   R({ priceId: ENV.STRIPE_PRICE_PRO, currency: "eur" }).problems, ["amount:missing"]);
// Cross-wired configuration: right plan id, another plan's money.
ck("Basic's price id with Pro's amount is refused",
   R({ priceId: ENV.STRIPE_PRICE_BASIC, currency: "eur", unitAmount: 1500 }).plan, null);

console.log("\n-- AN UNKNOWN IDENTIFIER CANNOT GRANT A PLAN --");
for (const id of ["price_unknown123", "prod_notAPrice", "", null, "price_"]) {
  ck(`unknown price id ${JSON.stringify(id)} is refused`,
     R({ priceId: id, currency: "eur", unitAmount: 1500 }).plan, null);
}
ck("a perfectly valid amount alone grants nothing",
   R({ currency: "eur", unitAmount: 1500 }).plan, null);
ck("...with reason unknown_price_or_plan", R({ currency: "eur", unitAmount: 3000 }).reason, "unknown_price_or_plan");
ck("an unknown lookup_key is refused", R({ lookupKey: "golsz_platinum", currency: "eur", unitAmount: 1500 }).plan, null);
ck("metadata naming a non-plan is refused", R({ metadataPlan: "admin", currency: "eur", unitAmount: 1500 }).plan, null);
ck("metadata cannot conjure 'free'", R({ metadataPlan: "free", currency: "eur", unitAmount: 0 }).plan, null);
// With nothing configured (today's real state) nothing resolves by id.
ck("with NO env configured, a price id resolves nothing",
   resolvePlanFromStripe({ priceId: "price_TESTpro00000000", currency: "eur", unitAmount: 1500 }, {}).plan, null);

console.log("\n-- the webhook uses it, and no longer infers from money --");
ck("planFromAmount is gone", /planFromAmount/.test(WEBHOOK), false);
ck("the catalogue is imported", /from "\.\/_plan-catalog\.js"/.test(WEBHOOK), true);
ck("amount_total is never used to choose a plan", /planFrom|resolvePlan\w*\(.*amount_total/.test(WEBHOOK), false);
ck("subscription.created is handled (it carries the Price)", /customer\.subscription\.created/.test(WEBHOOK), true);
ck("the customer id is bound even when the plan is unresolved",
   /Bind the Stripe customer to the profile ALWAYS/.test(WEBHOOK), true);
ck("an unconfigured catalogue is logged loudly", /stripe catalog NOT configured/.test(WEBHOOK), true);
ck("no live Stripe ids are committed", /price_[A-Za-z0-9]{10,}/.test(CAT), false);
ck("price ids come from env", /STRIPE_PRICE_BASIC|STRIPE_PRICE_PRO|STRIPE_PRICE_ELITE/.test(CAT), true);

console.log("\n-- readPriceFields pulls the right things --");
ck("reads a Stripe price object",
   readPriceFields({ id: "price_x", lookup_key: "k", currency: "eur", unit_amount: 1500 }),
   { priceId: "price_x", lookupKey: "k", currency: "eur", unitAmount: 1500 });
ck("survives a missing price", readPriceFields(null), {});
ck("...and a malformed one", readPriceFields({ id: 5, unit_amount: "1500" }), { priceId: null, lookupKey: null, currency: null, unitAmount: null });

console.log("\n-- checkout stays disabled until live EUR Stripe exists --");
ck("all three links are still test-mode", ["starter", "pro", "elite"].every((k) => /\/test_/.test(STRIPE_LINKS_LIVE[k])), true);
ck("the gate keeps them dark", /function stripeLinkFor/.test(APP), true);

console.log("\n-- tier naming is consistent in the legal copy --");
const TERMS = fs.readFileSync(REPO + "/terms.html", "utf8");
ck("terms no longer says 'Starter'", /Starter/.test(TERMS), false);
ck("terms names the four current tiers", /Free, Basic, Pro and Elite/.test(TERMS), true);
ck("...and states the billing currency", /euro \(EUR\)/.test(TERMS), true);

console.log("\n-- ALL FOUR PRICE LOCATIONS AGREE --");
// The audit finding this section exists to prevent: a plan price lives in
// four independent places, the CAD change updated three, and plan_config
// silently kept USD figures that api/scout.js then quoted to athletes as
// GOLSZ's real prices. Diffing three of four is what let that through, so
// this derives all four from their actual source text and compares them.
//
//   1. golsz-app.html  PLANS[].price          — what the UI renders
//   2. api/_plan-catalog.js PLAN_CATALOG[]    — what the Stripe webhook trusts (minor units)
//   3. migration 120 plan_config seed         — what Scout tells athletes
//   4. migration 120 margin-summary CASE      — what the Admin MRR card computes
const TIERS = ["free", "starter", "pro", "elite"];

// 1. the client
const fromPLANS = Object.fromEntries(PLANS.map((x) => [x.id, x.price]));

// 2. the server catalogue, converted out of minor units
const fromCatalog = { free: 0 };
for (const e of PLAN_CATALOG) fromCatalog[e.plan] = e.unitAmount / 100;

// 3. the plan_config seed in the migration
const fromPlanConfig = {};
for (const m of MIG.matchAll(/set price_eur = (\d+)\s+where plan_id = '(\w+)'/g)) {
  fromPlanConfig[m[2]] = Number(m[1]);
}

// 4. the margin-summary CASE expression (free is the implicit else 0)
const fromMarginSQL = { free: 0 };
const caseSrc = MIG.slice(MIG.indexOf("create or replace function"));
for (const m of caseSrc.matchAll(/when '(\w+)' then (\d+)/g)) {
  fromMarginSQL[m[1]] = Number(m[2]);
}

ck("1. golsz-app.html PLANS", TIERS.map((t) => fromPLANS[t]), [0, 6, 15, 30]);
ck("2. api/_plan-catalog.js PLAN_CATALOG", TIERS.map((t) => fromCatalog[t]), [0, 6, 15, 30]);
ck("3. migration 120 plan_config seed", TIERS.map((t) => fromPlanConfig[t]), [0, 6, 15, 30]);
ck("4. migration 120 margin-summary SQL", TIERS.map((t) => fromMarginSQL[t]), [0, 6, 15, 30]);

// The diff itself: every pair must agree for every tier. Stated as a list of
// disagreements so a failure names exactly which surfaces drifted apart.
const SOURCES = {
  "golsz-app.html": fromPLANS,
  "_plan-catalog.js": fromCatalog,
  "plan_config": fromPlanConfig,
  "margin-summary SQL": fromMarginSQL,
};
const names = Object.keys(SOURCES);
const disagreements = [];
for (const tier of TIERS) {
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = SOURCES[names[i]][tier], b = SOURCES[names[j]][tier];
      if (a !== b) disagreements.push(`${tier}: ${names[i]}=${a} vs ${names[j]}=${b}`);
    }
  }
}
ck("no two price surfaces disagree on any tier", disagreements, []);

// Scout must read the renamed column, and must not print a dollar sign in
// front of a euro amount — the exact shape of the bug that was live.
ck("scout.js reads plan_config for its price knowledge", /plan_config\?select=/.test(SCOUT), true);
ck("...selecting price_eur", /price_eur/.test(SCOUT), true);
ck("...with a fallback while migration 120 lands", /retrying with price_usd/.test(SCOUT), true);
ck("...and renders a euro sign, not a dollar sign",
   /\\u20AC\$\{p\[priceKey\]\}\/mo/.test(SCOUT), true);
ck("no '$' + price_usd template survives", /\$\$\{p\.price_usd\}/.test(SCOUT), false);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
