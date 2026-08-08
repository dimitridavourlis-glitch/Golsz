#!/usr/bin/env node
// .cjs throughout: package.json declares "type": "module", and these suites
// are CommonJS (they require() and eval() code out of the source files).
//
// GOLSZ test runner.
//
// These suites used to live in a scratch directory outside the repo, which
// meant they vanished when the session that wrote them ended and could not
// gate a deploy. They are here now so `npm test` is a real check.
//
// Every suite follows the same contract: run standalone with `node`, print
// "N/M passed" as its last line, and exit non-zero if anything failed. They
// deliberately extract the FUNCTIONS UNDER TEST out of api/scout.js and
// golsz-app.html at run time rather than importing copies — a suite that
// tests a copy passes happily while production is broken.
//
// Usage:
//   npm test              run everything
//   npm test -- salvage   run only suites whose name matches "salvage"

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const filter = process.argv[2] || "";
const files = fs.readdirSync(dir)
  .filter((f) => f.startsWith("test_") && f.endsWith(".cjs"))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!files.length) {
  console.error(filter ? `No suites match "${filter}".` : "No test suites found.");
  process.exit(1);
}

let failed = 0;
let totalAssertions = 0;
const failures = [];

for (const f of files) {
  const name = f.replace(/^test_|\.cjs$/g, "");
  let out = "";
  let ok = true;
  try {
    out = execFileSync(process.execPath, [path.join(dir, f)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    ok = false;
    out = (e.stdout || "") + (e.stderr || "");
  }
  const last = out.trim().split("\n").filter(Boolean).pop() || "(no output)";
  const m = /^(\d+)\/(\d+) passed$/.exec(last.trim());
  if (m) totalAssertions += Number(m[2]);

  // Two reporting styles exist here for historical reasons: the newer suites
  // print "N/M passed", the older ones print "ALL PASS". Both are fine. The
  // EXIT CODE is what decides pass/fail; the tally is only for counting.
  //
  // The extra "did it say anything recognisable" check exists so a suite that
  // silently does nothing — wrong path, empty extraction, a require that
  // resolved to an empty object — cannot exit 0 and be reported as green.
  const reported = !!m || /ALL PASS/.test(out);
  if (!ok || !reported) {
    failed += 1;
    failures.push({ name, out });
    console.log(`FAIL  ${name.padEnd(26)} ${ok ? "produced no pass marker" : last}`);
  } else {
    console.log(`ok    ${name.padEnd(26)} ${last}`);
  }
}

if (failures.length) {
  console.log("\n" + "=".repeat(60));
  for (const { name, out } of failures) {
    console.log(`\n--- ${name} ---`);
    console.log(out.split("\n").filter((l) => /FAIL|Error|error:/.test(l)).slice(0, 20).join("\n") || out.slice(-1500));
  }
}

console.log(`\n${files.length - failed}/${files.length} suites passed (${totalAssertions} assertions)`);
process.exit(failed ? 1 : 0);
