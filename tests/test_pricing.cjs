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

const slice = (from, to) => {
  const i = APP.indexOf(from), j = APP.indexOf(to);
  // A missing anchor used to give indexOf -1, so slice() returned a huge
  // trailing chunk of the file and eval() either threw a confusing
  // SyntaxError or — worse — silently succeeded on the wrong code. Renaming
  // hasFeature() to featureUnlocked()/featureLocked() tripped exactly this.
  if (i < 0) throw new Error(`dead anchor (start): "${from}" is no longer in golsz-app.html`);
  if (j < 0) throw new Error(`dead anchor (end): "${to}" is no longer in golsz-app.html`);
  return APP.slice(i, j);
};
// Direct eval LEAKS function declarations into this scope but not consts,
// so planPrice arrives on its own and only PRICE_CURRENCY needs extracting.
// Destructuring planPrice here too would collide with the leaked function.
eval(slice("const CURRENCY_SYMBOL =", "const VAPID_PUBLIC_KEY") +
  "\nfunction __c() { return { CURRENCY_SYMBOL, PLAN_PRICES, REGION_CURRENCY }; }");
const { CURRENCY_SYMBOL, PLAN_PRICES, REGION_CURRENCY } = __c();
eval(slice("const STRIPE_LINKS = {", "// A Stripe Payment Link is test-mode") + "\nfunction __sl() { return STRIPE_LINKS; }");
const STRIPE_LINKS_LIVE = __sl();
eval(slice("const PLANS = [", "\n// Supabase client") + "\nfunction __p() { return PLANS; }");
const PLANS = __p();
eval(slice("const FEATURE_MIN_PLAN = {", "// ---- ENTITLEMENT IS THREE-VALUED") + "\nfunction __f() { return FEATURE_MIN_PLAN; }");
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
ck("the euro sign is still the euro sign", CURRENCY_SYMBOL.eur, "\u20AC");
ck("dollars are disambiguated, not bare $", [CURRENCY_SYMBOL.cad, CURRENCY_SYMBOL.usd], ["CA$", "US$"]);
// api/geo.js returns ca / us / eu / default. The first three map; "default"
// and anything unexpected fall to USD rather than to nothing.
ck("Canada -> CAD", currencyForRegion("ca"), "cad");
ck("US -> USD", currencyForRegion("us"), "usd");
ck("Europe -> EUR", currencyForRegion("eu"), "eur");
ck("rest of world -> USD", currencyForRegion("default"), "usd");
ck("an unknown region -> USD, never undefined", currencyForRegion("antarctica"), "usd");
ck("...and a missing region too", currencyForRegion(undefined), "usd");


// planPrice takes a PLAN and a CURRENCY now, not a bare amount — the amount
// comes from the table, so a caller cannot pass a number the catalogue has
// never heard of.
ck("planPrice formats EUR", ["free", "starter", "pro", "elite"].map((p) => planPrice(p, "eur")),
   ["\u20AC0", "\u20AC6", "\u20AC15", "\u20AC30"]);
ck("planPrice formats CAD", ["free", "starter", "pro", "elite"].map((p) => planPrice(p, "cad")),
   ["CA$0", "CA$9", "CA$23", "CA$45"]);
ck("planPrice formats USD", ["free", "starter", "pro", "elite"].map((p) => planPrice(p, "usd")),
   ["US$0", "US$7", "US$16", "US$32"]);
// An unknown currency must not render an empty price or "undefined".
ck("an unknown currency falls back to USD", planPrice("pro", "gbp"), "US$16");
ck("a missing currency falls back to USD", planPrice("pro"), "US$16");
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
// BOTH of the two lines above passed on 2026-08-24 while the homepage carried
// "All prices in CAD" in its pricing footnote, directly contradicting the "All
// prices in euro (EUR)" line 60 lines above it. Each check could only fail in
// one direction: the first looks for the SYMBOL C$ followed by a digit, which
// the word "CAD" does not contain; the second confirms the right claim is
// PRESENT and says nothing about a wrong one sitting beside it.
//
// GOLSZ is a Nicosia (Cyprus) business selling in EUR. The currency word is
// the claim customers actually read, so assert the wrong word is ABSENT, not
// merely that the right one appears somewhere.
ck("the word CAD appears nowhere on the homepage", /\bCAD\b/.test(HOME), false);
ck("...nor any other Canadian-business claim", /\bCanadian\b/.test(HOME), false);
// Every currency statement must agree. One page cannot name two currencies.
const currencyClaims = [...HOME.matchAll(/All prices in ([A-Za-z()\s]+?)(?:\s*&middot;|\.|<)/g)]
  .map((m) => m[1].trim());
