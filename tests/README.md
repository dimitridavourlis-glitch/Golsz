# GOLSZ tests

```bash
npm test              # everything
npm test -- salvage   # only suites matching "salvage"
npm run check         # node --check on the APIs, then the suites
npm run deploy        # check + vercel --prod  (use this, not bare vercel)
```

## Why these exist in this shape

There is no Jest, no framework, no dependencies. Each suite is a standalone
`.cjs` script that prints its own tally and exits non-zero on failure. That
was a deliberate trade: the project has one runtime dependency (`web-push`)
and adding a test framework to a single-file app was never worth it.

**`.cjs`, not `.js`** — `package.json` declares `"type": "module"`, and these
suites are CommonJS because they `require()` and `eval()` code out of the
source files.

## The one rule that matters

**Suites extract the functions under test out of `api/scout.js` and
`golsz-app.html` at run time.** They never contain a copy of the logic.

A suite that tests a copy passes happily while production is broken. This
happened: an earlier suite read a generated `_scout_extracted.js` side file,
which drifted and lived outside the repo entirely.

If you add a suite, follow the same pattern:

```js
const REPO = require("path").join(__dirname, "..");
const SRC = require("fs").readFileSync(REPO + "/api/scout.js", "utf8");
eval(SRC.slice(SRC.indexOf("function myThing("), ...));
```

## The second rule: fixtures must be the shape production sends

Extracting the real function is only half the guarantee. **A fixture that
omits something the client seeds is not a simplified version of production —
it is a different input, and the suite is testing a different system.**

This cost a live regression on 2026-08-11, in the same change that documented
the trap it fell into.

`shouldUseFaqMatch()` gained a gate refusing the FAQ short-circuit when a
short reactive message arrives after Scout has spoken, so a correction could
never be answered with a canned encyclopedia entry. Its guard suite asserted
that a genuine cold-open question still matched the FAQ, using:

```js
const COLD_OPEN = [{ role: "user", content: "..." }];   // never happens
```

Production never sends that. `golsz-app.html` seeds every new conversation
with the greeting as an **assistant** turn and posts the array verbatim, so
the very first request of a brand-new chat already contains an assistant
message. `isReplyToScout()` was therefore true on turn one, and every short
cold-open question — the FAQ's entire reason to exist — was disqualified. The
$0 path would have gone to near zero. The suite was green throughout, because
its cold open was a shape the server can never receive.

So: **before writing a fixture, read how the client builds the payload.** For
Scout that is `const api = next.slice(-RECENT_TURNS).map(...)` in
`golsz-app.html`, and `next` always begins with a seeded greeting. Every
conversation fixture in `test_faq_correction_gate.cjs` now starts from a
shared `GREETING` constant for exactly this reason.

The generalisation, which is also what the four other measurement bugs in
this repo had in common (`0 || null` swallowing zeros, `indexOf` -1 feeding
`slice`, a mock discriminator matching `/classif/`, a CHECK constraint
rewritten without `'failed'`): **ask whether the check can distinguish the
thing you are about to conclude — before you run it, not after the number
looks wrong.** In every case the information was never in the number. It was
in the gap between what was measured and what was about to be decided.

## `test_handler_smoke.cjs` is the important one

Every other suite tests individual functions. That is not enough, and on
2026-08-08 it cost a production outage: `storedAssessment` was declared
inside an `if (userId)` block and read outside it, so every established
athlete got a 502 *after* the model had already answered and been billed.
`node --check` passes on that — a `ReferenceError` is a runtime fact, not a
syntax one — and all seventeen function-level suites were green throughout.

`test_handler_smoke.cjs` runs the **real exported handler** with `fetch`
mocked (auth, profile, athlete, pathway, capabilities, reserves, Anthropic)
across three athlete shapes. It asserts the handler does not throw, does not
502, **gets past auth**, reaches the branch under test, and returns real
`reply_text`.

That auth assertion is not decoration. The first version of this file
silently 401'd on all three scenarios and reported 6/6 passing while
testing nothing at all.

**When you add a code path that depends on handler-scope state, add a
scenario here.** Function-level tests cannot see scope.

## Reporting styles

Older suites print `ALL PASS`; newer ones print `N/M passed`. The runner
accepts both — the exit code decides pass/fail, and the tally is only used
for counting. A suite that produces neither marker is treated as a failure,
so a script that silently does nothing (bad path, empty extraction) cannot
exit 0 and be reported green.
