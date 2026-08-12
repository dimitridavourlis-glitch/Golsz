---
name: measurement-integrity
description: Use when writing or running a query, scan, test suite, or verification against the GOLSZ codebase or its Supabase data — and whenever about to conclude something from a result, report "the tests pass", trust a green suite, or accept a number that did not change. Covers detectors that measure the wrong thing, suites that assert against nothing, allowlists that rot, and null results.
---

# Measurement integrity

Every rule here was bought with a specific production failure. The reasoning
matters more than the rule, because the next case will not be the one listed.

## The standing check

**Before running a query, test, or verification, ask: can this distinguish the
thing I am about to conclude?** Ahead of the measurement, not after a number
looks suspicious.

State what decision the check will drive, then ask what the check groups
together that the decision needs kept apart. If a label, column, or fixture
conflates two mechanisms, split it before running.

## Four ways a check fails, in increasing order of invisibility

**1. It measures the wrong thing.** A label conflating two mechanisms.
`answered_by` once meant both "served from the FAQ table" and "served from the
response cache" — so no query could tell which path had gone quiet. Split into
`faq` and `cache` in migration 124.

**2. It measures the right thing over the wrong input.** A test fixture
`[{role:"user"}]` stood in for a cold-open conversation. The client always
seeds a greeting as an assistant turn first, so production never sends that
shape. A fixture that omits something the client seeds is not a simplified
input, it is a different system. Read how the payload is actually built.

**3. It measures the right thing over *nothing*.** A component omitted
`scout_context` from its `select()`. The rendering logic was correct and every
assertion passed, over a field that structurally could not arrive. The feature
could never have worked and the suite was green.

**4. The data is fine and the reading is not.** Six routing rows were read as
evidence about how one specific question had been classified — when nobody had
established that question was among the six. The conclusion was substantial,
reported as though the data had produced it, and rested on an unchecked
premise. **Before drawing from a result, say out loud which premise connects
the rows to the question, then check the rows contain it.** Match records to a
known action — a timestamp, an id — never to their position in a list.

## The null result

**State the expected delta BEFORE making a change, then check it.**

A number that fails to move draws no attention to itself. A red suite
announces itself; an obviously wrong figure announces itself; *absence of
change* produces no signal at all and is visible only to someone who predicted
it.

This has paid twice. Adding eight RPCs to a detector's allowlist left its
finding count unchanged, which should have been impossible — asking why
exposed that the detector was blind to an entire call shape
(`sb.rpc(...).then(({ error }) => ...)`, never awaited, never examined). It is
the only technique available for a class of failure that emits nothing.

## A detector is only worth its green if its signal is absent from the failure case

The first write-error scan searched for the string `error` near the call.
`catch (e) { console.error(...) }` contains it — so the broken pattern counted
as evidence of the fix. It reported 4 when the answer was 36, and would have
closed the question with "the codebase is basically clean".

**Every scan gets two fixtures: one known-broken it must flag, one known-good
it must not.** Both live in the suite, and they run before its result on the
real file means anything. `tests/test_write_error_checked.cjs` and
`tests/test_client_scope.cjs` both do this; copy the shape.

## Allowlists rot, and rot silently

An allowlist keyed on a value has one failure mode: an unlisted entry is
invisible. It does not fail — it passes unchecked.

`MUTATING_RPCS` was already wrong when written. Seven entries; **nine mutating
RPCs missing**, and one entry for an RPC the client never calls. The fix is
never "remember to add it" — it is an assertion that the list and reality
agree:

- every value found in the source must be classified (nothing unclassified)
- every classified value must still be found (nothing stale)

Both directions. A permanent exemption list that outlives its entries rots
into blanket permission.

**Never copy console output into an allowlist.** Failure messages truncate —
`.slice(0, 50)` — so an entry pasted from the terminal never matches the real
value, and the same item gets reported as both unreviewed *and* stale. Match
by prefix, and read the source not the report.

## Syntax checks say nothing about scope

`node --check` and a Babel transform verify **syntax**. An undeclared
identifier is well-formed source and a runtime `ReferenceError`. Twice the
suite stayed green and a grep found it: `storedAssessment` (every established
athlete got a 502 *after* the model had answered and been billed) and
`noteDraft`. That is a gap to close with a real parser, not a discipline to
remember — `tests/test_client_scope.cjs` parses the client with
`@babel/parser` and resolves actual bindings.

## Anchors

These suites extract functions from source at run time by slicing between
string anchors, and never retype them. Two ways that breaks:

- **Dead anchor**: `indexOf` returns -1, `slice(-1, n)` yields garbage, and
  ~24 assertions once evaluated against an empty string while printing PASS.
- **Ambiguous anchor**: an anchor occurring twice silently takes the first.
  `PathwayPlan` and `DevelopmentPlan` contained a byte-identical guard, so a
  `.replace(..., 1)` meant for one landed on the other — and the visual check
  passed because a *different* component's skeleton was on screen.

`tests/test_anchor_integrity.cjs` enforces both across every suite. Ambiguity
is reviewed rather than banned, because several ambiguities are correct by
construction and a check that fails on correct code gets muted.

## Before instrumenting a question, check whether something already answers it

Twice in one day the answer sat within a few lines of the code being edited: a
comment directly above `callAnthropic()` documenting that the proposed change
was already made, and a `logFaqMiss()` call eleven lines below a function
edited repeatedly that morning — writing to `scout_faq_misses`, a table that
exists precisely to answer "why didn't the FAQ fire".

**A table whose name is the question is a strong hint.** Read what sits
immediately around the function, especially the logging.

## Removals need the same review as additions

A wrong claim can be the only thing explaining what sits next to it. Deleting
a false "SECONDARY GOAL" card left the diagram node beneath it unlabelled —
claiming nothing, therefore implying anything. No assertion catches "this is
now unexplained"; it is a looking-at-it property. "I took out the false thing"
feels self-evidently complete and isn't.

## The gate must fail on the real exit code

```bash
npm run check | grep -q "suites passed" && vercel deploy --prod --scope golszcom
```

takes **grep's** exit code, not the test run's. A failing suite deployed once
that way. Redirect and gate on the command itself:

```bash
npm run check > /tmp/check.log 2>&1 && vercel deploy --prod --scope golszcom
```

## Conventions

- `npm run check` = `node --check` ×2 + `node tests/run-all.cjs`.
- `npm test` takes a **filter substring**, not a path.
- Suites `eval(slice(...))` the real source. **Never retype the function under
  test** — a retyped copy passes forever while production diverges.
