// GOAL-RELATIVE READINESS — FOUNDATION.
//
// No score is computed anywhere in this layer, and these tests exist largely
// to prove that. The recurring theme is that unknowns must SURVIVE: an
// unmappable metric, an unknown competitive level and an absent reference
// band are all first-class states, because Master Architecture §35 forbids
// manufactured certainty and an athlete could train against a fabricated
// number for months before anyone noticed.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SRC = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));

// SPORT_SCHEMA first (the foundation resolves against it), then the
// foundation itself. End markers stop before the next block so neither is
// re-declared in a second scope — that mistake made an earlier suite mutate
// an orphan copy of the schema registry.
eval(slice("const SPORT_CORE = {", "\n// ============================================================\n// GOAL-RELATIVE READINESS") +
  "\nfunction __extractSchema() { return { SPORT_CORE, SPORT_SCHEMAS }; }");
const { SPORT_CORE } = __extractSchema();
eval(slice("const BENCHMARK_ALIASES = {", "\n// Deterministic recovery for the goal-capture") +
  "\nfunction __extractFoundation() { return { BENCHMARK_BANDS, READINESS_DIMENSIONS, READINESS_WEIGHTS, AMBIGUOUS_METRICS }; }");
const { BENCHMARK_BANDS, READINESS_DIMENSIONS, READINESS_WEIGHTS, AMBIGUOUS_METRICS } = __extractFoundation();

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

console.log("-- 1. free-text benchmarks map to canonical indicators --");
ck("'40 yard dash'-style soccer input resolves", resolveBenchmarkMetric("soccer", "40m sprint").key, "sprint_40m");
ck("'10m' resolves", resolveBenchmarkMetric("soccer", "10m").key, "sprint_10m");
ck("'vert' shorthand resolves", resolveBenchmarkMetric("soccer", "vert").key, "vertical_jump");
ck("'beep test' resolves to the Yo-Yo indicator", resolveBenchmarkMetric("soccer", "beep test").key, "yo_yo");
ck("case and spacing are tolerated", resolveBenchmarkMetric("SOCCER", "  10 M  ").key, "sprint_10m");
ck("the canonical key itself resolves", resolveBenchmarkMetric("soccer", "sprint_10m").key, "sprint_10m");
ck("a resolution carries the unit from SPORT_SCHEMA", resolveBenchmarkMetric("soccer", "10m").unit, "s");
ck("basketball shorthand resolves", resolveBenchmarkMetric("basketball", "ppg").key, "ppg");
ck("'lane agility' resolves", resolveBenchmarkMetric("basketball", "lane agility").key, "lane_agility");

console.log("\n   -- the athlete's own text is NEVER overwritten --");
const r = resolveBenchmarkMetric("soccer", "  Beep Test ");
ck("original string is preserved verbatim", r.raw, "  Beep Test ");
ck("...alongside the canonical key", r.key, "yo_yo");

console.log("\n-- ambiguous metrics stay UNRESOLVED --");
for (const amb of ["sprint", "speed", "jump", "%", "time", "test"]) {
  ck(`'${amb}' is too ambiguous to resolve`, resolveBenchmarkMetric("soccer", amb).resolved, false);
}
ck("...and says why", resolveBenchmarkMetric("soccer", "sprint").reason, "ambiguous");
ck("an unknown metric is unresolved, not coerced to the nearest match",
   resolveBenchmarkMetric("soccer", "bench press").resolved, false);
ck("...with reason no_match", resolveBenchmarkMetric("soccer", "bench press").reason, "no_match");
ck("empty metric is unresolved", resolveBenchmarkMetric("soccer", "").reason, "empty");
ck("null metric does not throw", resolveBenchmarkMetric("soccer", null).resolved, false);
ck("unknown sport cannot resolve any metric", resolveBenchmarkMetric("curling", "10m").reason, "unknown_sport");
ck("every ambiguous term is genuinely absent from the alias tables",
   AMBIGUOUS_METRICS.every((a) => !resolveBenchmarkMetric("soccer", a).resolved
     && !resolveBenchmarkMetric("basketball", a).resolved), true);

