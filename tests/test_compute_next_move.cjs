// Harness test for computeNextMove() (golsz-app.html) — mirrors the
// directive's §11 IF/THEN ladder. Pulled inline (not required from the
// HTML file) since it's a plain pure function with no JSX/React deps.
const BENCHMARK_RETEST_DAYS = 60;
function computeNextMove({ profileComplete, goalDefined, plan, baselineComplete, pathwayCreated, targetsCount, staleTargets, mostRecentBenchmarkDate }) {
  if (!profileComplete) return "COMPLETE_PROFILE";
  if (!goalDefined) return "DEFINE_GOAL";
  if (plan === "free") return "INVITE_TO_PATHWAY";
  if (!baselineComplete) return "ESTABLISH_BASELINE";
  if (!pathwayCreated) return "BUILD_PATHWAY";
  if (!targetsCount) return "TARGET_WORK";
  if (staleTargets > 0) return "FOLLOW_UP";
  if (!mostRecentBenchmarkDate || (Date.now() - new Date(mostRecentBenchmarkDate).getTime()) > BENCHMARK_RETEST_DAYS * 24 * 60 * 60 * 1000) return "RETEST";
  return "REVIEW_PROGRESS";
}

const now = Date.now();
const daysAgo = (n) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

const base = {
  profileComplete: true, goalDefined: true, plan: "starter", baselineComplete: true,
  pathwayCreated: true, targetsCount: 3, staleTargets: 0, mostRecentBenchmarkDate: daysAgo(10),
};

const cases = [
  ["incomplete profile wins over everything", { ...base, profileComplete: false, goalDefined: false, plan: "free" }, "COMPLETE_PROFILE"],
  ["no goal, profile done", { ...base, goalDefined: false }, "DEFINE_GOAL"],
  ["free plan, profile+goal done", { ...base, plan: "free" }, "INVITE_TO_PATHWAY"],
  ["paid plan, no baseline", { ...base, baselineComplete: false }, "ESTABLISH_BASELINE"],
  ["baseline done, no pathway", { ...base, pathwayCreated: false }, "BUILD_PATHWAY"],
  ["pathway done, zero targets", { ...base, targetsCount: 0 }, "TARGET_WORK"],
  ["targets exist but stale", { ...base, staleTargets: 2 }, "FOLLOW_UP"],
  ["no benchmark ever recorded", { ...base, mostRecentBenchmarkDate: null }, "RETEST"],
  ["benchmark older than 60 days", { ...base, mostRecentBenchmarkDate: daysAgo(90) }, "RETEST"],
  ["benchmark recent, everything else clean", { ...base, mostRecentBenchmarkDate: daysAgo(5) }, "REVIEW_PROGRESS"],
  ["elite plan follows same ladder as any paid plan", { ...base, plan: "elite", pathwayCreated: false }, "BUILD_PATHWAY"],
];

let pass = 0, fail = 0;
for (const [label, input, expected] of cases) {
  const actual = computeNextMove(input);
  if (actual === expected) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.log(`FAIL  ${label} -> expected ${expected}, got ${actual}`); }
}
console.log(`\n${pass}/${cases.length} passed`);
process.exit(fail > 0 ? 1 : 0);
