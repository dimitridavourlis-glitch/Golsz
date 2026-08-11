// Every suite's slice anchors must still exist in the source it reads.
//
// WHY THIS EXISTS
// These suites extract the functions under test out of api/scout.js and
// golsz-app.html at run time, by slicing between string anchors. When a
// refactor renames the thing an anchor points at, indexOf() returns -1 and
// slice(-1, n) yields garbage. There is no error. The suite either throws
// something unrelated, or — far worse — evaluates the wrong code and reports
// green.
//
// This has happened three times in this repo:
//   • ~24 assertions in launch_p0 / triage_readiness ran against an empty
//     string while printing PASS (fixed with the backtick-walk + promptSlice)
//   • test_pricing sliced to "function hasFeature(" after that function was
//     replaced, and evaluated a large trailing chunk of golsz-app.html. It
//     only failed because the garbage happened to be unparseable — an anchor
//     landing mid-function would have produced valid, wrong code and passed
//   • test_entitlement_parity hit the same rename and threw a clear message,
//     because it had a guard. That is the difference this file generalises.
//
// Rather than adding a guard to each of ~30 suites — a large mechanical edit
// with real risk of breaking working files — this checks every suite at once,
// including suites written after today.
//
// WHAT IT DOES NOT CATCH, stated so the green is not over-read:
//   • uniqueness. An anchor that occurs twice silently takes the first
//     occurrence; existence is all that is verified here.
//   • that a slice ENDS where the author meant, only that both ends exist.
//   • anchors built by string concatenation or held in variables.
// So a pass means "no anchor is dead", not "every extraction is correct".

const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// Every file a suite could plausibly read.
const SOURCES = {};
for (const d of ["api"]) {
  for (const n of fs.readdirSync(path.join(REPO, d))) {
    if (n.endsWith(".js")) SOURCES[n] = fs.readFileSync(path.join(REPO, d, n), "utf8");
  }
}
for (const n of fs.readdirSync(REPO)) {
  if (n === "golsz-app.html" || n === "supabase-schema.sql" || /^supabase-migration-.*\.sql$/.test(n)) {
    SOURCES[n] = fs.readFileSync(path.join(REPO, n), "utf8");
  }
}
const ALL_SOURCE = Object.values(SOURCES).join("\n");

// Anchors appear in two shapes across these suites:
//   SRC.indexOf("literal")            — direct
//   slice("from", "to")               — via a local helper
const RECEIVER = "(?:APP|SCOUT|SCHEMA|MIG|SRC|PROMPT|CLASSIFIER|MOD|HTML|FILE|TXT|CODE)";
const HELPER = "(?:slice|promptSlice|sliceOf|between|section|grab|extract)";
const PATTERNS = [
  new RegExp(RECEIVER + '\\.(?:last)?[iI]ndexOf\\(\\s*"([^"\\\\]{6,})"', "g"),
  new RegExp(RECEIVER + "\\.(?:last)?[iI]ndexOf\\(\\s*'([^'\\\\]{6,})'", "g"),
  new RegExp(HELPER + '\\(\\s*"([^"\\\\]{6,})"\\s*(?:,\\s*"([^"\\\\]{6,})")?', "g"),
  new RegExp(HELPER + "\\(\\s*'([^'\\\\]{6,})'\\s*(?:,\\s*'([^'\\\\]{6,})')?", "g"),
];

const suites = fs.readdirSync(path.join(REPO, "tests"))
  .filter((n) => n.startsWith("test_") && n.endsWith(".cjs") && n !== path.basename(__filename))
  .sort();

if (suites.length < 20) throw new Error(`only found ${suites.length} suites — this file is not scanning what it thinks it is`);

let checked = 0;
const dead = [];
for (const name of suites) {
  const t = fs.readFileSync(path.join(REPO, "tests", name), "utf8");

  // Scope the search to the files this suite actually reads. Falling back to
  // every source would let a suite "pass" on an anchor that exists in some
  // unrelated file — the same class of false negative this file is about.
  const reads = [...t.matchAll(/readFileSync\([^)]*?["']([^"']+)["']/g)].map((m) => path.basename(m[1]));
  const pool = reads.length ? reads.map((b) => SOURCES[b] || "").join("\n") : ALL_SOURCE;

  const literals = new Set();
  for (const re of PATTERNS) {
    for (const m of t.matchAll(re)) {
      for (const g of m.slice(1)) if (g) literals.add(g);
    }
  }
  for (const lit of literals) {
    checked++;
    if (!pool.includes(lit)) dead.push({ suite: name, lit });
  }
}

console.log(`   scanned ${suites.length} suites, ${checked} anchor literals`);
ck("every slice anchor still exists in the source its suite reads",
   dead.map((d) => `${d.suite}: ${d.lit.slice(0, 60)}`), []);
// A scan that finds nothing because its patterns stopped matching is the same
// failure this file guards against, one level up.
ck("the scan actually found anchors to check", checked > 100, true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
