// BENCHMARK INTELLIGENCE V1.2 — specificity, sample-size gating, import
// pipeline, protocol protection, provenance and the comparison engine.
//
// Every fixture below is SYNTHETIC and obviously so (round numbers, fake
// sources). None of it is real sports-performance data, and none of it is
// registered in BENCHMARK_BANDS — it exists only to exercise the machinery.
// The suite's most important assertions are the ones proving GOLSZ refuses:
// refuses to guess specificity, refuses percentiles from small samples,
// refuses incompatible protocols, refuses malformed rows.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SRC = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));

eval(slice("const SPORT_CORE = {", "\n// ============================================================\n// GOAL-RELATIVE READINESS") +
  "\nfunction __s() { return { SPORT_CORE }; }");
const { SPORT_CORE } = __s();
eval(slice("const BENCHMARK_ALIASES = {", "\n// Deterministic recovery for the goal-capture") +
  "\nfunction __b() { return { BENCHMARK_BANDS, SAMPLE_SIZE_GATES, BENCHMARK_IMPORT_COLUMNS, SPECIFICITY_DIMENSIONS, UNIT_CONVERSIONS }; }");
const { BENCHMARK_BANDS, SAMPLE_SIZE_GATES, BENCHMARK_IMPORT_COLUMNS, SPECIFICITY_DIMENSIONS, UNIT_CONVERSIONS } = __b();

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

console.log("-- 1. specificity: every dimension supports an explicit unknown --");
const blank = makeSpecificity({});
ck("all seven dimensions exist and default to null",
   Object.keys(blank).sort(), ["age_max", "age_min", "competition_level", "development_stage", "position_group", "sex", "sport"]);
ck("...every one is null, never absent", Object.values(blank).every((v) => v === null), true);
ck("specificity is ranked across six dimensions", SPECIFICITY_DIMENSIONS.length, 6);

console.log("\n   -- matching: population-null is permissive, athlete-null is NOT --");
const ATH = { sport: "soccer", sex: "male", age_min: 16, development_stage: "specialization", competition_level: "academy", position_group: "defence" };
ck("a fully-general population matches anyone in the sport",
   specificityMatches({ sport: "soccer" }, ATH).match, true);
ck("a population not split by position still matches (null === ALL)",
   specificityMatches({ sport: "soccer", sex: "male", position_group: null }, ATH).match, true);
ck("an exactly-matching population matches", specificityMatches(ATH, ATH).match, true);
ck("a female population does NOT match a male athlete",
   specificityMatches({ sport: "soccer", sex: "female" }, ATH).match, false);
ck("a different position group does not match",
   specificityMatches({ sport: "soccer", position_group: "attack" }, ATH).match, false);
ck("an age band the athlete is below does not match",
   specificityMatches({ sport: "soccer", age_min: 18, age_max: 23 }, ATH).reason, "age_below_range");
ck("an age band the athlete is above does not match",
   specificityMatches({ sport: "soccer", age_min: 9, age_max: 12 }, ATH).reason, "age_above_range");
// The critical asymmetry.
ck("a sex-specific population CANNOT be applied to an athlete of unknown sex",
   specificityMatches({ sport: "soccer", sex: "male" }, { sport: "soccer" }).reason, "athlete_sex_unknown");
ck("an age-banded population CANNOT be applied to an athlete of unknown age",
   specificityMatches({ sport: "soccer", age_min: 15, age_max: 17 }, { sport: "soccer" }).reason, "athlete_age_unknown");
ck("a level-specific population needs a known athlete level",
   specificityMatches({ sport: "soccer", competition_level: "academy" }, { sport: "soccer" }).reason, "athlete_competition_level_unknown");
ck("cross-sport never matches", specificityMatches({ sport: "basketball" }, ATH).reason, "sport_mismatch");

console.log("\n   -- deterministic selection: most specific wins, honestly --");
const GEN = { sport: "soccer", metric: "sprint_10m", sample_size: 5000, source_date: "2024-01-01", specificity: { sport: "soccer" } };
const MID = { sport: "soccer", metric: "sprint_10m", sample_size: 900, source_date: "2023-01-01", specificity: { sport: "soccer", sex: "male", age_min: 15, age_max: 17 } };
const SPEC = { sport: "soccer", metric: "sprint_10m", sample_size: 120, source_date: "2022-01-01", specificity: ATH };
const sel = selectReferencePopulation([GEN, SPEC, MID], ATH);
ck("the MOST specific compatible population is selected, not the biggest", sel.selected, SPEC);
ck("...and all compatible ones are reported", sel.compatible.length, 3);
ck("a bigger but less specific population loses to a more specific one",
   specificityScore(SPEC.specificity) > specificityScore(GEN.specificity), true);
