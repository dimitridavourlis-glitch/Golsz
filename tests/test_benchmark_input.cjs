// P1-2 — benchmark input catches up with the reference architecture.
//
// V1.2 built a comparison engine that can tell hand timing from electronic
// and a standing vertical from an approach vertical. None of it could ever
// reach an athlete's own numbers, because the input form stored a free-text
// metric name, a number and a free-text unit — no protocol at all.
//
// The load-bearing risk in the fix is DRIFT: the client has no build step and
// cannot import from api/scout.js, so BENCHMARK_METRICS_BY_SPORT is a second
// copy of SPORT_SCHEMAS' performance_indicators. This suite diffs them at run
// time. If someone edits one and not the other, this fails.
//
// It also asserts the thing the whole layer exists to protect: unknown stays
// unknown, and nothing here turns readiness scoring on.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SRC = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const MIG = fs.readFileSync(REPO + "/supabase-migration-114-benchmark-protocol.sql", "utf8");
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));

eval(slice("const SPORT_CORE = {", "\n// ============================================================\n// GOAL-RELATIVE READINESS") +
  "\nfunction __s() { return { SPORT_SCHEMAS }; }");
const { SPORT_SCHEMAS } = __s();

eval(slice("const BENCHMARK_ALIASES = {", "\n// Deterministic recovery for the goal-capture") +
  "\nfunction __b() { return { PROTOCOL_DIMENSIONS, PROTOCOL_INCOMPATIBILITIES, BENCHMARK_BANDS }; }");
const { PROTOCOL_DIMENSIONS, PROTOCOL_INCOMPATIBILITIES, BENCHMARK_BANDS } = __b();

// The client's copies. Pulled out of the HTML and evaluated, so the test
// reads exactly what the browser will.
const clientSlice = (from, to) => APP.slice(APP.indexOf(from), APP.indexOf(to));
eval(clientSlice("const BENCHMARK_METRICS_BY_SPORT = {", "function Benchmarks({ viewUserId, manageId })") +
  "\nfunction __c() { return { BENCHMARK_METRICS_BY_SPORT, METRIC_PROTOCOL_FIELDS, PROTOCOL_OPTIONS }; }");
const { BENCHMARK_METRICS_BY_SPORT, METRIC_PROTOCOL_FIELDS, PROTOCOL_OPTIONS } = __c();

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

console.log("-- the client's metric list must not drift from SPORT_SCHEMAS --");
// Client keys are display sport names ("Soccer"); the schema keys are ids.
const SPORT_ID_FOR = { Soccer: "soccer", Basketball: "basketball" };
ck("the client covers exactly the sports that have a schema",
   Object.keys(BENCHMARK_METRICS_BY_SPORT).map((k) => SPORT_ID_FOR[k]).sort(),
   Object.keys(SPORT_SCHEMAS).sort());

for (const [displayName, clientList] of Object.entries(BENCHMARK_METRICS_BY_SPORT)) {
  const schema = SPORT_SCHEMAS[SPORT_ID_FOR[displayName]];
  const server = schema.performance_indicators.map((m) => ({ key: m.key, label: m.label, unit: m.unit }));
  const client = clientList.map((m) => ({ key: m.key, label: m.label, unit: m.unit }));
  ck(`${displayName}: keys, labels and units match the schema exactly`, client, server);
}

console.log("\n-- protocol questions come from real incompatibilities --");
const materialDims = new Set(PROTOCOL_INCOMPATIBILITIES.filter((r) => r.severity === "material").map((r) => r.dimension));
const asked = new Set(Object.values(METRIC_PROTOCOL_FIELDS).flat());
ck("every dimension the form asks about is a MATERIAL incompatibility",
   [...asked].filter((d) => !materialDims.has(d)), []);
ck("...and a real PROTOCOL_DIMENSION", [...asked].filter((d) => !PROTOCOL_DIMENSIONS.includes(d)), []);
// Asking about a metric that doesn't exist would render an option nobody can pick.
const allMetricKeys = new Set(Object.values(BENCHMARK_METRICS_BY_SPORT).flat().map((m) => m.key));
ck("every metric with protocol questions is a real metric",
   Object.keys(METRIC_PROTOCOL_FIELDS).filter((k) => !allMetricKeys.has(k)), []);
