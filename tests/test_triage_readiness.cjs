// Prompt #1 — Scout Triage Stabilization.
//
// Covers the three pure functions that decide whether GOLSZ knows enough
// about an athlete to stop interviewing and start assessing:
//   classifyGoalText()   free-text goal -> pathway_plan.pathway_type enum
//   pathwayPriorityFor() sport+pathway -> critical/useful/deprioritized fields
//   isAssessmentReady()  the ONE canonical readiness signal
//
// Zero live model calls by design. The conversational qualities this feature
// also touches — whether Scout's probing FEELS natural, whether the recap
// reads well — are deliberately NOT asserted here: they're model behaviour,
// they'd need a real API call, and a flaky assertion inside `npm run check`
// fails deploys for reasons unrelated to the change. Those stay manual QA.
//
// Per tests/README.md: everything under test is extracted from api/scout.js
// at run time. Nothing is retyped. A suite that tests a copy passes happily
// while production is broken — that already happened once here
// (test_budget_gate.cjs held a hand-copied config while the real
// ANTHROPIC_DEFAULTS shipped the broken value it was supposed to catch).

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SRC = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));

// One contiguous slice covering the whole triage-readiness block. Direct
// eval() leaks FUNCTION declarations into this scope but NOT const/let, so
// the config constant is retrieved through an appended extractor function
// that closes over it (same pattern as test_budget_gate.cjs).
eval(slice("const GOAL_TEXT_PATTERNS", "\n// Same extraction shape as extractProfileUpdates()") +
  "\nfunction __extractTriageDeps() { return { PATHWAY_FIELD_PRIORITY }; }");
const { PATHWAY_FIELD_PRIORITY } = __extractTriageDeps();

let p = 0, f = 0;
const ck = (label, actual, expected) => {
  const A = JSON.stringify(actual), E = JSON.stringify(expected);
  if (A === E) { p++; console.log("PASS  " + label); }
  else { f++; console.log(`FAIL  ${label}\n   exp ${E}\n   got ${A}`); }
};

console.log("-- classifyGoalText: unambiguous goals resolve --");
ck("NCAA D1 -> ncaa", classifyGoalText("I want to play NCAA D1 soccer"), "ncaa");
ck("bare 'D1' -> ncaa", classifyGoalText("trying to get a D1 offer"), "ncaa");
ck("'division 2' -> ncaa", classifyGoalText("Division 2 would be realistic"), "ncaa");
ck("NAIA -> naia", classifyGoalText("looking at NAIA schools"), "naia");
ck("junior college -> juco", classifyGoalText("might start at junior college"), "juco");
ck("U Sports -> canadian_university", classifyGoalText("I want to play U Sports in Canada"), "canadian_university");
ck("go pro -> professional", classifyGoalText("I want to go pro"), "professional");
ck("sign a contract -> professional", classifyGoalText("hoping to sign a contract next year"), "professional");
ck("academy -> academy", classifyGoalText("get into a top academy"), "academy");

console.log("\n-- classifyGoalText: refuses to guess (Master Architecture §18) --");
// §18's own worked example: "I want to play college soccer" could mean NCAA
// D1, any NCAA, NAIA, JUCO or Canadian university. Guessing would silently
// weight the athlete's entire assessment against a pathway they never chose.
ck("bare 'college' is ambiguous -> null", classifyGoalText("I want to play college soccer"), null);
ck("two different categories -> null", classifyGoalText("NCAA or maybe go pro in Europe"), null);
ck("no recognised goal -> null", classifyGoalText("I just want to get better"), null);
ck("empty string -> null", classifyGoalText(""), null);
ck("null input -> null", classifyGoalText(null), null);
ck("non-string input -> null", classifyGoalText({ goal: "ncaa" }), null);
// Word-boundary guards: these must NOT read as "pro".
ck("'program' does not match professional", classifyGoalText("I'm in a good training program"), null);
ck("'progress' does not match professional", classifyGoalText("I want to make progress"), null);

console.log("\n-- config shape: the sport/goal axis actually differentiates --");
ck("soccer:ncaa treats gpa as critical",
   PATHWAY_FIELD_PRIORITY["soccer:ncaa"].critical.includes("gpa"), true);
ck("soccer:professional does NOT treat gpa as critical",
   PATHWAY_FIELD_PRIORITY["soccer:professional"].critical.includes("gpa"), false);
