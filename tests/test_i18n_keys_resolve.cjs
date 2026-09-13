// EVERY t("key") IN THE APP RESOLVES TO A REAL STRING.
//
// The dictionaries were already checked for parity — all four languages carry
// the same keys — and that is a different question from the one that actually
// breaks a screen. Parity says the four dictionaries agree; it says nothing
// about whether the code asks for a key that any of them contain.
//
// Caught in the wild 2026-09-13: a new day-editor button shipped calling
// t("pathway_add"), a key that never existed. The dictionaries were in perfect
// parity, every suite was green, and the button rendered the literal text
// "pathway_add" to the athlete. A missing key is invisible to a parity check
// by construction, because it is missing from all four equally.
const fs = require("fs");
const path = require("path");
const APP = fs.readFileSync(path.join(__dirname, "..", "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// The English dictionary is the source of truth for WHICH keys exist; the
// parity suite already guarantees the other three match it.
const enStart = APP.indexOf("const I18N = {");
const enBlock = APP.slice(enStart, APP.indexOf("\n  fr: {", enStart));
ck("the English dictionary was found", enBlock.length > 20000, true);
const defined = new Set([...enBlock.matchAll(/(?:^|[{,]\s*)([a-z][a-z0-9_]*)\s*:/gm)].map((m) => m[1]));
ck("it holds a realistic number of keys", defined.size > 500, true);

// Only literal, single-argument calls can be checked statically. Computed keys
// — t("pathway_type_" + x) — are the other suites' problem, not this one.
const asked = new Set([...APP.matchAll(/\bt\(\s*"([a-z][a-z0-9_]*)"\s*\)/g)].map((m) => m[1]));
ck("a realistic number of literal lookups were found", asked.size > 200, true);

const missing = [...asked].filter((k) => !defined.has(k)).sort();
ck("every literal t() key exists in the dictionary", missing, []);

// The reverse is deliberately NOT an error: keys are legitimately reached by
// computed lookup, so an "unused" key is usually a false positive. Counted
// only so a sudden jump is visible.
console.log(`   ${asked.size} literal lookups, ${defined.size} keys defined`);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
