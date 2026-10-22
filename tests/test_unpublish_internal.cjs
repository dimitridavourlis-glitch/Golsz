// THE REPO'S WORKING PAPERS MUST NOT BE PUBLIC URLS ON GOLSZ.COM.
//
// vercel.json serves the whole checkout (outputDirectory "."), so CLAUDE.md,
// the migrations, supabase-schema.sql, tests/ and tools/ were all fetchable
// (verified live 2026-10-22). tools/unpublish-internal.cjs removes them as the
// LAST step of the Vercel build, after the gate has passed.
//
// What has to hold, and what this file holds:
//   1. the build runs it last, and `unpublish` is a real script
//   2. run for real over a COPY, the internal paths are gone and every file
//      the product needs is still there, api/ included (deleting api/ at build
//      time would delete the serverless functions)
//   3. nothing a visitor's browser can request points at a removed path
//   4. it refuses to run in a working checkout, so `npm run unpublish` cannot
//      delete the repo's docs by accident
//
// The repo's own files are never modified by this suite.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.join(__dirname, "..");
const TOOL = path.join(REPO, "tools", "unpublish-internal.cjs");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) p++; else { f++; console.log(`FAIL  ${l}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(e)}`); }
};

/* ---------- 1. wired last ---------- */

const vercel = JSON.parse(fs.readFileSync(path.join(REPO, "vercel.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const B = vercel.buildCommand;
ck("`unpublish` is a real script", pkg.scripts.unpublish, "node tools/unpublish-internal.cjs");
ck("the build runs it", B.includes("npm run unpublish"), true);
ck("...after the gate", B.indexOf("npm run unpublish") > B.indexOf("npm run check"), true);
ck("...after strip, so nothing it removes is needed by a later step", B.indexOf("npm run unpublish") > B.indexOf("npm run strip"), true);
ck("...and it is the last step", B.trim().endsWith("npm run unpublish"), true);

/* ---------- 2. run for real, over a copy ---------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "golsz-unpublish-"));
fs.cpSync(REPO, tmp, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(REPO, src);
    return rel !== "node_modules" && rel !== ".git" && !rel.startsWith("node_modules" + path.sep) && !rel.startsWith(".git" + path.sep);
  },
});
const apiBefore = fs.readdirSync(path.join(tmp, "api")).sort();
const run = (args, env) => spawnSync("node", [TOOL, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const first = run([tmp], {});
ck("it runs cleanly over a copy", first.status, 0);

const exists = (rel) => fs.existsSync(path.join(tmp, rel));
for (const gone of ["CLAUDE.md", "AGENTS.md", "AI_HANDOFF.md", "README.md", "ADS-BUILD-ORDER.md", "SETUP.md",
  "opencode.json", "supabase-schema.sql", "supabase-migration-026-push-webhook-triggers.sql",
  "supabase-migration-160-passport-parity-and-append-only.sql", "supabase-migrations-096-101-COMBINED.sql",
  "tests", "tools", "golsz-guard", ".github", ".claude"]) {
  ck(`removed: ${gone}`, exists(gone), false);
}
for (const kept of ["index.html", "about.html", "contact.html", "terms.html", "privacy.html", "golsz-app.html",
  "js/app.js", "js/main.js", "js/landing.js", "css", "assets", "data", "sw.js", "manifest.json", "robots.txt",
  "sitemap.xml", "vercel.json", "package.json", "package-lock.json", "api"]) {
  ck(`kept: ${kept}`, exists(kept), true);
}
ck("every serverless function survives, byte-for-byte listing", fs.readdirSync(path.join(tmp, "api")).sort(), apiBefore);
ck("the repo has serverless functions to lose", apiBefore.length > 12, true);
ck("no migration or schema file is left at the root",
  fs.readdirSync(tmp).filter((n) => /^supabase-/.test(n)), []);
ck("no markdown is left at the root", fs.readdirSync(tmp).filter((n) => /\.md$/i.test(n)), []);
ck("running it twice is a no-op", /nothing to do/.test(run([tmp], {}).stdout), true);

/* ---------- 3. nothing a browser requests points at a removed path ---------- */

const REMOVED = /(^|\/)(CLAUDE|AGENTS|AI_HANDOFF|README|ADS-BUILD-ORDER|SETUP|DESIGN-HANDOFF|SPEC-[\w-]+)\.md$|opencode\.json$|(^|\/)supabase-[\w.-]*\.sql$|^\/?(tests|tools|golsz-guard|\.github|\.claude)\//i;
const served = ["index.html", "about.html", "contact.html", "terms.html", "privacy.html", "golsz-app.html", "golsz-final-look.html"];
let pointers = [];
for (const file of served) {
  const src = fs.readFileSync(path.join(REPO, file), "utf8");
  for (const m of src.matchAll(/\b(?:href|src|action)\s*=\s*["']([^"'#?]+)/gi)) if (REMOVED.test(m[1])) pointers.push(`${file}: ${m[1]}`);
}
const sw = fs.readFileSync(path.join(REPO, "sw.js"), "utf8");
for (const m of sw.matchAll(/["'`](\/?[\w./-]+)["'`]/g)) if (REMOVED.test(m[1])) pointers.push(`sw.js: ${m[1]}`);
const manifest = fs.readFileSync(path.join(REPO, "manifest.json"), "utf8");
for (const m of manifest.matchAll(/"(?:src|start_url|url)"\s*:\s*"([^"]+)"/g)) if (REMOVED.test(m[1])) pointers.push(`manifest.json: ${m[1]}`);
for (const file of ["js/main.js", "js/landing.js", "js/app.js"]) {
  const src = fs.readFileSync(path.join(REPO, file), "utf8");
  for (const m of src.matchAll(/\bfetch\(\s*["'`]([^"'`]+)/g)) if (REMOVED.test(m[1])) pointers.push(`${file}: fetch ${m[1]}`);
}
const appHtml = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
for (const m of appHtml.matchAll(/\bfetch\(\s*["'`]([^"'`]+)/g)) if (REMOVED.test(m[1])) pointers.push(`golsz-app.html: fetch ${m[1]}`);
ck("no served page, worker, manifest or fetch points at a removed path", pointers, []);
ck("the pattern itself matches what it claims to (positive control)",
  [REMOVED.test("/CLAUDE.md"), REMOVED.test("supabase-schema.sql"), REMOVED.test("/tests/run-all.cjs"), REMOVED.test("/js/app.js")],
  [true, true, true, false]);

/* ---------- 4. it will not delete a working checkout ---------- */

const before = fs.existsSync(path.join(REPO, "CLAUDE.md"));
const refused = run([], { VERCEL: "" });
ck("no argument and no VERCEL: refuses", refused.status, 1);
ck("...says why", /refusing to run outside a Vercel build/.test(refused.stderr), true);
ck("...and the repo's own docs are still there", before && fs.existsSync(path.join(REPO, "CLAUDE.md")) && fs.existsSync(path.join(REPO, "tests")), true);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
