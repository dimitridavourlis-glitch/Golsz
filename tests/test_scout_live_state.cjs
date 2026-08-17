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

// PROMPT-SIDE ASSERTIONS READ THE PROMPT, NOT THE FILE.
// Two failure modes this closes, both found on 2026-08-11 while reconciling
// the prompt rewrite:
//   1. An assertion testing SCOUT (the whole file) can pass by matching a
//      CODE COMMENT describing the old rule. Two in test_entitlement_parity
//      were doing exactly that, against comments written in this session.
//   2. A window sliced on an anchor the rewrite deleted gets indexOf() === -1,
//      so slice(-1, n) returns garbage and its assertions evaluate against
//      nothing while looking healthy. About 24 assertions were in that state.
// Extracting the template literal and throwing on a dead anchor makes both
// impossible rather than merely unlikely.
const PROMPT_OPEN = "const SYSTEM_PROMPT = `";
const _ps = SCOUT.indexOf(PROMPT_OPEN) + PROMPT_OPEN.length;
let _pe = _ps;
while (_pe < SCOUT.length) { if (SCOUT[_pe] === "`" && SCOUT[_pe - 1] !== "\\") break; _pe++; }
const PROMPT = SCOUT.slice(_ps, _pe);
if (PROMPT.length < 5000) throw new Error("SYSTEM_PROMPT extraction failed — the declaration moved or the walk broke");
function promptSlice(anchor, len) {
  const i = PROMPT.indexOf(anchor);
  if (i < 0) throw new Error(`dead anchor: "${anchor}" — the prompt no longer contains it`);
  return PROMPT.slice(i, i + len);
}

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
   /Never reword their stated goal to fit a pathway/.test(PROMPT), true);
ck("...and the old blanket refusal is called out as wrong",
   /a real conflict to surface and resolve with them/.test(PROMPT), true);
ck("Scout is told it can propose a corrected Pathway",
   /function synthesizePathwayFromState/.test(SCOUT), true);
ck("...via the one-tap suggested_pathway mechanism",
   (SCOUT.match(/finalizeSuggestedPathway\(data, pathwayBuildCtx, incomingText, userPlan\)/g) || []).length === 4, true);
// CLOSED 2026-08-11 by a client-side preview, which is a stronger fix than
// the prompt sentence it replaces: it cannot be skipped by a model that
// decides not to mention the change.
//
// The hazard is that addSuggestedPathway() upserts milestones as a straight
// REPLACE. An athlete with six milestones and three ticked off loses all of
// it in one tap. Showing the incoming Pathway alone would not prevent that,
// so the panel shows BOTH sides and states the destruction in words.
ck("the preview renders the athlete's CURRENT Pathway before the incoming one",
   APP.indexOf("scout_pathway_current") < APP.indexOf("scout_pathway_incoming"), true);
ck("...and completed milestones are visibly marked as such",
   /ms && ms\.done \? "\\u2713 " : "\\u00b7 "/.test(APP), true);
ck("the replacement is stated in words, with both counts and the done count",
   /scout_pathway_replace_warning[\s\S]{0,160}replace\("\{old\}", cur\.length\)[\s\S]{0,80}replace\("\{done\}", done\)[\s\S]{0,80}replace\("\{new\}", next\.length\)/.test(APP), true);
ck("a first-time build says so instead of warning about a replacement",
   /cur\.length[\s\S]{0,120}scout_pathway_first_build/.test(APP), true);
ck("the warning is highlighted only when something is actually destroyed",
   /color: cur\.length \? C\.amber : C\.slate/.test(APP), true);
// The old anchor was `addSuggestedPathway(i, m.suggestedPathway)` — the
// one-tap commit button, which no longer exists: the button now opens a
// confirm panel and nothing writes until a second, mode-carrying tap. So the
// ordering claim is re-stated against what actually commits now, and the
// stronger property it was reaching for is asserted directly below.
ck("the preview sits ABOVE anything that can commit it",
   APP.indexOf("scout_pathway_replace_warning") < APP.indexOf('addSuggestedPathway(i, m.suggestedPathway, replacing'), true);

// THE INVARIANT THE OLD TEST ONLY GESTURED AT.
// A single tap used to overwrite every milestone the athlete owned, including
// ticks, dates and stages. addSuggestedPathway now refuses to write at all
// without an explicit mode, so a future edit that reintroduces a one-tap call
// site fails here rather than shipping.
ck("addSuggestedPathway refuses to write without an explicit mode",
   /if \(mode !== "add" && mode !== "replace"\) return;/.test(APP), true);
ck("...and every call site passes one",
   [...APP.matchAll(/addSuggestedPathway\(([^)]*)\)/g)]
     .map((m) => m[1])
     .filter((a) => a.trim() && !/^msgIndex/.test(a))   // "" is prose in a comment, not a call
     .filter((a) => !/, *(?:"add"|"replace"|replacing)/.test(a)), []);
