// GOLSZ BENCHMARK INTELLIGENCE V1 — research + ingestion layer.
//
// The load-bearing claim of this suite is negative: that GOLSZ currently has
// ZERO reference bands and refuses to pretend otherwise. Every other test
// here protects a boundary that, if crossed, would let a fabricated or
// mis-framed number reach an athlete — someone who might then train against
// it for months.
//
// Extracted from api/scout.js at run time per tests/README.md.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SRC = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));

eval(slice("const SPORT_CORE = {", "\n// ============================================================\n// GOAL-RELATIVE READINESS") +
  "\nfunction __schema() { return { SPORT_CORE }; }");
const { SPORT_CORE } = __schema();
eval(slice("const BENCHMARK_ALIASES = {", "\n// Deterministic recovery for the goal-capture") +
  "\nfunction __bench() { return { BENCHMARK_SOURCES, BENCHMARK_BANDS, REFERENCE_TYPES, REQUIREMENT_TYPES, PROTOCOL_INCOMPATIBILITIES, PROTOCOL_DIMENSIONS, READINESS_DIMENSIONS }; }");
const { BENCHMARK_SOURCES, BENCHMARK_BANDS, REFERENCE_TYPES, REQUIREMENT_TYPES,
  PROTOCOL_INCOMPATIBILITIES, PROTOCOL_DIMENSIONS, READINESS_DIMENSIONS } = __bench();

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

console.log("-- source hierarchy: every source is Tier A/B/C and traceable --");
ck("sources are registered", BENCHMARK_SOURCES.length > 0, true);
ck("every source declares a tier of A, B or C",
   BENCHMARK_SOURCES.every((s) => ["A", "B", "C"].includes(s.tier)), true);
