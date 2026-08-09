// Launch-blocker regressions — P0-6 (sport support truth), P1-1 (medical
// boundary in the base persona) and P0-5 (goal authorship).
//
// Each of these exists because the audit found the product asserting
// something it could not back: that GOLSZ had built-out data for eight
// sports it has no schema for; that Scout had a medical boundary when only
// two of its prompt branches did; and that goal_text was a real, editable
// field when it appeared nowhere an athlete could see.
//
// Functions are extracted from api/scout.js at run time per tests/README.md,
// never retyped.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SRC = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));

// SPORT_SCHEMAS is a const, so a direct eval does not leak it — the appended
// extractor closes over it. Same pattern as every other suite here.
eval(slice("const SPORT_CORE = {", "\n// ============================================================\n// GOAL-RELATIVE READINESS") +
  "\nfunction __sport() { return { SPORT_SCHEMAS, SPORT_SUPPORT_LEVELS }; }");
const { SPORT_SCHEMAS, SPORT_SUPPORT_LEVELS } = __sport();

eval(slice("function normalizeGoalForComparison(", "\n// The deliberate FIRST SLICE"));

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ============================================================
console.log("-- P0-6: 'core' is unreachable without a real schema --");
// The bug: migration 094 declared ten sports 'core'; SPORT_SCHEMAS holds two.
// Scout's prompt reads 'core' as "GOLSZ has real depth here."
const SCHEMA_SPORTS = Object.keys(SPORT_SCHEMAS);
ck("SPORT_SCHEMAS still holds exactly soccer and basketball", SCHEMA_SPORTS.sort(), ["basketball", "soccer"]);
ck("the three support levels are unchanged", SPORT_SUPPORT_LEVELS, ["core", "supported", "secondary"]);

ck("a schema-backed sport MAY be core", resolveSportSupportLevel("soccer", "core"), "core");
ck("...basketball too", resolveSportSupportLevel("basketball", "core"), "core");
// The eight the audit found. Every one of these was being announced to the
// model as 'core' with nothing behind it.
for (const sport of ["futsal", "american football", "baseball", "tennis", "golf", "lacrosse", "handball", "volleyball"]) {
  ck(`"${sport}" declared core is capped to supported`, resolveSportSupportLevel(sport, "core"), "supported");
}
ck("a sport GOLSZ never heard of cannot be core", resolveSportSupportLevel("kabaddi", "core"), "supported");
ck("secondary stays secondary for a schema-less sport", resolveSportSupportLevel("rowing", "secondary"), "secondary");
ck("supported stays supported for a schema-less sport", resolveSportSupportLevel("rowing", "supported"), "supported");
ck("a schema-backed sport is not forced UP to core", resolveSportSupportLevel("soccer", "secondary"), "secondary");
// Garbage in the column must not become authority.
ck("an invalid declared level falls back to secondary", resolveSportSupportLevel("soccer", "elite"), "secondary");
ck("null declared level falls back to secondary", resolveSportSupportLevel("soccer", null), "secondary");
ck("null sport can never be core", resolveSportSupportLevel(null, "core"), "supported");
ck("case and padding do not defeat the schema lookup", resolveSportSupportLevel("  Soccer  ", "core"), "core");

console.log("\n-- P0-6: the hard yes/no flag --");
ck("soccer has structured knowledge", hasStructuredSportKnowledge("soccer"), true);
ck("volleyball does NOT", hasStructuredSportKnowledge("volleyball"), false);
ck("null does NOT", hasStructuredSportKnowledge(null), false);
ck("the flag reaches ATHLETE STATE", /golsz_structured_sport_knowledge=\$\{athleteState\.structuredSportKnowledge \? "yes" : "no"\}/.test(SRC), true);
ck("buildAuthoritativeContext's caller computes it", /structuredSportKnowledge: hasStructuredSportKnowledge\(sport\)/.test(SRC), true);
ck("the support level is capped at the read site, not just declared",
   /sportSupportLevel = resolveSportSupportLevel\(sport, declared\)/.test(SRC), true);

