// The shared stylesheet and main.js carry no content hash, so they get a short
// cache with revalidation, never immutable. js/app.js (?v= stamped) keeps its
// immutable rule. The CSP must survive these additions untouched.
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const VERCEL = JSON.parse(fs.readFileSync(path.join(REPO, "vercel.json"), "utf8"));
const CLAUDE = fs.readFileSync(path.join(REPO, "CLAUDE.md"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const rules = VERCEL.headers || [];
const cacheOf = (source) => {
  const r = rules.filter((h) => h.source === source);
  const h = r[0] && r[0].headers.find((x) => x.key === "Cache-Control");
  return { count: r.length, value: h && h.value };
};
const SHORT = "public, max-age=3600, stale-while-revalidate=86400";

console.log("-- new short-cache rules --");
ck("/css/(.*) has one rule with the short cache", cacheOf("/css/(.*)"), { count: 1, value: SHORT });
ck("/js/main.js has one rule with the short cache", cacheOf("/js/main.js"), { count: 1, value: SHORT });
ck("neither new rule is immutable", SHORT.includes("immutable"), false);

console.log("\n-- unchanged rules --");
ck("/js/app.js stays immutable for a year", cacheOf("/js/app.js"),
   { count: 1, value: "public, max-age=31536000, immutable" });
ck("only /js/app.js is immutable",
   rules.filter((h) => h.headers.some((x) => /immutable/.test(x.value))).map((h) => h.source),
   ["/js/app.js"]);
const csp = rules.find((h) => h.source === "/((?!api/).*)").headers.find((x) => x.key === "Content-Security-Policy").value;
ck("CSP default-src and script-src intact",
   [csp.startsWith("default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://challenges.cloudflare.com;"),
    csp.includes("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;"),
    csp.includes("font-src 'self' https://fonts.gstatic.com;"),
    csp.endsWith("form-action 'self'")], [true, true, true, true]);

console.log("\n-- vercel.json shape --");
ck("buildCommand unchanged", VERCEL.buildCommand,
   "npm run check && npm run split && npm run compile && npm run strip && npm run unpublish");
ck("outputDirectory is .", VERCEL.outputDirectory, ".");
ck("top-level keys are within the schema",
   Object.keys(VERCEL).every((k) => ["$schema", "buildCommand", "outputDirectory", "redirects", "crons", "headers"].includes(k)), true);
ck("no comment keys in header rules", rules.every((h) => Object.keys(h).every((k) => ["source", "headers"].includes(k))), true);

console.log("\n-- docs --");
ck("CLAUDE.md documents the rules and why not immutable",
   [/max-age=3600,\s+stale-while-revalidate=86400/.test(CLAUDE), /NOT\s+immutable/.test(CLAUDE)], [true, true]);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