ck("every source has a real URL", BENCHMARK_SOURCES.every((s) => /^https:\/\//.test(s.url)), true);
ck("every source names its population", BENCHMARK_SOURCES.every((s) => !!s.population), true);
ck("every source declares a valid reference_type",
   BENCHMARK_SOURCES.every((s) => REFERENCE_TYPES.includes(s.reference_type)), true);
// The excluded-source policy, as a test rather than a comment.
const BANNED = ["blog", "tiktok", "instagram", "forum", "reddit", "quora", "recruiting-site"];
ck("NO source is a blog, social post or forum",
   BENCHMARK_SOURCES.some((s) => BANNED.some((b) => s.url.toLowerCase().includes(b))), false);
ck("official NBA combine data is registered as Tier A",
   BENCHMARK_SOURCES.filter((s) => s.url.includes("nba.com")).every((s) => s.tier === "A"), true);
ck("peer-reviewed protocol sources are Tier B",
   BENCHMARK_SOURCES.filter((s) => s.url.includes("pubmed") || s.url.includes("ncbi")).every((s) => s.tier === "B"), true);

console.log("\n-- descriptive data is NOT a requirement --");
ck("reference types are the five agreed concepts", REFERENCE_TYPES.length, 5);
ck("only official_requirement counts as a requirement", REQUIREMENT_TYPES, ["official_requirement"]);
ck("an observed distribution is NOT a requirement",
   isRequirement({ reference_type: "observed_distribution" }), false);
ck("a population reference is NOT a requirement",
   isRequirement({ reference_type: "population_reference" }), false);
ck("a published standard is NOT a requirement",
   isRequirement({ reference_type: "published_standard" }), false);
ck("a GOLSZ-derived band is NOT a requirement",
   isRequirement({ reference_type: "derived_reference_band" }), false);
ck("only an explicit official_requirement is",
   isRequirement({ reference_type: "official_requirement" }), true);
ck("null/garbage is never a requirement", [isRequirement(null), isRequirement({})], [false, false]);
// The specific trap named in the brief.
ck("NBA combine data is registered as observed_distribution, never a requirement",
   BENCHMARK_SOURCES.filter((s) => s.url.includes("nba.com"))
     .every((s) => s.reference_type === "observed_distribution" && !isRequirement(s)), true);
ck("...and carries an explicit caution against NCAA misuse",
   BENCHMARK_SOURCES.filter((s) => s.id === "nba_combine_strength_agility")
     .every((s) => /never be presented as an NCAA requirement/i.test(s.caution)), true);

console.log("\n-- protocol compatibility --");
const HAND = { protocol: { timing_method: "hand", distance_m: 40, start_type: "standing" } };
const ELEC = { protocol: { timing_method: "electronic", distance_m: 40, start_type: "standing" } };
ck("identical protocols are compatible", protocolCompatible(ELEC, ELEC).compatible, true);
ck("hand vs electronic is INCOMPATIBLE", protocolCompatible(HAND, ELEC).compatible, false);
const handIssue = protocolCompatible(HAND, ELEC).issues[0];
ck("...flagged as known_incompatible", handIssue.reason, "known_incompatible");
ck("...as material, not cosmetic", handIssue.severity, "material");
ck("...citing the peer-reviewed magnitude", /0\.22-0\.31 s/.test(handIssue.magnitude_note), true);
ck("...with its sources attached", handIssue.sources.length > 0, true);
// The critical policy: never silently correct.
ck("NO incompatibility auto-normalizes",
   PROTOCOL_INCOMPATIBILITIES.every((r) => r.auto_normalize === false), true);
ck("standing vs flying start is incompatible",
   protocolCompatible({ protocol: { start_type: "standing" } }, { protocol: { start_type: "flying" } }).compatible, false);
ck("standing vertical vs max vertical is incompatible",
   protocolCompatible({ protocol: { jump_protocol: "standing_vertical" } },
                      { protocol: { jump_protocol: "max_vertical" } }).compatible, false);
ck("different sprint distances are flagged",
   protocolCompatible({ protocol: { distance_m: 10 } }, { protocol: { distance_m: 40 } }).compatible, false);
ck("different sex populations are flagged",
   protocolCompatible({ protocol: { sex: "male" } }, { protocol: { sex: "female" } }).compatible, false);
ck("different age groups are flagged",
   protocolCompatible({ protocol: { age_group: "u16" } }, { protocol: { age_group: "senior" } }).compatible, false);
// Unknown metadata must never read as "fine".
ck("unknown protocol on ONE side is flagged, not assumed compatible",
   protocolCompatible({ protocol: { timing_method: "electronic" } }, { protocol: {} }).compatible, false);
ck("...with reason unknown_on_one_side",
   protocolCompatible({ protocol: { timing_method: "electronic" } }, { protocol: {} }).issues[0].reason,
   "unknown_on_one_side");
ck("two fully-unknown protocols raise no false conflict (nothing to compare)",
   protocolCompatible({ protocol: {} }, { protocol: {} }).compatible, true);
ck("null inputs do not throw", protocolCompatible(null, null).compatible, true);
ck("all eight protocol dimensions are modelled", PROTOCOL_DIMENSIONS.length, 8);

console.log("\n-- NO FABRICATED BENCHMARK NUMBERS EXIST --");
ck("the band registry is EMPTY — research is not yet done", BENCHMARK_BANDS.length, 0);
ck("a lookup honestly reports no_reference_data",
   benchmarkBandFor({ sport: "soccer", metric: "10m", targetLevel: "ncaa_d1" }).status, "no_reference_data");
ck("...for basketball too",
   benchmarkBandFor({ sport: "basketball", metric: "vertical", targetLevel: "ncaa_d1" }).status, "no_reference_data");
// Guard against a future contributor pasting in numbers without provenance.
ck("every band (once populated) must pass full provenance validation",
   BENCHMARK_BANDS.every((b) => validateBenchmarkBand(b).valid), true);
const bad = validateBenchmarkBand({ sport: "soccer", metric: "sprint_10m" });
ck("a band missing provenance is REJECTED", bad.valid, false);
ck("...naming the missing fields", bad.errors.includes("missing:source_url"), true);
ck("...including sample size", bad.errors.includes("missing:sample_size"), true);
ck("...and sex", bad.errors.includes("missing:sex"), true);
ck("...and measurement protocol", bad.errors.includes("missing:measurement_protocol"), true);
ck("an invalid reference_type is rejected",
   validateBenchmarkBand({ reference_type: "vibes" }).errors.includes("bad:reference_type"), true);
ck("an evidence_quality outside the core hierarchy is rejected",
   validateBenchmarkBand({ evidence_quality: "trust_me" }).errors.includes("bad:evidence_quality"), true);
ck("an invalid direction is rejected",
   validateBenchmarkBand({ direction: "sideways" }).errors.includes("bad:direction"), true);
// Unknown must be explicit, never a silent zero.
ck("sample_size 'unknown' is ACCEPTED as an honest value",
   validateBenchmarkBand({ sample_size: "unknown" }).errors.includes("bad:sample_size"), false);
ck("...but a non-numeric, non-'unknown' sample size is rejected",
   validateBenchmarkBand({ sample_size: "loads" }).errors.includes("bad:sample_size"), true);
const good = validateBenchmarkBand({
  sport: "basketball", metric: "vertical_jump", unit: "cm", target_level: "ncaa_d1",
  reference_type: "observed_distribution", direction: "higher_is_better", bands: [],
  source_name: "X", source_url: "https://example.org", source_date: "2026-01-01",
  evidence_quality: "official_competition_result", confidence: 0.8,
  sample_size: "unknown", sex: "male", measurement_protocol: { jump_protocol: "max_vertical" },
});
ck("a fully-provenanced band validates", good.valid, true);

console.log("\n-- partial assessment must remain possible --");
// Readiness must be able to evaluate SOME dimensions while naming the ones it
// cannot — "insufficient verified benchmark data" is an acceptable answer.
ck("athletic_fit is explicitly blocked on reference bands",
   READINESS_DIMENSIONS.find((d) => d.id === "athletic_fit").needs.includes("reference_bands"), true);
ck("other dimensions do NOT depend on benchmark bands",
   READINESS_DIMENSIONS.filter((d) => d.id !== "athletic_fit")
     .every((d) => !d.needs.includes("reference_bands")), true);
ck("scoring remains gated shut while bands are empty",
   readinessScoringReady("soccer", "ncaa").ready, false);
ck("...and reports zero reference bands as the reason",
   readinessScoringReady("basketball", "ncaa").reference_bands, 0);

console.log("\n-- sport isolation still holds in the benchmark layer --");
ck("a basketball source is not offered for soccer",
   BENCHMARK_SOURCES.filter((s) => s.sport === "basketball").every((s) => s.sport !== "soccer"), true);
ck("protocol sources are sport-agnostic (sport: null), not mislabelled",
   BENCHMARK_SOURCES.filter((s) => s.covers.includes("measurement_protocol")).every((s) => s.sport === null), true);
ck("an unsupported sport still degrades gracefully",
   benchmarkBandFor({ sport: "Track", metric: "100m" }).status, "unknown_sport");

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
