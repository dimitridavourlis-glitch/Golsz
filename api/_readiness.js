// ============================================================
// GOLSZ — Passport Strength / Readiness engine (server-side canonical copy)
//
// WHY THIS EXISTS
// The five readiness sub-scores were computed ONLY in golsz-app.html
// (computeProfileQuality / computePerformanceScore / computeDevelopmentScore
// / computePathwayScore, plus an inline verification score). AI Scout could
// not see any of it. The result, found in the 2026-08-10 audit: the app
// performed a deterministic diagnosis on Home, and Scout performed a
// completely separate prose diagnosis in chat, with nothing keeping the two
// honest. An athlete could read "Performance 40" on Home and be told
// something different by Scout in the same minute.
//
// This module is the authoritative implementation. api/scout.js consumes it
// so Scout is handed the SAME numbers the athlete is looking at, rather than
// re-deriving an opinion from raw rows.
//
// WHY IT IS A COPY AND NOT AN IMPORT
// golsz-app.html is a single-file, no-build-step app: Babel-in-browser over
// a <script type="text/babel"> block. It cannot `import` from api/. The
// repo's existing answer to exactly this problem is api/_plan-catalog.js
// ("Mirrors PLANS in golsz-app.html; tests/test_cad_pricing.cjs diffs the
// two so they cannot drift"). This follows that precedent:
// tests/test_readiness_parity.cjs extracts BOTH implementations at run time
// and asserts they agree across a matrix of athlete shapes, so a change to
// one that is not mirrored in the other fails `npm test` rather than
// shipping two diagnoses.
//
// The `_` prefix keeps this file out of Vercel's serverless function count
// (the project sits exactly on the Hobby limit of 12).
//
// NOTHING HERE INVENTS A NUMBER. Every sub-score is a function of rows that
// already exist, and every missing item is named rather than folded into an
// opaque percentage — the "why is my score 72 / how do I improve it"
// requirement the original client code was written against.
// ============================================================

// Order is load-bearing: composite is a plain mean over this list, and
// `weakest` breaks ties by taking the FIRST minimum in this order. Both
// behaviours are mirrored from the client and pinned by the parity suite.
const READINESS_DIMENSIONS = ["profile_quality", "verification", "performance", "development", "pathway"];

// Mirrors golsz-app.html. Sports where a position field is meaningless, so
// asking for one would permanently hold profile_quality below 100.
const SPORTS_WITHOUT_POSITION = ["Golf", "Bowling"];

// Mirrors SPORT_POSITION_LABEL in golsz-app.html. Only the label differs by
// sport; the check itself is "is ath.position set". A sport missing from
// this map still gets the check, labelled "Position".
const SPORT_POSITION_LABEL = {
  Track: "EVENT", Swimming: "EVENT", Diving: "EVENT", "Cross Country": "EVENT", Triathlon: "EVENT", Gymnastics: "EVENT",
  Boxing: "WEIGHT CLASS", Wrestling: "WEIGHT CLASS", Weightlifting: "WEIGHT CLASS",
  "Martial Arts": "DISCIPLINE", Cycling: "DISCIPLINE", Skiing: "DISCIPLINE", Snowboarding: "DISCIPLINE", Equestrian: "DISCIPLINE",
  Fencing: "WEAPON", Sailing: "CLASS", Rowing: "SEAT", Archery: "DIVISION",
  Tennis: "PLAYS", "Table Tennis": "PLAYS", Badminton: "PLAYS", Squash: "PLAYS", Racquetball: "PLAYS",
  Cheerleading: "ROLE",
};

// ---- profile_quality -----------------------------------------------------
// Breadth of a completed Passport. Returns the named gaps, not just a score,
// because "add a bio and a highlight" is actionable and "61%" is not.
function computeProfileQuality(ath, prof) {
  if (!ath) return { score: 0, filled: 0, total: 0, missing: [] };
  const isPlayerLike = !prof || !prof.occupation || prof.occupation === "Player";
  const needsPosition = isPlayerLike && ath.sport && !SPORTS_WITHOUT_POSITION.includes(ath.sport);
  const checks = [
    { label: "Sport", ok: !!ath.sport },
    { label: "Club", ok: !!ath.club_name },
    { label: "Grad year", ok: !!ath.grad_year },
    { label: "Country", ok: !!ath.country },
    { label: "Recruiting status", ok: !!ath.recruiting_status },
    { label: "Bio", ok: !!(ath.bio && ath.bio.trim()) },
    { label: "Photo", ok: !!(prof && prof.avatar_url) },
    { label: "Highlights", ok: Array.isArray(ath.highlights) && ath.highlights.length > 0 },
    { label: "Career timeline", ok: Array.isArray(ath.timeline) && ath.timeline.length > 0 },
  ];
  if (needsPosition) checks.splice(1, 0, { label: SPORT_POSITION_LABEL[ath.sport] || "Position", ok: !!ath.position });
  const filled = checks.filter((c) => c.ok).length;
  const total = checks.length;
  return { score: total ? Math.round((filled / total) * 100) : 0, filled, total, missing: checks.filter((c) => !c.ok).map((c) => c.label) };
}