ck("add is the default and replace is the deliberate branch",
   /const merged = mode === "replace" \? incoming : existing\.concat\(incoming\)/.test(APP), true);
ck("both branches normalise, so Scout's dateless/stageless steps are repaired",
   /const incoming = \(pathway\.milestones \|\| \[\]\)\.map\(normalizeMilestone\)/.test(APP), true);
ck("replacing states what is lost before it writes",
   /pathwayConfirm === "replace"[\s\S]{0,600}scout_pathway_replace_warning/.test(APP), true);
ck("Scout holds the current Pathway to compare against", /const \[currentPathway, setCurrentPathway\]/.test(APP), true);
// Pinned the exact column list, so it broke when `stages, current_stage_id`
// were added for the node editor. The property is that Scout reads the Pathway
// on mount — not which columns it happened to need in August. Asserting the
// columns it actually depends on, and leaving room for more.
ck("...read on mount alongside the other athlete reads",
   /sb\.from\("pathway_plan"\)\.select\("pathway_type, target_timeline, milestones[^"]*"\)/.test(APP), true);
ck("...and refreshed after an apply so a second proposal compares correctly",
   /setCurrentPathway\(\{ pathway_type: pathway\.pathway_type/.test(APP), true);
ck("all four preview strings are translated in every language",
   ["scout_pathway_current", "scout_pathway_incoming", "scout_pathway_replace_warning", "scout_pathway_first_build"]
     .every((k) => (APP.match(new RegExp(k + ":", "g")) || []).length === 4), true);
ck("the goal still bends nothing — the Pathway bends to it",
   /The goal is theirs\. The Pathway bends to it, never the reverse/.test(PROMPT), true);
ck("a contradiction is an allowed trigger for suggested_pathway",
   /PATHWAY CONFLICTS WITH THEIR GOAL: their written goal reads/.test(SCOUT), true);
ck("...and a suggestion may never contradict the written goal",
   /rejected a suggested Plan that contradicted the athlete's written goal/.test(SCOUT), true);
// Free stays free: correcting a Pathway must not become a Free feature.
ck("suggested_pathway is still Free-gated", /if \(!hasFeature\(plan, "pathway_plan"\)\) return \{ pathway: null, source: "gated" \}/.test(SCOUT), true);
// The server-side Free gate used to be the literal expression
// `userPlan === "free" ? null : extractSuggestedPathway(data)` at each of
// the four response paths. Those were replaced by finalizeSuggestedPathway()
// when the deterministic Scout->Plan handoff landed, so asserting on that
// string would now be testing a ghost. Assert the BEHAVIOUR instead, by
// running the real gate: Free must still get nothing even when the model
// emitted a perfectly valid Pathway and the athlete asked for it.
{
  const gateFrom = SCOUT.indexOf("function resolveSuggestedPathway");
  const gateTo = SCOUT.indexOf("// One call the four response paths share");
  if (gateFrom < 0 || gateTo < 0) throw new Error("resolveSuggestedPathway not found — update this slice");
  // hasFeature comes from api/_entitlements.js, which resolveSuggestedPathway
  // closes over in production; supply the real one here.
  const { hasFeature } = require("../api/_entitlements.js");
  const PATHWAY_TYPE_SET = new Set(["ncaa", "juco", "european_club", "professional"]);
  eval(SCOUT.slice(gateFrom, gateTo));
  const validModelPathway = { pathway_type: "european_club", target_timeline: null, milestones: [{ label: "x", done: false }] };
  ck("suggested_pathway still stripped server-side for free",
     resolveSuggestedPathway({ modelPathway: validModelPathway, approved: true, plan: "free", goalDefined: true, pathwayType: "european_club", readiness: null }).pathway, null);
  ck("...and Basic still receives it",
     resolveSuggestedPathway({ modelPathway: validModelPathway, approved: true, plan: "starter", goalDefined: true, pathwayType: "european_club", readiness: null }).pathway !== null, true);
}

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
   /What you KNOW vs what you GUESS is everything/.test(PROMPT), true);
ck("judgements must still be committed to", /Agents commit to a view, then say when they might be wrong/.test(PROMPT), true);
ck("unverified facts must be flagged as unsure",
   /Say what you'd check and why it matters/.test(PROMPT), true);
// DEFERRED by the owner on 2026-08-11, not lost. The old prompt named the
// pattern outright ("never assert one version, then reverse, then reverse
// again"). The rewrite's FACT-vs-GUESS section plus "If sources disagree,
// say so once" cover most of it; the explicit pattern-naming does not exist.
ck("...and the weak spot is named explicitly",
   /small clubs, youth leagues, and lower divisions, your recall is weakest there/.test(PROMPT), true);
ck("conflicting sources get one plain statement plus a pick",
   /If sources disagree, say so once/.test(PROMPT), true);

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
