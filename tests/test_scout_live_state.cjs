// Scout must be connected to the athlete's LIVE product state (2026-08-10).
//
// Five defects, all found from real screenshots of a real account, all
// regression-guarded here:
//
//   A  getAthleteState() read ONE column from pathway_plan
//      (baseline_complete), so the whole of Scout's knowledge of the Plan
//      was the boolean "a row exists". It could not see pathway_type,
//      milestones, targets, development items or a single benchmark.
//   B  Editing a goal left pathway_type stale. Production held goal_text
//      "play for a top European club" against pathway_type 'juco'.
//   C  A rule protecting the athlete's GOAL WORDING had been generalised by
//      the model into "I can't change what's listed on your Plan", so Scout
//      refused to help with a Plan it was being asked to fix.
//   D  A pathway_plan row with zero milestones was rendered as a completed
//      Pathway on Home while the Plan tab said "No milestones yet".
//   E  Scout asserted a club's promotion, corrected itself, then asserted
//      again — confident invention on a verifiable fact.
//
// The load-bearing assertion in this file is the last section: none of the
// above may move a quota, a price, an auth rule or a cost counter.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// Run the REAL reconciliation code rather than a retyped copy: slice from
// the pattern table through the end of reconcileGoalWithPathway and eval it.
// Direct eval leaks the function declarations into this scope; the consts
// stay in the eval scope, which is fine because the functions close over it.
const from = SCOUT.indexOf("const GOAL_TEXT_PATTERNS");
const to = SCOUT.indexOf("// Applies ONLY the derived pathway_type");
eval(SCOUT.slice(from, to));

console.log("-- A: Scout reads live product state, not just a boolean --");
const stateFn = SCOUT.slice(SCOUT.indexOf("async function getAthleteState"), SCOUT.indexOf("// Atomic reserve-and-check"));
// URLs here are built by string concatenation, not template literals.
ck("pathway_plan select carries the whole Plan",
   /pathway_plan\?user_id=eq\." \+ userId \+ "&select=pathway_type,target_timeline,milestones,baseline_complete/.test(stateFn), true);