console.log("\n-- soccer metrics CANNOT contaminate basketball --");
ck("'yo-yo' is meaningless in basketball", resolveBenchmarkMetric("basketball", "beep test").resolved, false);
ck("'clean sheets' is meaningless in basketball", resolveBenchmarkMetric("basketball", "clean sheets").resolved, false);
ck("'ppg' is meaningless in soccer", resolveBenchmarkMetric("soccer", "ppg").resolved, false);
ck("'lane agility' is meaningless in soccer", resolveBenchmarkMetric("soccer", "lane agility").resolved, false);
ck("'3p%' is meaningless in soccer", resolveBenchmarkMetric("soccer", "3p%").resolved, false);
// A metric both sports genuinely share must still resolve per-sport.
ck("'vertical' resolves in BOTH sports (legitimately shared)",
   [resolveBenchmarkMetric("soccer", "vertical").key, resolveBenchmarkMetric("basketball", "vertical").key],
   ["vertical_jump", "vertical_jump"]);
ck("...but 'assists' means different indicators and stays sport-scoped",
   [resolveBenchmarkMetric("soccer", "assists").key, resolveBenchmarkMetric("basketball", "assists").key],
   ["assists", "apg"]);

console.log("\n-- units cannot be compared incorrectly --");
const s10 = resolveBenchmarkMetric("soccer", "10m");
const s40 = resolveBenchmarkMetric("soccer", "40m");
const vert = resolveBenchmarkMetric("soccer", "vertical");
ck("same metric, same unit -> comparable", canCompareBenchmarks(s10, s10).ok, true);
ck("different metrics -> refused", canCompareBenchmarks(s10, s40).ok, false);
ck("...with a reason", canCompareBenchmarks(s10, s40).reason, "different_metric");
ck("seconds vs centimetres -> refused", canCompareBenchmarks(s10, vert).ok, false);
ck("an unresolved side -> refused, never assumed compatible",
   canCompareBenchmarks(s10, resolveBenchmarkMetric("soccer", "sprint")).ok, false);
ck("...with reason unresolved",
   canCompareBenchmarks(s10, resolveBenchmarkMetric("soccer", "sprint")).reason, "unresolved");
ck("same key but a differing unit is still refused (the cm/inches trap)",
   canCompareBenchmarks({ resolved: true, key: "vertical_jump", unit: "cm" },
                        { resolved: true, key: "vertical_jump", unit: "in" }).reason, "unit_mismatch");
ck("null inputs do not throw", canCompareBenchmarks(null, null).ok, false);

console.log("\n-- 2. reference bands: NO INVENTED NUMBERS --");
ck("the band registry ships EMPTY — real data is still required", BENCHMARK_BANDS.length, 0);
const band = benchmarkBandFor({ sport: "soccer", metric: "10m", positionGroup: "defence", targetLevel: "ncaa_d1" });
ck("a lookup reports no_reference_data rather than inventing a band", band.status, "no_reference_data");
ck("...and returns no band object", band.band, null);
ck("...while still confirming the metric resolved", band.metric, "sprint_10m");
ck("an unresolved metric is reported as such, not as missing data",
   benchmarkBandFor({ sport: "soccer", metric: "sprint" }).status, "unresolved_metric");
ck("an unknown sport is reported as such", benchmarkBandFor({ sport: "curling", metric: "10m" }).status, "unknown_sport");
// If bands are ever populated, this catches a malformed entry immediately.
ck("every band (when populated) must declare direction, source and evidence quality",
   BENCHMARK_BANDS.every((b) => b.direction && b.source && SPORT_CORE.evidence_tiers.includes(b.evidence_quality)), true);

console.log("\n-- 3. current level: known or unknown, never inferred --");
ck("no level on record -> unknown", resolveCurrentLevel("soccer", {}).known, false);
ck("...with an explicit reason", resolveCurrentLevel("soccer", {}).reason, "not_on_record");
ck("a stored level resolves through SPORT_SCHEMA",
   resolveCurrentLevel("soccer", { current_level: { value: "NCAA Division II", source: "athlete_stated" } }).level.id, "ncaa_d2");