ck("with equal specificity, the larger sample wins",
   selectReferencePopulation([{ ...GEN, sample_size: 10 }, { ...GEN, sample_size: 99 }], ATH).selected.sample_size, 99);
ck("an athlete missing specificity falls back to the general population",
   selectReferencePopulation([GEN, SPEC], { sport: "soccer" }).selected, GEN);
ck("no compatible population -> null, never a near-miss",
   selectReferencePopulation([SPEC], { sport: "soccer", sex: "female", age_min: 16, development_stage: "specialization", competition_level: "academy", position_group: "defence" }).selected, null);
ck("the label states the scope plainly",
   specificityLabel({ sport: "soccer", sex: "male", age_min: 15, age_max: 17, competition_level: "academy" }),
   "male, age 15-17, academy, all positions");
ck("...and says 'all positions' when the source did not split by position",
   /all positions/.test(specificityLabel({ sport: "soccer", sex: "male" })), true);

console.log("\n-- 2. sample-size gating --");
ck("thresholds are flagged PROVISIONAL, not scientific", SAMPLE_SIZE_GATES._provisional, true);
ck("...with a review note", /Review before launch/.test(SAMPLE_SIZE_GATES._review_note), true);
ck("N=10 is insufficient", sampleSizeTier(10), "insufficient_sample");
ck("N=50 is descriptive only", sampleSizeTier(50), "descriptive_only");
ck("N=200 is percentile eligible", sampleSizeTier(200), "percentile_eligible");
ck("N=5000 is a strong reference", sampleSizeTier(5000), "strong_reference");
ck("unknown N is insufficient, never assumed adequate", sampleSizeTier("unknown"), "insufficient_sample");
ck("null N is insufficient", sampleSizeTier(null), "insufficient_sample");
ck("a negative/garbage N is insufficient", [sampleSizeTier(-5), sampleSizeTier("lots")], ["insufficient_sample", "insufficient_sample"]);
// The specific protection required.
ck("percentiles are REFUSED for a descriptive-only sample", percentilesAllowed(50), false);
ck("percentiles are refused for an insufficient sample", percentilesAllowed(10), false);
ck("percentiles are refused when N is unknown", percentilesAllowed("unknown"), false);
ck("percentiles are permitted only from 100+", [percentilesAllowed(99), percentilesAllowed(100)], [false, true]);

console.log("\n-- 3. unit normalisation: exact conversions only --");
ck("inches convert to centimetres exactly", convertUnit(10, "in", "cm").value, 25.4);
ck("centimetres convert back", Number(convertUnit(25.4, "cm", "in").value.toFixed(6)), 10);
ck("same unit is a no-op", convertUnit(5, "s", "s"), { ok: true, value: 5, converted: false });
ck("an unsupported conversion is REFUSED, not approximated", convertUnit(5, "s", "cm").ok, false);
ck("...with a reason", convertUnit(5, "s", "cm").reason, "no_conversion");
ck("non-numeric input is refused", convertUnit("fast", "in", "cm").ok, false);
// A protocol is not a unit.
ck("there is NO hand->electronic 'conversion' pretending to be a unit",
   Object.keys(UNIT_CONVERSIONS).some((k) => /hand|electronic/.test(k)), false);

console.log("\n-- 4. import pipeline --");
ck("the contract declares 33 columns", BENCHMARK_IMPORT_COLUMNS.length, 33);
const GOOD = {
  sport: "soccer", metric: "10m", unit: "s", sex: "male", age_min: 15, age_max: 17,
  development_stage: "specialization", competition_level: "academy", position_group: "",
  reference_type: "observed_distribution", direction: "lower_is_better",
  n: 1200, mean: 1.9, sd: 0.1, p10: 2.05, p25: 1.98, p50: 1.9, p75: 1.83, p90: 1.76,
  measurement_protocol: "electronic gates; standing start",
  protocol_timing_method: "electronic", protocol_start_type: "standing", protocol_distance_m: 10,
  source_name: "Synthetic Fixture",
  source_url: "https://example.org/fixture", source_date: "2025-01-01", publication_date: "2025-02-01",
  population_description: "Synthetic test population", evidence_quality: "measured_test", confidence: 0.8, notes: "",
};
const okRes = importBenchmarkRecord(GOOD);
ck("a complete row imports", okRes.ok, true);
ck("...the metric is canonicalised", okRes.record.metric, "sprint_10m");
ck("...the raw supplied row is preserved verbatim", okRes.record.raw, GOOD);
ck("...provenance is captured", okRes.record.provenance.source_url, "https://example.org/fixture");
ck("...sample tier is derived", okRes.record.sample_tier, "strong_reference");
ck("...percentiles are permitted at this N", okRes.record.percentiles_allowed, true);
ck("...blank position_group becomes null (ALL), not a guess", okRes.record.specificity.position_group, null);
ck("...and the structured protocol is captured separately from the prose",
   okRes.record.provenance.protocol_structured.timing_method, "electronic");