// ---- verification --------------------------------------------------------
// Tri-state, mirrored from HomeTab's inline computation. Identity
// verification only — deliberately NOT the subscription badge.
function computeVerificationScore(identityVerified, hasPendingRequest) {
  const isVerified = !!identityVerified;
  const pending = !!hasPendingRequest;
  return {
    score: isVerified ? 100 : pending ? 50 : 0,
    status: isVerified ? "verified" : pending ? "pending" : "none",
  };
}

// ---- performance ---------------------------------------------------------
// Rewards breadth (metrics tracked) AND depth (retested at least once, i.e.
// real progression rather than a single snapshot).
function computePerformanceScore(benchmarks) {
  if (!benchmarks || !benchmarks.length) return { score: 0, metricsTracked: 0, metricsRetested: 0 };
  const byMetric = {};
  for (const b of benchmarks) (byMetric[b.metric] = byMetric[b.metric] || []).push(b);
  const metricsTracked = Object.keys(byMetric).length;
  const metricsRetested = Object.values(byMetric).filter((arr) => arr.length >= 2).length;
  const score = Math.min(100, metricsTracked * 20 + metricsRetested * 10);
  return { score, metricsTracked, metricsRetested };
}

// ---- development ---------------------------------------------------------
// 30 for having a plan at all (working a plan is the point, not finishing it
// instantly), scaling to 100 as items are marked done.
function computeDevelopmentScore(items) {
  if (!items || !items.length) return { score: 0, done: 0, total: 0 };
  const done = items.filter((i) => i.status === "done").length;
  const score = Math.round(30 + 70 * (done / items.length));
  return { score, done, total: items.length };
}

// ---- pathway -------------------------------------------------------------
// A pathway_plan row with zero milestones is a shell, not a Pathway: it
// carries a category and nothing the athlete can act on. hasPathway means
// "worth calling built"; pathwayStarted keeps the weaker "a row exists".
function computePathwayScore(pathway, targetsCount) {
  let score = 0;
  const milestones = (pathway && Array.isArray(pathway.milestones)) ? pathway.milestones : [];
  if (pathway) score += 40;
  if (milestones.length > 0) score += Math.round(30 * (milestones.filter((m) => m.done).length / milestones.length));
  if (targetsCount > 0) score += 30;
  const started = !!pathway;
  const complete = started && milestones.length > 0;
  return {
    score: Math.min(100, score), hasPathway: complete, pathwayStarted: started,
    milestonesDone: milestones.filter((m) => m.done).length, milestonesTotal: milestones.length, targetsCount,
  };
}

// ---- composite -----------------------------------------------------------
// One call producing everything Scout needs: the five sub-scores, the plain
// mean, the weakest dimension (what to actually talk about), and the named
// missing information behind each one.
//
// Inputs are raw rows, deliberately — the caller does not get to pre-judge
// anything. targetsCount is a COUNT, not a truncated list: passing a capped
// page of targets here would silently change the score.
function computeReadiness({ athlete, profile, benchmarks, devItems, pathway, targetsCount, identityVerified, hasPendingVerification }) {
  const quality = computeProfileQuality(athlete, profile);
  const verification = computeVerificationScore(identityVerified, hasPendingVerification);
  const performance = computePerformanceScore(benchmarks);
  const development = computeDevelopmentScore(devItems);
  const pathwayScore = computePathwayScore(pathway, targetsCount || 0);

  const subScores = {
    profile_quality: quality.score,
    verification: verification.score,
    performance: performance.score,
    development: development.score,
    pathway: pathwayScore.score,
  };
  const composite = Math.round(READINESS_DIMENSIONS.reduce((sum, d) => sum + subScores[d], 0) / READINESS_DIMENSIONS.length);
  const weakest = READINESS_DIMENSIONS.reduce((min, d) => (subScores[d] < subScores[min] ? d : min), READINESS_DIMENSIONS[0]);

  return { subScores, composite, weakest, quality, verification, performance, development, pathway: pathwayScore };
}

// Athlete-facing names for the dimensions. Scout must never say
// "profile_quality" out loud — see stripInternalTerminology in api/scout.js.
const DIMENSION_LABEL = {
  profile_quality: "Passport completeness",
  verification: "identity verification",
  performance: "benchmark testing",
  development: "development plan progress",
  pathway: "pathway and target list",
};

export {
  READINESS_DIMENSIONS,
  SPORTS_WITHOUT_POSITION,
  SPORT_POSITION_LABEL,
  DIMENSION_LABEL,
  computeProfileQuality,
  computeVerificationScore,
  computePerformanceScore,
  computeDevelopmentScore,
  computePathwayScore,
  computeReadiness,
};
