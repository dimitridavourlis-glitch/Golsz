// /api/geo is a serverless call; js/main.js's initRegion() must make it only on
// pages that have a consumer for the answer (prices, currency labels, hero).
// Runs initRegion's real source against a stub document/fetch, and checks the
// real marketing pages so the guard cannot silently turn off the price swap.

const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(REPO, "js/main.js"), "utf8");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error("FAIL: " + m); } };

const m = /function initRegion\(\)[\s\S]*?\n  \}/.exec(SRC);
ok(!!m, "initRegion is present in js/main.js");
const body = m ? m[0] : "";

function run(present) {
  const calls = [];
  const document = { querySelector: (sel) => (present.some((p) => sel.includes(p)) ? {} : null) };
  const fetch = (url) => { calls.push(url); return new Promise(() => {}); };
  new Function("document", "fetch", "applyCurrency", "applyHeroImage", body + "; initRegion();")(
    document, fetch, () => {}, () => {});
  return calls;
}

ok(run([]).length === 0, "no fetch when no consumer matches");
const price = run(["[data-gz-price]"]);
ok(price.length === 1 && price[0] === "/api/geo", "one /api/geo fetch with [data-gz-price]");
const hero = run(["[data-hero-region]"]);
ok(hero.length === 1 && hero[0] === "/api/geo", "one /api/geo fetch with [data-hero-region]");

const CONSUMER = /data-gz-price|data-gz-currency-label|data-gz-currency-short|data-hero-region/;
const has = (f) => CONSUMER.test(fs.readFileSync(path.join(REPO, f), "utf8"));
ok(has("index.html"), "index.html still has a price consumer");
ok(has("about.html"), "about.html still has a hero consumer");
for (const f of ["privacy.html", "terms.html", "contact.html", "404.html"]) {
  ok(!has(f), f + " has no geo consumer (so no call)");
}

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
