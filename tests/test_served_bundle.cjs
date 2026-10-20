// WHAT THE ATHLETE ACTUALLY DOWNLOADS.
//
// golsz-app.html carries the whole app as JSX in a
// <script type="text/babel-deferred"> block. No browser executes that type,
// and babel-standalone has not been loaded since precompile started building
// at author time — so every visitor was downloading ~393KB gzipped of source
// the browser parses as an opaque text node and discards, and THEN js/app.js
// to get the same code in runnable form. Roughly half of a 730KB first load.
//
// The block is the SOURCE: precompile builds from it and 100+ suites assert
// against it, so it stays in the repo and is removed at build time instead.
// That split only works if two things hold, and this file holds them:
//
//   1. the committed file still HAS the block — otherwise the program is gone
//   2. the stripper produces a page that can still boot
//
// (2) is checked by running the real stripper over a COPY in a temp dir. The
// repo's own files are never touched by this suite.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const OPEN = '<script type="text/babel-deferred" data-presets="react">';

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

/* ---------- 1. the source is still in the repo ---------- */

// If this ever fails, someone has committed a stripped file and the program's
// source is gone from version control. It is the reason stripping can be a
// build step at all.
ck("the committed page still carries its source", APP.indexOf(OPEN) > -1, true);
ck("...and precompile can still find the end of it",
   APP.indexOf("</script>", APP.indexOf(OPEN) + OPEN.length) > -1, true);

/* ---------- 2. the build is wired to strip ---------- */

