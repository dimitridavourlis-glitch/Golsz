// BENCHMARK CSV INGESTION — the parser that turns a filled-in
// data/benchmark-templates/*.csv into rows importBenchmarkDataset() validates.
//
// Everything under test is eval()'d out of api/scout.js at run time, per
// tests/README.md: a suite that tests a copy passes happily while production
// is broken. The two slices below are the same ones test_benchmark_import.cjs
// uses, because the CSV path is only meaningful end-to-end — a parser that
// produces rows the real importBenchmarkRecord() rejects has not parsed
// anything useful.
//
// Fixture rule (tests/README.md, second rule): the fixture must be the shape
// production sends. Production here is a spreadsheet export, so the fixtures
// are spreadsheet artefacts — CRLF, a BOM, a trailing ",,,," row, quoted
// prose with commas and newlines in it, and the three #-comment rows both
// real templates ship with. The last section parses the REAL template files
// off disk rather than a paraphrase of them.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SRC = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const slice = (from, to) => {
  const a = SRC.indexOf(from), b = SRC.indexOf(to);
  if (a < 0 || b < 0 || b <= a) {
    console.error(`ANCHOR DEAD: ${JSON.stringify(from)} -> ${JSON.stringify(to)} (${a}, ${b})`);
    process.exit(1);
  }
  return SRC.slice(a, b);
};

eval(slice("const SPORT_CORE = {", "\n// ============================================================\n// GOAL-RELATIVE READINESS") +
  "\nfunction __s() { return { SPORT_CORE }; }");
const { SPORT_CORE } = __s();
eval(slice("const BENCHMARK_ALIASES = {", "\n// Deterministic recovery for the goal-capture") +
  "\nfunction __b() { return { BENCHMARK_IMPORT_COLUMNS }; }");
const { BENCHMARK_IMPORT_COLUMNS } = __b();

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// The extraction has to have produced the real thing, not an empty scope.
ck("parseBenchmarkCsv was extracted from api/scout.js", typeof parseBenchmarkCsv, "function");
ck("importBenchmarkCsv was extracted from api/scout.js", typeof importBenchmarkCsv, "function");
ck("...and so was the importer it must not bypass", typeof importBenchmarkDataset, "function");
ck("33 contract columns", BENCHMARK_IMPORT_COLUMNS.length, 33);

const H = BENCHMARK_IMPORT_COLUMNS.join(",");
// One row that genuinely passes importBenchmarkRecord(). Synthetic and
// obviously so — round numbers, a fake DOI — but structurally real.
const VALUES = {
  sport: "soccer", metric: "sprint_10m", unit: "s", sex: "male", age_min: "15", age_max: "17",
  development_stage: "specialization", competition_level: "academy", position_group: "",
  reference_type: "observed_distribution", direction: "lower_is_better",
  n: "240", mean: "1.80", sd: "0.10", p10: "1.65", p25: "1.72", p50: "1.80", p75: "1.88", p90: "1.95",
  measurement_protocol: "electronic gates, standing start, turf", protocol_timing_method: "electronic",
  protocol_start_type: "standing", protocol_jump_protocol: "", protocol_distance_m: "10",
  protocol_surface: "artificial_turf", source_name: "Synthetic Study", source_url: "https://example.org/synthetic",
  source_date: "2024-01-01", publication_date: "2024-02-01", population_description: "Synthetic academy males",
  evidence_quality: "measured_test", confidence: "0.8", notes: "",
};
// Quote a value only where the CSV requires it, exactly as a spreadsheet does.
const cell = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const rowFor = (cols, over) => cols.map((c) => cell((over && c in over ? over[c] : VALUES[c]))).join(",");
const GOOD_ROW = rowFor(BENCHMARK_IMPORT_COLUMNS);