ck("...while unreported protocol dimensions stay ABSENT, not guessed",
   "jump_protocol" in okRes.record.provenance.protocol_structured, false);


console.log("\n   -- malformed rows are REJECTED, never repaired --");
const bad = (o) => importBenchmarkRecord({ ...GOOD, ...o });
ck("unsupported sport rejected", bad({ sport: "curling" }).errors.includes("unsupported_sport"), true);
ck("unknown metric rejected", bad({ metric: "bench press" }).ok, false);
ck("ambiguous metric rejected", bad({ metric: "sprint" }).ok, false);
ck("bad reference_type rejected", bad({ reference_type: "vibes" }).errors.includes("bad_reference_type"), true);
ck("bad direction rejected", bad({ direction: "sideways" }).errors.includes("bad_direction"), true);
ck("evidence tier outside SPORT_CORE rejected", bad({ evidence_quality: "trust_me" }).errors.includes("bad_evidence_quality"), true);
ck("missing source_url rejected", bad({ source_url: "" }).errors.includes("missing:source_url"), true);
ck("missing measurement_protocol rejected", bad({ measurement_protocol: "" }).errors.includes("missing:measurement_protocol"), true);
ck("missing population_description rejected", bad({ population_description: "" }).errors.includes("missing:population_description"), true);
ck("garbage sample size rejected", bad({ n: "heaps" }).errors.includes("bad_sample_size"), true);
ck("an incompatible unit is rejected, NOT coerced", bad({ unit: "kg" }).ok, false);
ck("a rejection returns the raw row for inspection", bad({ sport: "curling" }).raw.sport, "curling");
ck("'unknown' N is accepted as honest but gates percentiles off",
   [bad({ n: "unknown" }).ok, bad({ n: "unknown" }).record.percentiles_allowed], [true, false]);

console.log("\n   -- batch import produces a real report --");
const rep = importBenchmarkDataset([GOOD, { ...GOOD, sport: "curling" }, GOOD, { ...GOOD, n: 40, source_url: "https://example.org/other" }]);
ck("total counted", rep.total, 4);
ck("valid rows accepted", rep.accepted_count, 2);
ck("invalid + duplicate rejected", rep.rejected_count, 2);
ck("the duplicate is identified as such",
   rep.rejected.some((r) => r.errors.includes("duplicate_record")), true);
ck("...rather than silently merged", rep.accepted.filter((a) => a.provenance.source_url === "https://example.org/fixture").length, 1);
ck("tiers are summarised", rep.by_sample_tier.strong_reference, 1);
ck("percentile-eligible count is reported", rep.percentile_eligible_count, 1);
ck("an empty dataset does not throw", importBenchmarkDataset([]).total, 0);
ck("null input does not throw", importBenchmarkDataset(null).accepted_count, 0);

console.log("\n-- 5. comparison engine (NOT scoring) --");
const POP = importBenchmarkRecord(GOOD).record;
const cmp = compareToReference({ sport: "soccer", metric: "10m", value: 1.88, unit: "s",
  athlete: ATH, protocol: { timing_method: "electronic", start_type: "standing" }, populations: [POP] });
ck("a compatible comparison succeeds", cmp.status, "ok");
ck("...offering a percentile when N and protocol both allow", cmp.percentile_available, true);
ck("...naming the population scope", /male, age 15-17/.test(cmp.population.specificity_label), true);
ck("...reporting sample size", cmp.population.sample_size, 1200);
ck("...reporting evidence quality", cmp.evidence_quality, "measured_test");
ck("...and full provenance", cmp.provenance.source_url, "https://example.org/fixture");
// The safety rule, as a test.
ck("a descriptive population is NOT presented as a requirement", cmp.population.is_requirement, false);
ck("...and carries an explicit caution", /not a requirement/.test(cmp.caution), true);
ck("the engine returns NO score, grade or rating",
   ["score", "rating", "grade", "readiness"].some((k) => k in cmp), false);