// Sprints and jumps are precisely the cases V1.2 flagged as non-comparable
// across protocols; not asking would leave them permanently unusable.
ck("sprint metrics ask about timing method", METRIC_PROTOCOL_FIELDS.sprint_10m.includes("timing_method"), true);
ck("...and start type", METRIC_PROTOCOL_FIELDS.sprint_40m.includes("start_type"), true);
ck("vertical jump asks which jump protocol", METRIC_PROTOCOL_FIELDS.vertical_jump, ["jump_protocol"]);
// Counting stats have no protocol; asking would be noise.
ck("goals scored asks nothing", METRIC_PROTOCOL_FIELDS.goals, undefined);
ck("points per game asks nothing", METRIC_PROTOCOL_FIELDS.ppg, undefined);

console.log("\n-- the offered values are the ones the engine compares against --");
for (const [dim, opts] of Object.entries(PROTOCOL_OPTIONS)) {
  const offered = opts.map(([v]) => v).sort();
  const known = [...new Set(PROTOCOL_INCOMPATIBILITIES.filter((r) => r.dimension === dim).flatMap((r) => [r.a, r.b]))].sort();
  ck(`${dim}: the dropdown offers exactly the values the engine knows`, offered, known);
}

console.log("\n-- unknown must stay unknown --");
ck("empty answers are stripped before the insert", /for \(const \[k, v\] of Object\.entries\(protocol\)\) if \(v\) cleanProtocol\[k\] = v;/.test(APP), true);
ck("an all-unknown protocol is stored as NULL, not {}",
   /protocol: Object\.keys\(cleanProtocol\)\.length \? cleanProtocol : null,/.test(APP), true);
ck("the 'not recorded' option is the DEFAULT, listed first",
   /<option value="">\{t\("bench_protocol_unknown"\)\}/.test(APP), true);
ck("the hint says GOLSZ records 'not known' rather than guessing",
   /records \\"not known\\" rather than guessing/.test(APP), true);
ck("a free-text metric gets NULL metric_key, never a guessed one",
   /metric_key: metricKey \|\| null,/.test(APP), true);
ck("switching metric clears protocol answers", /setMetricKey\(key\);\s*\n\s*setProtocol\(\{\}\);/.test(APP), true);

console.log("\n-- sports without a schema keep working --");
ck("the picker only appears when the sport has a schema", /const sportMetrics = sport \? \(BENCHMARK_METRICS_BY_SPORT\[sport\] \|\| null\) : null;/.test(APP), true);
ck("...and free text is the fallback branch", /\) : \(\s*\n\s*<input value=\{metric\} onChange=\{\(e\) => setMetric\(e\.target\.value\)\} placeholder=\{t\("benchmarks_metric_ph"\)\}/.test(APP), true);
ck("even a schema sport can record something the list doesn't name",
   /<option value="__other">\{t\("bench_other_metric"\)\}<\/option>/.test(APP), true);
ck("...and __other never becomes a metric_key",
   /metricKey !== "__other" && METRIC_PROTOCOL_FIELDS\[metricKey\]/.test(APP), true);

console.log("\n-- migration 114 --");
ck("adds metric_key", /add column if not exists metric_key text/.test(MIG), true);
ck("adds protocol jsonb", /add column if not exists protocol jsonb/.test(MIG), true);
// The index's WHERE clause legitimately contains "is not null"; what must
// not exist is a NOT NULL constraint on either new column, which would make
// the migration fail against existing rows.
ck("neither new column is NOT NULL — existing history is not rewritten",
   /add column if not exists (metric_key text|protocol jsonb) not null/i.test(MIG), false);
ck("it says explicitly that old rows are NOT backfilled", /Backfilling a guess would/.test(MIG), true);
ck("the client reads the new columns back", /select\("id, metric, metric_key, protocol, value, unit, recorded_date"\)/.test(APP), true);

console.log("\n-- scoring stays OFF --");
ck("no reference bands were added", BENCHMARK_BANDS.length, 0);
ck("readiness scoring is still gated shut", readinessScoringReady("soccer", "ncaa").ready, false);
ck("...for basketball too", readinessScoringReady("basketball", "ncaa").ready, false);
ck("the Benchmarks UI shows no comparison, percentile or rating",
   /percentile|vs\. average|rating|score/i.test(APP.slice(APP.indexOf("function Benchmarks({"), APP.indexOf("/* ============ POSTS GRID"))), false);

console.log("\n-- localization --");
for (const lang of ["en", "fr", "es", "el"]) {
  const i = APP.indexOf("\n  " + lang + ": {");
  const block = APP.slice(i, i + 60000);
  const keys = ["bench_pick_metric", "bench_other_metric", "bench_protocol_title", "bench_protocol_unknown",
    "bench_protocol_hint", "bench_dim_timing_method", "bench_timing_electronic", "bench_jump_max"];
  ck(`${lang} defines every benchmark-input key`, keys.filter((k) => !block.includes(k + ":")), []);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