console.log("\n-- 1. RFC 4180: quoting is not split(',') --");
{
  const csv = `${H}\n${rowFor(BENCHMARK_IMPORT_COLUMNS, { measurement_protocol: "electronic timing gates; standing start 0.5m behind line, artificial turf" })}\n`;
  const r = parseBenchmarkCsv(csv);
  ck("a file whose protocol contains a comma still parses", r.ok, true);
  ck("...into exactly one row, not two", r.rows.length, 1);
  ck("...with the comma inside the value, not a field boundary",
     r.rows[0].measurement_protocol, "electronic timing gates; standing start 0.5m behind line, artificial turf");
  ck("...and the column AFTER the quoted one is not shifted", r.rows[0].protocol_timing_method, "electronic");
  ck("...and the last column is still the last column", r.rows[0].notes, "");
}
{
  const r = parseBenchmarkCsv(`${H}\n${rowFor(BENCHMARK_IMPORT_COLUMNS, { notes: 'source calls it a "flying" start' })}\n`);
  ck('doubled "" unescapes to one literal quote', r.rows[0].notes, 'source calls it a "flying" start');
}
{
  const r = parseBenchmarkCsv(`${H}\n${rowFor(BENCHMARK_IMPORT_COLUMNS, { notes: 'all "" of it' })}\n`);
  ck('a value that is only doubled quotes survives', r.rows[0].notes, 'all "" of it');
}
{
  const csv = `${H}\n${rowFor(BENCHMARK_IMPORT_COLUMNS, { notes: "line one\nline two" })}\n`;
  const r = parseBenchmarkCsv(csv);
  ck("a newline inside quotes does NOT end the record", r.rows.length, 1);
  ck("...the newline is kept in the value", r.rows[0].notes, "line one\nline two");
  ck("...and the row after it still parses", parseBenchmarkCsv(csv + GOOD_ROW + "\n").rows.length, 2);
}
{
  // The nastiest realistic combination: comma + newline + escaped quote in one
  // field, mid-record, in a CRLF file.
  const nasty = 'protocol: 10m, "flying" start\r\nsurface: turf';
  const csv = `${H}\r\n${rowFor(BENCHMARK_IMPORT_COLUMNS, { notes: nasty })}\r\n`;
  const r = parseBenchmarkCsv(csv);
  ck("comma + CRLF + escaped quote in one field", r.rows.length, 1);
  ck("...CRLF inside quotes normalises to LF, so the same prose compares equal across OSes",
     r.rows[0].notes, 'protocol: 10m, "flying" start\nsurface: turf');
}

console.log("\n-- 2. line endings --");
{
  const lf = parseBenchmarkCsv(`${H}\n${GOOD_ROW}\n`);
  const crlf = parseBenchmarkCsv(`${H}\r\n${GOOD_ROW}\r\n`);
  ck("CRLF parses", crlf.ok, true);
  ck("...to the identical rows as LF", crlf.rows, lf.rows);
  ck("...with no stray \\r on the last column", crlf.rows[0].notes.indexOf("\r"), -1);
  ck("...and no stray \\r on the last HEADER name either", crlf.header[32], "notes");
  const mixed = parseBenchmarkCsv(`${H}\r\n${GOOD_ROW}\n${GOOD_ROW}\r\n`);
  ck("LF and CRLF mixed in one file", mixed.rows.length, 2);
  ck("a final row with no trailing newline is not dropped", parseBenchmarkCsv(`${H}\n${GOOD_ROW}`).rows.length, 1);
}

console.log("\n-- 3. comment rows and blank rows are skipped, not imported --");
{
  const csv = [H,
    "# EXAMPLE ROW — placeholders only, NOT real data. Delete before import.",
    "# Leave protocol_* blank when the source does not report that dimension.",
    "   # indented comments count too",
    "",
    GOOD_ROW,
    ",".repeat(32), // Excel's trailing all-empty row
    ""].join("\n");
  const r = parseBenchmarkCsv(csv);
  ck("three comment rows are skipped", r.skipped.comment, 3);
  ck("blank and all-empty rows are skipped", r.skipped.blank, 2);
  ck("...leaving only the real data row", r.rows.length, 1);
  ck("...and nothing was rejected, so the report is not noise", r.rejected.length, 0);
  ck("a '#' INSIDE a quoted value is data, never a comment",
     parseBenchmarkCsv(`${H}\n${rowFor(BENCHMARK_IMPORT_COLUMNS, { notes: "line one\n# not a comment" })}\n`).rows[0].notes,
     "line one\n# not a comment");
  ck("...and a '#' mid-field is left alone",
     parseBenchmarkCsv(`${H}\n${rowFor(BENCHMARK_IMPORT_COLUMNS, { notes: "cohort #3" })}\n`).rows[0].notes, "cohort #3");
}

