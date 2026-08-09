// Harness for estimateTierCost/budgetGate cache-aware pricing (api/scout.js).
//
// Rewritten 2026-08-09 after this exact class of bug shipped live: this
// suite used to hand-copy a CFG constant "Live scout_model_config after
// migration 104" instead of reading the real ANTHROPIC_DEFAULTS out of
// api/scout.js — so it kept passing while the actual shipped fallback still
// had advanced/premium max_output_tokens=4096, the exact value migration
// 104 was written to remove. A test that asserts against a copy of the
// truth cannot catch the copy and the truth disagreeing. Same rule as
// tests/README.md: extract, never retype.
//
// The bug itself, found by sending one real message through Scout and
// reading the production logs: scout_model_config had ZERO rows (migration
// 104 was an UPDATE against a table nothing had ever seeded — a silent
// no-op), so getModelConfigByTier() fell back to ANTHROPIC_DEFAULTS, whose
// advanced/premium max_output_tokens was still 4096 — pricing the output
// ceiling ALONE at 4096 x $15/M = $0.0614, which exceeds every plan's
// HARD_MAX_COST_PER_REQUEST except elite's $0.08. budgetGate() therefore
// downgraded advanced/premium to Haiku for free/starter/pro on every
// request, regardless of the actual question's complexity — silently
// defeating "Sonnet for hard questions" for three of four plans.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SRC = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));

// The real fallback config, the real cost formula, the real tier order and
// the real per-plan ceilings — all extracted, not retyped. One contiguous
// slice from TIER_ORDER through the end of estimateTierCost (also pulls in
// complexityScore()/getModelConfigByTier(), unused here, harmless).
//
// A direct eval() leaks FUNCTION declarations into the enclosing scope but
// NOT const/let — that's spec behaviour, not a bug, and it is exactly why
// every other suite in this repo that extracts a const only ever reaches it
// indirectly through an extracted FUNCTION's closure. This test needs the
// constants themselves, so an extractor function is appended to the evaled
// text — the function leaks (getting it out), and it closes over the
// consts from the SAME eval invocation (getting them in).
// estimateTierCost is itself a `function` declaration in the source, so it
// leaks on its own and must NOT also be destructured below — a const
// redeclaring an identifier a function declaration already bound in the
// same scope is a SyntaxError, caught here rather than left as a puzzle.
eval(slice("const TIER_ORDER", "\nasync function budgetGate(") +
  "\nfunction __extractBudgetGateDeps() { return { TIER_ORDER, ANTHROPIC_DEFAULTS, HARD_MAX_COST_PER_REQUEST }; }");
const { TIER_ORDER, ANTHROPIC_DEFAULTS, HARD_MAX_COST_PER_REQUEST } = __extractBudgetGateDeps();

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

console.log("-- the exact regression: ANTHROPIC_DEFAULTS must not be the broken value --");
// Named directly at the numbers, not just at downstream behaviour, so a
// future edit that reintroduces 4096 fails HERE instead of being explained
// away by some other passing assertion.
ck("advanced max_output_tokens is 1024, not the broken 4096",
   ANTHROPIC_DEFAULTS.advanced.max_output_tokens, 1024);
ck("premium max_output_tokens is 2048, not the broken 4096",
   ANTHROPIC_DEFAULTS.premium.max_output_tokens, 2048);
ck("the broken ceiling's own cost alone no longer exceeds every plan",
   (ANTHROPIC_DEFAULTS.advanced.max_output_tokens * ANTHROPIC_DEFAULTS.advanced.output_cost_per_million) / 1e6 <= HARD_MAX_COST_PER_REQUEST.starter, true);

// A synchronous re-implementation of the real (async, DB-backed) budgetGate,
// driven by the REAL extracted CFG/HARD_MAX/formula — this is testing the
// same arithmetic budgetGate() runs, just without a network round trip.
function budgetGateSync(tier, plan, fresh, cached, cfgByTier) {
  const hardMax = HARD_MAX_COST_PER_REQUEST[plan] || HARD_MAX_COST_PER_REQUEST.free;
  let idx = TIER_ORDER.indexOf(tier);
  while (idx > 0) {
    const cfg = cfgByTier[TIER_ORDER[idx]];
    if (estimateTierCost(cfg, fresh, cached, cfg.max_output_tokens) <= hardMax) break;
    idx -= 1;
  }
  return TIER_ORDER[idx];
}

const SYS = 6000, CONVO = 600;   // typical: cached system prompt + short conversation

console.log("\n-- cost of one advanced reply, using the REAL default config --");
console.log("   estimate:", estimateTierCost(ANTHROPIC_DEFAULTS.advanced, CONVO, SYS, ANTHROPIC_DEFAULTS.advanced.max_output_tokens).toFixed(4));

ck("cached input is priced ~10x cheaper than fresh",
   estimateTierCost(ANTHROPIC_DEFAULTS.advanced, 0, 1000, 0).toFixed(6),
   (estimateTierCost(ANTHROPIC_DEFAULTS.advanced, 1000, 0, 0) / 10).toFixed(6));
