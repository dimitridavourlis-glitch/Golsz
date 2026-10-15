// The marketing and legal pages must say what the product does today.
//
// WHY THIS EXISTS
// The 2026-10-09 audit found the privacy policy describing a product that no
// longer existed: under-18 accounts created by a parent (withdrawn on
// 20 September 2026), an "Under-16" heading, five account types (migration 138
// left Player and Parent), the app at golsz.vercel.app "and, once connected,
// golsz.com", and a flat "does not use cookies" over an app that keeps its
// sign-in session in local storage and sends Google, Cloudflare and jsDelivr
// the visitor's IP on every load. It also omitted data the product does
// collect: sign-up IP addresses, a per-minute usage heartbeat, error reports,
// an internal trust score, and Scout's memory and caches.
//
// Separately, contact/terms/privacy carried an old header and footer whose
// Feed and Discover links pointed at app pages that are switched off, so they
// landed silently on Home. Those three pages now share index.html's header
// and footer byte for byte, and this suite holds them to that.
//
// What it cannot check, stated so the green is not over-read: that a sentence
// in the policy is TRUE. It pins the specific stale claims that were removed
// and the specific disclosures that were added; the code is still the truth.

const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");

let pass = 0, fail = 0;
function ck(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log(`FAIL  ${name}\n   exp ${w}\n   got ${g}`); }
}

const PAGES = ["index.html", "about.html", "contact.html", "terms.html", "privacy.html"];
const SRC = {};
for (const p of PAGES) SRC[p] = fs.readFileSync(path.join(REPO, p), "utf8");
const PRIVACY = SRC["privacy.html"];

console.log("-- privacy.html no longer describes a product that does not exist --");
for (const stale of [
  "Under-16",                         // the s.5 heading; GOLSZ is 18+
  "golsz.vercel.app",                 // the site is golsz.com
  "scout, agent, coach, or physio",   // migration 138 removed these
  "does not use cookies",             // replaced by what is actually true
  "parent/guardian must create it",   // the withdrawn under-18 route
  "Last updated: August 2026",
]) {
  ck(`privacy does not say "${stale}"`, PRIVACY.includes(stale), false);
}
ck("privacy is dated 9 October 2026", PRIVACY.includes("Last updated: 9 October 2026"), true);

console.log("\n-- privacy.html discloses what the product actually does --");
for (const [label, re] of [
  ["sign-up IP addresses", /IP address the request came from/],
  ["the time-in-app heartbeat", /one minute of activity for each minute/],
  ["error reports linked to the account", /Error reports\./],
  ["the internal trust score as profiling", /Automated decisions and profiling/],
  ["the trust score's inputs", /how long the account has existed[\s\S]{0,300}reported your posts/],
  ["Scout memory", /Scout memory/],
  ["cached Scout replies", /copies of recent replies/],
  ["the unmatched-question log, kept after deletion", /without<\/strong> your account identifier[\s\S]{0,400}not deleted when you delete your account/],
  ["browser local storage", /local storage/],
  ["region from IP, not stored", /we do not store it/],
  ["storage outside Québec and Canada", /outside Québec and Canada, including in the United States/],
  ["the Law 25 person in charge", /The person in charge of the protection of personal information at GOLSZ is its founder\. Contact: <a href="mailto:hello@golsz\.com">hello@golsz\.com<\/a>/],
  ["confidentiality incidents", /Commission d'accès à l'information, as Québec law requires/],
  ["deletion from Settings or by email", /delete your account from Settings, or by emailing/],
]) {
  ck(`privacy covers ${label}`, re.test(PRIVACY), true);
}
for (const provider of ["Supabase", "Vercel", "Stripe", "Anthropic", "xAI", "Google Fonts", "cdnjs", "jsDelivr", "push service"]) {
  ck(`privacy names ${provider}`, PRIVACY.includes(provider), true);
}
// xAI is a fallback that only exists when SCOUT_FALLBACK_API_KEY is set
// (fallbackProviderConfig() in api/scout.js returns null without it).
ck("xAI is described as something that MAY be used", /xAI \(Grok\)<\/strong> &mdash; may be used/.test(PRIVACY), true);
// Turnstile ships dormant (TURNSTILE_SITE_KEY is ""), so it must not be
// presented as active.
ck("Turnstile is described as not active", /Cloudflare Turnstile, a bot check, but it is not active/.test(PRIVACY), true);

