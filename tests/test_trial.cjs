// §14 capped trial: eligibility maths + entitlement + fail-closed reserve.
// The eligibility expression is lifted verbatim from api/scout.js and asserted
// against the source, so a change there fails this test instead of drifting.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const src = fs.readFileSync(REPO + "/api/scout.js", "utf8");

let p=0,f=0;
const ck=(l,a,e)=>{const A=JSON.stringify(a),E=JSON.stringify(e);
  if(A===E){p++;console.log("PASS  "+l);}else{f++;console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`);}};

// The real expression, kept honest by asserting the source still contains it.
const EXPR = `plan === "free" && !isAdmin && !aiUnlimited
      && trialUsed < trialTotal
      && (trialExpiresAt === null || Date.now() <= trialExpiresAt)`;
ck("eligibility expression still matches api/scout.js", src.includes(EXPR), true);

const DAY = 86400000;
function live({plan="free", isAdmin=false, aiUnlimited=false, used=0, total=30, startedAt=null, days=5}) {
  const trialUsed = used, trialTotal = total;
  const trialExpiresAt = startedAt ? new Date(startedAt).getTime() + days * DAY : null;
  return eval(EXPR);
}
const now = Date.now();

ck("a brand-new free athlete is eligible (no start yet)", live({}), true);
ck("day 1 of 5 is live", live({startedAt: new Date(now - 1*DAY)}), true);
ck("day 4.9 is still live", live({startedAt: new Date(now - 4.9*DAY)}), true);
ck("day 5.1 has expired", live({startedAt: new Date(now - 5.1*DAY)}), false);
ck("29 of 30 used is live", live({used:29}), true);
ck("30 of 30 used is exhausted", live({used:30}), false);
ck("over-count cannot come back", live({used:99}), false);
ck("expiry and exhaustion are independent (fresh but exhausted)", live({used:30, startedAt:new Date(now-1*DAY)}), false);
ck("a paying Starter gets no trial", live({plan:"starter"}), false);
ck("a paying Elite gets no trial", live({plan:"elite"}), false);
ck("admins bypass the trial entirely", live({isAdmin:true}), false);
ck("ai_unlimited accounts bypass it", live({aiUnlimited:true}), false);

console.log("\n-- entitlement, not billing --");
ck("trial grants Starter entitlements", src.includes('entitlementPlan = "starter";'), true);
ck("the tool gate reads entitlement, not the raw plan", src.includes('if (entitlementPlan === "free" && classification && classification.needs_tool'), true);
ck("pathway gate reads entitlement (all 3 sites)",
   (src.match(/data\.suggested_pathway = entitlementPlan === "free"/g)||[]).length, 3);
ck("no raw-plan free gate survives", (src.match(/userPlan === "free"/g)||[]).length, 0);
ck("telemetry still logs the REAL plan", src.includes("plan: userPlan,"), true);

console.log("\n-- spend safety --");
ck("trial is reserved before the lifetime free budget", src.indexOf("if (trialLive) {") < src.indexOf('if (plan === "free" && !reservedTrial)'), true);
ck("a trial message does not also burn lifetime free budget", src.includes('if (plan === "free" && !reservedTrial) {'), true);
ck("reserve fails CLOSED when the database is unreachable",
   src.includes('console.error("GOLSZ reserve_trial_question failed:", e);\n    return { allowed: false, reason: "unavailable" };'), true);
ck("every release site compensates the trial too",
   (src.match(/if \(reservedTrial\) await releaseTrialQuestion\(userId\);/g)||[]).length, 3);
ck("daily cap during trial is its own env var", src.includes('trialLive ? Number(process.env.TRIAL_DAILY_LIMIT || 8)'), true);

console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
