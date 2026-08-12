// Readiness sub-scores — performance, development, pathway.
//
// WHY THIS FILE WAS REWRITTEN
// This suite used to open with three hand-typed copies of the scoring
// functions and test those. That is the exact failure tests/README.md calls
// "the one rule that matters", and it had already bitten here: production's
// computePathwayScore() was deliberately changed so that
//
//     hasPathway = started && milestones.length > 0
//
// — a pathway_plan row with zero milestones is a shell carrying a category
// and nothing the athlete can act on, so it is no longer "built" — and a new
// `pathwayStarted` field was added to keep the weaker "a row exists" meaning
// available. The copy in this file still returned `hasPathway: !!pathway`.
// Both shapes were green, because the copy was consistent with itself and
// every assertion only read `.score`, which the change did not touch.
//
// api/_readiness.js is a plain importable module — tests/test_readiness_parity
// .cjs already require()s it — so no source slicing is needed here.

const path = require("path");
const fs = require("fs");
const REPO = path.join(__dirname, "..");
const R = require("../api/_readiness.js");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// Guard the extraction itself. The runner's "did it say anything
// recognisable" check catches a suite that dies outright; it cannot catch one
// that loaded a PARTIAL module and quietly skipped half its assertions.
console.log("-- the real module loaded, not a copy --");
for (const name of ["computePerformanceScore", "computeDevelopmentScore", "computePathwayScore", "computeReadiness"]) {
  ck(`${name} came from api/_readiness.js`, typeof R[name], "function");
}
const { computePerformanceScore, computeDevelopmentScore, computePathwayScore } = R;

console.log("\n-- performance: breadth (metrics tracked) and depth (retested) --");
ck("no benchmarks", computePerformanceScore([]).score, 0);
ck("null benchmarks is the same as none", computePerformanceScore(null).score, 0);
ck("1 metric, 1 entry", computePerformanceScore([{ metric: "40yd" }]).score, 20);
ck("1 metric, retested", computePerformanceScore([{ metric: "40yd" }, { metric: "40yd" }]).score, 30);
ck("2 metrics, 1 retested", computePerformanceScore([{ metric: "40yd" }, { metric: "40yd" }, { metric: "vertical" }]).score, 50);
ck("capped at 100", computePerformanceScore(Array(10).fill(0).map((_, i) => ({ metric: "m" + i }))).score <= 100, true);
ck("the counts are reported, not just the score",
   computePerformanceScore([{ metric: "40yd" }, { metric: "40yd" }, { metric: "vertical" }]),
   { score: 50, metricsTracked: 2, metricsRetested: 1 });

console.log("\n-- development: 30 for having a plan, scaling to 100 as items close --");
ck("no items", computeDevelopmentScore([]).score, 0);
ck("1 active, 0 done", computeDevelopmentScore([{ status: "active" }]).score, 30);
ck("1 item, done", computeDevelopmentScore([{ status: "done" }]).score, 100);
ck("2 items, 1 done", computeDevelopmentScore([{ status: "done" }, { status: "active" }]).score, 65);
ck("done/total are reported", computeDevelopmentScore([{ status: "done" }, { status: "active" }]),
   { score: 65, done: 1, total: 2 });

console.log("\n-- pathway: score --");
ck("no pathway, no targets", computePathwayScore(null, 0).score, 0);
ck("pathway set, no milestones, no targets", computePathwayScore({ pathway_type: "ncaa", milestones: [] }, 0).score, 40);
ck("pathway + all milestones done + targets", computePathwayScore({ pathway_type: "ncaa", milestones: [{ done: true }, { done: true }] }, 3).score, 100);
ck("pathway + half milestones done", computePathwayScore({ pathway_type: "ncaa", milestones: [{ done: true }, { done: false }] }, 0).score, 55);
ck("targets alone score, with no pathway row at all", computePathwayScore(null, 2).score, 30);

console.log("\n-- pathway: hasPathway vs pathwayStarted (the drift this suite missed) --");
// A row with no milestones is STARTED but not BUILT. The old copy conflated
// the two and reported hasPathway:true for a shell — and hasPathway is what
// Scout and the Passport Strength meter read to decide whether to tell an
// athlete they have a pathway at all.
const shell = computePathwayScore({ pathway_type: "ncaa", milestones: [] }, 0);
ck("a milestone-less shell is NOT a built pathway", shell.hasPathway, false);
ck("...but it IS started", shell.pathwayStarted, true);
const real = computePathwayScore({ pathway_type: "ncaa", milestones: [{ done: false }] }, 0);
ck("one milestone makes it a real pathway", real.hasPathway, true);
ck("...and still started", real.pathwayStarted, true);
const none = computePathwayScore(null, 0);
ck("no row: neither built nor started", [none.hasPathway, none.pathwayStarted], [false, false]);
ck("a non-array milestones value is treated as none, not a crash",
   [computePathwayScore({ milestones: "oops" }, 0).hasPathway,
    computePathwayScore({ milestones: null }, 0).milestonesTotal], [false, 0]);
ck("full shape is reported", real,
   { score: 40, hasPathway: true, pathwayStarted: true, milestonesDone: 0, milestonesTotal: 1, targetsCount: 0 });

console.log("\n-- and the source really is the shipping one --");
const SRC = fs.readFileSync(REPO + "/api/_readiness.js", "utf8");
ck("api/_readiness.js still defines the pathwayStarted split", /pathwayStarted: started/.test(SRC), true);
ck("...and hasPathway is the milestone-gated value", /const complete = started && milestones\.length > 0;/.test(SRC), true);
// If someone reintroduces a local copy above, this goes red.
ck("this suite contains no reimplementation",
   /^function compute/m.test(fs.readFileSync(__filename, "utf8")), false);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
