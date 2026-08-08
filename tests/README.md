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
