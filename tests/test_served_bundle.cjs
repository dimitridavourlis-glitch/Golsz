// WHAT THE ATHLETE ACTUALLY DOWNLOADS.
//
// The app's source is golsz-app.jsx. The page, golsz-app.html, used to carry it
// too, inside an inert <script type="text/babel-deferred"> block that no browser
// runs: 1.45 MB of the 1.5 MB page. Vercel's build stripped it (and lifted the
// French, Spanish and Greek dictionaries out of js/app.js), but the repo itself
// served the unstripped files, so the app measured here was not the one on
// golsz.com: AVA's speed check, which serves the repo uncompressed on a phone
// network, saw the sign-up screen after 5.2 s. Since 2026-11-14 (AVA job 216)
// the repo holds what production serves and Vercel's build compiles nothing.
//
// What has to hold, and what this file holds:
//   1. the page carries no source, and the source is still in the repo
//   2. the deploy serves what the gate checked: no build step after it
//   3. js/app.js is English only, and each other language is its own file that
//      the loader fetches only for a reader of that language
//   4. the page can still start itself
//
// The repo's own files are never modified by this suite.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { appSource, OPEN, MARKER } = require("./_app_source.cjs");
const pre = require("../tools/precompile.cjs");

const REPO = path.join(__dirname, "..");
const PAGE = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const JSX = fs.readFileSync(path.join(REPO, "golsz-app.jsx"), "utf8");
const APPJS = fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8");
const APP = appSource();

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

/* ---------- 1. the page carries no source; the repo still does ---------- */

ck("the page has no JSX block", PAGE.indexOf("text/babel"), -1);
ck("...it keeps one line saying where the source is", PAGE.split(MARKER).length, 2);
// The whole point, measured rather than asserted in the abstract: the page was
// 1,511,299 bytes. Anything near that again means source crept back in.
ck("the page is under 40 KB", Buffer.byteLength(PAGE) < 40000, true);
ck("the source is in golsz-app.jsx", JSX.length > 500000 && /function GolszApp\(/.test(JSX) && /function Auth\(/.test(JSX), true);
// The suites read the two together; this is the text they slice.
ck("appSource() rebuilds one block of source in the page", APP.split(OPEN).length, 2);

/* ---------- 2. what is served is what the gate checked ---------- */

const vercel = JSON.parse(fs.readFileSync(path.join(REPO, "vercel.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const B = vercel.buildCommand;
ck("the build gates first", B.indexOf("npm run check"), 0);
// No compile, split or strip on Vercel: a deploy-time build is how the repo came
// to serve a different app from production's. The gate fails a stale js/app.js
// (test_compiled_artifact), so the committed files are the ones to serve.
ck("...and builds nothing after the gate", /compile|split|strip/.test(B), false);
ck("the old deploy-time scripts are gone", [pkg.scripts.split, pkg.scripts.strip], [undefined, undefined]);
ck("...and so are their tools", ["split-i18n.cjs", "strip-jsx.cjs"].map((n) => fs.existsSync(path.join(REPO, "tools", n))), [false, false]);
ck("`compile` builds the app", pkg.scripts.compile, "node tools/precompile.cjs");
ck("the gate syntax-checks the dictionaries too", /js\/i18n\/\*\.js/.test(pkg.scripts.check), true);
ck("Vercel serves the repo root, so the committed page is the served page", vercel.outputDirectory, ".");
ck("the dictionaries are committed, not ignored",
   /^js\/i18n\/?$/m.test(fs.readFileSync(path.join(REPO, ".gitignore"), "utf8")), false);

/* ---------- 3. one language in the bundle, the others on request ---------- */

// The merge hook is what makes a lifted dictionary reachable. Without it the
// files would be fetched and never read: three languages silently English.
ck("the source merges whatever the loader fetched", JSX.includes(pre.MERGE_HOOK), true);
const lifted = pre.liftDictionaries(JSX);
const dictOf = (body) => vm.runInNewContext("({\n" + body + "\n})");
for (const lang of pre.LIFTED) {
  const file = path.join(REPO, "js", "i18n", lang + ".js");
  ck(`js/i18n/${lang}.js exists`, fs.existsSync(file), true);
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox);
  const got = sandbox.window.__GOLSZ_I18N && sandbox.window.__GOLSZ_I18N[lang];
  const want = dictOf(lifted.dictionaries[lang]);
  ck(`...and sets every ${lang} key the source has`, got && Object.keys(got).length, Object.keys(want).length);
  ck(`...with the source's words`, got && got.goal_setup_title, want.goal_setup_title);
  // The bundle must not carry this language: that was the 69 KB (gzipped) every
  // reader of English downloaded for nothing.
  ck(`js/app.js does not carry the ${lang} dictionary`, APPJS.includes(JSON.stringify(want.goal_setup_title).slice(1, -1)), false);
}
ck("English stays in the bundle (every other language falls back to it)",
   APPJS.includes(dictOf(lifted.jsx.slice(lifted.jsx.indexOf("\n  en: {\n") + 9, lifted.jsx.indexOf("\n  },\n", lifted.jsx.indexOf("\n  en: {\n")))).goal_setup_title), true);
// A dictionary that fails to arrive must still produce a working app.
ck("a failed dictionary load still boots the app", /d\.onerror = loadApp;/.test(PAGE), true);
ck("...and a missing key falls back to English rather than rendering its name",
   /key in I18N\.en \? I18N\.en\[key\] : key/.test(JSX), true);
// One version string for both files, or a fresh bundle eventually pairs with a
// dictionary cached from an older deploy - silently, because it just falls back.
ck("the dictionary's cache-buster derives from the bundle's",
   /var BUILD = APP_SRC\.slice\(APP_SRC\.indexOf\("\?v="\) \+ 3\);/.test(PAGE), true);
ck("...and is used for the dictionary URL",
   /d\.src = "js\/i18n\/" \+ want \+ "\.js\?v=" \+ BUILD;/.test(PAGE), true);
ck("...and English readers fetch no dictionary at all", /if \(want === "en"\) \{ loadApp\(\); return; \}/.test(PAGE), true);

/* ---------- 4. the page can still start itself ---------- */

ck("the page has its stylesheet", PAGE.indexOf("<style>") > -1, true);
ck("...its mount point", /id="root"/.test(PAGE), true);
ck("...and the loader that fetches the bundle", /var APP_SRC = "js\/app\.js\?v=[0-9a-f]{16}";/.test(PAGE), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
