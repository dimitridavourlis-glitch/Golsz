// The response cache must never replay advice generated under a different
// subscription state.
//
// Production, 2026-08-11: "Which GOLSZ plan do I actually need?" classified
// as simple_knowledge, so it was cached — but the model had answered it from
// the athlete's live record. After the account moved to Elite the identical
// question replayed the Free-era reply, opening "You're on Free right now".
// Personalized advice served under a plan that no longer existed.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
let p = 0, f = 0;
const ck = (l, a, e) => { const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); } else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); } };
const i = SCOUT.indexOf("function responseCacheFingerprint"), j = SCOUT.indexOf("async function getCachedResponse");
if (i < 0 || j < 0) throw new Error("cache helpers not found");
eval(SCOUT.slice(i, j));

const STATE = { pathwayComplete: false, pathwayType: "professional", targetsCount: 0,
  readiness: { composite: 54, performance: { metricsTracked: 2 }, development: { total: 0 } } };
const key = (plan, goal, st) => cacheKeyFor("simple_knowledge", "Which GOLSZ plan do I actually need?", "en", "economy",
  responseCacheFingerprint(plan, goal, st));

// ---- plan is in the key --------------------------------------------------
const free = key("free", "MLS contract", STATE);
for (const plan of ["starter", "pro", "elite"]) {
  ck(`free and ${plan} cannot share a cache entry`, key(plan, "MLS contract", STATE) === free, false);
}
ck("every tier produces a distinct key",
   new Set(["free", "starter", "pro", "elite"].map((pl) => key(pl, "MLS contract", STATE))).size, 4);
ck("the same athlete on the same plan still hits cache", key("free", "MLS contract", STATE), free);

// ---- other state that changes personalized advice ------------------------
const variants = {
  "goal text": key("free", "NCAA Division 1 scholarship", STATE),
  "pathway completeness": key("free", "MLS contract", { ...STATE, pathwayComplete: true }),
  "pathway category": key("free", "MLS contract", { ...STATE, pathwayType: "ncaa" }),
  "targets existing": key("free", "MLS contract", { ...STATE, targetsCount: 4 }),
  "benchmarks tracked": key("free", "MLS contract", { ...STATE, readiness: { ...STATE.readiness, performance: { metricsTracked: 0 } } }),
  "development plan": key("free", "MLS contract", { ...STATE, readiness: { ...STATE.readiness, development: { total: 3 } } }),
  "readiness score": key("free", "MLS contract", { ...STATE, readiness: { ...STATE.readiness, composite: 72 } }),
};
for (const [what, k] of Object.entries(variants)) ck(`${what} changes the key`, k === free, false);
ck("all state variants are mutually distinct", new Set([free, ...Object.values(variants)]).size, 8);

// ---- degenerate inputs ---------------------------------------------------
ck("no state does not throw", typeof key("free", null, null), "string");
ck("missing plan defaults to free, not to a shared bucket",
   responseCacheFingerprint(null, "g", STATE).startsWith("free|"), true);
ck("plan is the FIRST component of the fingerprint",
   responseCacheFingerprint("pro", "g", STATE).startsWith("pro|"), true);

// ---- last line of defence ------------------------------------------------
for (const tier of ["Free", "Basic", "Pro", "Elite"]) {
  ck(`a reply naming ${tier} is never written to cache`,
     replyIsPlanSpecific({ reply_text: `That opens on ${tier}.` }), true);
}
ck("ordinary advice is still cacheable",
   replyIsPlanSpecific({ reply_text: "Work change of direction twice a week." }), false);
ck("a missing reply is not treated as plan-specific", replyIsPlanSpecific({}), false);

// ---- wiring --------------------------------------------------------------
ck("the call site passes the fingerprint",
   /cacheKeyFor\(classification\.intent, latestText, faqLang, modelTier, cacheFingerprint\)/.test(SCOUT), true);
ck("the fingerprint is computed from live state",
   /cacheFingerprint = responseCacheFingerprint\(plan, goalText, athleteState\)/.test(SCOUT), true);
ck("plan-specific replies are gated at write time",
   /&& !replyIsPlanSpecific\(data\)\) await setCachedResponse/.test(SCOUT), true);
ck("the summary digest is untouched (memory architecture)",
   /function athleteStateDigest\(state, plan, goalDefined\) \{/.test(SCOUT), true);
ck("cache eligibility is still intent-limited", /CACHE_ELIGIBLE_INTENTS = new Set\(\["simple_knowledge"\]\)/.test(SCOUT), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
