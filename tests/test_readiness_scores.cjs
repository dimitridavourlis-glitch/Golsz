function computePerformanceScore(benchmarks) {
  if (!benchmarks || !benchmarks.length) return { score: 0, metricsTracked: 0, metricsRetested: 0 };
  const byMetric = {};
  for (const b of benchmarks) (byMetric[b.metric] = byMetric[b.metric] || []).push(b);
  const metricsTracked = Object.keys(byMetric).length;
  const metricsRetested = Object.values(byMetric).filter((arr) => arr.length >= 2).length;
  const score = Math.min(100, metricsTracked * 20 + metricsRetested * 10);
  return { score, metricsTracked, metricsRetested };
}
function computeDevelopmentScore(items) {
  if (!items || !items.length) return { score: 0, done: 0, total: 0 };
  const done = items.filter((i) => i.status === "done").length;
  const score = Math.round(30 + 70 * (done / items.length));
  return { score, done, total: items.length };
}
function computePathwayScore(pathway, targetsCount) {
  let score = 0;
  const milestones = (pathway && Array.isArray(pathway.milestones)) ? pathway.milestones : [];
  if (pathway) score += 40;
  if (milestones.length > 0) score += Math.round(30 * (milestones.filter((m) => m.done).length / milestones.length));
  if (targetsCount > 0) score += 30;
  return { score: Math.min(100, score), hasPathway: !!pathway, milestonesDone: milestones.filter((m) => m.done).length, milestonesTotal: milestones.length, targetsCount };
}

let failed = 0;
function check(name, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} - ${name} (got ${JSON.stringify(got)}, expected ${JSON.stringify(expect)})`);
}

// Performance
check("no benchmarks", computePerformanceScore([]).score, 0);
check("1 metric, 1 entry", computePerformanceScore([{ metric: "40yd" }]).score, 20);
check("1 metric, retested", computePerformanceScore([{ metric: "40yd" }, { metric: "40yd" }]).score, 30);
check("2 metrics, 1 retested", computePerformanceScore([{ metric: "40yd" }, { metric: "40yd" }, { metric: "vertical" }]).score, 50);
check("capped at 100", computePerformanceScore(Array(10).fill(0).map((_, i) => ({ metric: "m" + i }))).score <= 100, true);

// Development
check("no items", computeDevelopmentScore([]).score, 0);
check("1 active, 0 done", computeDevelopmentScore([{ status: "active" }]).score, 30);
check("1 active, 1 done", computeDevelopmentScore([{ status: "done" }]).score, 100);
check("2 items, 1 done", computeDevelopmentScore([{ status: "done" }, { status: "active" }]).score, 65);

// Pathway
check("no pathway, no targets", computePathwayScore(null, 0).score, 0);
check("pathway set, no milestones, no targets", computePathwayScore({ pathway_type: "ncaa", milestones: [] }, 0).score, 40);
check("pathway + all milestones done + targets", computePathwayScore({ pathway_type: "ncaa", milestones: [{ done: true }, { done: true }] }, 3).score, 100);
check("pathway + half milestones done", computePathwayScore({ pathway_type: "ncaa", milestones: [{ done: true }, { done: false }] }, 0).score, 55);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
