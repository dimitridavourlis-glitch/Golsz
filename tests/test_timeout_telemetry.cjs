// Step 8 telemetry state machine. Mirrors the ordering in api/scout.js's
// handler; the point is that a degraded reply can never be recorded as clean,
// and that the two fields only ever take values migration 106's CHECK
// constraints allow.
const VALID_TIMEOUT = new Set(["none","classifier_timeout","tool_budget_exhausted","retry_skipped","provider_error"]);
const VALID_FALLBACK = new Set(["none","sonnet_retry","haiku_cross_model"]);

function run({ classification, deepFailsFirst = false, retryRoomOk = true, retryAlsoFails = false, toolBudgetExhausted = false }) {
  let timeoutReason = "none", fallbackUsed = "none";
  if (classification === null) timeoutReason = "classifier_timeout";
  else if (classification && classification.error) timeoutReason = "provider_error";
  if (deepFailsFirst) {
    if (retryRoomOk) {
      if (timeoutReason === "none") timeoutReason = "provider_error";
      fallbackUsed = "sonnet_retry";
      if (retryAlsoFails) fallbackUsed = "haiku_cross_model";
    } else {
      timeoutReason = "retry_skipped";
      if (retryAlsoFails) fallbackUsed = "haiku_cross_model";
    }
  }
  if (!deepFailsFirst && toolBudgetExhausted && timeoutReason === "none") timeoutReason = "tool_budget_exhausted";
  return { timeoutReason, fallbackUsed };
}
let p=0,f=0;
const ck=(l,a,e)=>{const A=JSON.stringify(a),E=JSON.stringify(e);
  if(A===E){p++;console.log("PASS  "+l);}else{f++;console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`);}};

const ok = { intent: "career_advice", confidence: 0.9 };
ck("clean run records none/none", run({ classification: ok }), { timeoutReason: "none", fallbackUsed: "none" });
ck("classifier timeout is captured", run({ classification: null }).timeoutReason, "classifier_timeout");
ck("classifier provider error is distinguished from a timeout",
   run({ classification: { error: "500" } }).timeoutReason, "provider_error");
ck("tool loop cut short is degraded even though the reply succeeded",
   run({ classification: ok, toolBudgetExhausted: true }).timeoutReason, "tool_budget_exhausted");
ck("a retried deep call records the retry", run({ classification: ok, deepFailsFirst: true }).fallbackUsed, "sonnet_retry");
ck("a retried deep call also records why", run({ classification: ok, deepFailsFirst: true }).timeoutReason, "provider_error");
ck("no budget to retry is recorded as retry_skipped",
   run({ classification: ok, deepFailsFirst: true, retryRoomOk: false }).timeoutReason, "retry_skipped");
ck("cross-model fallback is recorded",
   run({ classification: ok, deepFailsFirst: true, retryAlsoFails: true }).fallbackUsed, "haiku_cross_model");
ck("classifier timeout is NOT overwritten by a later provider error",
   run({ classification: null, deepFailsFirst: true }).timeoutReason, "classifier_timeout");
ck("worst case still records both dimensions",
   run({ classification: null, deepFailsFirst: true, retryAlsoFails: true }),
   { timeoutReason: "classifier_timeout", fallbackUsed: "haiku_cross_model" });

console.log("\n-- every reachable combination satisfies migration 106's CHECK constraints --");
let bad = 0, n = 0;
for (const c of [null, ok, { error: "x" }])
  for (const d of [true, false]) for (const r of [true, false])
    for (const ra of [true, false]) for (const tb of [true, false]) {
      const out = run({ classification: c, deepFailsFirst: d, retryRoomOk: r, retryAlsoFails: ra, toolBudgetExhausted: tb });
      n++;
      if (!VALID_TIMEOUT.has(out.timeoutReason) || !VALID_FALLBACK.has(out.fallbackUsed)) bad++;
    }
ck(`all ${n} reachable combinations produce constraint-valid values`, bad, 0);
console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
