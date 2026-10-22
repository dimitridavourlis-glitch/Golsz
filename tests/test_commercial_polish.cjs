// THE SMALL THINGS A PAYING CUSTOMER NOTICES.
//
// Each of these came out of the 2026-10-22 commercial-readiness audit and each
// is cheap to undo by accident, so each is pinned here:
//
//   * a branded 404 page (the default was Vercel's bare "NOT_FOUND")
//   * right-sized icons (the fallback icon was a 126 KB, 1024px PNG)
//   * pricing that says taxes are extra and links the refund terms
//   * content that stays visible with JavaScript off
//   * a Permissions-Policy that denies what the product never uses and
//     does NOT deny what it does use
//   * an admin link that cannot carry a javascript: URL
//   * the return from checkout: a banner that waits for the plan, in four
//     languages, and says who to write to when it is slow
//   * an "Update card" button on the failed-payment notice, and a Help block

const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) p++; else { f++; console.log(`FAIL  ${l}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(e)}`); }
};

const APP = read("golsz-app.html");
const HOME = read("index.html");
const CSS = read("css/styles.css");
const VERCEL = JSON.parse(read("vercel.json"));

/* ---------- 404 ---------- */
const NF = read("404.html");
ck("a 404.html exists", NF.length > 1000, true);
ck("it is not indexed", /<meta name="robots" content="noindex">/.test(NF), true);
// Vercel serves this page AT the bad URL, so a relative link would resolve
// against a path that does not exist and the page would render unstyled.
const rel = [...NF.matchAll(/\b(?:href|src)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(\/|#|mailto:|https?:)/.test(u));
ck("every link and asset on it is absolute (it is served at arbitrary paths)", rel, []);
ck("it carries the stylesheet", /href="\/css\/styles\.css"/.test(NF), true);
ck("and a way home, to the app and to support", /href="\/"/.test(NF) && /golsz-app\.html/.test(NF) && /hello@golsz\.com/.test(NF), true);
ck("it loads no scripts (nothing to break on a missing page)", /<script/.test(NF), false);

/* ---------- icons ---------- */
const size = (f) => fs.statSync(path.join(REPO, f)).size;
ck("the Apple touch icon is small", size("assets/apple-touch-icon.png") < 30000, true);
ck("the fallback icon is small", size("assets/favicon-48.png") < 8000, true);
for (const pg of ["index.html", "about.html", "contact.html", "terms.html", "privacy.html"]) {
  const h = read(pg);
  ck(`${pg} no longer points the touch/fallback icons at the 1024px file`,
     !/rel="(?:alternate icon|apple-touch-icon)" href="[^"]*favicon\.png"/.test(h), true);
}
ck("the PWA manifest keeps its large icons (installability needs them)", /favicon\.png/.test(read("manifest.json")), true);

/* ---------- pricing copy ---------- */
ck("the pricing footnote still starts the way the pricing suite expects",
   /All prices in <span data-gz-currency-short>EUR<\/span>/.test(HOME), true);
ck("...says prices are before taxes, which Stripe shows at checkout", /before any applicable taxes shown at checkout/.test(HOME), true);
ck("...and links the refund terms", /<a href="terms\.html#refunds">Refund terms<\/a>/.test(HOME), true);
ck("the anchor it links exists on the terms page", /<h2 id="refunds">/.test(read("terms.html")), true);
ck("the terms really do say taxes are shown at checkout (the claim is not invented)", /applicable taxes are shown at checkout/.test(read("terms.html")), true);

/* ---------- no-JS visibility ---------- */
ck("revealed content is forced visible when scripting is off", /@media \(scripting: none\) \{\s*\.reveal \{ opacity: 1; transform: none; transition: none; \}/.test(CSS), true);

/* ---------- headers ---------- */
const catchAll = VERCEL.headers.find((h) => h.source === "/((?!api/).*)");
const pp = (catchAll.headers.find((h) => h.key === "Permissions-Policy") || {}).value || "";
ck("a Permissions-Policy is sent on pages", pp.length > 0, true);
for (const f of ["camera", "microphone", "geolocation", "payment"]) ck(`it denies ${f}`, new RegExp(`${f}=\\(\\)`).test(pp), true);
// What the app genuinely uses must not be switched off by this header.
for (const used of ["clipboard", "web-share", "notifications", "push"]) ck(`it does not deny ${used}, which the app uses`, pp.includes(used), false);
const usesCamMicGeo = /getUserMedia|mediaDevices|navigator\.geolocation/.test(APP + read("js/main.js") + read("js/landing.js"));
ck("(positive control) the code really never asks for camera, microphone or location", usesCamMicGeo, false);
const assets = VERCEL.headers.find((h) => h.source === "/assets/(.*)");
ck("static images and icons are cacheable", !!assets && /max-age=86400/.test(assets.headers[0].value), true);
ck("...but the unhashed stylesheet and scripts are not made stale for a day", VERCEL.headers.some((h) => /css|js\/\(/.test(h.source) && /max-age=86400/.test(JSON.stringify(h.headers))), false);

/* ---------- one canonical host ---------- */
const redir = (VERCEL.redirects || []).find((r) => (r.has || []).some((h) => h.type === "host" && h.value === "golsz.vercel.app"));
ck("golsz.vercel.app redirects to golsz.com (it served a full duplicate of the site)", !!redir && /^https:\/\/golsz\.com\//.test(redir.destination), true);
ck("...permanently, and keeps the path", !!redir && redir.permanent === true && /\$1/.test(redir.destination), true);
// The database's push trigger posts to https://golsz.vercel.app/api/send-push.
// A redirect on /api would turn that POST into a GET or drop it, silently
// ending every push notification, so /api must be excluded by the pattern.
const re = new RegExp("^" + redir.source + "$");
ck("...but /api/* is NOT redirected (the push-notification trigger posts there)",
   [re.test("/api/send-push"), re.test("/api/stripe-webhook"), re.test("/golsz-app.html"), re.test("/index.html"), re.test("/")], [false, false, true, true, true]);

/* ---------- admin link ---------- */
ck("the knowledge source link goes through safeHref", /safeHref\(k\.source_url\)\s*\?\s*<a href=\{safeHref\(k\.source_url\)\}/.test(APP), true);
ck("...and a non-http value is shown as text, not as a link", /<span style=\{\{ color: C\.slate \}\}>\{k\.source_url\}<\/span>/.test(APP), true);
ck("no raw href={k.source_url} is left", /href=\{k\.source_url\}/.test(APP), false);

/* ---------- checkout return ---------- */
const BN = APP.slice(APP.indexOf("function CheckoutReturnBanner()"), APP.indexOf("function GolszApp("));
ck("the banner component exists", BN.length > 500, true);
ck("it only starts when the URL says checkout=success", /\/\[\?&\]checkout=success\\b\/\.test\(window\.location\.search\)/.test(BN), true);
ck("it polls the athlete's own plan row", /from\("profiles"\)\.select\("plan"\)\.eq\("id", user\.id\)/.test(BN), true);
ck("it declares success only when the plan is no longer free", /data\.plan !== "free"/.test(BN), true);
ck("it gives up after a bounded number of tries and says so (never spins forever)", /tries >= 30/.test(BN) && /setState\("late"\)/.test(BN), true);
ck("it cleans up its timer on unmount", /return \(\) => \{ stop = true; if \(timer\) clearTimeout\(timer\); \}/.test(BN), true);
ck("it never writes anything: no insert, update, upsert, rpc", /\.(insert|update|upsert|delete|rpc)\(/.test(BN), false);
ck("Continue drops the query string so a refresh does not replay the banner", /window\.location\.replace\(window\.location\.pathname\)/.test(BN), true);
ck("it is mounted once, in the app shell", (APP.match(/<CheckoutReturnBanner \/>/g) || []).length, 1);
ck("...and defines no hook below an early return of its own (hooks are at the top)", /if \(state === "none"\) return null;/.test(BN) && BN.indexOf("useEffect(") < BN.indexOf('if (state === "none") return null;'), true);

/* ---------- settings ---------- */
const pastDue = APP.slice(APP.indexOf("{paymentPastDue && ("), APP.indexOf("{paymentPastDue && (") + 1400);
ck("the failed-payment notice has an Update card button", /settings_payment_update_card/.test(pastDue), true);
ck("...only when there is a Stripe customer to open a portal for", /\{stripeCustomerId && \(\s*<button/.test(pastDue), true);
ck("a Help block links support, refund terms and privacy",
   /href="mailto:hello@golsz\.com"/.test(APP) && /href="terms\.html#refunds"/.test(APP) && /settings_help_privacy/.test(APP), true);

/* ---------- strings, four languages, genuinely translated ---------- */
const KEYS = ["checkout_activating", "checkout_active", "checkout_continue", "checkout_late", "settings_payment_update_card",
  "settings_help", "settings_help_contact", "settings_help_billing", "settings_help_privacy"];
const starts = ["  en: {", "  fr: {", "  es: {", "  el: {"].map((h) => APP.indexOf("\n" + h + "\n"));
const dicts = starts.map((s) => APP.slice(s, APP.indexOf("\n  },\n", s)));
const grab = (d, k) => (new RegExp(`\\b${k}: "((?:[^"\\\\]|\\\\.)*)"`).exec(d) || [])[1];
for (const k of KEYS) {
  ck(`${k} exists in en, fr, es and el`, dicts.map((d) => !!grab(d, k)), [true, true, true, true]);
  if (k !== "settings_help_contact") ck(`${k}: fr, es and el are translated, not English copies`, [1, 2, 3].map((i) => grab(dicts[i], k) !== grab(dicts[0], k)), [true, true, true]);
}
ck("the activated message keeps its {plan} placeholder in every language", dicts.map((d) => /\{plan\}/.test(grab(d, "checkout_active"))), [true, true, true, true]);
ck("every language's slow-activation message says who to write to", dicts.map((d) => /hello@golsz\.com/.test(grab(d, "checkout_late"))), [true, true, true, true]);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
