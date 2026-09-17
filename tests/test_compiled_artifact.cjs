// THE COMPILED CLIENT MATCHES THE SOURCE IT CAME FROM.
//
// golsz-app.html still holds the JSX — 21 suites slice real expressions out of
// it — but the browser no longer compiles it. It loads js/app.js, which is
// generated. That creates exactly one new way to ship a broken app: edit the
// JSX, forget to recompile, and every athlete runs yesterday's code while every
// other suite passes, because every other suite reads the JSX.
//
// So the generator writes the sha of the block it compiled into the artifact's
// header, and this asserts it still matches. It is the cheap check; the
// expensive one (recompile and compare bytes) runs under GOLSZ_FULL_COMPILE=1.
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const APPJS = fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8");
const pre = require(path.join(REPO, "tools", "precompile.cjs"));

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

console.log("-- the artifact is the source, compiled --");
const jsx = pre.extract(HTML);
const stamped = (APPJS.match(/^\/\/ source-sha: ([0-9a-f]{16})$/m) || [])[1];
ck("the artifact records which source it came from", typeof stamped, "string");
// THE GATE. If this fails, someone edited the JSX and did not run
// `npm run compile` — the app in the browser is not the app in the file.
ck("...and that source is the JSX currently in golsz-app.html", stamped, pre.sha(jsx));

console.log("\n-- the browser is not asked to compile anything --");
// The TAG, not the word — a source comment explaining what was removed is not
// a script that loads 2.9MB of compiler.
ck("babel-standalone is no longer loaded",
   /<script[^>]+babel-standalone[^>]*>/.test(HTML), false);
ck("nothing calls transformScriptTags", /transformScriptTags/.test(HTML), false);
// The filter existed only to hide Babel's own warning; keeping it would mean
// silently swallowing real console.warn/error calls forever.
ck("the babel console-warning filter is gone", /in-browser Babel transformer/.test(HTML), false);
ck("the page loads the compiled bundle instead", /js\/app\.js\?v=[0-9a-f]{16}/.test(HTML), true);
ck("the compiled bundle is real JSX output", /React\.createElement\(/.test(APPJS), true);
// A browser with no module loader cannot resolve an import. The automatic
// runtime emits one, and the failure is a white screen.
ck("no automatic-runtime import leaked in", /jsx-runtime|jsx-dev-runtime/.test(APPJS), false);

console.log("\n-- the cache buster tracks the bytes --");
const served = (HTML.match(/js\/app\.js\?v=([0-9a-f]{16})/) || [])[1];
ck("the query string matches the artifact it serves", served, pre.sha(APPJS));
ck("...and every reference to it agrees",
   [...new Set([...HTML.matchAll(/js\/app\.js\?v=([0-9a-f]{16})/g)].map((m) => m[1]))].length, 1);

console.log("\n-- failure is visible, not an eternal loading bar --");
// The worst failure this page can have is a running animation that never ends,
// because it is indistinguishable from "slow" and the athlete just waits.
ck("a bundle that fails to load says so", /s\.onerror = function \(\) \{ bootFailed\("load"\); \};/.test(HTML), true);
ck("...and so does one that loads but never mounts", /bootFailed\("timeout"\)/.test(HTML), true);
ck("the failure state offers a reload", /location\.reload\(\)/.test(HTML), true);

console.log("\n-- the compiler cannot drift --");
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
// A caret would let another machine produce different bytes from unchanged
// source and fail this gate on a repo nobody touched.
ck("@babel/standalone is pinned exact", /^\d+\.\d+\.\d+$/.test(pkg.devDependencies["@babel/standalone"]), true);

if (process.env.GOLSZ_FULL_COMPILE === "1") {
  console.log("\n-- full recompile (GOLSZ_FULL_COMPILE=1) --");
  const fresh = pre.compile(jsx);
  ck("recompiling this source reproduces the committed artifact byte for byte",
     fresh === APPJS.slice(APPJS.indexOf("\n", APPJS.indexOf("source-sha")) + 1), true);
} else {
  console.log("\n   (set GOLSZ_FULL_COMPILE=1 to recompile and compare bytes)");
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