console.log("\n   -- refusals --");
ck("no data -> no_reference_data",
   compareToReference({ sport: "soccer", metric: "10m", value: 2, unit: "s", athlete: ATH, populations: [] }).status,
   "no_reference_data");
ck("unknown metric -> unresolved_metric",
   compareToReference({ sport: "soccer", metric: "sprint", value: 2, athlete: ATH, populations: [POP] }).status,
   "unresolved_metric");
ck("unsupported sport -> unresolved_metric (never a substitute sport)",
   compareToReference({ sport: "curling", metric: "10m", value: 2, athlete: {}, populations: [POP] }).status,
   "unresolved_metric");
ck("no compatible population -> explicit status",
   compareToReference({ sport: "soccer", metric: "10m", value: 2, unit: "s",
     athlete: { sport: "soccer", sex: "female", age_min: 16, development_stage: "specialization", competition_level: "academy", position_group: "defence" },
     populations: [POP] }).status, "no_compatible_population");
// Protocol protection at the point of comparison.
const handCmp = compareToReference({ sport: "soccer", metric: "10m", value: 1.88, unit: "s",
  athlete: ATH, protocol: { timing_method: "hand", start_type: "standing" }, populations: [POP] });
ck("hand-timed vs electronically-timed still compares...", handCmp.status, "ok");
ck("...but the percentile is WITHHELD", handCmp.percentile_available, false);
ck("...because the conflict is BLOCKING, not mere uncertainty", handCmp.protocol_compatibility.blocking, true);
ck("...and the incompatibility is surfaced", handCmp.protocol_compatibility.compatible, false);
// Uncertainty must reduce comparability without blocking it outright.
const vagueCmp = compareToReference({ sport: "soccer", metric: "10m", value: 1.88, unit: "s",
  athlete: ATH, protocol: { timing_method: "electronic" }, populations: [POP] });
ck("unreported protocol detail does NOT block the comparison", vagueCmp.percentile_available, true);
ck("...but is flagged as not fully compatible", vagueCmp.protocol_compatibility.compatible, false);
ck("...and is explicitly non-blocking", vagueCmp.protocol_compatibility.blocking, false);
ck("...with the unknown dimensions named",
   vagueCmp.protocol_compatibility.issues.every((i) => i.reason === "unknown_on_one_side"), true);
// Small-sample protection at the point of comparison.
const smallPop = importBenchmarkRecord({ ...GOOD, n: 40 }).record;
const smallCmp = compareToReference({ sport: "soccer", metric: "10m", value: 1.88, unit: "s",
  athlete: ATH, protocol: { timing_method: "electronic", start_type: "standing" }, populations: [smallPop] });
ck("a descriptive-only population yields NO percentile", smallCmp.percentile_available, false);
ck("...while still describing the population honestly", smallCmp.population.sample_tier, "descriptive_only");

console.log("\n-- 6. readiness stays LOCKED --");
ck("no reference bands are registered in production", BENCHMARK_BANDS.length, 0);
ck("scoring is not ready for soccer", readinessScoringReady("soccer", "ncaa").ready, false);
ck("scoring is not ready for basketball", readinessScoringReady("basketball", "ncaa").ready, false);
ck("no readiness weight has been assigned",
   Object.values(readinessWeightsFor("soccer", "ncaa")).every((v) => v === null), true);
ck("importing data does NOT unlock scoring by itself",
   readinessScoringReady("soccer", "ncaa").weights_configured, false);

console.log("\n-- 7. templates exist and match the contract --");
const soccerCsv = fs.readFileSync(REPO + "/data/benchmark-templates/soccer_benchmark_populations.csv", "utf8");
const basketCsv = fs.readFileSync(REPO + "/data/benchmark-templates/basketball_benchmark_populations.csv", "utf8");
ck("soccer template header matches the importer contract exactly",
   soccerCsv.split("\n")[0].split(","), BENCHMARK_IMPORT_COLUMNS);
ck("basketball template header matches too",
   basketCsv.split("\n")[0].split(","), BENCHMARK_IMPORT_COLUMNS);
ck("neither template contains real data rows",
   [soccerCsv, basketCsv].every((c) => c.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("sport,")).length === 0), true);
ck("the basketball template carries the NBA population caveat",
   /never be presented as an NCAA requirement/.test(basketCsv), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
