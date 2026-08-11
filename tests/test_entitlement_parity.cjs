// Entitlement parity — one authoritative answer to "which plan unlocks X".
//
// Before api/_entitlements.js there were two answers: golsz-app.html's
// FEATURE_MIN_PLAN, which actually gates the UI, and the free-text GOLSZ
// CAPABILITIES block the Scout prompt was assembled from, which is what
// Scout told athletes. Nothing kept them in step, so Scout could name a tier
// the UI did not enforce and the athlete would hit a paywall that did not
// match what they had just been told.
//
// api/scout.js now COMPUTES entitlement answers from the shared module. The
// client keeps its copy because golsz-app.html has no build step; this suite
// is what stops the two drifting, by diffing them key by key out of the real
// files rather than from anything retyped here.
//
// This suite also pins the "cheapest plan that solves it" rule. Recommending
// Elite when Basic would do is the single most damaging thing this system
// could get wrong, so it is asserted directly rather than left to the prompt.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const ent = require("../api/_entitlements.js");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- extract the client's copy -------------------------------------------
const rankSrc = APP.match(/const PLAN_RANK = \{[^}]+\};/);
const featSrc = APP.match(/const FEATURE_MIN_PLAN = \{[\s\S]*?\n\};/);
const hasFeatSrc = APP.match(/function hasFeature\(plan, feature\) \{[\s\S]*?\n\}/);
if (!rankSrc || !featSrc || !hasFeatSrc) throw new Error("client entitlement source not found — markers moved, update this suite");
const client = eval(`${rankSrc[0]}\n${featSrc[0]}\n${hasFeatSrc[0]}\n({ PLAN_RANK, FEATURE_MIN_PLAN, hasFeature })`);

// ---- the diff that makes drift impossible --------------------------------
ck("PLAN_RANK identical", ent.PLAN_RANK, client.PLAN_RANK);
ck("FEATURE_MIN_PLAN identical", ent.FEATURE_MIN_PLAN, client.FEATURE_MIN_PLAN);
ck("no feature exists on only one side",
   Object.keys(ent.FEATURE_MIN_PLAN).sort(), Object.keys(client.FEATURE_MIN_PLAN).sort());

// Behavioural equivalence, not just structural: every feature against every
// plan must gate the same way on both sides.
for (const plan of Object.keys(ent.PLAN_RANK)) {
  for (const feature of Object.keys(ent.FEATURE_MIN_PLAN)) {
    ck(`hasFeature(${plan}, ${feature}) agrees`, ent.hasFeature(plan, feature), client.hasFeature(plan, feature));
  }
}
// Unknown features are ungated on both sides — a typo must not silently lock
// something for everyone.
ck("unknown feature ungated (server)", ent.hasFeature("free", "not_a_real_feature"), true);
ck("unknown feature ungated (client)", client.hasFeature("free", "not_a_real_feature"), true);

// ---- entitlements are UNCHANGED by this refactor -------------------------
// The task that introduced this module explicitly must not move who gets
// what. These are the values as of migration 122.
ck("pdf_export still Basic", ent.FEATURE_MIN_PLAN.pdf_export, "starter");
ck("readiness breakdown still Pro", ent.FEATURE_MIN_PLAN.readiness, "pro");
ck("targets still Basic", ent.FEATURE_MIN_PLAN.targets, "starter");
ck("benchmarks still Basic", ent.FEATURE_MIN_PLAN.benchmarks, "starter");
ck("development_plan still Pro", ent.FEATURE_MIN_PLAN.development_plan, "pro");
ck("pathway_plan still Basic", ent.FEATURE_MIN_PLAN.pathway_plan, "starter");
ck("four plans, no more no fewer", Object.keys(ent.PLAN_RANK).sort(), ["elite", "free", "pro", "starter"]);
ck("display names unchanged", [ent.planDisplayName("free"), ent.planDisplayName("starter"), ent.planDisplayName("pro"), ent.planDisplayName("elite")],
   ["Free", "Basic", "Pro", "Elite"]);

