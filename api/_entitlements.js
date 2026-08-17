// ============================================================
// GOLSZ — authoritative feature entitlement mapping
//
// WHY THIS EXISTS
// Before this file there were TWO answers to "which plan unlocks a Pathway":
//
//   1. golsz-app.html's FEATURE_MIN_PLAN, which actually gates the UI, and
//   2. the free-text GOLSZ CAPABILITIES block assembled for the Scout prompt,
//      which is what Scout told athletes.
//
// Nothing kept them in step. Scout could confidently name the wrong tier, or
// name a tier for a feature the UI had since moved, and the athlete would hit
// a paywall that did not match what they had just been told. The 2026-08-10
// audit flagged this as a real drift surface, not a hypothetical one.
//
// This module is the single authority. api/scout.js consumes it directly so
// entitlement answers are COMPUTED, never narrated from prose the model read.
//
// WHY THE CLIENT STILL HAS A COPY
// golsz-app.html is a no-build-step, Babel-in-browser single file and cannot
// import from api/. The repo already solved this exact problem for money in
// api/_plan-catalog.js ("Mirrors PLANS in golsz-app.html;
// tests/test_cad_pricing.cjs diffs the two so they cannot drift"). Same
// contract here: tests/test_entitlement_parity.cjs extracts FEATURE_MIN_PLAN
// and PLAN_RANK out of BOTH files at run time and fails if they differ by so
// much as one key. Drift stops being possible-but-unnoticed and becomes a
// red build.
//
// THIS FILE CHANGES NO ENTITLEMENTS. Every value below is copied verbatim
// from golsz-app.html as of the migration-122 state. Adjusting who gets what
// is a separate, deliberate decision.
// ============================================================

// DB enum values, not display names. "starter" is Basic on screen — that
// mismatch is historical and deliberately preserved (see CLAUDE.md); the
// user-facing product says Free / Basic / Pro / Elite and access control
// keys off these.
const PLAN_RANK = { free: 0, starter: 1, pro: 2, elite: 3 };

const PLAN_DISPLAY_NAME = { free: "Free", starter: "Basic", pro: "Pro", elite: "Elite" };

// Verbatim mirror of FEATURE_MIN_PLAN in golsz-app.html.
const FEATURE_MIN_PLAN = {
  pdf_export: "starter",
  readiness: "pro",
  targets: "starter",
  benchmarks: "starter",
  development_plan: "pro",
  pathway_plan: "starter",
};

// What each feature is called when talking to a human. Scout is forbidden
// from emitting the raw keys (see stripInternalTerminology in api/scout.js),
// so every entitlement sentence is built from these instead.
const FEATURE_LABEL = {
  pdf_export: "exporting your Passport as a PDF",
  readiness: "the full breakdown of your Passport Strength score",
  targets: "a target list with outreach tracking",
  benchmarks: "benchmark tracking and retests",
  development_plan: "a development plan",
  pathway_plan: "a Pathway with dated milestones",
};

function planRank(plan) {
  const r = PLAN_RANK[plan || "free"];
  return typeof r === "number" ? r : 0;
}

// Mirrors featureUnlocked() in golsz-app.html, including the full_access
// override. If these two disagree the client offers what the server refuses,
// which for a comped user means being shown a feature and then denied it.
// There is no planKnown() equivalent here: the server always has the row it is
// deciding about, so "not loaded yet" is not a state that exists on this side.
function hasFeature(plan, feature, fullAccess) {
  if (fullAccess) return true;
  const min = FEATURE_MIN_PLAN[feature];
  if (!min) return true;
  return planRank(plan) >= planRank(min);
}

function planDisplayName(plan) {
  return PLAN_DISPLAY_NAME[plan || "free"] || "Free";
}

// The lowest plan that unlocks EVERY feature passed in. This is the whole
// point of computing entitlements rather than letting the model choose a
// tier: the answer is the maximum requirement across the identified needs,
// never "the most expensive plan that would also work".
//
// Unknown / ungated features contribute nothing, so a list of them returns
// "free" — i.e. nothing to sell.
function lowestPlanUnlocking(features) {
  let needed = "free";
  for (const f of features || []) {
    const min = FEATURE_MIN_PLAN[f];
    if (min && planRank(min) > planRank(needed)) needed = min;
  }
  return needed;
}

// Given the athlete's current plan and the features their CURRENT situation
// actually calls for, work out what is already covered, what is not, and the
// single cheapest upgrade that would cover the gap.
//
// `needs` must come from real observed state (an empty Pathway, an empty
// target list, a readiness dimension they asked about) — never from a
// schedule or a conversation counter. If nothing is locked this returns
// upgradeTo: null and Scout has nothing to raise, which is the common case
// and must stay the common case.
function evaluateEntitlements(plan, needs) {
  const current = plan || "free";
  const list = Array.isArray(needs) ? needs.filter((f) => Object.hasOwn(FEATURE_MIN_PLAN, f)) : [];
  const covered = list.filter((f) => hasFeature(current, f));
  const locked = list.filter((f) => !hasFeature(current, f));
  const upgradeTo = locked.length ? lowestPlanUnlocking(locked) : null;
  return {
    currentPlan: current,
    currentPlanName: planDisplayName(current),
    covered,
    coveredLabels: covered.map((f) => FEATURE_LABEL[f] || f),
    locked,
    lockedLabels: locked.map((f) => FEATURE_LABEL[f] || f),
    upgradeTo,
    upgradeToName: upgradeTo ? planDisplayName(upgradeTo) : null,
  };
}

export {
  PLAN_RANK,
  PLAN_DISPLAY_NAME,
  FEATURE_MIN_PLAN,
  FEATURE_LABEL,
  planRank,
  hasFeature,
  planDisplayName,
  lowestPlanUnlocking,
  evaluateEntitlements,
};
