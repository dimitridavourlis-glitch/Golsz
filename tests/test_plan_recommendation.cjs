// RECOMMEND — the plan-recommendation layer.
//
// Scout's job is to help, then, only if helping surfaced a real need the
// athlete's plan cannot meet, to name the LOWEST plan that meets it. The
// failure modes being designed out are all commercial rather than technical:
// manufacturing a weakness to justify a pitch, reaching for Elite when Basic
// solves it, and repeating a pitch someone has already declined.
//
// Every scenario in the brief is exercised here against the real shipped
// functions. Nothing is retyped and no second pricing source is introduced —
// api/_entitlements.js is the only mapping consulted.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const ent = require("../api/_entitlements.js");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};
function slice(a, b, label) {
  const i = SCOUT.indexOf(a), j = SCOUT.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error(`could not slice ${label}`);
  return SCOUT.slice(i, j);
}
eval(slice("function planDailyLimit(plan) {", "// Renders the object above into the one factual block", "recommend layer"));

// ---- limits are unchanged ------------------------------------------------
ck("Free is still 3/day", planDailyLimit("free"), 3);
ck("Basic is still 8/day", planDailyLimit("starter"), 8);
ck("Pro is still 15/day", planDailyLimit("pro"), 15);
ck("Elite is still 20/day", planDailyLimit("elite"), 20);

// ---- state fixtures ------------------------------------------------------
// A genuinely healthy athlete: Plan built, benchmarks tracked, targets being
// worked, development plan running. Nothing is missing, so nothing is owed.
const HEALTHY = { pathwayComplete: true, targetsCount: 6, questionsUsedToday: 1,
  readiness: { performance: { metricsTracked: 4, metricsRetested: 3 }, development: { total: 4 } } };
// Bare account: no Plan, no benchmarks, no targets, no development work.
const BARE = { pathwayComplete: false, targetsCount: 0, questionsUsedToday: 0,
  readiness: { performance: { metricsTracked: 0 }, development: { total: 0 } } };
// Everything except a development plan — the classic Basic->Pro case.
const NEEDS_DEV_ONLY = { pathwayComplete: true, targetsCount: 3, questionsUsedToday: 0,
  readiness: { performance: { metricsTracked: 3 }, development: { total: 0 } } };

const evalFor = (plan, state) => ent.evaluateEntitlements(plan, deriveEntitlementNeeds(state));

// ---- 1. Free athlete who does NOT need an upgrade ------------------------
{
  const e = evalFor("free", HEALTHY);
  ck("healthy Free athlete is owed nothing", e.upgradeTo, null);
  ck("...and nothing is reported locked", e.locked, []);
  ck("...so a weakness is never manufactured", deriveEntitlementNeeds(HEALTHY), []);
}

// ---- 2. Free -> Basic, genuine need --------------------------------------
{
  // Wants a Pathway and a target list. Both open on Basic.
  const state = { pathwayComplete: false, targetsCount: 0, questionsUsedToday: 0,
    readiness: { performance: { metricsTracked: 3 }, development: { total: 2 } } };
  const e = evalFor("free", state);
  ck("Free needing a Plan and targets is pointed at Basic", e.upgradeToName, "Basic");
  ck("...never at Pro", e.upgradeToName === "Pro", false);
  ck("...never at Elite", e.upgradeToName === "Elite", false);
}

// ---- 3. Free -> Pro, genuine need ----------------------------------------
{
  const e = evalFor("free", BARE);
  ck("a bare Free account needs Pro (development plan is the top requirement)", e.upgradeToName, "Pro");
  ck("...and Basic items are named as part of what Pro covers",
     e.lockedLabels.some((s) => /Pathway/.test(s)) && e.lockedLabels.some((s) => /development plan/.test(s)), true);
  ck("...still never Elite", e.upgradeToName === "Elite", false);
}

