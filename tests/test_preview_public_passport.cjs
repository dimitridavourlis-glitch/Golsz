// tools/preview-public-passport.cjs injects a fixture stub into a COPY of golsz-app.html, in memory.
// This pins the three things that keep it harmless: the committed page has no stub, the stub is
// added to the served copy only, and the fixtures cover the four cases the browser run needs.
const fs = require("fs");
const path = require("path");
const { pageWithStub, FIXTURES } = require("../tools/preview-public-passport.cjs");

const html = fs.readFileSync(path.join(__dirname, "..", "golsz-app.html"), "utf8");
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("FAIL: " + msg); } };

ok(!/window\.fetch\s*=\s*function|sendBeacon/.test(html), "committed golsz-app.html carries no preview stub");
ok(!html.includes("/__log") && !html.includes("__vendor"), "committed golsz-app.html has no preview hooks");

const cfg = { supabaseUrl: "https://x.supabase.co", anonKey: "k", fixture: "a", data: FIXTURES.a, theme: "light", retry: false };
const served = pageWithStub(html, cfg);
ok(served.length > html.length && served.includes("window.fetch = function"), "served copy has the stub");
ok(served.search(/<head[^>]*><script>/) >= 0, "stub is the first thing in <head>, before the theme script");

const a = FIXTURES.a, b = FIXTURES.b;
ok(a.club_name && a.country && a.shows_benchmarks && a.benchmarks.length === 3, "fixture a: full athlete, 3 benchmarks");
ok(a.benchmarks.every((x) => x.recorded_date && (x.measured_by || x.protocol)), "fixture a: every benchmark has a date and a method");
ok(b.club_name === null && b.country === null && b.full_name === a.full_name, "fixture b: same athlete, club and country hidden");
ok(FIXTURES.c === null, "fixture c: null (banned, removed or revoked)");
ok(FIXTURES.d && FIXTURES.d.full_name, "fixture d: succeeds on retry");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