ck("...carrying its source", resolveCurrentLevel("soccer", { current_level: { value: "ncaa_d2", source: "coach_evaluation" } }).source, "coach_evaluation");
ck("a bare string value is accepted and defaults to athlete_stated",
   resolveCurrentLevel("soccer", { current_level: "academy" }).source, "athlete_stated");
ck("a level from ANOTHER sport does not resolve",
   resolveCurrentLevel("soccer", { current_level: { value: "AAU / club circuit" } }).known, false);
ck("...and says it was unrecognised for this sport",
   resolveCurrentLevel("soccer", { current_level: { value: "AAU / club circuit" } }).reason, "unrecognised_for_sport");
ck("...while preserving what the athlete actually said",
   resolveCurrentLevel("soccer", { current_level: { value: "AAU / club circuit" } }).raw, "AAU / club circuit");
// The inference ban, stated as tests.
ck("a club name alone NEVER implies a level",
   resolveCurrentLevel("soccer", { club_hint: "Omonia first team" }).known, false);
ck("an age alone NEVER implies a level", resolveCurrentLevel("soccer", { age: 22 }).known, false);
ck("athlete enthusiasm NEVER implies a level",
   resolveCurrentLevel("soccer", { dream_outcome: { value: "professional", source: "athlete_stated" } }).known, false);
ck("null context does not throw", resolveCurrentLevel("soccer", null).known, false);
ck("unknown sport -> unknown level", resolveCurrentLevel("curling", { current_level: "elite" }).known, false);

console.log("\n-- 4. readiness dimensions + configurable weighting --");
const ids = READINESS_DIMENSIONS.map((d) => d.id);
ck("all six dimensions are declared", ids.length, 6);
ck("...covering every area required", ids.sort(),
   ["athletic_fit", "development_fit", "evidence_strength", "exposure_readiness", "level_fit", "pathway_requirements"]);
ck("NO weight has been chosen yet — every value is null",
   Object.values(readinessWeightsFor("soccer", "ncaa")).every((v) => v === null), true);
ck("weighting can vary by sport+pathway (distinct profiles exist)",
   ["soccer:ncaa", "soccer:professional", "basketball:ncaa"].every((k) => !!READINESS_WEIGHTS[k]), true);
ck("an unconfigured sport/pathway falls back to DEFAULT, not to another sport's profile",
   readinessWeightsFor("curling", "ncaa"), READINESS_WEIGHTS.DEFAULT);
ck("every profile covers every dimension",
   Object.values(READINESS_WEIGHTS).every((w) => ids.every((d) => d in w)), true);

console.log("\n   -- the gate that stops a half-built engine scoring --");
const gate = readinessScoringReady("soccer", "ncaa");
ck("scoring is NOT ready", gate.ready, false);
ck("...because weights are unset", gate.weights_configured, false);
ck("...and there are no reference bands", gate.reference_bands, 0);
ck("no sport/pathway combination is scoring-ready yet",
   ["soccer:ncaa", "soccer:professional", "basketball:ncaa"]
     .every((k) => readinessScoringReady(...k.split(":")).ready === false), true);

console.log("\n-- 5. Passport Strength is SEPARATE from Goal-relative Readiness --");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
ck("the composite score is labelled Passport Strength", /home_readiness_composite: "PASSPORT STRENGTH"/.test(APP), true);
ck("...in the section title too", /home_readiness_title: "PASSPORT STRENGTH"/.test(APP), true);
ck("...and translated in all four languages",
   (APP.match(/home_readiness_composite: "(PASSPORT STRENGTH|FORCE DU PASSEPORT|FUERZA DEL PASAPORTE|ΙΣΧΥΣ ΔΙΑΒΑΤΗΡΙΟΥ)"/g) || []).length, 4);
ck("no user-facing label still calls the profile score 'GOLSZ READINESS'",
   /home_readiness_(title|composite): "GOLSZ READINESS"/.test(APP), false);