console.log("\n-- 4. header binding is BY NAME: a reordered file must not shift --");
{
  const reordered = BENCHMARK_IMPORT_COLUMNS.slice();
  // The realistic accident: someone drags source_url to the front of the sheet.
  reordered.splice(reordered.indexOf("source_url"), 1);
  reordered.unshift("source_url");
  // ...and swaps two neighbours while they are in there.
  const i = reordered.indexOf("age_min");
  [reordered[i], reordered[i + 1]] = [reordered[i + 1], reordered[i]];
  const r = parseBenchmarkCsv(`${reordered.join(",")}\n${rowFor(reordered)}\n`);
  ck("a reordered header is accepted", r.ok, true);
  ck("...source_url is still the URL, not whatever sat in column 27",
     r.rows[0].source_url, VALUES.source_url);
  ck("...age_min is still age_min", r.rows[0].age_min, VALUES.age_min);
  ck("...age_max is still age_max", r.rows[0].age_max, VALUES.age_max);
  ck("...every one of the 33 values landed under its own name",
     BENCHMARK_IMPORT_COLUMNS.every((c) => r.rows[0][c] === VALUES[c]), true);

  // And the record the importer builds must be identical either way.
  const a = importBenchmarkCsv(`${H}\n${GOOD_ROW}\n`);
  const b = importBenchmarkCsv(`${reordered.join(",")}\n${rowFor(reordered)}\n`);
  ck("in-order and reordered files import the same specificity", b.accepted[0].specificity, a.accepted[0].specificity);
  ck("...the same stats", b.accepted[0].stats, a.accepted[0].stats);
  ck("...and the same provenance", b.accepted[0].provenance, a.accepted[0].provenance);
}

console.log("\n-- 5. a header that is not the contract is refused, loudly --");
{
  const missing = BENCHMARK_IMPORT_COLUMNS.filter((c) => c !== "source_url");
  const r = parseBenchmarkCsv(`${missing.join(",")}\n${rowFor(missing)}\n`);
  ck("a file missing source_url does not parse", r.ok, false);
  ck("...it names the column", r.errors, ["missing_column:source_url"]);
  ck("...and imports nothing at all rather than a shifted subset", r.rows.length, 0);
  const imported = importBenchmarkCsv(`${missing.join(",")}\n${rowFor(missing)}\n`);
  ck("importBenchmarkCsv stops at the parse stage", [imported.ok, imported.stage], [false, "parse"]);
  ck("...with nothing accepted", imported.accepted_count, 0);
}
{
  const typo = BENCHMARK_IMPORT_COLUMNS.map((c) => (c === "source_date" ? "source_dt" : c));
  const r = parseBenchmarkCsv(`${typo.join(",")}\n${rowFor(typo)}\n`);
  ck("a typo'd header name is reported as BOTH missing and unrecognised",
     r.errors.slice().sort(), ["missing_column:source_date", "unknown_column:source_dt"]);
}
{
  const extra = BENCHMARK_IMPORT_COLUMNS.concat(["internal_scratch"]);
  ck("an extra column is refused rather than silently ignored",
     parseBenchmarkCsv(`${extra.join(",")}\n${rowFor(extra)}\n`).errors, ["unknown_column:internal_scratch"]);
}
{
  const dup = BENCHMARK_IMPORT_COLUMNS.concat(["notes"]);
  ck("a duplicated column name is refused",
     parseBenchmarkCsv(`${dup.join(",")}\n${rowFor(dup)}\n`).errors, ["duplicate_column:notes"]);
}
ck("an empty file is a parse failure, not an empty success", parseBenchmarkCsv("").errors, ["no_header_row"]);
ck("a file of nothing but comments is a parse failure too",
   parseBenchmarkCsv("# all comments\n# still comments\n").errors, ["no_header_row"]);
{
  // Excel writes a BOM. Without stripping it the first header name is
  // "﻿sport" and all 33 columns read as wrong.
  const r = parseBenchmarkCsv(`﻿${H}\n${GOOD_ROW}\n`);
  ck("a UTF-8 BOM does not break the first column", r.ok, true);
  ck("...the first header name is clean", r.header[0], "sport");
  const spaced = parseBenchmarkCsv(`${BENCHMARK_IMPORT_COLUMNS.join(" , ")}\n${GOOD_ROW}\n`);
  ck("spaces around header names are tolerated", spaced.ok, true);
}

