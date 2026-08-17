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
// The client no longer has hasFeature(). It was replaced by a three-valued
// pair, because in the UI "plan not loaded yet" is a different fact from
// "plan is free" and coercing them together showed a paying athlete an
// upgrade prompt on every page load. The server keeps hasFeature() — for
// ENFORCEMENT, denying an unknown plan is correct.
const knownSrc = APP.match(/function planKnown\(plan\) \{[^}]*\}/);
// Signature-tolerant: pinning the exact arg list broke the moment full_access
// was added. The property is that the function exists and can be extracted.
const unlockedSrc = APP.match(/function featureUnlocked\([^)]*\) \{[\s\S]*?\n\}/);
const lockedSrc = APP.match(/function featureLocked\([^)]*\) \{[\s\S]*?\n\}/);
if (!rankSrc || !featSrc || !knownSrc || !unlockedSrc || !lockedSrc) throw new Error("client entitlement source not found — markers moved, update this suite");
// featureUnlocked/featureLocked now read a module-level flag when no explicit
// third argument is passed. Declared here so the extracted source evaluates,
// and left false so every existing assertion measures the plan-only path.
const client = eval(`let CURRENT_FULL_ACCESS = false;\n${rankSrc[0]}\n${featSrc[0]}\n${knownSrc[0]}\n${unlockedSrc[0]}\n${lockedSrc[0]}\n({ PLAN_RANK, FEATURE_MIN_PLAN, planKnown, featureUnlocked, featureLocked })`);

// ---- the diff that makes drift impossible --------------------------------
ck("PLAN_RANK identical", ent.PLAN_RANK, client.PLAN_RANK);
ck("FEATURE_MIN_PLAN identical", ent.FEATURE_MIN_PLAN, client.FEATURE_MIN_PLAN);
ck("no feature exists on only one side",
   Object.keys(ent.FEATURE_MIN_PLAN).sort(), Object.keys(client.FEATURE_MIN_PLAN).sort());

// Behavioural equivalence, not just structural: every feature against every
// plan must gate the same way on both sides.
// For a KNOWN plan the two sides must still agree exactly — the three-valued
// split changed how the UI handles "not loaded", not who is entitled to what.
for (const plan of Object.keys(ent.PLAN_RANK)) {
  for (const feature of Object.keys(ent.FEATURE_MIN_PLAN)) {
    ck(`entitlement(${plan}, ${feature}) agrees`, ent.hasFeature(plan, feature), client.featureUnlocked(plan, feature));
    // Known plan: exactly one of unlocked/locked is true. Never both, never neither.
    ck(`...and is decisive for ${plan}/${feature}`,
       client.featureUnlocked(plan, feature) !== client.featureLocked(plan, feature), true);
  }
}
// Unknown features are ungated on both sides — a typo must not silently lock
// something for everyone.
ck("unknown feature ungated (server)", ent.hasFeature("free", "not_a_real_feature"), true);
ck("unknown feature ungated (client)", client.featureUnlocked("free", "not_a_real_feature"), true);

// ---- THE INVARIANT: an unknown plan can never render as locked -----------
// This is the whole point of the split. If featureLocked() ever returns true
// for a null plan, every gated surface in the app starts showing "Upgrade to
// unlock" to paying athletes again while their subscription loads.
for (const unknown of [null, undefined, ""]) {
  for (const feature of Object.keys(ent.FEATURE_MIN_PLAN)) {
    ck(`unknown plan (${JSON.stringify(unknown)}) is never locked for ${feature}`,
       client.featureLocked(unknown, feature), false);
    ck(`...and never unlocked either`, client.featureUnlocked(unknown, feature), false);
  }
}
ck("planKnown is false for null", client.planKnown(null), false);
ck("planKnown is true for a real plan", client.planKnown("free"), true);

// The server deliberately does the OPPOSITE: enforcement denies an unknown
// plan rather than deferring. Asserted so the divergence stays intentional.
ck("server still denies an unknown plan (enforcement)", ent.hasFeature(null, "targets"), false);

// And the coercing client function must stay gone — an old-style call should
// be a loud ReferenceError, not a silent paywall.
ck("client hasFeature() is not reintroduced", /function hasFeature\(/.test(APP), false);

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


// ---- THE full_access OVERRIDE MUST AGREE ON BOTH SIDES ------------------
// A comped user gets paid features without a paid plan. If the two gates
// disagree, the client shows a feature and the server refuses it — which for a
// comped user is worse than being locked out, because it looks like a bug in
// something they were told they had.
for (const feature of Object.keys(ent.FEATURE_MIN_PLAN)) {
  for (const plan of ["free", "starter", "pro", "elite"]) {
    ck(`full_access unlocks ${feature} for ${plan} on both sides`,
       [ent.hasFeature(plan, feature, true), client.featureUnlocked(plan, feature, true)], [true, true]);
  }
}
// And it must not leak the other way: absent or false behaves exactly as before.
for (const feature of Object.keys(ent.FEATURE_MIN_PLAN)) {
  ck(`full_access=false leaves ${feature} gated as before (server)`,
     ent.hasFeature("free", feature, false), ent.hasFeature("free", feature));
  ck(`...and on the client`,
     client.featureUnlocked("free", feature, false), client.featureUnlocked("free", feature));
}
// THE ORDERING RULE. planKnown() is checked BEFORE full_access, so a plan that
// has not loaded never renders as unlocked even for a comped user. Reversing
// those two lines would flash full access during every page load.
ck("an unknown plan stays locked even with full_access",
   client.featureUnlocked(null, "development_plan", true), false);
ck("...and undefined too", client.featureUnlocked(undefined, "pathway_plan", true), false);
// The server has no planKnown equivalent — it always holds the row it decides
// about — so this asymmetry is deliberate, not a parity failure.
// ORDERING, as a property rather than as a syntax match. The first version of
// this pinned the literal two lines and broke the moment the override started
// reading a module-level default — while the behavioural assertions above kept
// passing, because the behaviour was never wrong. Assert that planKnown is
// consulted before anything full_access-related, however that is written.
{
  const fnSrc = /function featureUnlocked\([^)]*\) \{[\s\S]*?\n\}/.exec(APP)[0];
  // Search the BODY only: `fullAccess` is a PARAMETER NAME, so it appears in the
  // signature before planKnown and the first version of this failed on correct
  // code. The claim is about the order of the checks, not of the characters.
  const fnBody = fnSrc.slice(fnSrc.indexOf("{"));
  const kIdx = fnBody.indexOf("planKnown(plan)");
  const fIdx = fnBody.search(/fullAccess|CURRENT_FULL_ACCESS/);
  ck("featureUnlocked consults planKnown before full_access", kIdx >= 0 && kIdx < fIdx, true);
  const lockSrc = /function featureLocked\([^)]*\) \{[\s\S]*?\n\}/.exec(APP)[0];
  const lockBody = lockSrc.slice(lockSrc.indexOf("{"));
  const lk = lockBody.indexOf("planKnown(plan)");
  const lf = lockBody.search(/fullAccess|CURRENT_FULL_ACCESS/);
  ck("...and so does featureLocked", lk >= 0 && lk < lf, true);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