ck("...not just baseline_complete", /select=baseline_complete"/.test(stateFn), false);
ck("development_plan_items is read", /development_plan_items\?user_id=eq/.test(stateFn), true);
ck("outreach_targets is read", /outreach_targets\?user_id=eq/.test(stateFn), true);
ck("athlete_benchmarks is read", /athlete_benchmarks\?user_id=eq/.test(stateFn), true);
// Unbounded reads would blow the prompt budget for a heavy user.
ck("every list read is capped", (stateFn.match(/&limit=\d+/g) || []).length >= 3, true);
ck("benchmarks come newest-first", /athlete_benchmarks[^`]*order=recorded_date\.desc/.test(stateFn), true);
ck("...and are de-duplicated to one CURRENT value per metric",
   /seen\.has\(row\.metric\)/.test(stateFn) && /seen\.add\(row\.metric\)/.test(stateFn), true);
ck("the returned state exposes the Plan contents",
   ["pathwayType", "pathwayTimeline", "milestoneCount", "milestonesDone", "pathwayComplete", "devItems", "targets", "benchmarks"]
     .every((k) => stateFn.includes(k)), true);

console.log("\n-- A: and it reaches the prompt --");
ck("THEIR PLAN block is built", /THEIR PLAN \(the Plan tab, live\)/.test(SCOUT), true);
ck("THEIR BENCHMARKS block is built", /THEIR BENCHMARKS \(Passport/.test(SCOUT), true);
ck("THEIR DEVELOPMENT PLAN block is built", /THEIR DEVELOPMENT PLAN \(live\)/.test(SCOUT), true);
ck("THEIR TARGET LIST block is built", /THEIR TARGET LIST \(live\)/.test(SCOUT), true);
// The whole point: live record beats remembered value.
ck("the record is declared to outrank Scout's own memory",
   /If your memory of a number disagrees with this list, this list is right/.test(SCOUT), true);
ck("Scout is told not to re-suggest existing dev items",
   /Never re-suggest an item already on this list/.test(SCOUT), true);
ck("...or existing targets", /Never re-suggest a target already on this list/.test(SCOUT), true);

console.log("\n-- B: goal vs pathway reconciliation (running the real function) --");
// The exact production case from the screenshots.
const realCase = reconcileGoalWithPathway("My goal is to play for a top European club", "juco", 0);
ck("the live bug is detected", realCase.derived, "european_club");
ck("...and with 0 milestones it is a SAFE auto-fix", realCase.safeAutoFix, true);
ck("...so it is not raised as an unresolved conflict", realCase.conflict, false);

// Same contradiction, but the athlete has real work in the Pathway.
const withWork = reconcileGoalWithPathway("My goal is to play for a top European club", "juco", 3);
ck("with milestones present it becomes a CONFLICT", withWork.conflict, true);
ck("...and is NOT silently auto-fixed", withWork.safeAutoFix, false);
ck("...and names what is stored", withWork.storedType, "juco");

ck("agreement is not a conflict", reconcileGoalWithPathway("I want to play NCAA D1", "ncaa", 5).conflict, false);
ck("no pathway yet is not a conflict", reconcileGoalWithPathway("I want to play NCAA D1", null, 0).conflict, false);
// Ambiguity must never be guessed — that is what created the bug.
const ambiguous = reconcileGoalWithPathway("I want to play college soccer, NCAA or JUCO", "professional", 4);
ck("an ambiguous goal yields no derived type", ambiguous.derived, null);
ck("...and is never treated as a conflict", ambiguous.conflict, false);
ck("...and is never auto-fixed", ambiguous.safeAutoFix, false);
for (const empty of [null, undefined, "", "   "]) {
  ck(`empty goal ${JSON.stringify(empty)} is inert`, reconcileGoalWithPathway(empty, "juco", 0).conflict, false);
}

console.log("\n-- B: the athlete's written goal is never rewritten --");
const fixFn = SCOUT.slice(SCOUT.indexOf("async function autoFixPathwayType"), SCOUT.indexOf("async function autoFixPathwayType") + 1200);
ck("auto-fix PATCHes pathway_type and nothing else",
   /JSON\.stringify\(\{ pathway_type: derivedType \}\)/.test(fixFn), true);
ck("...it never writes goal_text", /goal_text/.test(fixFn), false);
ck("...it never writes milestones", /milestones/.test(fixFn), false);
ck("...and it validates against the real enum", /PATHWAY_TYPE_SET\.has\(derivedType\)/.test(fixFn), true);
ck("the existing athlete-authored goal guard still stands",
   /GOLSZ goal overwrite BLOCKED \(athlete-authored\)/.test(SCOUT), true);

console.log("\n-- C: Scout may correct a Pathway, not just defer --");
ck("the deflection rule is scoped to the goal wording only",
   /THIS RULE COVERS THE WORDING OF THEIR GOAL AND NOTHING ELSE/.test(SCOUT), true);
ck("...and the old blanket refusal is called out as wrong",
   /Saying "I can't change what's on your Plan" is wrong/.test(SCOUT), true);
ck("Scout is told it can propose a corrected Pathway",
   /propose a corrected Pathway/.test(SCOUT), true);
ck("...via the one-tap suggested_pathway mechanism",
   /build or rebuild one via suggested_pathway/.test(SCOUT), true);
ck("...and must say what will change before they accept",
   /say plainly what will change/.test(SCOUT), true);
ck("the goal still bends nothing — the Pathway bends to it",
   /the goal is theirs and the Pathway bends to it, never the reverse/.test(SCOUT), true);
ck("a contradiction is an allowed trigger for suggested_pathway",
   /PATHWAY CONFLICTS WITH THEIR GOAL appears and they have agreed to a rebuild/.test(SCOUT), true);
ck("...and a suggestion may never contradict the written goal",
   /Never send one that contradicts their written goal/.test(SCOUT), true);
// Free stays free: correcting a Pathway must not become a Free feature.
ck("suggested_pathway is still Free-gated", /Never include it for a Free-plan athlete/.test(SCOUT), true);
ck("...and still stripped server-side for free", /userPlan === "free" \? null : extractSuggestedPathway/.test(SCOUT), true);

console.log("\n-- D: an empty Pathway is not a Pathway --");
ck("server computes pathwayComplete from milestone count",
   /pathwayComplete: pathwayCreated && milestoneCount > 0/.test(SCOUT), true);
ck("the prompt says a milestone-less Pathway is a shell",
   /it is a shell, not a finished Pathway/.test(SCOUT), true);
ck("...and forbids calling it built", /Do not describe it as built, done or in place/.test(SCOUT), true);
// Client must agree with the server, or Home and Scout contradict again.
eval(APP.slice(APP.indexOf("function computePathwayScore"), APP.indexOf("// Plan-gating")) +
     "\nfunction __pw(a,b){ return computePathwayScore(a,b); }");
const emptyPw = __pw({ pathway_type: "juco", milestones: [] }, 0);
ck("client: a 0-milestone pathway is NOT hasPathway", emptyPw.hasPathway, false);
ck("...but is recorded as started", emptyPw.pathwayStarted, true);
const realPw = __pw({ pathway_type: "european_club", milestones: [{ label: "x", done: true }, { label: "y", done: false }] }, 2);
ck("client: a real pathway IS hasPathway", realPw.hasPathway, true);
ck("...with milestone progress intact", [realPw.milestonesDone, realPw.milestonesTotal], [1, 2]);
ck("client: no pathway row at all", [__pw(null, 0).hasPathway, __pw(null, 0).pathwayStarted], [false, false]);
ck("Home distinguishes empty from absent", /home_pathway_empty/.test(APP), true);
for (const lang of ["en", "fr", "es", "el"]) {
  const i = APP.indexOf("\n  " + lang + ": {");
  ck(`${lang} defines home_pathway_empty`, APP.slice(i, i + 60000).includes("home_pathway_empty:"), true);
}

console.log("\n-- E: commit on judgement, hedge on unverified fact --");
ck("the fact/judgement split is stated",
   /FACTS AND JUDGEMENTS ARE DIFFERENT THINGS/.test(SCOUT), true);
ck("judgements must still be committed to", /Commit to those\. That is the job\./.test(SCOUT), true);
ck("unverified facts must be flagged as unsure",
   /say you are not sure and say what you would check/.test(SCOUT), true);
ck("the flip-flop pattern is named and forbidden",
   /Never assert one version, then reverse, then reverse again/.test(SCOUT), true);
ck("...and the weak spot is named explicitly",
   /Small clubs, youth leagues and lower divisions are exactly where your recall is weakest/.test(SCOUT), true);
ck("conflicting sources get one plain statement plus a pick",
   /When sources genuinely disagree/.test(SCOUT), true);

console.log("\n-- NOTHING COMMERCIAL OR SECURITY-RELATED MOVED --");
// This is the section that must never go green by accident.
ck("Scout daily allowances unchanged (3/8/15/20)",
   /ELITE_DAILY_LIMIT \|\| 20[\s\S]{0,200}PRO_DAILY_LIMIT \|\| 15[\s\S]{0,200}STARTER_DAILY_LIMIT \|\| 8[\s\S]{0,200}FREE_DAILY_LIMIT \|\| 3/.test(SCOUT), true);
ck("free lifetime cap still 40",
   /const freeLifetimeLimit = Number\(process\.env\.FREE_LIFETIME_LIMIT \|\| 40\)/.test(SCOUT), true);
ck("quota reservation still skipped only for admin/unlimited",
   /if \(!isAdmin && !aiUnlimited\) \{/.test(SCOUT), true);
ck("cost is still recorded every reply", /record_scout_usage_cost/.test(SCOUT), true);
ck("routing telemetry still written", /scout_routing_log/.test(SCOUT), true);
ck("CORS allowlist untouched", /ALLOWED_ORIGIN \|\| "https:\/\/golsz\.com,https:\/\/golsz\.vercel\.app"/.test(SCOUT), true);
ck("EUR prices untouched in the client", /price: 6,[\s\S]{0,400}price: 15,[\s\S]{0,400}price: 30,/.test(APP), true);
ck("plan ids untouched",
   (APP.slice(APP.indexOf("const PLANS = ["), APP.indexOf("const PLANS = [") + 1200)
      .match(/id: "(free|starter|pro|elite)"/g) || []),
   ['id: "free"', 'id: "starter"', 'id: "pro"', 'id: "elite"']);
ck("the new reads are athlete-scoped, never cross-athlete",
   (stateFn.match(/user_id=eq\./g) || []).length >= 4, true);
ck("...and each one interpolates the caller's own userId",
   (stateFn.match(/user_id=eq\." \+ userId/g) || []).length >= 4, true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