console.log("\n-- 6. ragged rows are rejected, never padded or truncated --");
{
  const short = rowFor(BENCHMARK_IMPORT_COLUMNS.slice(0, 30));
  const r = parseBenchmarkCsv(`${H}\n${GOOD_ROW}\n${short}\n`);
  ck("the file still parses", r.ok, true);
  ck("the good row survives", r.rows.length, 1);
  ck("the short row is rejected", r.rejected.length, 1);
  ck("...with the count it had", r.rejected[0].errors, ["field_count:expected_33_got_30"]);
  ck("...and the line number in the file the researcher is editing", r.rejected[0].line, 3);
  ck("...and its raw fields, so it can be fixed", r.rejected[0].raw.length, 30);
}
{
  const long = GOOD_ROW + ",oops";
  const r = parseBenchmarkCsv(`${H}\n${long}\n`);
  ck("a row with an extra field is rejected, not truncated to 33",
     r.rejected[0].errors, ["field_count:expected_33_got_34"]);
  ck("...and contributes no row", r.rows.length, 0);
}
{
  const bad = GOOD_ROW.replace(VALUES.source_name, '"Synthetic"Study');
  const r = parseBenchmarkCsv(`${H}\n${bad}\n`);
  ck("text after a closing quote is malformed, not guessed at",
     r.rejected[0].errors.includes("text_after_closing_quote"), true);
}
{
  // Nothing after the stray quote may contain a quote of its own, or that
  // one closes the field and the failure becomes an ordinary ragged row
  // (covered above) instead of the runaway this asserts.
  const r = parseBenchmarkCsv(`${H}\n"never closed,soccer,sprint_10m\nmore,rows,swallowed\n`);
  ck("an unterminated quote is FATAL — the rest of the file is not trustworthy", r.ok, false);
  ck("...and it names the line", r.errors[0], "unterminated_quote:line_2");
  ck("...and no row is imported from a file whose framing is unknown", r.rows.length, 0);
  ck("...so importBenchmarkCsv stops at the parse stage",
     [importBenchmarkCsv(`${H}\n"never closed,soccer\n`).ok, importBenchmarkCsv(`${H}\n"never closed,soccer\n`).accepted_count], [false, 0]);
}

console.log("\n-- 7. values stay strings; the importer does the type work --");
{
  const r = parseBenchmarkCsv(`${H}\n${GOOD_ROW}\n`);
  ck("numbers arrive as strings", typeof r.rows[0].n, "string");
  ck("...verbatim", r.rows[0].n, "240");
  const blanks = parseBenchmarkCsv(`${H}\n${rowFor(BENCHMARK_IMPORT_COLUMNS, { sd: "", position_group: "", n: "" })}\n`);
  ck("an unreported value stays '' — never 0", blanks.rows[0].sd, "");
  ck("...never null either", blanks.rows[0].position_group, "");
  ck("...and the importer, not the parser, turns a blank n into 'unknown'",
     importBenchmarkCsv(`${H}\n${rowFor(BENCHMARK_IMPORT_COLUMNS, { n: "" })}\n`).accepted[0].sample_size, "unknown");
  ck("...which the importer's own gate then calls insufficient",
     importBenchmarkCsv(`${H}\n${rowFor(BENCHMARK_IMPORT_COLUMNS, { n: "" })}\n`).accepted[0].sample_tier, "insufficient_sample");
  ck("an unquoted value with padding is trimmed",
     parseBenchmarkCsv(`${H}\n${GOOD_ROW.replace(",240,", ",  240  ,")}\n`).rows[0].n, "240");
  // notes is the last column and GOOD_ROW leaves it empty, so this appends
  // an explicitly QUOTED padded value — cell() would not quote it otherwise.
  ck("...but padding INSIDE quotes is the source's, and is kept",
     parseBenchmarkCsv(`${H}\n${GOOD_ROW}"  spaced  "\n`).rows[0].notes, "  spaced  ");
}