ck("soccer:professional explicitly deprioritizes gpa",
   PATHWAY_FIELD_PRIORITY["soccer:professional"].deprioritized.includes("gpa"), true);
ck("basketball:ncaa also treats gpa as critical (generalises across sport)",
   PATHWAY_FIELD_PRIORITY["basketball:ncaa"].critical.includes("gpa"), true);
ck("basketball:professional deprioritizes gpa (generalises across goal)",
   PATHWAY_FIELD_PRIORITY["basketball:professional"].deprioritized.includes("gpa"), true);

console.log("\n-- target_level is USEFUL, never CRITICAL (demoted 2026-08-09) --");
// It was populated for only 1 of 13 production athletes AND it restates the
// goal ("NCAA D1 soccer" already establishes the level). Critical in both
// places meant a stated goal still left the athlete blocked on a duplicate
// question. Asserted across EVERY entry so a future edit can't quietly
// re-promote it in one config and reintroduce the block.
for (const key of Object.keys(PATHWAY_FIELD_PRIORITY)) {
  ck(`${key}: target_level is not critical`,
     PATHWAY_FIELD_PRIORITY[key].critical.includes("target_level"), false);
  ck(`${key}: target_level is still tracked as useful`,
     PATHWAY_FIELD_PRIORITY[key].useful.includes("target_level"), true);
}
// The point of the demotion: a stated goal alone now unblocks an athlete who
// never spelled out a separate "target level".
ck("an athlete with a goal but no target_level IS ready",
   isAssessmentReady({
     athlete: { sport: "soccer", position: "CB", club_name: "Omonia U19", age_reported: 17,
       scout_context: { timeline: { value: "2 years", source: "athlete_stated" } } },
     goalText: "I want to go pro",
   }).sufficient_for_preliminary_assessment, true);

console.log("\n-- DEFAULT is the COMMON path, not an edge case --");
// ~11 sports are offered and two are configured; every free athlete whose
// goal text didn't classify also lands here. It gets tested hardest.
ck("DEFAULT exists", !!PATHWAY_FIELD_PRIORITY.DEFAULT, true);
ck("DEFAULT has non-empty critical fields", PATHWAY_FIELD_PRIORITY.DEFAULT.critical.length > 0, true);
ck("unconfigured sport+goal falls back to DEFAULT",
   pathwayPriorityFor("handball", "transfer"), PATHWAY_FIELD_PRIORITY.DEFAULT);
ck("configured sport with unclassified goal falls back to DEFAULT",
   pathwayPriorityFor("soccer", null), PATHWAY_FIELD_PRIORITY.DEFAULT);
ck("unknown sport with known goal falls back to DEFAULT",
   pathwayPriorityFor("curling", "ncaa"), PATHWAY_FIELD_PRIORITY.DEFAULT);
ck("null sport does not throw", pathwayPriorityFor(null, null), PATHWAY_FIELD_PRIORITY.DEFAULT);
ck("sport matching is case-insensitive",
   pathwayPriorityFor("Soccer", "ncaa"), PATHWAY_FIELD_PRIORITY["soccer:ncaa"]);
ck("DEFAULT never deprioritizes anything (nothing to safely drop without a goal)",
   PATHWAY_FIELD_PRIORITY.DEFAULT.deprioritized.length, 0);

console.log("\n-- isAssessmentReady: not ready --");
// The roadmap's Test D, verbatim: "I am 16 and want to go pro."
const barelyAnything = {
  athlete: { age_reported: 16, scout_context: {} },
  goalText: "I want to go pro",
};
const notReady = isAssessmentReady(barelyAnything);
ck("sparse athlete is NOT ready", notReady.sufficient_for_preliminary_assessment, false);
ck("...and says what is actually blocking", notReady.missing_critical.length > 0, true);
ck("...missing sport specifically", notReady.missing_critical.includes("sport"), true);
ck("...confidence is low when not ready", notReady.confidence, "low");
ck("an entirely empty context is not ready and does not throw",
   isAssessmentReady({}).sufficient_for_preliminary_assessment, false);
ck("no argument at all does not throw",
   isAssessmentReady().sufficient_for_preliminary_assessment, false);

