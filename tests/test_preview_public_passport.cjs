// tools/preview-public-passport.cjs injects a fixture stub into a COPY of golsz-app.html, in memory.
// This pins the three things that keep it harmless: the committed page has no stub, the stub is
// added to the served copy only, and the fixtures cover the four cases the browser run needs.
const fs = require("fs");
const path = require("path");
const { pageWithStub, constantsFrom, appBundle, FIXTURES } = require("../tools/preview-public-passport.cjs");

const html = fs.readFileSync(path.join(__dirname, "..", "golsz-app.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "..", "golsz-app.jsx"), "utf8");
// The page and the app's code together, the way every suite reads them.
const APP = require("./_app_source.cjs").appSource();
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("FAIL: " + msg); } };

ok(!/window\.fetch\s*=\s*function|sendBeacon/.test(APP), "committed golsz-app.html and golsz-app.jsx carry no preview stub");
ok(!APP.includes("/__log") && !APP.includes("__vendor"), "committed golsz-app.html and golsz-app.jsx have no preview hooks");

// The stub answers the address, and recognises the key, the app really sends: the ones in its source.
const declared = (name) => new RegExp(name + '\\s*=\\s*"([^"]+)"').exec(source)[1];
const consts = constantsFrom(appBundle());
ok(consts.supabaseUrl === declared("SUPABASE_URL") && consts.anonKey === declared("SUPABASE_ANON_KEY"),
  "the served page's Supabase address and anon key come from the bundle the page runs, and match golsz-app.jsx");

const cfg = { reload: false, supabaseUrl: "https://x.supabase.co", anonKey: "k", fixture: "a", data: FIXTURES.a, theme: "light", retry: false };
const served = pageWithStub(html, cfg);
ok(served.length > html.length && served.includes("window.fetch = function"), "served copy has the stub");
ok(served.search(/<head[^>]*><script>/) >= 0, "stub is the first thing in <head>, before the theme script");

const a = FIXTURES.a, b = FIXTURES.b;
ok(a.club_name && a.country && a.shows_benchmarks && a.benchmarks.length === 3, "fixture a: full athlete, 3 benchmarks");
ok(a.benchmarks.every((x) => x.recorded_date && (x.measured_by || x.protocol)), "fixture a: every benchmark has a date and a method");
ok(b.club_name === null && b.country === null && b.full_name === a.full_name, "fixture b: same athlete, club and country hidden");
ok(FIXTURES.c === null, "fixture c: null (banned, removed or revoked)");
ok(FIXTURES.d && FIXTURES.d.full_name, "fixture d: succeeds on retry");

// fixture=crash: exists, and exists only in the served copy; the file on disk is never written.
ok(FIXTURES.crash && FIXTURES.crash.full_name, "fixture crash: lookup data present");
ok(!/PublicPassport render failed|fixture crash|log_client_error auth=/.test(APP), "committed golsz-app.html and golsz-app.jsx have no crash fixture");
const servedCrash = pageWithStub(html, { ...cfg, fixture: "crash", data: FIXTURES.crash });
ok(servedCrash.includes("PublicPassport render failed") && servedCrash.includes("log_client_error"), "served copy carries the crash stub and the log_client_error answer");
ok(!served.includes('"fixture":"crash"') && servedCrash.includes('"fixture":"crash"'), "crash mode is selected by the config only");
const diskAfter = fs.readFileSync(path.join(__dirname, "..", "golsz-app.html"), "utf8");
ok(diskAfter === html && fs.readFileSync(path.join(__dirname, "..", "golsz-app.jsx"), "utf8") === source, "files on disk unchanged after building served copies");
ok(/keep_fnames/.test(fs.readFileSync(path.join(__dirname, "..", "tools", "precompile.cjs"), "utf8")), "terser keeps function names (the crash stub finds PublicPassport by name)");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