// ---- the cheapest-plan rule ----------------------------------------------
ck("a Pathway alone resolves to Basic, not Pro or Elite", ent.lowestPlanUnlocking(["pathway_plan"]), "starter");
ck("Pathway + targets + benchmarks still only Basic", ent.lowestPlanUnlocking(["pathway_plan", "targets", "benchmarks"]), "starter");
ck("adding a development plan raises it to Pro — and stops there", ent.lowestPlanUnlocking(["pathway_plan", "development_plan"]), "pro");
ck("nothing needed resolves to free", ent.lowestPlanUnlocking([]), "free");
ck("unknown needs resolve to free", ent.lowestPlanUnlocking(["mystery"]), "free");
ck("no combination of real features ever resolves to Elite",
   Object.keys(ent.FEATURE_MIN_PLAN).some(() => false) || ent.lowestPlanUnlocking(Object.keys(ent.FEATURE_MIN_PLAN)) !== "elite", true);

// ---- evaluateEntitlements ------------------------------------------------
{
  const e1 = ent.evaluateEntitlements("free", ["pathway_plan", "targets"]);
  ck("free athlete needing a Pathway is pointed at Basic", e1.upgradeToName, "Basic");
  ck("...and nothing is reported as already covered", e1.covered, []);
  ck("...and the locked items are named in plain language",
     e1.lockedLabels.every((s) => !/_/.test(s)), true);

  const e2 = ent.evaluateEntitlements("starter", ["pathway_plan", "development_plan"]);
  ck("Basic athlete already has the Pathway", e2.covered, ["pathway_plan"]);
  ck("...and is pointed at Pro only for the development plan", e2.upgradeToName, "Pro");

  const e3 = ent.evaluateEntitlements("pro", ["pathway_plan", "development_plan"]);
  ck("Pro athlete needs nothing", e3.upgradeTo, null);
  ck("...and has everything covered", e3.locked, []);

  const e4 = ent.evaluateEntitlements("elite", ["pathway_plan", "development_plan", "readiness"]);
  ck("Elite athlete is never sold anything", e4.upgradeTo, null);

  const e5 = ent.evaluateEntitlements("free", []);
  ck("no identified need means no upgrade at all", e5.upgradeTo, null);
}

// ---- Scout consumes the module, not a prose list -------------------------
ck("scout.js imports the shared entitlement module", /from "\.\/_entitlements\.js"/.test(SCOUT), true);
ck("scout.js computes plan fit rather than narrating it", /evaluateEntitlements\(plan, entNeeds\)/.test(SCOUT), true);
ck("the prompt is told the computed tier is the only one it may name",
   /is the ONLY plan you may name/.test(SCOUT), true);
ck("the prompt forbids reaching for a more expensive tier",
   /Never name a more expensive one/.test(SCOUT), true);
// Reworded in the 2026-08-11 prompt rewrite. The guarantee is now stated as
// a hard ceiling on which plan may be named, which is strictly stronger than
// the old "don't derive it from the prose" phrasing.
ck("the prompt forbids naming any tier PLAN FIT did not compute",
   /never name a plan PLAN FIT did not name/.test(SCOUT), true);
ck("silence is the default when nothing is locked",
   /Do not mention plans, pricing or upgrading in this reply at all/.test(SCOUT), true);

// ---- needs come from real state, never from a schedule -------------------
{
  const from = SCOUT.indexOf("function deriveEntitlementNeeds");
  const to = SCOUT.indexOf("// ============================================================", from);
  if (from < 0) throw new Error("deriveEntitlementNeeds not found");
  eval(SCOUT.slice(from, to));
  const bare = { pathwayComplete: false, targetsCount: 0, readiness: { performance: { metricsTracked: 0 }, development: { total: 0 } } };
  ck("a bare account needs the full set", deriveEntitlementNeeds(bare).sort(), ["benchmarks", "development_plan", "pathway_plan", "targets"]);
  const healthy = { pathwayComplete: true, targetsCount: 4, readiness: { performance: { metricsTracked: 3 }, development: { total: 2 } } };
  ck("a healthy account needs nothing — so nothing is ever pitched", deriveEntitlementNeeds(healthy), []);
  ck("null state pitches nothing", deriveEntitlementNeeds(null), []);
  // The whole point: an athlete in good shape must be un-sellable, no matter
  // how long the conversation runs.
  ck("a healthy account resolves to no upgrade", ent.evaluateEntitlements("free", deriveEntitlementNeeds(healthy)).upgradeTo, null);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
