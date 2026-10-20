// THE ROAD — one vertical line, read bottom to top.
//
// The ordering is RUN here, not grepped, because the road's whole claim is
// that it draws the same rule nextMilestone selects from. If those two ever
// disagree, the app says "do this next" while pointing somewhere else.
//
// The other thing under guard is that the road is a VIEW. Array position is
// semantic in this data - moveMilestone swaps by index and test_pathway
// _milestones pins that it swaps within a stage group - so re-presenting the
// list must never re-order the stored one.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};
const grab = (sig) => {
  const at = APP.indexOf(sig);
  if (at < 0) return "";
  return APP.slice(at, APP.indexOf("\n}", at) + 2);
};

/* ---------- the ordering, executed ---------- */

const sugSrc = grab("function suggestedDate(m) {");
const rankSrc = grab("function milestoneRank(m) {");
const cmpUSrc = grab("function compareUndone(a, b) {");
const cmpDSrc = grab("function compareDone(a, b) {");
const nextSrc = grab("function nextMilestone(milestones) {");
for (const [n, s] of [["suggestedDate", sugSrc], ["milestoneRank", rankSrc],
                      ["compareUndone", cmpUSrc], ["compareDone", cmpDSrc], ["nextMilestone", nextSrc]]) {
  ck(`${n} exists`, s.length > 0, true);
}
let ORD = {};
try {
  ORD = new Function(sugSrc + rankSrc + cmpUSrc + cmpDSrc + nextSrc +
    " return { suggestedDate, milestoneRank, compareUndone, compareDone, nextMilestone };")();
} catch (e) { ck("the ordering evaluates", "threw: " + e.message, true); }

const mk = (id, over) => ({ id, label: id, done: false, due: null, stage: null, ...over });
const MINE_SOON = mk("mine_soon", { due: "2026-10-20" });
const MINE_LATE = mk("mine_late", { due: "2026-12-01" });
const SUG_SOONER = mk("sug", { due: "2026-10-01", due_src: "scout" });
const UNDATED = mk("undated");
const DONE_OLD = mk("done_old", { done: true, done_at: "2026-01-01" });
const DONE_NEW = mk("done_new", { done: true, done_at: "2026-09-01" });
const DONE_LEGACY = mk("done_legacy", { done: true, done_at: null });

const order = (rows) => rows.slice().sort(ORD.compareUndone).map((m) => m.id);
ck("the athlete's own date outranks a sooner one Scout guessed",
   order([SUG_SOONER, MINE_LATE]), ["mine_late", "sug"]);
ck("among the athlete's own, earliest first",
   order([MINE_LATE, MINE_SOON]), ["mine_soon", "mine_late"]);
ck("undated steps come last", order([UNDATED, SUG_SOONER]), ["sug", "undated"]);
ck("...and keep list order between themselves",
   order([mk("u2"), mk("u1")]), ["u2", "u1"]);

// THE CLAIM THE WHOLE SCREEN RESTS ON.
ck("the road's first undone stop IS nextMilestone",
   order([SUG_SOONER, MINE_LATE, UNDATED])[0], ORD.nextMilestone([SUG_SOONER, MINE_LATE, UNDATED]).id);
ck("...and that holds when only suggestions are dated",
   order([SUG_SOONER, UNDATED])[0], ORD.nextMilestone([SUG_SOONER, UNDATED]).id);
ck("...and when nothing is dated at all",
   order([UNDATED, mk("z")])[0], ORD.nextMilestone([UNDATED, mk("z")]).id);

const dorder = (rows) => rows.slice().sort(ORD.compareDone).map((m) => m.id);
ck("done steps read newest first", dorder([DONE_OLD, DONE_NEW]), ["done_new", "done_old"]);
// done_at only started being stamped when touchedMilestone learned to.
ck("a step ticked before done_at existed sorts last, not first",
   dorder([DONE_LEGACY, DONE_OLD]), ["done_old", "done_legacy"]);
ck("...and two of them keep list order",
   dorder([mk("l1", { done: true }), mk("l2", { done: true })]), ["l1", "l2"]);

/* ---------- the road is a view, not a mutation ---------- */

