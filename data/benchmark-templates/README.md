# GOLSZ benchmark dataset templates

Drop a completed CSV here and it can be fed to `importBenchmarkDataset()` in
`api/scout.js`. **These templates contain header rows and commented examples
only — there is deliberately no real performance data in this repository.**

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