ck("null cached rate falls back to 10% of base, not free",
   estimateTierCost({ input_cost_per_million: 3, output_cost_per_million: 15, cached_input_cost_per_million: null, max_output_tokens: 1024 }, 0, 1000, 0).toFixed(6),
   "0.000300");

console.log("\n-- gate decisions on a typical conversation, using the config that is ACTUALLY live when the DB table is empty --");
for (const plan of ["free", "starter", "pro", "elite"]) {
  console.log(`   ${plan.padEnd(8)} -> ${budgetGateSync("advanced", plan, CONVO, SYS, ANTHROPIC_DEFAULTS)}`);
}
ck("starter reaches advanced on a typical question (this is the exact case that was broken live)",
   budgetGateSync("advanced", "starter", CONVO, SYS, ANTHROPIC_DEFAULTS), "advanced");
ck("pro reaches advanced", budgetGateSync("advanced", "pro", CONVO, SYS, ANTHROPIC_DEFAULTS), "advanced");
ck("elite reaches premium", budgetGateSync("premium", "elite", CONVO, SYS, ANTHROPIC_DEFAULTS), "premium");

console.log("\n-- the exact real-world case found live, 2026-08-09: hard caps too tight to ever afford one advanced reply --");
// A mid-conversation message logged in production: 2801 fresh + 5260 cached
// input tokens. The synthetic CONVO/SYS constants above (600/6000) were too
// optimistic to ever have caught this — they estimate to ~$0.019, under even
// the OLD $0.02 cap, while this real case estimates to ~$0.0253. Migration
// 104's fallback fix and migration 110's DB seed were both real and correct,
// but left this second, deeper problem: the hard cap itself was reachable-
// in-theory but not in practice, because it only budgeted for the output
// ceiling and left no real room for this app's necessarily-fresh
// (uncacheable) per-request athlete context. Fixed by raising free/starter's
// cap from 0.02 to 0.03. Asserted directly against the real numbers, not a
// synthetic case, so a future re-tightening of the cap fails HERE.
const REAL_FRESH = 2801, REAL_CACHED = 5260;
console.log("   real-case advanced cost estimate:",
  estimateTierCost(ANTHROPIC_DEFAULTS.advanced, REAL_FRESH, REAL_CACHED, ANTHROPIC_DEFAULTS.advanced.max_output_tokens).toFixed(4));
ck("starter's cap covers the real observed case with margin, not by a hair",
   HARD_MAX_COST_PER_REQUEST.starter >= estimateTierCost(ANTHROPIC_DEFAULTS.advanced, REAL_FRESH, REAL_CACHED, ANTHROPIC_DEFAULTS.advanced.max_output_tokens) * 1.1, true);
ck("starter reaches advanced on the exact real case that was broken live",
   budgetGateSync("advanced", "starter", REAL_FRESH, REAL_CACHED, ANTHROPIC_DEFAULTS), "advanced");
ck("free reaches advanced on the same real case (free/starter share the advanced ceiling)",
   budgetGateSync("advanced", "free", REAL_FRESH, REAL_CACHED, ANTHROPIC_DEFAULTS), "advanced");

console.log("\n-- the gate still bites when it should --");
ck("a very long conversation still downgrades starter",
   budgetGateSync("advanced", "starter", 8000, SYS, ANTHROPIC_DEFAULTS) !== "advanced", true);
ck("elite survives that same long conversation",
   budgetGateSync("advanced", "elite", 8000, SYS, ANTHROPIC_DEFAULTS), "advanced");
ck("gate never upgrades above the tier passed in",
   budgetGateSync("standard", "elite", CONVO, SYS, ANTHROPIC_DEFAULTS), "standard");
ck("economy is the floor, never downgraded away",
   budgetGateSync("economy", "free", 99999, 99999, ANTHROPIC_DEFAULTS), "economy");

console.log("\n-- the real async budgetGate(), with fetch mocked to return the EXACT broken production state (an empty table) --");
(async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_KEY = "svc";
  global.fetch = async (url) => {
    if (String(url).includes("/rest/v1/scout_model_config")) {
      return { ok: true, json: async () => [] }; // <- the real production state found live
    }
    return { ok: true, json: async () => ({}) };
  };
  // getModelConfigByTier() closes over modelConfigCache/MODEL_CONFIG_CACHE_TTL_MS,
  // declared just above it in the source — pulled into the SAME eval call so
  // the closure has something real to close over, not a ReferenceError.
  eval(slice("let modelConfigCache", "async function getPlatformSpend"));
  eval(slice("async function budgetGate(", "function unconfiguredAdapter"));

  const realStarter = await budgetGate("advanced", "starter", CONVO, SYS);
  const realPro = await budgetGate("advanced", "pro", CONVO, SYS);
  const realElite = await budgetGate("premium", "elite", CONVO, SYS);
  ck("REAL budgetGate(), empty DB table, starter reaches advanced", realStarter, "advanced");
  ck("REAL budgetGate(), empty DB table, pro reaches advanced", realPro, "advanced");
  ck("REAL budgetGate(), empty DB table, elite reaches premium", realElite, "premium");

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})();
