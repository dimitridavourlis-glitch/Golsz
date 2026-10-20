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
// Comment lines stripped: the component own prose names the props and the
// functions the counts below are counting, and a grep that counts prose passes
// on a comment while nothing in the code reads anything. Same idiom, and the
// same reason, as test_pathway_milestones.cjs.
const roadCode = road.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
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

/* ---------- the section the athlete says they are in ---------- */

// THE DEFECT THIS CLOSES. RoadMap destructured currentStageId and never
// mentioned it again: press "I'm here now" on Plan, the panel closes, and the
// Road looked identical - the only confirmation was reopening that same editor
// or going to Home. PathwayMap had been the reader and was deleted in 36c644c,
// which put back the exact defect resolveStageIndex's own comment records.
// The prop boundary was already right; what was missing was a reader. So this
// is asserted at the point of CONSUMPTION, inside the component's own slice.
ck("the road reads the id it is handed, not just accepts it",
   (roadCode.match(/currentStageId/g) || []).length > 1, true);
ck("...through the stated-only lookup",
   /const statedIdx = statedStageIndex\(stages, currentStageId\);/.test(roadCode), true);
// Not the resolver Home uses: it falls back to the recruiting_status guess and
// cannot tell a caller which answer it gave, so a marker built on it prints an
// inference inside a chip that reads as a quote.
ck("...and never through the one that falls back to a guess",
   /resolveStageIndex|currentStageIndex/.test(roadCode), false);

// THE CHIP ACTUALLY RENDERS THE VALUE. Counting statedChip() calls is not
// enough - a chip whose body ignored statedStage would satisfy the count and
// render a constant, which is this same defect one layer in.
const chip = grab("  const statedChip = () => {");
ck("the chip exists", chip.length > 0, true);
ck("...and says nothing when the athlete has not said anything",
   /if \(!statedStage\) return null;/.test(chip), true);
ck("...and names the section, not a constant",
   /\{stageLabel\(statedStage, t\)\}/.test(chip), true);
ck("...with its own label, once", (chip.match(/t\("pathway_section_now"\)/g) || []).length, 1);
// Disclosed rather than hidden: a marked section with no steps filed under it
// is asserted in the header and absent from the road below.
ck("...and says so when no steps are filed under it",
   /t\("pathway_section_now_empty"\)/.test(chip), true);
ck("...which is decided from the steps, not from the ladder",
   /rows\.some\(\(m\) => String\(m\.stage\) === String\(statedStage\.id\)\)/.test(roadCode), true);

// FAILURE MODES 2 AND 3, ANSWERED BY CONSTRUCTION RATHER THAN BY A RULE.
// Signposts are emitted inside ordered.forEach; `ordered` is three segments in
// DATE order and lastStage dedupes only consecutive runs, so one section can
// head three signposts while a section with no steps heads none. A marker
// there would print a number of times decided by date interleave, and the
// topmost could sit ABOVE the step pill pointing up the road. So the marker is
// read from the LADDER, which is always complete, and drawn outside the loop.
ck("the marker is read from the ladder, not from the drawn road",
   /const statedStage = statedIdx >= 0 \? \(stages \|\| \[\]\)\[statedIdx\] : null;/.test(roadCode), true);
ck("...and drawn once per return, outside ordered.forEach",
   (roadCode.match(/\{statedChip\(\)\}/g) || []).length, 2);
// The empty-road card is the extreme form of a section with no steps: an
// athlete whose only statement so far is which section they are in.
ck("...including in the empty-road card",
   /\{statedChip\(\)\}\n\s*<div[^>]*>\{t\("road_empty"\)\}<\/div>/.test(roadCode), true);
ck("...with no per-milestone section comparison anywhere",
   /m\.stage[^;]*currentStageId|currentStageId[^;]*m\.stage/.test(roadCode), false);