// ---- 4. Basic -> Pro ------------------------------------------------------
{
  const e = evalFor("starter", NEEDS_DEV_ONLY);
  ck("Basic athlete missing only a development plan is pointed at Pro", e.upgradeToName, "Pro");
  // `covered` lists NEEDS they already have unlocked. Their Pathway is not
  // listed because it is not a need at all — it is already built. A need
  // only exists where the record shows a gap.
  ck("...and their built Pathway is not treated as a need", deriveEntitlementNeeds(NEEDS_DEV_ONLY).includes("pathway_plan"), false);
  ck("...exactly one thing is locked", e.locked, ["development_plan"]);
}

// ---- 5. Pro -> Elite ------------------------------------------------------
// No feature requires Elite. Volume is the only honest trigger.
{
  ck("no feature in the mapping requires Elite",
     Object.values(ent.FEATURE_MIN_PLAN).includes("elite"), false);
  const e = evalFor("pro", BARE);
  ck("a Pro athlete is never feature-upgraded to Elite", e.upgradeTo, null);
  const quiet = deriveVolumeNeed("pro", 5, planDailyLimit("pro"));
  ck("a Pro athlete with 5 of 15 messages used feels no pressure", quiet.pressured, false);
  const pressed = deriveVolumeNeed("pro", 13, planDailyLimit("pro"));
  ck("a Pro athlete at 13 of 15 is genuinely constrained", pressed.pressured, true);
  ck("...and Elite is the tier that fixes it", pressed.nextPlan, "elite");
}

// ---- 6. Elite user: never upsell -----------------------------------------
{
  for (const state of [BARE, HEALTHY, NEEDS_DEV_ONLY]) {
    ck("Elite is never sold anything, whatever their state", evalFor("elite", state).upgradeTo, null);
  }
  ck("...and Elite has no tier above it for volume either",
     deriveVolumeNeed("elite", 20, planDailyLimit("elite")).nextPlan, null);
  ck("...so a maxed-out Elite athlete is still never pitched",
     deriveVolumeNeed("elite", 20, planDailyLimit("elite")).pressured, false);
}

// ---- 7. Athlete explicitly asks which plan they need ---------------------
// The answer is computed, so it is the same whether they ask or not — no
// separate "they asked" path that could inflate the recommendation.
{
  const e = evalFor("free", NEEDS_DEV_ONLY);
  ck("the answer to 'which plan do I need' is the computed one", e.upgradeToName, "Pro");
  ck("...and it is stable, not situational", evalFor("free", NEEDS_DEV_ONLY).upgradeToName, e.upgradeToName);
}

// ---- 8/9/10. Refusal, affordability, repeated asks -----------------------
const DECLINES = [
  "I can't afford it right now",
  "cannot afford that",
  "no thanks",
  "not interested",
  "that's too expensive",
  "I don't want to pay",
  "I'm staying on Free",
  "stop asking me to upgrade",
  "I'm not paying for this",
  "no money for that",
];
for (const d of DECLINES) {
  ck(`decline detected: "${d}"`, athleteDeclinedUpgrade([{ role: "user", content: d }]), true);
}
// Ordinary conversation must never read as a refusal.
const NOT_DECLINES = [
  "What can I afford to work on this month?",
  "I want to go pro",
  "Can you help me build a plan?",
  "How much time do I need to spend on this?",
  "I'm interested in the U Sports route",
];
for (const n of NOT_DECLINES) {
  ck(`not a decline: "${n.slice(0, 34)}"`, athleteDeclinedUpgrade([{ role: "user", content: n }]), false);
}
ck("a refusal earlier in the conversation still counts later",
   athleteDeclinedUpgrade([{ role: "user", content: "no thanks" }, { role: "assistant", content: "ok" }, { role: "user", content: "what next?" }]), true);
ck("only the ATHLETE can decline — not the model's own words",
   athleteDeclinedUpgrade([{ role: "assistant", content: "no thanks" }]), false);