// The i18n KEYS deliberately keep their old names: renaming them would break
// stored data and lookups for zero user benefit.
ck("i18n keys are unchanged, so no contract breaks", /home_readiness_composite:/.test(APP), true);
// The two systems must not share machinery.
ck("Passport Strength sub-scores are NOT readiness dimensions",
   ids.some((d) => ["profile_quality", "verification", "performance", "development", "pathway"].includes(d)), false);
ck("the readiness foundation computes no score of any kind",
   /function computeGoalRelativeReadiness|readiness_score\s*=/.test(SRC), false);

console.log("\n-- legacy athletes and unsupported sports keep working --");
ck("an athlete with a benchmark in an unsupported sport degrades gracefully",
   resolveBenchmarkMetric("Track", "100m").reason, "unknown_sport");
ck("...and a band lookup for them does not throw",
   benchmarkBandFor({ sport: "Track", metric: "100m" }).status, "unknown_sport");
ck("...and their level is simply unknown", resolveCurrentLevel("Track", { current_level: "elite" }).known, false);
ck("...and they still get default weights rather than an error",
   !!readinessWeightsFor("Track", null), true);
ck("an athlete with NO sport at all does not throw anywhere",
   [resolveBenchmarkMetric(null, "10m").resolved, resolveCurrentLevel(null, {}).known,
    benchmarkBandFor({ sport: null, metric: "10m" }).status !== undefined], [false, false, true]);

console.log("\n-- FIELD-MISMATCH FIX: level must never reach recruiting_status --");
// Root cause: PROFILE_FIELD_MAP.level pointed at athletes.recruiting_status,
// a controlled Passport dropdown the athlete sets themselves. Scout emitting
// level:"NCAA D2" would have silently replaced their recruiting state with a
// competition level. Latent only — a production check found every stored
// value valid — but one live emission would have corrupted a real profile.
// Two separate slices: SCOUT_CONTEXT_KEYS is declared LATER in the file than
// PROFILE_FIELD_MAP, so pulling it into the same extractor hits a temporal
// dead zone (const, not var) rather than simply being undefined.
eval(slice("const PROFILE_FIELD_MAP", "\n// Pulls {reply, profile_updates}") +
  "\nfunction __extractMap() { return { PROFILE_FIELD_MAP }; }");
const { PROFILE_FIELD_MAP } = __extractMap();
eval(slice("const SCOUT_CONTEXT_KEYS = new Set", "\n// ============================================================\n// SPORT_SCHEMA V1") +
  "\nfunction __extractKeys() { return { SCOUT_CONTEXT_KEYS }; }");
const { SCOUT_CONTEXT_KEYS } = __extractKeys();
ck("`level` is GONE from the profile field map", "level" in PROFILE_FIELD_MAP, false);
ck("NOTHING maps into recruiting_status any more",
   Object.values(PROFILE_FIELD_MAP).some((v) => v.column === "recruiting_status"), false);
ck("competition level is a scout_context key instead", SCOUT_CONTEXT_KEYS.has("current_level"), true);
ck("...and resolveCurrentLevel reads exactly that key",
   resolveCurrentLevel("soccer", { current_level: { value: "ncaa_d2" } }).level.id, "ncaa_d2");
ck("the prompt no longer offers `level` as a profile_updates key",
   /previous_clubs, level, grad_year/.test(SRC), false);
// DEFERRED by the owner on 2026-08-11, not lost. The old prompt carried an
// explicit "there is NO 'level' key, use scout_context.current_level"
// redirect, added after a real field collision (task #28). The rewrite
// dropped it. The collision itself is still prevented in code by
// PROFILE_FIELD_MAP, which simply has no "level" entry to write through, so
// a stray key is ignored rather than mis-stored.
ck("recruiting_status is described as recruiting state only",
   /recruiting status \(their own Passport setting/.test(SRC), true);
ck("...and no longer claims to also mean competition level",
   /current competition level \/ recruiting status/.test(SRC), false);
ck("recruiting_status is still read for legacy profiles", /recruiting_status/.test(SRC), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