const road = grab("function RoadMap({ milestones, stages, currentStageId, athlete, goalText, pathwayType, resting, lang, t,");
ck("RoadMap exists", road.length > 0, true);
// .slice() before every .sort(). Array position is semantic here - moveMilestone
// swaps by index - so sorting the prop in place would silently re-order the
// athlete's stored plan as a side effect of looking at it.
ck("it never sorts the caller's array in place",
   (road.match(/\.slice\(\)\.sort\(/g) || []).length >= 2, true);
ck("...and sorts nothing without slicing first", /[^)]\.sort\(compare/.test(road.replace(/\.slice\(\)\.sort\(compare/g, "")), false);
ck("it writes nothing", /sb\.from\(|save\(|setMilestones/.test(road), false);
// It must not re-derive "what now" - it takes the same list it sorts.
ck("the current stop is the first undone, not a second rule",
   /const current = undone\.length \? undone\[0\] : null;/.test(road), true);

/* ---------- it reuses the existing paths ---------- */

ck("ticking goes through PathwayPlan's own toggleMilestone",
   /onToggle=\{\(id\) => \{ toggleMilestone\(id\); setOpenStop\(null\); \}\}/.test(APP), true);
ck("a signpost opens the stage editor the old map opened",
   /onSignpost=\{\(id\) => \{ setEditingGoal\(false\); setStageDraft\(stageLabelFor\(id\)\); setPendingStage\(null\); setEditingStage\(id\); \}\}/.test(APP), true);
// A date the athlete sets must become THEIRS, or canCallLate keeps treating
// it as Scout's guess and never calls it late however far it slips.
ck("setting a date clears the suggestion marker",
   /touchedMilestone\(\{ \.\.\.m, due: iso \}\)/.test(APP), true);

/* ---------- stages ---------- */

const stageOf = grab("  const stageOf = (m) => {");
ck("a step filed under a deleted stage renders without a signpost",
   /return st \? \{ id: st\.id, label: stageLabel\(st, t\) \} : null;/.test(road), true);
ck("...and a step with no stage at all is fine", /if \(!m \|\| !m\.stage\) return null;/.test(road), true);

/* ---------- lateness ---------- */

ck("the road labels dates through the shared helper",
   /milestoneDateLabel\(m, lang, t, resting\)/.test(road), true);
ck("...so resting and Scout-suggested dates are handled once, not again here",
   /canCallLate|due_src/.test(road), false);

/* ---------- one map, not two ---------- */

// PathwayMap is GONE, not switched off. It drew the stages as a second
// vertical route above this one, and the phase flag that chose between them
// was deleted with it once the redesign was committed to. There is one map.
ck("the stop or the road, and nothing else",
   /\{openStop \? \(/.test(APP), true);
ck("the map it replaced was deleted, not left unreachable",
   /function PathwayMap\(/.test(APP), false);
ck("...and the road took over its props",
   /function RoadMap\(\{ milestones, stages, currentStageId,/.test(APP), true);

/* ---------- the stop ---------- */

const stop = grab("function RoadStop({ step, index, total, stageName, sb, uid, lang, t, resting,");
ck("RoadStop exists", stop.length > 0, true);
// Two category fields exist and diverge: migration 155 seeds the jsonb copy on
// INSERT ONLY, so an athlete who re-categorised a step changed the row, not
// the jsonb. The row is the one they edited.
ck("the shortcut reads the category the athlete can edit",
   /const cat = fields && fields\.category \? fields\.category : null;/.test(stop), true);
ck("...not the jsonb copy", /step\.category/.test(stop), false);
ck("...and shows no shortcut when the category is unknown",
   /const shortcut = cat \? SHORTCUTS\[cat\] : null;/.test(stop), true);
ck("every shortcut lands on an allowlisted section",
   ["gz-highlights", "gz-schools", "gz-benchmarks"].every((s) => stop.indexOf(s) > 0), true);
ck("it discloses a Scout-chosen date rather than hiding it",
   /\{suggestedDate\(step\) \? \(/.test(stop), true);
ck("a done stop offers to un-tick", /t\("stop_not_done"\)/.test(stop), true);

/* ---------- translations ---------- */

for (const k of ["road_eyebrow", "road_title", "road_title_nogoal", "road_here", "road_goal",
  "road_pick_goal", "road_done", "road_next", "road_start", "road_calendar", "road_schools",
  "road_empty", "road_all_done", "stop_eyebrow", "stop_back", "stop_why", "stop_did_it",
  "stop_not_done", "stop_ask_scout", "stop_change_date", "stop_scout_date", "stop_add_clips",
  "stop_open_schools", "stop_log_test"]) {
  ck(`${k} is translated in all 4 languages`, (APP.match(new RegExp(`\\b${k}: "`, "g")) || []).length, 4);
}

ck("it is in the compiled bundle",
   fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8").includes("RoadMap"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