console.log("\n-- 8. the CSV path goes THROUGH importBenchmarkDataset, not around it --");
{
  const r = importBenchmarkCsv(`${H}\n${GOOD_ROW}\n`);
  ck("a valid row is accepted", [r.ok, r.accepted_count, r.rejected_count], [true, 1, 0]);
  ck("...with the sport/metric resolved by the real importer",
     [r.accepted[0].sport, r.accepted[0].metric, r.accepted[0].unit], ["soccer", "sprint_10m", "s"]);
  ck("...its sample tier gated by the real gates", r.accepted[0].sample_tier, "percentile_eligible");
  ck("...and the raw supplied row preserved", r.accepted[0].raw.source_url, VALUES.source_url);
  ck("the report is the importer's own shape",
     Object.keys(r).filter((k) => ["total", "accepted_count", "rejected_count", "by_sample_tier", "percentile_eligible_count", "accepted", "rejected"].includes(k)).length, 7);
  ck("...and the parse stage is reported alongside it", r.parse.skipped, { comment: 0, blank: 0 });

  // The CSV route must not weaken a single validation rule.
  const badType = importBenchmarkCsv(`${H}\n${rowFor(BENCHMARK_IMPORT_COLUMNS, { reference_type: "vibes" })}\n`);
  ck("a bad reference_type is still rejected via the CSV route", badType.rejected[0].errors, ["bad_reference_type"]);
  ck("...and the rejection carries the source line", badType.rejected[0].line, 2);
  const noSource = importBenchmarkCsv(`${H}\n${rowFor(BENCHMARK_IMPORT_COLUMNS, { source_url: "", measurement_protocol: "" })}\n`);
  ck("missing provenance is still rejected", noSource.rejected[0].errors.slice().sort(),
     ["missing:measurement_protocol", "missing:source_url"]);
  const badSport = importBenchmarkCsv(`${H}\n${rowFor(BENCHMARK_IMPORT_COLUMNS, { sport: "quidditch" })}\n`);
  ck("an unsupported sport is still rejected", badSport.rejected[0].errors.includes("unsupported_sport"), true);
  const dupe = importBenchmarkCsv(`${H}\n${GOOD_ROW}\n${GOOD_ROW}\n`);
  ck("duplicate detection still fires across CSV rows", dupe.rejected[0].errors, ["duplicate_record"]);
  ck("...on the second occurrence, at its line", dupe.rejected[0].line, 3);
  ck("...and the first is kept", dupe.accepted_count, 1);
  const mixed = importBenchmarkCsv(`${H}\n${GOOD_ROW}\n${rowFor(BENCHMARK_IMPORT_COLUMNS.slice(0, 5))}\n`);
  ck("a malformed row is reported separately from a validated rejection",
     [mixed.accepted_count, mixed.rejected_count, mixed.parse.malformed_rows.length], [1, 0, 1]);
}

console.log("\n-- 9. the REAL templates on disk --");
{
  const DIR = REPO + "/data/benchmark-templates/";
  for (const file of ["soccer_benchmark_populations.csv", "basketball_benchmark_populations.csv"]) {
    const text = fs.readFileSync(DIR + file, "utf8");
    const r = importBenchmarkCsv(text);
    ck(`${file}: parses`, r.ok, true);
    ck(`${file}: header IS the 33-column contract, in file order`, r.parse.header, BENCHMARK_IMPORT_COLUMNS);
    ck(`${file}: its 3 comment rows are skipped`, r.parse.skipped.comment, 3);
    ck(`${file}: contains no data — the repo ships no performance data`, r.total, 0);
    ck(`${file}: so nothing is accepted and nothing is rejected`, [r.accepted_count, r.rejected_count], [0, 0]);
    ck(`${file}: and the rejection report is empty, not noisy`, r.parse.malformed_rows, []);

    // The template's own commented example row, uncommented, is what a
    // researcher's first real row will look like structurally. It must reach
    // the importer as ONE row with the placeholder text intact — including
    // the protocol field that contains commas.
    const example = text.split(/\r?\n/).filter((l) => /^#\s*(soccer|basketball),/.test(l))[0];
    ck(`${file}: has a commented example row`, typeof example, "string");
    const asData = r.parse.header.join(",") + "\n" + example.replace(/^#\s*/, "") + "\n";
    const ex = parseBenchmarkCsv(asData);
    ck(`${file}: uncommented, it is exactly one well-formed 33-field row`,
       [ex.ok, ex.rows.length, ex.rejected.length], [true, 1, 0]);
    ck(`${file}: with its placeholder sample size intact`, ex.rows[0].n, "<N>");
    ck(`${file}: and the importer rejects the placeholders rather than importing them`,
       importBenchmarkCsv(asData).accepted_count, 0);
  }
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
