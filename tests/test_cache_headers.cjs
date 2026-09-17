// IMMUTABLE CACHING IS ONLY SAFE FOR A FILE WHOSE NAME CHANGES WITH ITS BYTES.
//
// js/app.js is requested as app.js?v=<sha of its contents>, so a new build is
// a new URL and a year-long cache can never serve a stale one. That is exactly
// what immutable is for, and it saves ~253KB gzip on every repeat open —
// currently re-downloaded every single time because everything is
// must-revalidate.
//
// js/landing.js and js/main.js are referenced from index.html with NO version
// string. Caching those immutably would pin them for a year: a landing-page
// fix would never reach anyone who had visited before, and nothing would say
// so. The first draft of this rule used /js/(.*) and would have done exactly
// that.
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const VERCEL = JSON.parse(fs.readFileSync(path.join(REPO, "vercel.json"), "utf8"));
const HTML = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const INDEX = fs.readFileSync(path.join(REPO, "index.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const immutable = (VERCEL.headers || []).filter((h) =>
  (h.headers || []).some((x) => /immutable/.test(x.value || "")));

console.log("-- only content-hashed files may be immutable --");
ck("exactly one immutable rule exists", immutable.length, 1);
ck("...and it targets js/app.js alone", immutable[0] && immutable[0].source, "/js/app.js");
// THE TRAP. A wildcard here silently pins every unversioned script for a year.
ck("it is not a wildcard over the whole js directory",
   /\(\.\*\)|\*/.test((immutable[0] && immutable[0].source) || ""), false);

console.log("\n-- and the file it targets really is content-hashed --");
ck("golsz-app.html requests app.js with a version hash",
   /js\/app\.js\?v=[0-9a-f]{16}/.test(HTML), true);
// If either of these ever gains a hash, it may join the rule — until then it
// must not.
for (const f2 of ["landing.js", "main.js"]) {
  const refs = [...INDEX.matchAll(new RegExp("js/" + f2.replace(".", "\\.") + "(\\?v=[0-9a-f]+)?", "g"))];
  const hashed = refs.length > 0 && refs.every((m) => !!m[1]);
  ck(`js/${f2} is unversioned, so it must NOT be covered`, hashed, false);
  ck(`...and the immutable rule does not reach it`,
     immutable[0].source === "/js/" + f2, false);
}

console.log("\n-- the HTML itself must stay revalidated --");
// It is the thing that names the hash. Cache the pointer and the hash never
// updates, which is worse than caching nothing.
ck("no rule makes the app HTML immutable",
   immutable.some((h) => /golsz-app|\/\(\(\?!/.test(h.source || "")), false);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