ck("the signpost loop is left exactly as it was",
   /if \(key !== lastStage\) \{\n      lastStage = key;/.test(roadCode), true);

// THE PRESS HAS TO CONFIRM ITSELF ON SCREEN. "I'm here now" sits in a panel
// rendered after the whole Road card, so pressing it closes a tall panel and
// can leave the chip scrolled past - rendered, invisible, and indistinguishable
// from the bug. One matched string, two readers: a second spelling is a silent
// no-op, which is why the id is a constant and not a literal.
ck("the chip carries the id the reveal looks up",
   /<button id=\{ROAD_STAGE_CHIP_ID\}/.test(roadCode), true);
// Signposts are emitted only while walking the milestones, so for a section
// with no steps filed under it the chip is the ONLY way into its editor.
ck("...and opens the same editor a signpost opens",
   /onClick=\{\(\) => onSignpost && onSignpost\(statedStage\.id\)\}/.test(roadCode), true);
ck("...and the button that sets the section calls the reveal",
   /setCurrentStage\(editingStage\); setEditingStage\(null\); revealStageChip\(\);/.test(APP), true);
ck("...which centres it one frame later, as the road does for YOU ARE HERE",
   /getElementById\(ROAD_STAGE_CHIP_ID\)/.test(APP), true);
// THREE: the declaration, the chip that carries it, and the getElementById
// that looks it up. A fourth is a third reader; a literal "gz-road-stage"
// anywhere instead is the silent no-op this constant exists to prevent.
ck("the id is declared once and read in exactly two places",
   (APP.match(/ROAD_STAGE_CHIP_ID/g) || []).length, 3);
ck("...and never written as a bare string",
   (APP.match(/"gz-road-stage"/g) || []).length, 1);

// THE RULE, RUN. Both -1 cases are live production states: every pre-128 row
// holds null, and test_scout_stage_remap pins that an unplaceable section id is
// deliberately LEFT on the row rather than cleared.
const statedSrc = grab("function statedStageIndex(stages, currentStageId) {");
ck("statedStageIndex exists", statedSrc.length > 0, true);
const statedIdxFn = new Function(statedSrc + " return statedStageIndex;")();
const LADDER = [{ id: "trials", label: "Trials" }, { id: "academy", label: "Academy" },
                { id: "firstteam", label: "First team" }];
ck("a stated section is found by id", statedIdxFn(LADDER, "academy"), 1);
ck("a numeric stored id matches a stringified section",
   statedIdxFn([{ id: "1" }, { id: "2" }], 2), 1);
ck("no statement at all is silence, not section one", statedIdxFn(LADDER, null), -1);
ck("a stale id naming no section on the ladder is silence too",
   statedIdxFn(LADDER, "ghost"), -1);
ck("an empty ladder is silence", statedIdxFn([], "trials"), -1);
ck("...and so is an absent one", statedIdxFn(null, "trials"), -1);

/* ---------- two markers, two sentences ---------- */

// FAILURE MODE 1. The step pill and the section chip state DIFFERENT facts -
// "this is your next stop" and "this is the section you say you are in" - and
// test_launch_p0 records what happens when two markers on one screen say the
// same words: the goal card and the rail both named a destination and no
// reader could say which one the steps pointed at.
//
// PRESENCE IS NOT ENOUGH, which is why the four-language count loop below
// cannot do this job. pathway_current_here passed that count for its whole
// life while rendering - under textTransform: uppercase - byte for byte
// identical to road_here in Spanish, and identical in Greek too.
//
// Folded, not uppercased: JS toUpperCase is not the browser's for Greek (it
// keeps the tonos the browser drops), so an equality test on case alone is a
// floor. NFD + strip combining marks + lowercase compares the letters.
const dictOf = (key) => [...APP.matchAll(new RegExp("\\b" + key + ': "([^"]*)"', "g"))].map((m) => m[1]);
const words = (s) => new Set(String(s).normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
const HERE = dictOf("road_here"), NEXT = dictOf("road_next"), NOW = dictOf("pathway_section_now");
ck("all three markers are translated four times",
   [HERE.length, NEXT.length, NOW.length], [4, 4, 4]);
ck("...as four distinct strings each",
   [new Set(HERE).size, new Set(NEXT).size, new Set(NOW).size], [4, 4, 4]);
// An empty intersection, per language, against BOTH the step pill and the
// footer's next-stop label - the two strings on this screen that could be
// mistaken for it. Greek folds to nothing under an a-z split, so it is
// compared on its own raw letters too.
const shares = (a, b) => a.map((x, i) => [...words(x)].filter((w) => words(b[i]).has(w)))
  .map((hit, i) => (hit.length ? i + ":" + hit.join("+") : null)).filter(Boolean);
ck("no language shares a word between the step pill and the section chip",
   shares(HERE, NOW), []);
ck("...nor between the next-stop label and the section chip",
   shares(NEXT, NOW), []);
const fold = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
ck("...and no language renders the two as the same string, case and accents folded",
   HERE.map((h, i) => fold(h) === fold(NOW[i])).filter(Boolean), []);
// The stage editor prints this same fact, and tapping a signpost opens that
// panel over the road - so it must print the same string, not a near-synonym.
ck("the stage editor names the section with the same key",
   /\{isCurrent && <span [^>]*>\{t\("pathway_section_now"\)\}<\/span>\}/.test(APP), true);
ck("...and the string that was identical to the step pill is rendered nowhere",
   APP.includes('t("pathway_current_here")'), false);
// Never deleted, only unread - the repo's rule. Asserted, not merely intended.
ck("...but its four translations are still defined",
   (APP.match(/\bpathway_current_here: "/g) || []).length, 4);

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
  "road_empty", "road_all_done", "pathway_section_now", "pathway_section_now_empty",
  "stop_eyebrow", "stop_back", "stop_why", "stop_did_it",
  "stop_not_done", "stop_ask_scout", "stop_change_date", "stop_scout_date", "stop_add_clips",
  "stop_open_schools", "stop_log_test"]) {
  ck(`${k} is translated in all 4 languages`, (APP.match(new RegExp(`\\b${k}: "`, "g")) || []).length, 4);
}

ck("it is in the compiled bundle",
   fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8").includes("RoadMap"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