console.log("\n-- P0-6: the prompt tells the model what 'no' actually means --");
const PROMPT_SPORT = SRC.slice(SRC.indexOf("golsz_structured_sport_knowledge in ATHLETE STATE"), SRC.indexOf("golsz_structured_sport_knowledge in ATHLETE STATE") + 2400);
ck("it names the flag as load-bearing", /hard yes\/no/i.test(PROMPT_SPORT), true);
ck("it states there is NO position structure when absent", /NO GOLSZ position structure/.test(PROMPT_SPORT), true);
ck("...no competition ladder", /NO competition ladder/.test(PROMPT_SPORT), true);
ck("...no eligibility data", /NO eligibility data/.test(PROMPT_SPORT), true);
ck("it forbids inventing requirements outright", /never invent them at all/.test(PROMPT_SPORT), true);
ck("it separates general knowledge from GOLSZ authority",
   /let general knowledge wear GOLSZ's authority/.test(PROMPT_SPORT), true);
ck("it still permits being helpful", /you may still help, and should/.test(PROMPT_SPORT), true);
ck("support_level can no longer override the flag", /never overrides the flag/.test(PROMPT_SPORT), true);
// Migration hygiene — the stored rows should not assert the false thing either.
const MIG = fs.readFileSync(REPO + "/supabase-migration-112-sport-support-truth.sql", "utf8");
ck("migration 112 downgrades non-schema sports", /set support_level = 'supported'[\s\S]*not in \('soccer', 'basketball'\)/.test(MIG), true);

// ============================================================
console.log("\n-- P1-1: the health boundary is in the BASE persona --");
// The failure: this rule lived only in the `development` specialist framing
// and the Physio occupation branch, so most conversations had none.
const BASE_START = SRC.indexOf("const SYSTEM_PROMPT");
const SPECIALIST_START = SRC.indexOf("const SPECIALIST_FRAMING = {");
ck("both prompt regions exist", BASE_START > -1 && SPECIALIST_START > BASE_START, true);
const BASE = SRC.slice(BASE_START, SPECIALIST_START);
ck("the boundary is inside the base prompt", /HEALTH AND MEDICAL BOUNDARY/.test(BASE), true);
ck("...and states it applies to EVERY reply", /applies to EVERY reply you write/.test(BASE), true);
ck("...regardless of specialist routing", /whatever specialist framing/.test(BASE), true);
ck("no injury diagnosis", /you do not diagnose injuries/.test(BASE), true);
ck("no treatment or rehab protocols", /do not prescribe treatment or rehab protocols/.test(BASE), true);
ck("no return-to-play timelines", /return-to-play timelines/.test(BASE), true);
ck("no medication or supplement dosing", /do not recommend or dose medication or supplements/.test(BASE), true);
ck("no weight-cutting instructions", /never give weight-cutting/.test(BASE), true);
ck("...including dehydration and calorie restriction", /dehydration, calorie-restriction/.test(BASE), true);
ck("...and the refusal is explicitly non-negotiable for minors", /that specific refusal is not negotiable/.test(BASE), true);
// Preserving the useful half matters as much as the refusal — a Scout that
// stops coaching is a worse product, not a safer one.
ck("general performance coaching is explicitly preserved", /General, educational sports-performance guidance is squarely your job/.test(BASE), true);
ck("it names the professionals to defer to",
   /physician, a physiotherapist or athletic trainer, a registered dietitian/.test(BASE), true);
ck("deferral is one sentence, not a disclaimer block", /not a disclaimer block/.test(BASE), true);
// The specialist branch keeps its own, more detailed version.
ck("the development specialist branch still carries its own rule",
   /Nutrition and recovery guidance here is general and educational only/.test(SRC.slice(SPECIALIST_START)), true);

// ============================================================
console.log("\n-- P0-5: an athlete-authored goal survives Scout --");
ck("identical text is not a 'change'", normalizeGoalForComparison("Play NCAA D1 Soccer."), normalizeGoalForComparison("play ncaa d1 soccer"));
ck("punctuation and spacing are ignored", normalizeGoalForComparison("  Sign  a pro contract!! "), "sign a pro contract");
ck("genuinely different goals differ",
   normalizeGoalForComparison("play ncaa d1") === normalizeGoalForComparison("go pro in europe"), false);

const ATHLETE = "Play NCAA Division I soccer on scholarship by 2028";
ck("a materially different goal is DROPPED when the athlete wrote theirs",
   applyGoalAuthorship({ goal: "sign for a European club", position: "cb" }, ATHLETE, "athlete_edited"),
   { position: "cb" });
ck("...the rest of the update still goes through",
   Object.keys(applyGoalAuthorship({ goal: "x y z different", club: "AEK" }, ATHLETE, "athlete_edited")), ["club"]);
ck("a restatement of the same goal is also dropped (nothing to write)",
   applyGoalAuthorship({ goal: "play ncaa division i soccer on scholarship by 2028." }, ATHLETE, "athlete_edited"), {});
ck("a Scout-captured goal IS still overwritable by Scout",
   applyGoalAuthorship({ goal: "sign for a European club" }, ATHLETE, "scout_captured"),
   { goal: "sign for a European club" });
ck("a legacy null source is treated as permissive, never retro-locked",
   applyGoalAuthorship({ goal: "sign for a European club" }, ATHLETE, null),
   { goal: "sign for a European club" });
ck("an athlete with no goal yet is unaffected",
   applyGoalAuthorship({ goal: "play NAIA basketball" }, null, null), { goal: "play NAIA basketball" });
ck("an update with no goal passes straight through",
   applyGoalAuthorship({ position: "gk" }, ATHLETE, "athlete_edited"), { position: "gk" });
ck("null updates do not throw", applyGoalAuthorship(null, ATHLETE, "athlete_edited"), null);

console.log("\n-- P0-5: authorship is recorded on every write path --");
ck("Scout writes stamp goal_source=scout_captured", /patches\.profiles\.goal_source = "scout_captured"/.test(SRC), true);
ck("...and a timestamp", /patches\.profiles\.goal_updated_at = new Date\(\)\.toISOString\(\)/.test(SRC), true);
ck("goal_source is fetched alongside goal_text", /goal_defined,goal_text,goal_source/.test(SRC), true);
// Every persist site must be wrapped — one unwrapped site defeats the guard.
ck("the safety net is wrapped by the authorship guard at every call site",
   SRC.match(/applyGoalSafetyNet\(/g).length, SRC.match(/applyGoalAuthorship\(applyGoalSafetyNet\(/g).length + 1); // +1 = the definition
ck("Scout is told when the goal is the athlete's own",
   /goal_authored_by_athlete=\$\{goalSource === "athlete_edited" \? "yes" : "no"\}/.test(SRC), true);
ck("...and told to ask rather than assume a change",
   /has that actually changed, or is Y a backup/.test(SRC), true);

console.log("\n-- P0-5: the client actually shows and edits the goal --");
ck("GoalCard exists", /function GoalCard\(/.test(APP), true);
ck("it renders goal_text itself, not a category", /<div style=\{\{ fontSize: 14, fontWeight: 800, color: C\.chalk, lineHeight: 1\.35 \}\}>\{goalText\}<\/div>/.test(APP), true);
ck("it writes goal_text", /goal_text: clean,/.test(APP), true);
ck("...and derives goal_defined in the same write", /goal_defined: true,/.test(APP), true);
ck("...and marks it athlete-authored", /goal_source: "athlete_edited",/.test(APP), true);
ck("Home renders it", /<GoalCard actingFor=\{actingFor\} onSaved=\{\(\) => reload\(\)\} \/>/.test(APP), true);
ck("Plan renders it", /<GoalCard actingFor=\{actingFor\} onSaved=\{\(\) => setGoalVersion/.test(APP), true);
ck("the Plan card no longer substitutes the pathway category for the goal",
   /plan_primary_goal"\)\}<\/span>\s*<\/div>\s*<div[^>]*>\{hasPrimaryGoal/.test(APP), false);
ck("a save failure is surfaced to the athlete, not just the console",
   /setErr\(\(e && e\.message\) \? `\$\{t\("goal_card_save_err"\)\}/.test(APP), true);
ck("empty input is rejected", /if \(!clean\) \{ setErr\(t\("goal_card_required"\)\); return; \}/.test(APP), true);
ck("a meaningless one-word goal is rejected", /clean\.length < 8/.test(APP), true);
ck("input is length-capped before it reaches the database", /\.slice\(0, 300\)/.test(APP.slice(APP.indexOf("function GoalCard"), APP.indexOf("function PathwayStrip"))), true);

console.log("\n-- localization: the new UI is not English-only --");
for (const lang of ["en", "fr", "es", "el"]) {
  const blockStart = APP.indexOf("\n  " + lang + ": {");
  const block = APP.slice(blockStart, blockStart + 60000);
  const keys = ["goal_card_title", "goal_card_empty", "goal_card_edit", "goal_card_save",
    "goal_card_save_err", "goal_card_too_short", "goal_card_pathway", "goal_card_by_you"];
  ck(`${lang} defines every goal_card key`, keys.filter((k) => !block.includes(k + ":")), []);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