console.log("\n-- isAssessmentReady: a stated goal is non-negotiable (§18) --");
const noGoal = {
  athlete: {
    sport: "soccer", position: "Right Back", club_name: "Tusculum", age_reported: 20,
    grad_year: 2026, gpa: 3.4,
    scout_context: { target_level: { value: "NCAA D2", source: "athlete_stated" } },
  },
  goalText: null,
};
const noGoalResult = isAssessmentReady(noGoal);
ck("a full profile with NO stated goal is still not ready",
   noGoalResult.sufficient_for_preliminary_assessment, false);
ck("...and names the goal as the blocker", noGoalResult.missing_critical.includes("goal"), true);

console.log("\n-- isAssessmentReady: ready (roadmap Test E) --");
const fullNcaa = {
  athlete: {
    sport: "soccer", position: "Right Back", club_name: "Tusculum University",
    age_reported: 20, grad_year: 2026, gpa: 3.4, height_cm: 180,
    scout_context: {
      target_level: { value: "NCAA D1", source: "athlete_stated" },
      timeline: { value: "within 18 months", source: "athlete_stated" },
      perceived_strengths: { value: "reads the game from deep", source: "athlete_stated" },
      perceived_weaknesses: { value: "needs more pace", source: "athlete_stated" },
      exposure_need: { value: "no highlight film yet", source: "ai_inferred", confidence: 0.7 },
    },
  },
  goalText: "NCAA D1 soccer",
};
const ready = isAssessmentReady(fullNcaa);
ck("complete NCAA athlete IS ready", ready.sufficient_for_preliminary_assessment, true);
ck("...with nothing critical outstanding", ready.missing_critical, []);
ck("...and high confidence when useful fields are covered too", ready.confidence, "high");

console.log("\n-- the roadmap's Test C: SAME athlete, DIFFERENT goal, different verdict --");
// The whole point of the sport/goal axis. Two athletes identical in every
// respect except their stated goal; gpa/grad_year are missing from both.
const athleteMinusAcademics = {
  sport: "soccer", position: "Centre Back", club_name: "Omonia U19", age_reported: 17,
  scout_context: {
    target_level: { value: "top level", source: "athlete_stated" },
    timeline: { value: "2 years", source: "athlete_stated" },
    perceived_strengths: { value: "aerial duels", source: "athlete_stated" },
    perceived_weaknesses: { value: "distribution", source: "athlete_stated" },
    main_gap: { value: "senior minutes", source: "ai_inferred", confidence: 0.6 },
  },
};
const asNcaa = isAssessmentReady({ athlete: athleteMinusAcademics, goalText: "NCAA D1" });
const asPro = isAssessmentReady({ athlete: athleteMinusAcademics, goalText: "I want to go pro" });

ck("NCAA goal: missing gpa BLOCKS readiness", asNcaa.missing_critical.includes("gpa"), true);
ck("NCAA goal: missing grad_year also blocks", asNcaa.missing_critical.includes("grad_year"), true);
ck("NCAA goal: therefore not ready", asNcaa.sufficient_for_preliminary_assessment, false);
ck("PRO goal: gpa is NOT a blocker", asPro.missing_critical.includes("gpa"), false);
ck("PRO goal: grad_year is NOT a blocker", asPro.missing_critical.includes("grad_year"), false);
ck("PRO goal: the same athlete IS ready", asPro.sufficient_for_preliminary_assessment, true);
ck("the two verdicts genuinely differ (this is the feature)",
   asNcaa.sufficient_for_preliminary_assessment !== asPro.sufficient_for_preliminary_assessment, true);

console.log("\n-- field presence: hard columns and scout_context both count --");
ck("age resolves from dob alone",
   isAssessmentReady({ athlete: { sport: "soccer", position: "GK", club_name: "X", dob: "2008-01-01",
     scout_context: { target_level: { value: "D2" } } }, goalText: "NCAA D2" }).missing_critical.includes("age"), false);
ck("age resolves from age_reported alone",
   isAssessmentReady({ athlete: { sport: "soccer", position: "GK", club_name: "X", age_reported: 17,
     scout_context: { target_level: { value: "D2" } } }, goalText: "NCAA D2" }).missing_critical.includes("age"), false);
ck("an empty-valued scout_context entry counts as MISSING, not present",
   isAssessmentReady({ athlete: { sport: "soccer", position: "GK", club_name: "X", age_reported: 17,
     scout_context: { timeline: { value: "", source: "ai_inferred" } } }, goalText: "go pro" })
     .missing_critical.includes("timeline"), true);
