// Harness for estimateTierCost/budgetGate cache-aware pricing (api/scout.js).
const TIER_ORDER = ["economy", "standard", "advanced", "premium"];
const HARD_MAX = { free: 0.01, starter: 0.02, pro: 0.04, elite: 0.08 };
// Live scout_model_config after migration 104.
const CFG = {
  economy:  { input_cost_per_million: 1, output_cost_per_million: 5,  cached_input_cost_per_million: 0.1, max_output_tokens: 1024 },
  standard: { input_cost_per_million: 1, output_cost_per_million: 5,  cached_input_cost_per_million: 0.1, max_output_tokens: 2048 },
  advanced: { input_cost_per_million: 3, output_cost_per_million: 15, cached_input_cost_per_million: 0.3, max_output_tokens: 1024 },
  premium:  { input_cost_per_million: 3, output_cost_per_million: 15, cached_input_cost_per_million: 0.3, max_output_tokens: 2048 },
};
function cachedInputRate(cfg) {
  const e = cfg.cached_input_cost_per_million;
  return e === null || e === undefined ? (cfg.input_cost_per_million || 0) * 0.1 : e;
}
function estimateTierCost(cfg, fresh, cached, out) {
  return (fresh*(cfg.input_cost_per_million||0))/1e6 + (cached*cachedInputRate(cfg))/1e6 + (out*(cfg.output_cost_per_million||0))/1e6;
}
function budgetGate(tier, plan, fresh, cached) {
  const hardMax = HARD_MAX[plan] || HARD_MAX.free;
  let idx = TIER_ORDER.indexOf(tier);
  while (idx > 0) {
    const cfg = CFG[TIER_ORDER[idx]];
    if (estimateTierCost(cfg, fresh, cached, cfg.max_output_tokens) <= hardMax) break;
    idx -= 1;
  }
  return TIER_ORDER[idx];
}
// The OLD behaviour, for comparison: all input at full rate.
function estimateOld(cfg, totalIn, out) {
  return (totalIn*(cfg.input_cost_per_million||0))/1e6 + (out*(cfg.output_cost_per_million||0))/1e6;
}
function budgetGateOld(tier, plan, totalIn) {
  const hardMax = HARD_MAX[plan] || HARD_MAX.free;
  let idx = TIER_ORDER.indexOf(tier);
  while (idx > 0) { const cfg = CFG[TIER_ORDER[idx]];
    if (estimateOld(cfg, totalIn, cfg.max_output_tokens) <= hardMax) break; idx -= 1; }
  return TIER_ORDER[idx];
}
let p=0,f=0;
const ck=(l,a,e)=>{const A=JSON.stringify(a),E=JSON.stringify(e);
  if(A===E){p++;console.log("PASS  "+l);}else{f++;console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`);}};

const SYS = 6000, CONVO = 600;   // typical: cached system prompt + short conversation

console.log("-- cost of one advanced reply --");
console.log("   old (all input full rate):", estimateOld(CFG.advanced, SYS+CONVO, 1024).toFixed(4));
console.log("   new (system prompt cached):", estimateTierCost(CFG.advanced, CONVO, SYS, 1024).toFixed(4));

ck("cached input is priced ~10x cheaper than fresh",
   estimateTierCost(CFG.advanced, 0, 1000, 0).toFixed(6), (estimateTierCost(CFG.advanced, 1000, 0, 0)/10).toFixed(6));
ck("null cached rate falls back to 10% of base, not free",
   estimateTierCost({input_cost_per_million:3,output_cost_per_million:15,cached_input_cost_per_million:null,max_output_tokens:1024}, 0, 1000, 0).toFixed(6),
   "0.000300");
ck("new estimate is strictly cheaper than the old one",
   estimateTierCost(CFG.advanced, CONVO, SYS, 1024) < estimateOld(CFG.advanced, SYS+CONVO, 1024), true);

console.log("\n-- gate decisions, typical conversation --");
for (const plan of ["free","starter","pro","elite"])
  console.log(`   ${plan.padEnd(8)} old=${budgetGateOld("advanced",plan,SYS+CONVO).padEnd(9)} new=${budgetGate("advanced",plan,CONVO,SYS)}`);

ck("starter now reaches advanced (it could not before)", budgetGate("advanced","starter",CONVO,SYS), "advanced");
ck("pro reaches advanced", budgetGate("advanced","pro",CONVO,SYS), "advanced");
ck("elite reaches premium", budgetGate("premium","elite",CONVO,SYS), "premium");
ck("free is still capped below advanced", budgetGate("advanced","free",CONVO,SYS) !== "advanced", true);
ck("old gate downgraded starter off advanced", budgetGateOld("advanced","starter",SYS+CONVO) !== "advanced", true);

console.log("\n-- the gate still bites when it should --");
ck("a very long conversation still downgrades starter",
   budgetGate("advanced","starter",8000,SYS) !== "advanced", true);
ck("elite survives that same long conversation", budgetGate("advanced","elite",8000,SYS), "advanced");
ck("gate never upgrades above the tier passed in", budgetGate("standard","elite",CONVO,SYS), "standard");
ck("economy is the floor, never downgraded away", budgetGate("economy","free",99999,99999), "economy");

console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