const vercel = JSON.parse(fs.readFileSync(path.join(REPO, "vercel.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
// ORDER, not a literal string. The build grew a step and pinning the exact
// command made this fail for a change that was correct. What must hold is the
// sequence, and each link is asserted on its own.
const B = vercel.buildCommand;
ck("the build gates first", B.indexOf("check") > -1 && B.indexOf("check") < B.indexOf("strip"), true);
ck("...then lifts the unused languages", B.indexOf("split") > B.indexOf("check"), true);
// compile has to run AFTER split or js/app.js still carries all four
// dictionaries and the lift saves nothing.
ck("...then rebuilds the bundle without them", B.indexOf("compile") > B.indexOf("split"), true);
ck("...and strips the source last", B.indexOf("strip") > B.indexOf("compile"), true);
ck("`strip` is a real script", pkg.scripts.strip, "node tools/strip-jsx.cjs");
ck("`split` is a real script", pkg.scripts.split, "node tools/split-i18n.cjs");

/* ---------- the language split ---------- */

// The merge hook is what makes a lifted dictionary reachable. Without it the
// split would write three files nothing reads and three languages would
// silently become English - a regression with no error anywhere.
// Matched by regex, not a quoted indexOf: the literal contains its own double
// quotes, and test_anchor_integrity's parser truncates an anchor at the first
// one, leaving a prefix that matches ambiguously.
ck("the source merges whatever the loader fetched",
   /Object\.assign\(I18N, \(typeof window !== "undefined" && window\.__GOLSZ_I18N\) \|\| \{\}\);/.test(APP), true);
// English is never lifted: it is the fallback every other language leans on.
ck("English stays in the bundle", /\n  en: \{\n/.test(APP), true);
for (const lang of ["fr", "es", "el"]) {
  ck(`${lang} is still in the repo for the suites to read`, new RegExp("\\n  " + lang + ": \\{\\n").test(APP), true);
}
// A dictionary that fails to arrive must still produce a working app.
ck("a failed dictionary load still boots the app", /d\.onerror = loadApp;/.test(APP), true);
ck("...and a missing key falls back to English rather than rendering its name",
   /key in I18N\.en \? I18N\.en\[key\] : key/.test(APP), true);
// One version string for both files, or a fresh bundle eventually pairs with
// a dictionary cached from an older deploy - silently, because a stale
// dictionary just falls back.
ck("the dictionary's cache-buster derives from the bundle's",
   /var BUILD = APP_SRC\.slice\(APP_SRC\.indexOf\("\?v="\) \+ 3\);/.test(APP), true);
ck("...and is used for the dictionary URL",
   /d\.src = "js\/i18n\/" \+ want \+ "\.js\?v=" \+ BUILD;/.test(APP), true);
ck("generated dictionaries are not committed",
   fs.readFileSync(path.join(REPO, ".gitignore"), "utf8").indexOf("js/i18n/") > -1, true);
ck("Vercel serves the repo root, so the stripped file is the served file",
   vercel.outputDirectory, ".");

/* ---------- 3. the stripper's output can still boot ---------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golsz-strip-"));
fs.mkdirSync(path.join(tmp, "js"));
fs.copyFileSync(path.join(REPO, "golsz-app.html"), path.join(tmp, "golsz-app.html"));
fs.copyFileSync(path.join(REPO, "js", "app.js"), path.join(tmp, "js", "app.js"));

let out = "";
try {
  out = execFileSync("node", [path.join(REPO, "tools", "strip-jsx.cjs"),
    path.join(tmp, "golsz-app.html"), path.join(tmp, "js", "app.js")], { encoding: "utf8" });
} catch (e) { out = "THREW: " + (e.stderr || e.message); }
ck("the stripper runs", /^strip: removed \d+ chars/.test(out), true);

const stripped = fs.readFileSync(path.join(tmp, "golsz-app.html"), "utf8");
ck("the JSX is gone", stripped.indexOf(OPEN), -1);
// Everything the page needs to start itself is outside the block.
ck("...the stylesheet is not", stripped.indexOf("<style>") > -1, true);
ck("...nor the mount point", /id="root"/.test(stripped), true);
ck("...nor the loader that fetches the bundle", /js\/app\.js\?v=/.test(stripped), true);
// The loader's cache-buster must still name the bundle that was built.
const vRepo = (APP.match(/js\/app\.js\?v=([a-f0-9]+)/) || [])[1];
const vStr = (stripped.match(/js\/app\.js\?v=([a-f0-9]+)/) || [])[1];
ck("...pointing at the same bundle as before", vStr, vRepo);

// The whole point, measured rather than asserted in the abstract.
ck("the served page is at least 95% smaller", stripped.length < APP.length * 0.05, true);

// Running twice is a no-op, not a failure: Vercel may build the same tree more
// than once, and a second pass must not error the deploy.
let again = "";
try {
  again = execFileSync("node", [path.join(REPO, "tools", "strip-jsx.cjs"),
    path.join(tmp, "golsz-app.html"), path.join(tmp, "js", "app.js")], { encoding: "utf8" });
} catch (e) { again = "THREW: " + (e.stderr || e.message); }
ck("stripping twice is a no-op", /nothing to do/.test(again), true);

/* ---------- 4. it refuses to strip a stale bundle ---------- */

// If someone edits the JSX and deploys without recompiling, stripping would
// serve the OLD bundle with no error anywhere — the new code would simply not
// exist, and nothing would say so. The stripper must refuse.
fs.copyFileSync(path.join(REPO, "golsz-app.html"), path.join(tmp, "golsz-app.html"));
fs.writeFileSync(path.join(tmp, "js", "app.js"), "// source-sha: 0000000000000000\n");
let refused = "";
try {
  execFileSync("node", [path.join(REPO, "tools", "strip-jsx.cjs"),
    path.join(tmp, "golsz-app.html"), path.join(tmp, "js", "app.js")], { encoding: "utf8", stdio: "pipe" });
  refused = "DID NOT REFUSE";
} catch (e) { refused = String(e.stderr || ""); }
ck("a bundle built from different source is refused", /was not built from this JSX/.test(refused), true);
ck("...and the page is left intact when it refuses",
   fs.readFileSync(path.join(tmp, "golsz-app.html"), "utf8").indexOf(OPEN) > -1, true);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