// terms.html s.18 sends the reader to "section 7 of our Privacy policy" for
// deletion and retention. Renumbering privacy.html must not break that.
{
  const h2s = [...PRIVACY.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
  ck("privacy section 7 is the one terms s.18 points to", /^7\. .*deleting your account/i.test(h2s[6] || ""), true);
  ck("privacy section 3 is cookies (terms and the old policy cite it)", /^3\. Cookies/.test(h2s[2] || ""), true);
}

console.log("\n-- every page shares one header and one footer --");
const HEADER = /<header class="site-header">[\s\S]*?<\/header>/;
const FOOTER = /<footer class="site-footer">[\s\S]*?<\/footer>/;
const indexHeader = (SRC["index.html"].match(HEADER) || [""])[0];
const indexFooter = (SRC["index.html"].match(FOOTER) || [""])[0];
ck("index.html has a header and a footer", !!indexHeader && !!indexFooter, true);
for (const p of PAGES) {
  const h = (SRC[p].match(HEADER) || [""])[0];
  const f = (SRC[p].match(FOOTER) || [""])[0];
  ck(`${p} header matches index.html`, h === indexHeader, true);
  ck(`${p} footer matches index.html`, f === indexFooter, true);
  // Feed and Discover are switched off in the app; ?page=feed and
  // ?page=discover are not valid pages and fall through to Home.
  ck(`${p} links to no switched-off app page`, /\?page=(feed|discover)\b/.test(SRC[p]), false);
}
// initActiveNav() in js/main.js marks `.nav-link[data-page]` matching the
// current file name. Contact is the one marketing page with its own nav entry.
ck("the shared header keeps Contact's active-nav hook (desktop + mobile)",
   (indexHeader.match(/class="nav-link" data-page="contact\.html"/g) || []).length, 2);
ck("the footer carries index.html's tagline",
   indexFooter.includes("The Sports Passport and AI Scout for athletes planning what comes next."), true);
ck("...not the old network tagline",
   PAGES.filter((p) => SRC[p].includes("The AI-powered professional network")), []);
ck("contact.html no longer says it is pre-launch", /Pre-launch/.test(SRC["contact.html"]), false);

console.log("\n-- the marketing copy matches the product --");
const INDEX = SRC["index.html"];
ck("the hero does not claim Scout tracks replies", /tracks who replied/.test(INDEX), false);
ck("CS Saint-Laurent (a real club) is not the sample club", /Saint-Laurent/.test(INDEX), false);
// FEATURE_MIN_PLAN in api/_entitlements.js: targets unlock at Basic, so
// outreach tracking must not be sold as a Pro feature; "progress reviews"
// exists nowhere in the product.
{
  const cards = [...INDEX.matchAll(/<article class="card plan[^"]*"[^>]*>([\s\S]*?)<\/article>/g)].map((m) => m[1]);
  const card = (name) => cards.find((c) => new RegExp(`<h3[^>]*>${name}</h3>`).test(c)) || "";
  ck("four plan cards", cards.length, 4);
  ck("Basic lists outreach tracking", /outreach tracking/i.test(card("Basic")), true);
  ck("Pro does not list outreach", /outreach/i.test(card("Pro")), false);
  ck("Pro lists the Passport Strength breakdown", /Passport Strength breakdown/.test(card("Pro")), true);
  ck("Pro lists the development plan", /development plan/i.test(card("Pro")), true);
  ck("no card advertises progress reviews", /progress review/i.test(INDEX), false);
  ck("Free: 3/day and 40 total", /3 Scout questions\/day &middot; 40 total/.test(card("Free")), true);
  ck("Basic: 8/day", /8 Scout questions\/day/.test(card("Basic")), true);
  ck("Pro: 15/day", /15 Scout questions\/day/.test(card("Pro")), true);
  ck("Elite: 20/day", /20 Scout questions\/day/.test(card("Elite")), true);
}
// GOLSZ is 18+. The about page's sample athlete was 16, "Class of 2028".
{
  const ABOUT = SRC["about.html"];
  const age = /<b>(\d+)<\/b><span>Age<\/span>/.exec(ABOUT);
  ck("the about-page sample athlete has an age", !!age, true);
  ck("...and is an adult", !!age && Number(age[1]) >= 18, true);
  ck("...with no high-school class year", /Class of 20\d\d/.test(ABOUT), false);
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
