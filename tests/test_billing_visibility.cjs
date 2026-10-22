// WHEN DOES MY PLAN RENEW, AND WHEN DOES IT END? (migration 164)
//
// Settings showed a plan name and nothing else. These pin the client half:
// the dates come from a query of their own (a missing column must never break
// the profile read Settings depends on), they are shown only when they mean
// something, they are formatted in the athlete's language, and the delete
// warning tells an athlete who is cancelling exactly what they forfeit.
// The server halves are pinned in test_stripe_webhook_logic.cjs and
// test_delete_account.cjs, which run the real handlers.

const fs = require("fs");
const path = require("path");
const APP = fs.readFileSync(path.join(__dirname, "..", "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) p++; else { f++; console.log(`FAIL  ${l}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(e)}`); }
};

/* ---------- the formatter, run for real ---------- */
const s0 = APP.indexOf("function formatBillingDate(");
const fmtSrc = APP.slice(s0, APP.indexOf("\n}\n", s0) + 3);
ck("found formatBillingDate", fmtSrc.length > 100, true);
const fmt = new Function(fmtSrc + "\nreturn formatBillingDate;")();
const ISO = "2026-10-26T12:00:00.000Z";
ck("English: a long date with the year", /October/.test(fmt(ISO, "en")) && /2026/.test(fmt(ISO, "en")), true);
ck("French: in French", /octobre/.test(fmt(ISO, "fr")), true);
ck("Spanish: in Spanish", /octubre/.test(fmt(ISO, "es")), true);
ck("Greek: in Greek script", /[\u0370-\u03FF]/.test(fmt(ISO, "el")), true);
ck("garbage is an empty string, never 'Invalid Date'", [fmt("not a date", "en"), fmt(null, "en") === "" || fmt(null, "en") === "Invalid Date", fmt(undefined, "en")], ["", false, ""]);
ck("an unknown language falls back rather than throwing", /2026/.test(fmt(ISO, "zz-not-a-locale-%%")), true);

/* ---------- its own query, never riding on the profile read ---------- */
const mainSel = /from\("profiles"\)\.select\("plan, payment_past_due, stripe_customer_id"\)/.test(APP);
ck("the profile read Settings depends on does NOT name the new columns", mainSel, true);
ck("the dates are read in a separate query", /select\("current_period_end, cancel_at_period_end"\)\.eq\("id", user\.id\)\.single\(\)/.test(APP), true);
ck("...whose failure is swallowed (a missing date is not an error)", /\} catch \(e\) \{ \/\* a date missing from a screen is not worth an error \*\/ \}/.test(APP), true);
ck("...and 'cancelling' is only ever an explicit true", /cancelling: b\.data\.cancel_at_period_end === true/.test(APP), true);

/* ---------- when it is shown ---------- */
const view = APP.slice(APP.indexOf('{stripeCustomerId && currentPlan !== "free" && billing.end'), APP.indexOf('{stripeCustomerId && currentPlan !== "free" && billing.end') + 700);
ck("shown only to a paying customer with a date", /stripeCustomerId && currentPlan !== "free" && billing\.end && formatBillingDate\(billing\.end, lang\)/.test(view), true);
ck("a cancelling plan says it ENDS (in the warning colour); a renewing one says it renews",
   /billing\.cancelling \? C\.amber : C\.slate/.test(view) && /billing\.cancelling \? "settings_billing_cancels" : "settings_billing_renews"/.test(view), true);

/* ---------- the delete guard and the forfeit warning ---------- */
ck("the delete guard lets a cancelling subscription through", /hasActiveSubscription\(currentPlan, stripeCustomerId\) && !billing\.cancelling/.test(APP), true);
ck("...but plan-switching still treats it as active (a new Payment Link would start a SECOND subscription)",
   /function hasActiveSubscription\(plan, stripeCustomerId\) \{\s*return !!stripeCustomerId && plan !== "free";\s*\}/.test(APP), true);
const warn = APP.slice(APP.indexOf("{billing.cancelling && billing.end && currentPlan"), APP.indexOf("{billing.cancelling && billing.end && currentPlan") + 420);
ck("deleting while cancelling shows what is forfeited, with the date", /settings_delete_forfeit/.test(warn) && /\.replace\("\{date\}"/.test(warn), true);

/* ---------- strings ---------- */
const starts = ["  en: {", "  fr: {", "  es: {", "  el: {"].map((h) => APP.indexOf("\n" + h + "\n"));
const dicts = starts.map((s) => APP.slice(s, APP.indexOf("\n  },\n", s)));
const grab = (d, k) => (new RegExp(`\\b${k}: "((?:[^"\\\\]|\\\\.)*)"`).exec(d) || [])[1];
for (const k of ["settings_billing_renews", "settings_billing_cancels", "settings_delete_forfeit"]) {
  ck(`${k} exists in en, fr, es and el`, dicts.map((d) => !!grab(d, k)), [true, true, true, true]);
  ck(`${k}: translated, not English copies`, [1, 2, 3].map((i) => grab(dicts[i], k) !== grab(dicts[0], k)), [true, true, true]);
  ck(`${k} keeps its {date} placeholder everywhere`, dicts.map((d) => /\{date\}/.test(grab(d, k))), [true, true, true, true]);
}
ck("the forfeit text promises no refund or restore that the terms do not (it says access ends and the period is lost)",
   /ends your access straight away/.test(grab(dicts[0], "settings_delete_forfeit")) && !/refund/i.test(grab(dicts[0], "settings_delete_forfeit")), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
