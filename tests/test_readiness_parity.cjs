// Readiness parity — the UI and AI Scout must produce ONE diagnosis.
//
// Before api/_readiness.js existed, Home computed five Passport Strength
// sub-scores in golsz-app.html and Scout formed a completely separate prose
// opinion in chat, with nothing reconciling them. An athlete could read
// "Performance 40" on Home and be told something different by Scout in the
// same minute. api/_readiness.js is now the authoritative implementation and
// api/scout.js hands Scout its RESULT.
//
// golsz-app.html has no build step and cannot import from api/, so it keeps
// its own copy — the same arrangement api/_plan-catalog.js uses for money.
// This suite is what makes that safe: it extracts BOTH implementations out
// of the real files at run time and runs them over a matrix of athlete
// shapes. Change one without the other and this goes red.
//
// Nothing here is retyped. Every function under test is sliced out of the
// source it actually ships from.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const server = require("../api/_readiness.js");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- extract the CLIENT implementation -----------------------------------
// Two sport constants (needed by computeProfileQuality) plus the four
// scoring functions, taken from their real positions in the file.
function slice(startMarker, endMarker, label) {
  const a = APP.indexOf(startMarker);
  const b = APP.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error(`could not slice ${label} — markers moved, update this suite`);
  return APP.slice(a, b);
}
const constsSrc = slice("const SPORT_POSITION_LABEL = {", "const SPORT_PREFERENCE = {", "sport constants");
const fnsSrc = slice("function computeProfileQuality(ath, prof) {", "// Plan-gating — re-mapped per the GOLSZ", "readiness functions");
// Direct eval leaks `function` declarations into this scope; `const` does
// NOT leak, which is fine for the functions (they close over it) but means
// the constants have to be handed back explicitly to be compared below.
const clientConsts = eval(constsSrc + "\n" + fnsSrc + "\n({ SPORT_POSITION_LABEL, SPORTS_WITHOUT_POSITION })");
const dimsMatch = APP.match(/const READINESS_DIMENSIONS = \[[^\]]+\];/);
if (!dimsMatch) throw new Error("client READINESS_DIMENSIONS not found");
eval(dimsMatch[0].replace("const READINESS_DIMENSIONS", "var CLIENT_DIMENSIONS"));
// The composite/weakest arithmetic lives inline in HomeTab rather than in a
// named function, so pull those exact two statements out too — retyping them
// is precisely how a rounding difference would slip through.
const compositeSrc = APP.match(/const composite = Math\.round\(READINESS_DIMENSIONS\.reduce\([^;]+;/);
const weakestSrc = APP.match(/const weakest = READINESS_DIMENSIONS\.reduce\([^;]+;/);
if (!compositeSrc || !weakestSrc) throw new Error("client composite/weakest lines not found");

function clientReadiness(fx) {
  const quality = computeProfileQuality(fx.athlete, fx.profile);
  // Mirrors HomeTab's inline verification block exactly.
  const isVerified = !!(fx.profile && fx.profile.identity_verified);
  const pendingReq = !!fx.hasPendingVerification;
  const verification = { score: isVerified ? 100 : pendingReq ? 50 : 0, status: isVerified ? "verified" : pendingReq ? "pending" : "none" };
  const performance = computePerformanceScore(fx.benchmarks);
  const development = computeDevelopmentScore(fx.devItems);
  const pathway = computePathwayScore(fx.pathway, (fx.targets || []).length);
  const subScores = {
    profile_quality: quality.score,
    verification: verification.score,
    performance: performance.score,
    development: development.score,
    pathway: pathway.score,
  };
  const READINESS_DIMENSIONS = CLIENT_DIMENSIONS;
  let composite, weakest;
  eval(compositeSrc[0].replace("const composite", "composite"));
  eval(weakestSrc[0].replace("const weakest", "weakest"));
  return { subScores, composite, weakest, quality, verification, performance, development, pathway };
}

// ---- the matrix ----------------------------------------------------------
// Deliberately includes the awkward cases: a sport with no position concept,
// a sport with a renamed position field, retested vs single-shot benchmarks,
// a pathway shell, and every verification state.
const FIXTURES = [
  { name: "empty account", athlete: null, profile: null, benchmarks: [], devItems: [], pathway: null, targets: [], hasPendingVerification: false },
  { name: "sport only", athlete: { sport: "Soccer" }, profile: {}, benchmarks: [], devItems: [], pathway: null, targets: [], hasPendingVerification: false },
  {
    name: "fully complete soccer player, verified",
    athlete: { sport: "Soccer", position: "Right back", club_name: "Tusculum", grad_year: 2026, country: "Canada", recruiting_status: "open", bio: "a bio", highlights: ["u"], timeline: [{ y: 1 }] },
    profile: { occupation: "Player", avatar_url: "a.png", identity_verified: true },
    benchmarks: [{ metric: "10m", value: 2 }, { metric: "10m", value: 1.9 }, { metric: "20m", value: 3 }],
    devItems: [{ status: "done" }, { status: "active" }],
    pathway: { milestones: [{ done: true }, { done: false }] },
    targets: [{ id: 1 }, { id: 2 }],
    hasPendingVerification: false,
  },
  {
    name: "golf — position check must not apply",
    athlete: { sport: "Golf", club_name: "c", grad_year: 2027, country: "Canada", recruiting_status: "open", bio: "b", highlights: [], timeline: [] },
    profile: { occupation: "Player", avatar_url: null, identity_verified: false },
    benchmarks: [], devItems: [], pathway: null, targets: [], hasPendingVerification: true,
  },
  {
    name: "track — position field is labelled EVENT",
    athlete: { sport: "Track", position: null, club_name: "c", grad_year: 2027, country: "US", recruiting_status: "open", bio: "b", highlights: ["h"], timeline: [{ y: 1 }] },
    profile: { occupation: "Player", avatar_url: "a.png", identity_verified: false },
    benchmarks: [{ metric: "100m", value: 11 }], devItems: [{ status: "active" }], pathway: { milestones: [] }, targets: [], hasPendingVerification: false,
  },
  {
    name: "non-player occupation skips the position check",
    athlete: { sport: "Soccer", club_name: "c", grad_year: 2027, country: "US", recruiting_status: "open", bio: "b", highlights: ["h"], timeline: [{ y: 1 }] },
    profile: { occupation: "Coach", avatar_url: "a.png", identity_verified: false },
    benchmarks: [], devItems: [], pathway: null, targets: [], hasPendingVerification: false,
  },
  {
    name: "pathway shell — row exists, zero milestones",
    athlete: { sport: "Basketball", position: "G", club_name: "c", grad_year: 2026, country: "US", recruiting_status: "open", bio: "b", highlights: ["h"], timeline: [{ y: 1 }] },
    profile: { occupation: "Player", avatar_url: "a.png", identity_verified: false },
    benchmarks: [{ metric: "vert", value: 30 }], devItems: [{ status: "done" }], pathway: { milestones: [] }, targets: [], hasPendingVerification: false,
  },
  {
    name: "many metrics, none retested — performance caps on breadth",
    athlete: { sport: "Soccer", position: "CB" },
    profile: { occupation: "Player" },
    benchmarks: [{ metric: "a", value: 1 }, { metric: "b", value: 1 }, { metric: "c", value: 1 }, { metric: "d", value: 1 }, { metric: "e", value: 1 }, { metric: "f", value: 1 }],
    devItems: [], pathway: null, targets: [], hasPendingVerification: false,
  },
  {
    name: "all dev items done",
    athlete: { sport: "Soccer", position: "CB" }, profile: { occupation: "Player" },
    benchmarks: [], devItems: [{ status: "done" }, { status: "done" }], pathway: null, targets: [{ id: 1 }], hasPendingVerification: false,
  },
];

for (const fx of FIXTURES) {
  const c = clientReadiness(fx);
  const s = server.computeReadiness({
    athlete: fx.athlete,
    profile: fx.profile,
    benchmarks: fx.benchmarks,
    devItems: fx.devItems,
    pathway: fx.pathway,
    targetsCount: (fx.targets || []).length,
    identityVerified: !!(fx.profile && fx.profile.identity_verified),
    hasPendingVerification: fx.hasPendingVerification,
  });
  ck(`${fx.name} — sub-scores identical`, s.subScores, c.subScores);
  ck(`${fx.name} — composite identical`, s.composite, c.composite);
  ck(`${fx.name} — weakest dimension identical`, s.weakest, c.weakest);
  ck(`${fx.name} — named missing Passport items identical`, s.quality.missing, c.quality.missing);
  ck(`${fx.name} — performance detail identical`, [s.performance.metricsTracked, s.performance.metricsRetested], [c.performance.metricsTracked, c.performance.metricsRetested]);
  ck(`${fx.name} — pathway detail identical`, [s.pathway.hasPathway, s.pathway.milestonesDone, s.pathway.milestonesTotal], [c.pathway.hasPathway, c.pathway.milestonesDone, c.pathway.milestonesTotal]);
  ck(`${fx.name} — verification status identical`, s.verification.status, c.verification.status);
}

// The dimension list itself must match, in order: composite is a mean over
// it and `weakest` breaks ties by taking the first minimum in this order.
ck("dimension list identical and in the same order", server.READINESS_DIMENSIONS, CLIENT_DIMENSIONS);
ck("sports without a position concept identical", server.SPORTS_WITHOUT_POSITION, clientConsts.SPORTS_WITHOUT_POSITION);
ck("position labels identical", server.SPORT_POSITION_LABEL, clientConsts.SPORT_POSITION_LABEL);

// Every dimension needs an athlete-facing name, or Scout would have to say
// the raw key out loud — which is exactly what the terminology rule forbids.
for (const d of server.READINESS_DIMENSIONS) {
  ck(`${d} has a plain-language label`, typeof server.DIMENSION_LABEL[d] === "string" && server.DIMENSION_LABEL[d].length > 0, true);
  ck(`${d}'s label is not the raw key`, server.DIMENSION_LABEL[d] === d, false);
}

// ---- and so does every item in `missing` ---------------------------------
// The check above was written for the five DIMENSIONS and stopped there, so
// when quality.missing turned from English labels into dictionary keys on
// 2026-10-21 nothing noticed that api/scout.js has no dictionary: the keys
// went straight into the Scout prompt that says "use the plain-language name
// above", and into the label of a Plan step that is WRITTEN to
// pathway_plan.milestones and read back from that row forever. An athlete
// who tapped "build my plan" got "Complete your Passport: add
// quality_item_grad_year, quality_item_recruiting".
//
// Asserting on the map alone would only prove the map exists. This derives
// the keys the REAL function emits — over the same fixtures, plus one sport
// per distinct position slug — and requires a word for every one of them.
const everyEmittedKey = new Set();
for (const fx of FIXTURES) {
  for (const k of server.computeProfileQuality(fx.athlete, fx.profile).missing) everyEmittedKey.add(k);
}
for (const sport of Object.keys(server.SPORT_POSITION_LABEL).concat("Soccer")) {
  for (const k of server.computeProfileQuality({ sport }, null).missing) everyEmittedKey.add(k);
}
// A row with no sport yet — the only shape that reports the sport itself as
// missing, and the one every other case above fills in by construction.
for (const k of server.computeProfileQuality({}, null).missing) everyEmittedKey.add(k);
ck("the emitted-key scan found the whole quality checklist", everyEmittedKey.size >= 10, true);
ck("...including a position slug per distinct label",
   [...new Set(Object.values(server.SPORT_POSITION_LABEL))].filter((s) => !everyEmittedKey.has("position_label_" + s)), []);
// A key with no line in the map falls back to a humanised slug, which reads
// as words but is not a translation anyone chose. Both are checked, because
// the fallback is a floor and this is the thing that keeps it unused.
ck("every key the function can emit has a written label",
   [...everyEmittedKey].filter((k) => !Object.prototype.hasOwnProperty.call(server.MISSING_ITEM_LABEL, k)).sort(), []);
ck("...and no label is the key, or carries its prefix or an underscore",
   [...everyEmittedKey].filter((k) => {
     const w = server.labelForMissing(k);
     return !w || w === k || /_/.test(w) || /^(quality_item|position_label)\b/.test(w);
   }).sort(), []);
// The array form is what all three call sites use, and it must not drop or
// reorder anything — the prompt names them in checklist order.
ck("the array form maps one-to-one, in order",
   server.labelsForMissing(["quality_item_bio", "position_label_weight_class", "quality_item_sport"]),
   ["bio", "weight class", "sport"]);
ck("a non-array is an empty list, not a crash", server.labelsForMissing(null), []);
// The map must not grow a line for a key nothing can emit: a stale entry is
// how the next slug rename looks covered when it is not.
ck("no written label exists for a key the function cannot emit",
   Object.keys(server.MISSING_ITEM_LABEL).filter((k) => !everyEmittedKey.has(k)).sort(), []);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