ck("every 'All prices in ...' statement was found", currencyClaims.length >= 2, true);
ck("...and they all name EUR", [...new Set(currencyClaims.map((c) => /eur/i.test(c)))], [true]);
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
// MRR IS GONE, not just unrendered. The calculation lived inside
// loadAnalytics(), which was deleted with the Analytics tab — it had been
// pulling 2000 profiles, 2000 athletes and five RPCs on every admin load for a
// screen that no longer existed.
//
// This is a real capability loss and is recorded as one rather than quietly
// dropped from the suite. It read 0 until live Stripe exists, which is why it
// was acceptable to lose now. When revenue starts, MRR needs rebuilding — and
// the assertions below are the specification for doing it right, because the
// original hardcoded 6/14/30 and silently under-reported by ~60% after the
// currency move.
ck("MRR is currently absent, calculation included",
   /mrrEstimate/.test(APP), false);
ck("...and if it returns it must derive from PLANS, never from literals",
   /planCounts\.starter \* 6|planCounts\.pro \* 14|planCounts\.elite \* 30/.test(APP), false);
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
const { resolvePlanFromStripe, PLAN_CATALOG, SUPPORTED_CURRENCIES, DEFAULT_CURRENCY, readPriceFields } = catalog;

// A fake env standing in for configured live Price ids. Nothing real is
// committed anywhere — the repo ships with these unset.
// Nine now — one Price per (plan, currency). Built from the catalogue itself
// so a tenth cannot appear without this env growing to match it.
const ENV = Object.fromEntries(
  PLAN_CATALOG.map((e, i) => [e.priceEnv, `price_TEST${e.plan}${e.currency}${String(i).padStart(4, "0")}`])
);
const idFor = (plan, cur) => ENV[PLAN_CATALOG.find((e) => e.plan === plan && e.currency === cur).priceEnv];
const R = (o) => resolvePlanFromStripe(o, ENV);

ck("catalogue holds exactly the three paid tiers",
   [...new Set(PLAN_CATALOG.map((e) => e.plan))], ["starter", "pro", "elite"]);
ck("...in exactly three currencies", SUPPORTED_CURRENCIES, ["eur", "cad", "usd"]);
ck("...which is nine Price objects", PLAN_CATALOG.length, 9);
ck("rest of the world is billed in USD", DEFAULT_CURRENCY, "usd");
// The amounts, stated here so a silent edit to the catalogue has to come and
// change this line too. These become IMMUTABLE Stripe Prices.
ck("EUR is 6 / 15 / 30",
   ["starter", "pro", "elite"].map((p) => PLAN_CATALOG.find((e) => e.plan === p && e.currency === "eur").unitAmount),
   [600, 1500, 3000]);
ck("CAD is 9 / 23 / 45",
   ["starter", "pro", "elite"].map((p) => PLAN_CATALOG.find((e) => e.plan === p && e.currency === "cad").unitAmount),
   [900, 2300, 4500]);
ck("USD is 7 / 16 / 32",
   ["starter", "pro", "elite"].map((p) => PLAN_CATALOG.find((e) => e.plan === p && e.currency === "usd").unitAmount),
   [700, 1600, 3200]);
ck("every (plan, currency) pair is present exactly once",
   PLAN_CATALOG.length, new Set(PLAN_CATALOG.map((e) => e.plan + ":" + e.currency)).size);
ck("every entry has its own lookup_key",
   new Set(PLAN_CATALOG.map((e) => e.lookupKey)).size, 9);
ck("...and its own env var", new Set(PLAN_CATALOG.map((e) => e.priceEnv)).size, 9);
ck("'free' is never grantable from Stripe", PLAN_CATALOG.some((e) => e.plan === "free"), false);

// The copy under the prices said "All prices in EUR." on every screen, in
// every region, while the numbers beside it were CAD or USD. A wrong currency
// LABEL is worse than none: it is a specific, confident, false claim about
// money, and it survived the whole multi-currency change until something read
// it out loud.
ck("the currency note is a template, not a hardcoded EUR",
   /prices_currency_note: "[^"]*\{currency\}/.test(APP), true);
ck("...in all four dictionaries", (APP.match(/prices_currency_note: "[^"]*\{currency\}/g) || []).length, 4);
ck("...and no dictionary still names EUR outright",
   /prices_currency_note: "[^"]*EUR/.test(APP), false);