ck("suppression is wired into the plan block", /if \(declined\) \{/.test(SCOUT), true);
ck("...and forbids raising plans again in any form",
   /Do not mention plans, pricing, upgrading or locked features again in this conversation/.test(SCOUT), true);

// ---- 11. Athlete changes goals -------------------------------------------
// Needs are derived from record state, not from the goal wording, so a goal
// change cannot by itself create or destroy a reason to upgrade.
{
  ck("needs do not depend on goal text", deriveEntitlementNeeds(HEALTHY), []);
  ck("...and a bare account needs the same set regardless",
     deriveEntitlementNeeds(BARE).sort(), ["benchmarks", "development_plan", "pathway_plan", "targets"]);
}

// ---- 12. Incomplete Passport data ----------------------------------------
{
  // Missing readiness entirely (new athlete, nothing computed yet).
  const thin = { pathwayComplete: false, targetsCount: 0, questionsUsedToday: 0, readiness: null };
  const needs = deriveEntitlementNeeds(thin);
  ck("a thin account still yields only real, observable gaps", needs.sort(), ["pathway_plan", "targets"]);
  ck("...and nothing is invented from missing data", needs.includes("development_plan"), false);
  ck("null state sells nothing at all", deriveEntitlementNeeds(null), []);
  ck("...and does not throw", evalFor("free", null).upgradeTo, null);
}

// ---- 13. Strong readiness -> no higher plan needed -----------------------
{
  for (const plan of ["free", "starter", "pro", "elite"]) {
    ck(`strong athlete on ${plan} is owed nothing`, evalFor(plan, HEALTHY).upgradeTo, null);
  }
}

// ---- help before sell, in the prompt -------------------------------------
// Reworded 2026-08-11. The numbered 5-step scaffold was replaced by the
// understand -> diagnose -> advise -> plan flow plus a hard "answer first"
// rule and an explicit silence default.
ck("the reasoning order is stated", /Then diagnose honestly[\s\S]*Then advise[\s\S]*Then plan/.test(SCOUT), true);
ck("plans are only raised once something is actually locked",
   /Only mention them when they've actually hit something locked/.test(SCOUT), true);
ck("a pitch in place of an answer is called out as losing them",
   /A pitch in place of an answer is how you lose them/.test(SCOUT), true);
ck("silence is the default when nothing is locked",
   /If nothing they raised points to a locked feature, say nothing about plans/.test(SCOUT), true);
// THE ANTI-UPSELL CEILING. Restored 2026-08-11 after the rewrite dropped it.
ck("the computed tier is the only one nameable", /never name a plan PLAN FIT did not name/.test(SCOUT), true);
ck("never a more expensive tier, even if it would also work",
   /never a more expensive tier even if it would also solve the problem/.test(SCOUT), true);
ck("the plan is named once, not repeatedly", /name the plan once, carry on/.test(SCOUT), true);
ck("only ever upward", /Only ever point upward\. Never suggest a cheaper plan\./.test(SCOUT), true);
ck("silence when nothing is locked", /Do not mention plans, pricing or upgrading in this reply at all/.test(SCOUT), true);
ck("no false urgency or guarantees", /Never use false urgency, fake scarcity, or guaranteed outcomes/.test(SCOUT), true);
ck("Free must still get real help", /Answer the question first, always/.test(SCOUT), true);

// ---- prices and limits untouched -----------------------------------------
{
  const cat = require("../api/_plan-catalog.js");
  // Keyed by plan AND currency now — Object.fromEntries on plan alone would
  // silently keep whichever currency happened to be last in the list.
  const at = (plan, cur) => (cat.PLAN_CATALOG.find((e) => e.plan === plan && e.currency === cur) || {}).unitAmount;
  ck("Basic still EUR 6.00", at("starter", "eur"), 600);
  ck("Pro still EUR 15.00", at("pro", "eur"), 1500);
  ck("Elite still EUR 30.00", at("elite", "eur"), 3000);
  ck("EUR is still sold", cat.SUPPORTED_CURRENCIES.includes("eur"), true);
  ck("entitlement mapping unchanged", ent.FEATURE_MIN_PLAN,
     { pdf_export: "starter", readiness: "pro", targets: "starter", benchmarks: "starter", development_plan: "pro", pathway_plan: "starter" });
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