ck("a plain (non-object) scout_context value still counts as present",
   isAssessmentReady({ athlete: { sport: "soccer", position: "GK", club_name: "X", age_reported: 17,
     scout_context: { timeline: "2 years" } }, goalText: "go pro" })
     .missing_critical.includes("timeline"), false);
ck("an empty-string column counts as MISSING",
   isAssessmentReady({ athlete: { sport: "soccer", position: "", club_name: "X", age_reported: 17,
     scout_context: {} }, goalText: "go pro" }).missing_critical.includes("position"), true);

console.log("\n-- confidence is derived, never free-form --");
const CONFIDENCES = new Set(["low", "moderate", "high"]);
ck("every confidence value is one of low/moderate/high",
   [notReady, ready, asNcaa, asPro, noGoalResult].every((r) => CONFIDENCES.has(r.confidence)), true);
ck("not-ready always reports low confidence regardless of useful fields",
   asNcaa.confidence, "low");
// The three bands, walked deliberately. Base athlete clears every CRITICAL
// field for soccer:professional, so only the useful-field count moves.
const proBase = { sport: "soccer", position: "CB", club_name: "X", age_reported: 17 };
const proCtx = (extra) => ({
  athlete: { ...proBase, ...extra, scout_context: { target_level: { value: "pro" }, timeline: { value: "2y" }, ...(extra && extra.scout_context) } },
  goalText: "go pro",
});
// 2 of 4 useful present -> 2 missing -> moderate.
const moderate = isAssessmentReady(proCtx({ height_cm: 185, scout_context: { main_gap: { value: "senior minutes" } } }));
ck("ready with a couple of useful gaps -> moderate", moderate.confidence, "moderate");
ck("...and is still genuinely ready", moderate.sufficient_for_preliminary_assessment, true);
// 0 of 4 useful present -> 4 missing -> low, even though assessment is possible.
const thinButReady = isAssessmentReady(proCtx({}));
ck("ready but with every useful field missing -> low confidence, not moderate",
   thinButReady.confidence, "low");
// This pairing is the point: GOLSZ can begin assessing while still saying
// plainly that it isn't confident yet (Master Architecture §33 — acknowledge
// uncertainty rather than manufacturing it away).
ck("...while still reporting itself ready (sufficient AND low is a valid state)",
   thinButReady.sufficient_for_preliminary_assessment, true);

console.log("\n-- goal safety net: athlete-stated dream_outcome rescues an empty goal_text --");
// The real failure it exists for: all 13 production athletes had goal_text
// empty while dream_outcome held genuine athlete-stated goals ("CPL
// professional contract", "turn pro in soccer"). Promotion only — never
// invention, never overwrite.
const STATED = { dream_outcome: { value: "CPL professional contract", source: "athlete_stated" } };
ck("promotes an athlete-stated dream_outcome sent THIS turn",
   applyGoalSafetyNet(null, STATED, null, null), { goal: "CPL professional contract" });
ck("...also when profile_updates exists but has no goal",
   applyGoalSafetyNet({ gpa: 3.4 }, STATED, null, null), { gpa: 3.4, goal: "CPL professional contract" });
ck("...and empty-string goal_text counts as empty",
   applyGoalSafetyNet(null, STATED, "   ", null), { goal: "CPL professional contract" });

console.log("   -- self-heal: promotes the STORED dream_outcome when nothing new is sent --");
// The exact production failure, 2026-08-09: the athlete confirmed their goal
// and Scout answered "goal locked in", but the model sent no dream_outcome
// update (it was already on file) and no profile_updates.goal, so goal_text
// stayed NULL. Watching only the incoming payload made the net unable to fire
// for precisely the athletes it existed to rescue.
ck("stored athlete_stated dream_outcome is promoted with NO incoming updates",
   applyGoalSafetyNet(null, null, null, STATED), { goal: "CPL professional contract" });
ck("...and when incoming updates exist but carry no dream_outcome",
   applyGoalSafetyNet(null, { main_gap: { value: "senior minutes", source: "ai_inferred" } }, null, STATED),
   { goal: "CPL professional contract" });
ck("this turn's statement wins over the older stored one",
   applyGoalSafetyNet(null, { dream_outcome: { value: "NCAA D1 soccer", source: "athlete_stated" } }, null, STATED),
   { goal: "NCAA D1 soccer" });

console.log("   -- and refuses in every case where it would invent or overwrite --");
ck("NEVER overwrites an existing goal_text (incoming)",
   applyGoalSafetyNet(null, STATED, "NCAA D1 soccer", null), null);
