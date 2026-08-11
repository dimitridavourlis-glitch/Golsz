// An unrecognised intent must never silently become the slow path.
//
// THE FAILURE THIS GUARDS (2026-08-11, found in production data)
// Adding "is_correction":true|false to the classifier's JSON contract made the
// model start emitting it as an INTENT. scout_routing_log has real rows with
// intent = 'is_correction'.
//
// Nothing errored. But 'is_correction' is in none of HAIKU_INTENTS,
// FAQ_ELIGIBLE_INTENTS or CACHE_ELIGIBLE_INTENTS, so every affected message
// lost the cheap model, the $0 FAQ answer and the cache in one go, and took
// the ~25s Sonnet path instead. Measured that day: sonnet averaged 25-27s
// against haiku's 12.7s and the $0 path's 2.5s, with a 48.6s maximum against
// a 50s budget. The only symptom anyone could see was "Scout is slow".
//
// The lesson is the routing shape, not this one field: an intent the router
// does not recognise fails toward the most expensive, slowest path, silently.
// Any future field added beside `intent` can do this again.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};
function slice(a, b, label) {
  const i = SCOUT.indexOf(a), j = SCOUT.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error(`could not slice ${label} — markers moved`);
  return SCOUT.slice(i, j);
}

// Consts and the function that closes over them must come out in one eval.
eval(slice("const KNOWN_INTENTS = new Set(", "async function classifyIntent", "intent guard"));
if (typeof normalizeClassification !== "function") throw new Error("normalizeClassification did not extract");

// `const` does not leak out of a direct eval — normalizeClassification closes
// over KNOWN_INTENTS, but this scope cannot name it. Read the members out of
// the source literal instead of retyping them, so the two can never drift.
const KNOWN_SRC = slice("const KNOWN_INTENTS = new Set([", "]);", "known intents literal");
const KNOWN_INTENTS = new Set(KNOWN_SRC.match(/"[a-z_]+"/g).map((s) => s.replace(/"/g, "")));
if (KNOWN_INTENTS.size < 5) throw new Error("KNOWN_INTENTS parse failed");

const quiet = () => { const o = console.log; console.log = () => {}; return () => { console.log = o; }; };

// ---- the exact production row -------------------------------------------
{
  const restore = quiet();
  const out = normalizeClassification({ intent: "is_correction", confidence: 0.9, faq_id: null });
  restore();
  ck("'is_correction' is no longer accepted as an intent", out.intent === "is_correction", false);
  ck("...it becomes a real intent", out.intent, "career_advice");
  ck("...and the signal it was actually giving is preserved", out.is_correction, true);
  ck("...so the correction gate still sees it", out.is_correction === true, true);
}

// ---- any unknown intent is repaired, not passed through ------------------
{
  for (const bogus of ["needs_tool", "correction", "unknown", "CareerAdvice", "faq_id"]) {
    const restore = quiet();
    const out = normalizeClassification({ intent: bogus, confidence: 0.9 });
    restore();
    ck(`unknown intent "${bogus}" is repaired`, KNOWN_INTENTS.has(out.intent), true);
  }
}

// ---- every real intent passes through untouched --------------------------
for (const good of [...KNOWN_INTENTS]) {
  const out = normalizeClassification({ intent: good, confidence: 0.9, faq_id: 3 });
  ck(`real intent survives untouched: ${good}`, out.intent, good);
  ck(`...and nothing else is rewritten: ${good}`, out.faq_id, 3);
}

// ---- it must not crash on the shapes the caller can actually pass --------
ck("null is passed through", normalizeClassification(null), null);
ck("a classifier error object is untouched", normalizeClassification({ error: "boom" }).error, "boom");
ck("a missing intent is left alone", normalizeClassification({ confidence: 1 }).intent, undefined);

// ---- the repaired intent must be routable, and must not be free ---------
// career_advice is the deliberate default: personalised, so it can never be
// answered from the FAQ or the cache, but it still respects the per-plan tier
// cap rather than pinning the message to the most expensive model.
const faqSet = slice("const FAQ_ELIGIBLE_INTENTS", "\n", "faq set");
const cacheSet = slice("const CACHE_ELIGIBLE_INTENTS", "\n", "cache set");
ck("the default intent is not FAQ-eligible", /career_advice/.test(faqSet), false);
ck("the default intent is not cache-eligible", /career_advice/.test(cacheSet), false);

// ---- the prompt must not invite the leak again --------------------------
const CLASSIFIER_OPEN = "const CLASSIFIER_SYSTEM = `";
const _cs = SCOUT.indexOf(CLASSIFIER_OPEN) + CLASSIFIER_OPEN.length;
let _ce = _cs;
while (_ce < SCOUT.length) { if (SCOUT[_ce] === "`" && SCOUT[_ce - 1] !== "\\") break; _ce++; }
const CLASSIFIER = SCOUT.slice(_cs, _ce);
if (CLASSIFIER.length < 2000) throw new Error("CLASSIFIER_SYSTEM extraction failed");
ck("the prompt says is_correction is not an intent",
   /IS A SEPARATE BOOLEAN FLAG, NOT AN INTENT/.test(CLASSIFIER), true);
ck("...and says so imperatively too",
   /Never put "is_correction" in the "intent" field/.test(CLASSIFIER), true);

// ---- the statement-form escalation is scoped again ----------------------
// Escalating on every mention of a club sent ordinary conversation to the
// ~25s path. Correctness is carried by the SYSTEM_PROMPT ban on stating an
// unverified level, not by forcing a search.
ck("a bare mention no longer forces a lookup",
   /does NOT, because the honest reply there simply repeats the name without classifying it/.test(CLASSIFIER), true);
ck("...but a question about standing still does",
   /is that a step up\?" does/.test(CLASSIFIER), true);
ck("...and the cost of over-escalating is recorded",
   /pushed normal chat onto the ~25s model/.test(CLASSIFIER), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
