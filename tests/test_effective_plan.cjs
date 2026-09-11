// THE PAYER'S PLAN, AND WHO GETS IT.
//
// The client gates every parent-managed surface on the PARENT's plan (it
// passes plan={userPlan} alongside actingFor=), while api/scout.js resolved
// the CHILD's. Children are created by api/create-child-account.js, which
// never sets a plan, so handle_new_user() leaves them on the 'free' default —
// and the Stripe webhook patches by stripe_customer_id, the PARENT's row, so
// a purchase never reaches the child either.
//
// A Pro parent opened their child's account, saw Pathway, targets and
// benchmarks unlocked, tapped "draft with Scout", and the server refused. The
// paywall and the product disagreed about who had paid.
//
// This suite runs the REAL rule lifted out of api/scout.js.
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const ENT = fs.readFileSync(REPO + "/api/_entitlements.js", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const i = SCOUT.indexOf("const EFFECTIVE_PLAN_RANK");
const j = SCOUT.indexOf("const ANTHROPIC_URL", i);
if (i < 0 || j < 0) throw new Error("effective plan rule markers moved");
// Function declarations leak from a direct eval; the const does not, so the
// extractor carries both out. Named differently from the source symbol
// because a direct eval shares this scope and would collide with it.
eval(SCOUT.slice(i, j) + "\nglobalThis.__rank = EFFECTIVE_PLAN_RANK;");
const effPlan = effectivePlan;

console.log("-- the payer raises, and never lowers --");
ck("a free child driven by a pro parent gets pro", effPlan("free", "pro"), "pro");
ck("a free child driven by an elite parent gets elite", effPlan("free", "elite"), "elite");
ck("a starter child driven by a pro parent gets pro", effPlan("starter", "pro"), "pro");
// The direction that matters most: a parent on a LOWER tier must not strip
// entitlements from a child who has their own subscription.
ck("a pro child driven by a free parent KEEPS pro", effPlan("pro", "free"), "pro");
ck("an elite child driven by a starter parent KEEPS elite", effPlan("elite", "starter"), "elite");
ck("equal tiers are unchanged", effPlan("pro", "pro"), "pro");

console.log("\n-- nothing is raised without a payer --");
ck("no parent means the athlete's own plan", effPlan("free", null), "free");
ck("an undefined payer plan changes nothing", effPlan("starter", undefined), "starter");
ck("an empty payer plan changes nothing", effPlan("starter", ""), "starter");

console.log("\n-- an unknown tier is never guessed upward --");
// A tier this rule has not heard of (a future plan, a typo, a tampered row)
// must fall back to the athlete's own plan rather than ranking as anything.
ck("an unknown payer tier does not raise", effPlan("free", "platinum"), "free");
ck("an unknown athlete tier is returned as-is", effPlan("platinum", "elite"), "platinum");

console.log("\n-- the ranking agrees with the entitlements table --");
const entRank = /const PLAN_RANK = \{([^}]*)\}/.exec(ENT);
if (!entRank) throw new Error("PLAN_RANK not found in api/_entitlements.js");
const parse = (body) => Object.fromEntries([...body.matchAll(/(\w+)\s*:\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
ck("EFFECTIVE_PLAN_RANK is byte-equal to the entitlements PLAN_RANK",
   globalThis.__rank, parse(entRank[1]));

console.log("\n-- the handler actually uses it, on an APPROVED link only --");
ck("the caller's plan is only fetched for a parent-managed request",
   /actingReason === "parent_managed" && callerId\) \? getProfileMeta\(callerId\)/.test(SCOUT), true);
ck("actingReason and callerId come from resolveActingAthlete, not the body",
   /actingReason = acting\.reason;[\s\S]{0,40}callerId = acting\.callerId;/.test(SCOUT), true);
ck("the resolved plan is what the rest of the handler reads",
   /const plan = effectivePlan\(ownPlan, parentMeta && parentMeta\.plan\);/.test(SCOUT), true);
// Metering must NOT follow the payer: a parent on Pro managing two children
// should not be able to spend one child's allowance on the other.
ck("metering stays keyed to the athlete, not the parent",
   /Metering, burst protection and duplicate detection stay keyed to the\s*\/\/ ATHLETE, not the parent/.test(SCOUT), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