ck("NEVER overwrites an existing goal_text (stored)",
   applyGoalSafetyNet(null, null, "NCAA D1 soccer", STATED), null);
ck("NEVER overrides a goal the model explicitly sent",
   applyGoalSafetyNet({ goal: "NCAA D2" }, STATED, null, STATED), { goal: "NCAA D2" });
const INFERRED = { dream_outcome: { value: "probably wants to go pro", source: "ai_inferred", confidence: 0.4 } };
ck("NEVER promotes an ai_inferred dream_outcome (§18: don't assume a goal)",
   applyGoalSafetyNet(null, INFERRED, null, null), null);
ck("NEVER promotes a STORED ai_inferred dream_outcome either",
   applyGoalSafetyNet(null, null, null, INFERRED), null);
ck("ignores an empty-valued dream_outcome",
   applyGoalSafetyNet(null, { dream_outcome: { value: "", source: "athlete_stated" } }, null, null), null);
ck("ignores a whitespace-only stored dream_outcome",
   applyGoalSafetyNet(null, null, null, { dream_outcome: { value: "   ", source: "athlete_stated" } }), null);
ck("ignores a non-object dream_outcome (no source to trust)",
   applyGoalSafetyNet(null, { dream_outcome: "turn pro" }, null, null), null);
ck("ignores a non-object STORED dream_outcome",
   applyGoalSafetyNet(null, null, null, { dream_outcome: "turn pro" }), null);
ck("ignores a source-less dream_outcome",
   applyGoalSafetyNet(null, { dream_outcome: { value: "turn pro" } }, null, null), null);
ck("nothing anywhere is a no-op", applyGoalSafetyNet(null, null, null, null), null);
ck("preserves other profile_updates untouched when it does nothing",
   applyGoalSafetyNet({ gpa: 3.4 }, null, null, null), { gpa: 3.4 });
// End-to-end: the promoted goal is what unblocks readiness.
ck("a promoted goal is enough to make an otherwise-complete athlete ready",
   isAssessmentReady({
     athlete: { sport: "soccer", position: "CB", club_name: "Omonia U19", age_reported: 17,
       scout_context: { timeline: { value: "2 years", source: "athlete_stated" } } },
     goalText: applyGoalSafetyNet(null, null, null, STATED).goal,
   }).sufficient_for_preliminary_assessment, true);

console.log("\n-- Scout must never claim a save it cannot verify --");
// Production 2026-08-09: Scout said "Goal locked in ... that's what actually
// goes on your Passport now" while goal_text stayed NULL. The model generates
// its reply BEFORE the write happens and can never see the outcome, so the
// only safe rule is that it never asserts persistence at all.
// Window widened from 4000 to 7000 on 2026-08-10: the goal-authorship
// paragraph inside this range grew when the "you CAN correct the Pathway"
// permission was added (issue C), pushing the save-honesty rule past the
// old cutoff. The assertions below are unchanged — only the slice that
// feeds them is big enough to still contain the section it is checking.
// Re-anchored 2026-08-11: the rewrite dropped the "Allowed profile_updates
// keys" preamble, so the old anchor returned -1 and sliced garbage. The
// save-honesty rule now lives in THINGS YOU NEVER DO; anchor on the rule
// itself so the window cannot drift off it again.
const SRC_PROMPT = SRC.slice(SRC.indexOf("Never assert something changed on their Passport"), SRC.indexOf("Never assert something changed on their Passport") + 700);
ck("the prompt forbids claiming something was saved", /Never assert something changed on their Passport/.test(SRC_PROMPT), true);
ck("...and names the specific phrases to avoid", /locked in.*saved.*updated/s.test(SRC_PROMPT), true);
ck("...and explains WHY (write happens after the reply)", /If the app's save fails, you won't know/.test(SRC_PROMPT), true);
ck("...and applies the rule beyond just goal", /Let their Passport show what actually stored/.test(SRC_PROMPT), true);

console.log("\n-- no fourth completeness percentage was introduced --");
// Three overlapping "how complete is this athlete" numbers already exist.
// The return shape is asserted exactly so a future edit can't quietly add one.
ck("return shape is exactly the four agreed keys",
   Object.keys(ready).sort(),
   ["confidence", "missing_critical", "missing_useful", "sufficient_for_preliminary_assessment"]);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
