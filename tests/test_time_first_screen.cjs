// tools/time-first-screen.cjs serves COPIES of index.html and golsz-app.html with a timing script and
// local libraries. This pins what keeps it harmless: the files on disk are never changed, the throttle
// defaults are the "normal mobile connection" the budgets are written for, the timing script exists only
// in the served copy, and an integrity attribute is dropped only when the local file's hash differs.
const fs = require("fs");
const path = require("path");
const { buildPage, parseArgs, lateFont, DEFAULTS, BUDGETS, LATE_FONT_PATH } = require("../tools/time-first-screen.cjs");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("FAIL: " + msg); } };

const before = { app: read("golsz-app.html"), home: read("index.html") };
const integrities = (h) => (h.match(/integrity="[^"]+"/g) || []);
const scriptTags = (h) => h.match(/<script src="[^"]*"[^>]*><\/script>/g) || [];

// every library "matches" or every library "differs", as the real cache does for React vs supabase-js
const hashOf = (html) => integrities(html).map((x) => x.slice(18, -1));
const appHashes = hashOf(before.app);
const matching = (i) => ({ sha384: appHashes[i] });
const differing = () => ({ sha384: "not-the-same-bytes" });

const same = buildPage(before.app, matching);
ok(integrities(same.html).join() === integrities(before.app).join(), "integrity attributes unchanged when the local bytes match");
ok(same.html.includes('<script src="/__vendor/0.js" integrity='), "React tag points at /__vendor/0.js and keeps its integrity");
ok(Object.keys(same.files).length === 3 && !/cdnjs\.cloudflare|cdn\.jsdelivr/.test(scriptTags(same.html).join()), "all three CDN script tags are rewritten to local files");
ok(scriptTags(same.html).every((t) => /crossorigin="anonymous"/.test(t) || !t.includes("/__vendor/")), "crossorigin attribute is kept");

const mixed = buildPage(before.app, (i) => (i === 2 ? differing() : matching(i)));
ok(integrities(mixed.html).length === 2 && /<script src="\/__vendor\/2\.js" crossorigin="anonymous" defer>/.test(mixed.html), "integrity is dropped only on the tag whose bytes differ");

ok(same.html.includes("PerformanceObserver") && same.html.includes("/__timing") && /^[\s\S]*?<head[^>]*><script async src="\/__hold">/.test(same.html), "served app copy carries the timing script, first in <head>");
ok(same.html.includes("largest-contentful-paint") && same.html.includes("first-contentful-paint"), "timing script observes FCP and LCP");
const home = buildPage(before.home, matching);
ok(home.html.includes("/__timing") && home.html.includes("/__hold") && Object.keys(home.files).length === 0, "served home copy carries the timing script and has no libraries to rewrite");

ok(!/PerformanceObserver|__timing|__hold|__vendor/.test(before.app + before.home), "timing script appears only in the served copies, not in the committed pages");
ok(read("golsz-app.html") === before.app && read("index.html") === before.home, "pages on disk are byte-identical after building the copies");

ok(DEFAULTS.rttMs === 150 && DEFAULTS.mbps === 1.6, "throttle defaults: 150 ms round trip, 1.6 Mbps");
ok(parseArgs([], {}).rttMs === 150 && parseArgs([], {}).mbps === 1.6, "no arguments: defaults");
const o = parseArgs(["8123", "--rtt=300", "--mbps=0.8"], {});
ok(o.port === 8123 && o.rttMs === 300 && o.mbps === 0.8, "port, --rtt and --mbps are configurable");
ok(parseArgs(["--lang=fr"], {}).lang === "fr" && parseArgs(["--lang=xx\"<"], {}).lang === undefined, "--lang takes only a known language code");
ok(same.html.includes('querySelector("#boot .m")') && same.html.includes("scrollWidth > de.clientWidth"), "timing script records the boot line and sideways overflow");
ok(parseArgs([], { TIMING_RTT_MS: "50", TIMING_MBPS: "4" }).mbps === 4, "environment variables configure the throttle");
ok(BUDGETS.homeLcpMs === 3000 && BUDGETS.appBootMs === 2500 && BUDGETS.appMountedMs === 5000, "budgets match the tool header");
const header = fs.readFileSync(path.join(root, "tools", "time-first-screen.cjs"), "utf8");
ok(/LCP\s+<= 3000 ms/.test(header) && /<= 2500 ms/.test(header) && /<= 5000 ms/.test(header), "budgets are written in the tool header");

// Layout shift (cls) and its positive control, --late-font.
ok(same.html.includes('observe("layout-shift"') && same.html.includes("hadRecentInput"), "timing script adds up layout shifts, leaving out the ones that follow a tap or key");
ok(BUDGETS.cls === 0.1 && /cls\s+<= 0\.10/.test(header), "the layout-shift budget is 0.10, and the tool header says so");
ok(parseArgs(["--late-font=6000"], {}).lateFontMs === 6000 && parseArgs([], {}).lateFontMs === undefined && parseArgs(["--late-font=soon"], {}).lateFontMs === undefined,
  "--late-font takes milliseconds and is off by default");
const fontUrls = (text) => text.match(/https:\/\/fonts\.googleapis\.com\/css2/g) || [];
const bundle = read("js/app.js");
// The app page names it twice, in <head> (the preload and the stylesheet link); the CSS @import is in
// the bundle. (Until AVA job 216 the page also held the app's source, a third, never-loaded copy.)
ok(fontUrls(before.app).length >= 2 && fontUrls(before.home).length >= 2 && fontUrls(bundle).length >= 1, "the pages and the bundle name the Google Fonts stylesheet (the rewrite below is not empty)");
const late = lateFont(before.app, 7);
ok(fontUrls(late).length === 0 && late.split(LATE_FONT_PATH + "?n=7").length - 1 === fontUrls(before.app).length, "--late-font points every one of them at the stand-in, with the page load's own number");
ok(fontUrls(lateFont(bundle, 8)).length === 0 && fontUrls(lateFont(before.home, 9)).length === 0, "...in the bundle's @import and on the home page too");
ok(late.length - fontUrls(before.app).length * (LATE_FONT_PATH + "?n=7").length === before.app.replace(/https:\/\/fonts\.googleapis\.com\/css2\?[^"')\s]+/g, "").length, "...and changes nothing else");
ok(read("golsz-app.html") === before.app && read("js/app.js") === bundle, "the page and the bundle on disk are untouched by it");

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