ck("...and every render site substitutes it",
   (APP.match(/prices_currency_note"\)\.replace\("\{currency\}"/g) || []).length, 4);

console.log("\n-- the client's prices match the catalogue that validates them --");
// This is the check that matters. The client renders PLAN_PRICES; the server
// validates against PLAN_CATALOG. If they drift, the page quotes one number
// and Stripe charges another, and nothing else in the system would notice.
{
  const drift = [];
  for (const e of PLAN_CATALOG) {
    const shown = (PLAN_PRICES[e.plan] || {})[e.currency];
    if (shown * 100 !== e.unitAmount) {
      drift.push(`${e.plan}/${e.currency}: client ${shown} vs catalogue ${e.unitAmount / 100}`);
    }
  }
  ck("no (plan, currency) pair disagrees between client and server", drift, []);
  ck("the client prices every plan in every currency",
     Object.keys(PLAN_PRICES).filter((p) => SUPPORTED_CURRENCIES.some((c) => typeof PLAN_PRICES[p][c] !== "number")), []);
  ck("free is free in all three", SUPPORTED_CURRENCIES.map((c) => PLAN_PRICES.free[c]), [0, 0, 0]);
}

console.log("\n-- a correct Price resolves --");
ck("Basic by price id", R({ priceId: idFor("starter", "eur"), currency: "eur", unitAmount: 600 }).plan, "starter");
ck("Pro by price id", R({ priceId: idFor("pro", "eur"), currency: "eur", unitAmount: 1500 }).plan, "pro");
ck("Elite by price id", R({ priceId: idFor("elite", "eur"), currency: "eur", unitAmount: 3000 }).plan, "elite");
ck("...and reports how it matched", R({ priceId: idFor("pro", "eur"), currency: "eur", unitAmount: 1500 }).matchedBy, "price_id");
ck("lookup_key resolves when the id is unknown",
   R({ priceId: "price_somethingElse", lookupKey: "golsz_pro_eur_monthly", currency: "eur", unitAmount: 1500 }).plan, "pro");
ck("explicit metadata resolves as a last resort",
   R({ metadataPlan: "elite", currency: "eur", unitAmount: 3000 }).plan, "elite");
ck("uppercase currency from Stripe is accepted",
   R({ priceId: idFor("starter", "eur"), currency: "EUR", unitAmount: 600 }).plan, "starter");

console.log("\n-- AN INCORRECT CURRENCY CANNOT GRANT A PLAN --");
for (const cur of ["usd", "cad", "gbp", "aud", "", null, undefined, 42]) {
  ck(`currency ${JSON.stringify(cur)} is refused`,
     R({ priceId: idFor("pro", "eur"), currency: cur, unitAmount: 1500 }).plan, null);
}
ck("...and the reason names the mismatch",
   R({ priceId: idFor("pro", "eur"), currency: "usd", unitAmount: 1500 }).reason, "configuration_mismatch");
ck("...naming the offending currency", R({ priceId: idFor("pro", "eur"), currency: "usd", unitAmount: 1500 }).problems, ["currency:usd"]);
// The old bug in one line: 3000 units of anything used to mean Elite.
ck("3000 USD does NOT grant Elite", R({ priceId: idFor("elite", "eur"), currency: "usd", unitAmount: 3000 }).plan, null);
ck("...and 3000 CAD does not either", R({ priceId: idFor("elite", "eur"), currency: "cad", unitAmount: 3000 }).plan, null);

console.log("\n-- AN INCORRECT AMOUNT CANNOT GRANT A PLAN --");
for (const amt of [0, 1, 599, 601, 1499, 1501, 2999, 100000, -1500]) {
  ck(`Pro price at ${amt} is refused`, R({ priceId: idFor("pro", "eur"), currency: "eur", unitAmount: amt }).plan, null);
}
for (const amt of [null, undefined, NaN, "1500"]) {
  ck(`non-numeric amount ${JSON.stringify(amt)} is refused`,
     R({ priceId: idFor("pro", "eur"), currency: "eur", unitAmount: amt }).plan, null);
}
ck("a missing amount is a problem, not a pass",
   R({ priceId: idFor("pro", "eur"), currency: "eur" }).problems, ["amount:missing"]);
// Cross-wired configuration: right plan id, another plan's money.
ck("Basic's price id with Pro's amount is refused",
   R({ priceId: idFor("starter", "eur"), currency: "eur", unitAmount: 1500 }).plan, null);

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
ck("price ids come from env", /STRIPE_PRICE_\$\{|STRIPE_PRICE_/.test(CAT), true);

console.log("\n-- readPriceFields pulls the right things --");
ck("reads a Stripe price object",
   readPriceFields({ id: "price_x", lookup_key: "k", currency: "eur", unit_amount: 1500 }),
   { priceId: "price_x", lookupKey: "k", currency: "eur", unitAmount: 1500 });
ck("survives a missing price", readPriceFields(null), {});
ck("...and a malformed one", readPriceFields({ id: 5, unit_amount: "1500" }), { priceId: null, lookupKey: null, currency: null, unitAmount: null });

console.log("\n-- checkout stays disabled until live EUR Stripe exists --");
// Nine links now, and they are EMPTY rather than sandbox — the old test-mode
// URLs were removed with the currency split. What matters is unchanged: not
// one of them is live, so checkout stays dark until the Cyprus account exists.
ck("no link in any currency is live yet",
   ["eur", "cad", "usd"].flatMap((c) => ["starter", "pro", "elite"].map((k) => (STRIPE_LINKS_LIVE[c] || {})[k]))
     .some((u) => /^https:\/\/buy\.stripe\.com\//.test(u || "") && !/\/test_/.test(u || "")), false);
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
// EUR only. The other three surfaces below (plan_config, the margin SQL, and
// the client's base PLANS row) are euro figures, and the catalogue now holds
// nine entries — without this filter the loop would keep whichever currency
// happened to be last and "compare" euros against dollars.
const fromCatalog = { free: 0 };
for (const e of PLAN_CATALOG) if (e.currency === "eur") fromCatalog[e.plan] = e.unitAmount / 100;

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
