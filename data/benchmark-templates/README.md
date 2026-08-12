# GOLSZ benchmark dataset templates

**These templates contain header rows and commented examples only — there is
deliberately no real performance data in this repository.**

## The CSV pipeline

Fill a copy of the template in, then hand the file text to
`importBenchmarkCsv()` in `api/scout.js`:

```bash
node --input-type=module -e '
import { importBenchmarkCsv } from "./api/scout.js";
import { readFileSync } from "node:fs";
const r = importBenchmarkCsv(readFileSync(process.argv[1], "utf8"));
console.log(JSON.stringify(r, null, 2));
' data/benchmark-templates/soccer_benchmark_populations.csv
```

It parses the file, binds each value to its column **by header name**, and
passes the rows to the existing `importBenchmarkDataset()` — the same
validation, unchanged. The CSV route weakens no rule: `reference_type`,
evidence tier, sample-size gates, unit conversion, required provenance and
duplicate detection all still apply, and `tests/test_benchmark_csv.cjs`
asserts each of them still fires through this path.

**Read the report, not the exit.** The result is
`importBenchmarkDataset()`'s own report with the parse stage attached:

| field | meaning |
|---|---|
| `ok` | the FILE was readable as the contract. Says nothing about the rows. |
| `stage` | `"parse"` if it stopped at the header, `"import"` if rows were validated |
| `parse.header` | the header as found, in file order |
| `parse.errors` | why the file was refused (`missing_column:source_url`, …) |
| `parse.skipped` | `#` comment rows and blank rows ignored |
| `parse.malformed_rows` | rows refused before validation (wrong field count, bad quoting), each with its **line number in your file** |
| `accepted` | the only thing that ever counted as imported |
| `rejected` | rows the importer refused, each with `errors` and its source `line` |

A row that appears in neither `accepted` nor `rejected` did not exist. If
`accepted_count` is lower than the number of rows you wrote, something was
dropped — find it in `rejected` or `parse.malformed_rows`.

### What the parser does and does not do to your data

- **RFC 4180.** Quoted fields, commas inside quotes (`measurement_protocol`
  always has one), newlines inside quotes, `""` for a literal quote, CRLF and
  LF mixed in one file, a final row with no trailing newline, and the UTF-8
  BOM Excel writes.
- **`#` comment rows and blank rows are skipped**, so the three commented
  example lines both templates ship with never reach the importer and never
  clutter the rejection report. A `#` inside a quoted value is data.
- **Binding is by name.** Reorder the columns in your spreadsheet and the
  import is still correct. A header missing a contract column, carrying an
  unrecognised one, or repeating one is **refused outright** — never imported
  with every value shifted one place.
- **Ragged rows are rejected, never padded or truncated** into shape.
- **Values stay strings.** `""` reaches the importer as `""`, which means
  "the source did not report this" — the parser never turns it into `0` or
  `null`. The importer does all coercion.
- Only two transformations happen anywhere: an **unquoted** field is trimmed
  (spreadsheets leave spaces after commas), and a CRLF **inside** quotes
  becomes LF so the same prose does not compare unequal depending on which OS
  saved the file. Whitespace inside quotes is the source's and is kept.

### Where it runs — and what is still yours to decide

`parseBenchmarkCsv()` and `importBenchmarkCsv()` are **named exports of
`api/scout.js` with no route attached**, on purpose. Benchmark populations
are what every athlete's percentile is computed against, so one bad write is
not one bad row — it moves every comparison built on it. Today the pipeline
is reachable from a maintainer's shell and from nothing else.

Two things are deliberately left undone:

1. **Nothing is persisted.** `importBenchmarkCsv()` returns a report and
   writes nowhere. There is no benchmark-population table — the reference
   pool is `BENCHMARK_BANDS` in `api/scout.js`, and it is still `[]`. Landing
   `accepted` somewhere (a migration and a service-role write, or generating
   the `BENCHMARK_BANDS` entries and committing them) is a separate decision,
   and every entry must still satisfy `validateBenchmarkBand()`.
2. **There is no endpoint.** If one is ever wanted, copy the gate
   `api/admin-user-action.js` already uses — verify the Supabase access token
   against `/auth/v1/user`, then look up `profiles.is_admin` with the service
   key, and refuse everything else — and put it in its own file rather than
   in `api/scout.js`'s handler, which is Scout's hot path and contracts on
   `messages[]`. Do **not** expose it unauthenticated in any form.

The rest of this document is the schema contract, and it is accurate.

## The one rule

Every numeric value must be traceable to a Tier A/B/C source. A row without
`source_url`, `source_date`, `measurement_protocol` and a sample size is
rejected by the importer, not repaired.

- **Tier A** official league / combine / governing-body / federation data
- **Tier B** peer-reviewed research, NSCA and recognised sports-science material
- **Tier C** university S&C standards, academy/club testing protocols where legitimately published

Not admissible: recruiting sites, blogs, social posts, forums, AI-generated
estimates.

## Descriptive vs required — the distinction that matters most

`reference_type` must be one of:

| value | meaning |
|---|---|
| `observed_distribution` | what a measured group actually did |
| `population_reference` | normative data for a defined population |
| `official_requirement` | a governing body genuinely requires this |
| `published_standard` | a published testing/protocol standard |
| `derived_reference_band` | GOLSZ-derived from one of the above; must cite its parent |

**Only `official_requirement` may ever be phrased to an athlete as something
they must achieve.** An observed average is not a requirement. NBA Combine
data describes NBA Combine invitees — never NCAA recruiting cut-offs.

## Specificity: leave it blank when the source does not say

`sex`, `age_min`, `age_max`, `development_stage`, `competition_level` and
`position_group` may all be left EMPTY. Empty means "this source did not break
the data down that way", which GOLSZ treats as an all-population reference.

Do **not** guess. A study of elite U17 males with no position split is a
genuine elite-U17-male reference; filling in `position_group=winger` to make it
look more useful would fabricate specificity the evidence does not support.

## Sample size

Put the real N. If the source does not report it, write `unknown` — never
leave it blank hoping it reads as zero, and never estimate.

Provisional gates (in `SAMPLE_SIZE_GATES`, env-overridable, **not validated
scientific thresholds — review before launch**):

| N | tier | athlete-facing effect |
|---|---|---|
| < 30 | `insufficient_sample` | not published |
| 30–99 | `descriptive_only` | described, **never** as a percentile |
| 100–499 | `percentile_eligible` | percentiles permitted |
| >= 500 | `strong_reference` | percentiles permitted |

## Measurement protocol

Free text, but be specific. GOLSZ refuses to compare incompatible protocols:
electronic vs hand timing, standing vs flying start, standing vs approach
vertical. Record timing method, distance, start type, surface and jump
protocol wherever the source states them.

## Units

Use the sport's canonical unit where possible. The importer converts only
exact, dimensionally-valid units (in↔cm, kg↔lb, ms↔s) and rejects anything
else rather than coercing it. A protocol difference is never a unit difference.
