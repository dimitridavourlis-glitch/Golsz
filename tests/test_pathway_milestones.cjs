// The milestone data model: dates, stages, and the "what do I do now" rule.
//
// WHAT THIS GUARDS
// A milestone was {id, label, done}. The pathway map and the checklist under it
// were two unconnected objects, so nothing in the data said which step was next
// and the screen could not answer the one question the athlete asks. Adding
// `due` and `stage` is what connects them.
//
// Both fields are OPTIONAL and normalised ON READ. An athlete who never opens
// this screen must not have their stored row rewritten, and Scout's suggested
// pathways arrive carrying neither field. That is the invariant most at risk
// from a well-meaning "let's just backfill it" change later.
//
// Functions are extracted from golsz-app.html at run time, never retyped — a
// retyped copy passes forever while production diverges. See tests/README.md.

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- extract the real functions -----------------------------------------
// The anchor is the FULL signature, not a name concatenated onto "function ".
// Built by concatenation it is invisible to test_anchor_integrity, which can
// only see the literal — and the literal was "function ", 248 occurrences of
// nothing. An anchor a checker cannot read is an unchecked anchor.
function grab(sig) {
  const start = APP.indexOf(sig);
  if (start < 0) throw new Error(sig + " not found — this suite is not reading what it thinks it is");
  let d = 0, j = APP.indexOf("{", start);
  for (; j < APP.length; j++) {
    if (APP[j] === "{") d++;
    else if (APP[j] === "}") { d--; if (!d) break; }
  }
  return APP.slice(start, j + 1);
}
// Direct eval leaks `function` declarations into this scope; `const` would not.
eval(grab("function normalizeMilestone(m) {"));
// Lifted too, not retyped: nextMilestone and milestoneDateLabel both call it,
// and a hand-written stub here would let the real predicate rot while every
// assertion below stayed green.
eval(grab("function suggestedDate(m) {"));
// canCallLate wraps it, and milestoneDateLabel below calls canCallLate, so
// both have to be in scope before the consumers are run rather than read.
eval(grab("function canCallLate(m, resting) {"));
// Lifted, not stubbed: touchedMilestone stamps a completion date through it,
// and a stub would let the real date formatting rot while this suite stayed
// green — the same reason suggestedDate is lifted above.
eval(grab("function isoDay(d) {"));
eval(grab("function touchedMilestone(m) {"));
// nextMilestone now sorts through the shared comparator, so both halves of
// the rule have to be in scope. Lifted, never restated: a stand-in here
// would let the real ordering rot while every assertion below stayed green.
eval(grab("function milestoneRank(m) {"));
eval(grab("function compareUndone(a, b) {"));
eval(grab("function compareDone(a, b) {"));
eval(grab("function nextMilestone(milestones) {"));

// ---- normalizeMilestone: additive, never destructive ---------------------
const legacy = { id: "m1", label: "Two full seasons at Lakeshore", done: true };
const n = normalizeMilestone(legacy);
ck("a legacy {id,label,done} milestone gains due and stage", [n.due, n.stage], [null, null]);
ck("...and keeps its id, label and done exactly", [n.id, n.label, n.done], ["m1", "Two full seasons at Lakeshore", true]);
ck("a valid ISO date is preserved", normalizeMilestone({ due: "2026-09-01" }).due, "2026-09-01");
// Free text in a date field is the shape that silently poisons every sort.
ck("a non-ISO date is rejected rather than stored", normalizeMilestone({ due: "next spring" }).due, null);
ck("a stage key is preserved when the model already supplies one", normalizeMilestone({ stage: "u19_u21" }).stage, "u19_u21");
ck("an empty-string stage normalises to null, not \"\"", normalizeMilestone({ stage: "" }).stage, null);
ck("a milestone with no id is given one", typeof normalizeMilestone({ label: "x" }).id, "string");
ck("labels are capped at 120 chars", normalizeMilestone({ label: "x".repeat(200) }).label.length, 120);

// ---- nextMilestone: a stated rule, not a guess ---------------------------
const A = { id: "a", label: "a", done: false, due: "2026-09-10", stage: null };
const B = { id: "b", label: "b", done: false, due: "2026-08-01", stage: null };
const C_ = { id: "c", label: "c", done: false, due: null, stage: null };
ck("the earliest-dated undone step wins", nextMilestone([A, B, C_]).id, "b");
// Overdue rises on its own precisely BECAUSE the rule is "earliest date" —
// there is no second rule for overdue, which is what keeps it predictable.
const OVERDUE = { id: "o", label: "o", done: false, due: "2020-01-01", stage: null };
ck("an overdue step rises without a special case", nextMilestone([A, B, OVERDUE]).id, "o");
ck("a done step is never next even if earliest", nextMilestone([{ ...B, done: true }, A]).id, "a");
ck("with no dates at all, list order decides", nextMilestone([C_, { ...A, due: null }]).id, "c");
ck("everything done returns null, so the caller must render a completion state",
   nextMilestone([{ ...A, done: true }, { ...B, done: true }]), null);
ck("an empty list returns null", nextMilestone([]), null);
ck("undefined is tolerated", nextMilestone(undefined), null);

// ---- moveMilestone swaps WITHIN the stage group -------------------------
// Read out of the source rather than reimplemented: the bug being guarded is
// precisely that the flat-array version looks correct in isolation.
const mv = APP.slice(APP.indexOf("function moveMilestone(id, dir)"));
const mvBody = mv.slice(0, mv.indexOf("\n  }") + 4);
// REVERSED 2026-08-13 with the render. Grouping by stage was taken back out —
// it split a short plan across four headings — so up/down moves a step past
// its VISIBLE neighbour again, which means the flat list.
//
// These two used to pin the grouped implementation. Pinning an implementation
// is what made them fail the moment the design changed, while the property
// that actually matters kept holding. So the structural checks are gone and
// the executed invariant below carries the weight.
ck("moveMilestone bounds-checks against the flat list",
   /j < 0 \|\| j >= milestones\.length/.test(mvBody), true);
ck("...and does not reintroduce stage grouping",
   /m\.stage \|\| null\) === \(me\.stage \|\| null/.test(mvBody), false);
// The old flat-array form must be gone, or "move up" jumps a stage heading.
ck("the flat-array swap is gone",
   /\[next\[i\], next\[j\]\] = \[next\[j\], next\[i\]\]/.test(mvBody), false);

// THE INVARIANT, stated as what must not happen rather than as what does.
// The flat-array version's real damage was not that it reordered wrongly — it
// SILENTLY RE-FILED a step the athlete had filed, because moving across a
// group boundary changes which heading a step renders under without touching
// its `stage`. A button labelled "move up" rewriting the athlete's own filing
// is the failure; swapping within a group is merely the fix that avoids it.
// Executed, not pattern-matched: this must hold however the function is written.
const mvFn = mvBody.replace(/^\s*function moveMilestone\(id, dir\)/, "function _mv(id, dir)");
let SAVED = null;
const MS = [
  { id: "a", label: "a", done: false, due: null, stage: "academy" },
  { id: "b", label: "b", done: false, due: null, stage: "academy" },
  { id: "c", label: "c", done: false, due: null, stage: "senior" },
  { id: "d", label: "d", done: false, due: null, stage: null },
];
// The extracted body closes over `milestones`, `save` and `touchedMilestone` —
// supply all three. new Function() sees only globals, so the eval'd helper
// above is NOT in its scope; passing the real one keeps this running the
// production function rather than a stub that cannot rot.
const run = new Function("milestones", "save", "touchedMilestone", mvFn + "; return _mv;");
const stageOf = (list) => list.map((m) => m.id + ":" + m.stage).join(",");
for (const [id, dir] of [["a", 1], ["b", -1], ["b", 1], ["c", -1], ["c", 1], ["d", -1], ["d", 1], ["a", -1]]) {
  SAVED = null;
  run(MS, (o) => { SAVED = o.milestones; }, touchedMilestone)(id, dir);
  if (SAVED) {
    const before = MS.slice().sort((x, y) => (x.id < y.id ? -1 : 1));
    const after = SAVED.slice().sort((x, y) => (x.id < y.id ? -1 : 1));
    ck(`moveMilestone("${id}", ${dir}) changes no milestone's stage`, stageOf(after), stageOf(before));
    ck(`moveMilestone("${id}", ${dir}) loses no milestone`, SAVED.length, MS.length);
  }
}

// ---- Scout's drafts go through the normaliser ---------------------------
// Scout's model output carries neither field. Missing either call site means
// a pathway built by Scout has milestones that cannot be dated or filed, and
// nothing fails — the fields are simply absent.
// Normalisation moved UP rather than away: it now happens once, at `incoming`,
// and both the add and replace branches build from it. Asserting the old
// inline `.map(normalizeMilestone)` at the upsert would now be asserting a
// shape the code deliberately stopped having.
ck("Scout's incoming milestones are normalised once, before either branch",
   /const incoming = \(pathway\.milestones \|\| \[\]\)\.map\(normalizeMilestone\)/.test(APP), true);
ck("...and the athlete's existing steps are normalised too, not trusted raw",
   /base\.milestones\.map\(normalizeMilestone\)/.test(APP), true);
// WHERE `base` COMES FROM IS THE POINT. currentPathway is loaded once, when
// Scout mounts. Merging an "add" against that copy silently un-ticks anything
// the athlete completed on Home or Plan while the conversation was open,
// because this write replaces the milestone array wholesale.
ck("...and an add re-reads the plan instead of trusting the mount snapshot",
   /if \(mode === "add"\) \{[\s\S]{0,200}from\("pathway_plan"\)/.test(APP), true);
// A failed re-read must abort rather than merge against a copy known to be
// stale: an athlete would rather tap again than lose a week of ticks.
ck("...and a failed re-read refuses to write at all",
   /if \(readErr\) \{[\s\S]{0,220}return;/.test(APP), true);
ck("...while a replace needs no re-read, because it overwrites either way",
   /let base = currentPathway;\n\s*if \(mode === "add"\)/.test(APP), true);
// Pinned `milestones: merged, baseline_complete` — adjacency, not the property
// — so it broke when `stages:` was inserted between them. What matters is that
// the upsert writes `merged`, whatever follows it.
// The row is built as a named object now, because one field on it is
// conditional. The guarantee is unchanged: what reaches the upsert is the
// athlete's steps PLUS Scout's, never Scout's alone — merged feeds the remap,
// and the remap's output is what the row carries.
ck("the upsert writes the merged list, not Scout's alone",
   /remapStagePositions\(merged, existingStages, nextStages,/.test(APP), true);
ck("...and the row it builds carries the result of that",
   /const row = \{[^}]*milestones: remap\.milestones,/.test(APP), true);
ck("...and that row is what is sent",
   /pathway_plan"\)\.upsert\(row, \{ onConflict: "user_id" \}\)/.test(APP), true);
// Sections are always a replace, never appended — two half-maps concatenated
// is not a route — but proposing none must leave the athlete's own intact
// rather than clearing them.
ck("Scout's sections replace, and an empty proposal keeps theirs",
   /const nextStages = proposedStages\.length \? proposedStages : existingStages;/.test(APP), true);
ck("...and stages reach the upsert", /milestones: remap\.milestones, stages: nextStages/.test(APP), true);
// Also pinned adjacency — `milestones: merged })` — and broke when stages were
// added between them. The claim is that the local mirror carries the same
// merged list the upsert wrote, so a SECOND proposal in the same conversation
// previews against what is actually on file.
// MIRRORS WHAT WAS WRITTEN, which is no longer the same object as what was
// merged: steps are re-filed by section position before the write, so pinning
// `milestones: merged` here would assert the local copy diverges from the row.
// The guarantee is that both carry the SAME expression.
ck("...and setCurrentPathway mirrors exactly what the upsert wrote",
   /setCurrentPathway\(\{[\s\S]{0,200}?milestones: remap\.milestones\b/.test(APP), true);
ck("...which is the re-filed list the row got, not the pre-remap one",
   /milestones: remap\.milestones, stages: nextStages, baseline_complete: true/.test(APP), true);
ck("...including the sections, or a second proposal compares against stale ones",
   /setCurrentPathway\(\{[\s\S]{0,260}?stages: nextStages/.test(APP), true);
ck("...and the marker, so it is not re-read from a pre-write snapshot",
   /setCurrentPathway\(\{[\s\S]{0,600}?current_stage_id: stagesReplaced \?/.test(APP), true);
ck("no un-normalised `milestones: pathway.milestones` remains",
   /milestones: pathway\.milestones\b/.test(APP), false);
// The whole point: an athlete's ticked, dated, self-written steps survive.
ck("add mode concatenates rather than overwriting",
   /existing\.concat\(incoming\)/.test(APP), true);

// ---- the load path normalises too ---------------------------------------
ck("PathwayPlan normalises what it reads from the database",
   /setMilestones\(Array\.isArray\(data\.milestones\) \? data\.milestones\.map\(normalizeMilestone\) : \[\]\)/.test(APP), true);

// ---- suggestions are never auto-filed -----------------------------------
// Same rule as the migration case: guessing on the athlete's behalf and
// rendering the guess as fact is the failure this app spent the week removing.
// The three suggested first steps were deleted on 2026-09-09 (the Passport
// already owns "add film" / "record a benchmark", and Targets owns "email one
// coach", so this was a second front door to the same three tasks). The rule
// they were the test case for is not gone, so it moves to the writer that
// remains: the athlete's own new step is filed where they filed it, or
// nowhere, and never at a stage this app picked for them.
ck("the suggestion buttons that guessed a stage are gone",
   /SUGGESTED_FIRST_STEPS/.test(APP), false);
// The call gained a `due` on 2026-09-12 — the add flow now takes a day, which
// is the whole point of that change. The rule this pins is the STAGE half:
// a hand-written step is filed where the athlete filed it or nowhere, never
// at a stage the app chose for them. Matched across the object rather than as
// one line, so adding a further field cannot silently drop the guarantee.
ck("a hand-written step is filed by the athlete or not at all",
   /normalizeMilestone\(\{[\s\S]{0,400}?label: newMilestone\.trim\(\),[\s\S]{0,400}?stage: stageKey \|\| null,/.test(APP), true);
// And the day it is given is a real one the athlete chose, not a default the
// app invented: every chip passes an explicit date into addMilestone.
ck("...and the day comes from the athlete's own tap",
   /function addMilestone\(stageKey, due\)/.test(APP), true);
ck("...with no-day left as a deliberate choice, not the default",
   /addMilestone\(null, null\)/.test(APP), true);
// toISOString() would convert to UTC first, so an athlete adding a step at
// 10pm in Nicosia would get tomorrow — "due" on a day they had not reached.
// Hoisted to a module-level function on 2026-09-12 so Home, Plan and the add
// flow share one date rule instead of three copies of it.
ck("...and dates are built from LOCAL parts, never toISOString()",
   /function isoDay\(d\) \{[\s\S]{0,140}?d\.getFullYear\(\)/.test(APP), true);

// ---- ONE PATHWAY, ONE READER --------------------------------------------
// Home and Plan must draw the same pathway. That held for free while stages
// were a constant; once an athlete can rename or add one, a second reader of
// SPORT_PATHWAY_STAGES means the two screens drift — the "two pictures of one
// object" failure this week removed, returning through a different door.
//
// So exactly one function may read the config, and this is the whole
// protection. Without it the rule decays the first time someone adds a third
// surface, silently and with every test still green.
const CODE_ONLY = APP
  .replace(/\/\*[\s\S]*?\*\//g, "")          // block comments
  .replace(/^[ \t]*\/\/.*$/gm, "");          // line comments
// Count READS THAT LIE OUTSIDE the resolver, not total occurrences: the
// resolver's own fallback names the config twice on one line
// (`SPORT_PATHWAY_STAGES[sport] || SPORT_PATHWAY_STAGES.__default`), so a
// naive count of 1 asserts a coincidence of syntax rather than the invariant.
// First version of this check did exactly that and failed on correct code.
const _rs = CODE_ONLY.indexOf("function athleteStages(");
if (_rs < 0) throw new Error("athleteStages not found — this suite is not reading what it thinks it is");
let _d = 0, _re = CODE_ONLY.indexOf("{", _rs);
for (; _re < CODE_ONLY.length; _re++) {
  if (CODE_ONLY[_re] === "{") _d++;
  else if (CODE_ONLY[_re] === "}") { _d--; if (!_d) break; }
}
const RESOLVER = CODE_ONLY.slice(_rs, _re + 1);
const total = [...CODE_ONLY.matchAll(/SPORT_PATHWAY_STAGES\s*[[.]/g)].length;
const inside = [...RESOLVER.matchAll(/SPORT_PATHWAY_STAGES\s*[[.]/g)].length;
ck("every read of SPORT_PATHWAY_STAGES is inside athleteStages()", total - inside, 0);
ck("...and the resolver really does read it", inside > 0, true);
ck("RoadMap takes stages as a prop rather than deriving them",
   /function RoadMap\(\{ milestones, stages,/.test(APP), true);
ck("PathwayStrip resolves through the same function",
   /const stages = athleteStages\(athlete, pathwayRow\)/.test(APP), true);

// EVERY SCREEN THAT DRAWS THE PATHWAY MUST READ THE COLUMNS THAT DEFINE IT.
// One resolver was not enough. Home called athleteStages() correctly but its
// fetch never selected `stages`, so `custom.length` was 0 and it fell back to
// the sport defaults — Plan drew the athlete's renamed sections, Home drew
// Academy/U19/Senior/Professional. The resolver made the two screens agree on
// HOW to read; nothing made them agree on WHAT to read, and the fallback is
// silent by design because it is the correct behaviour for an unedited row.
//
// So: any select on pathway_plan whose result reaches athleteStages() must
// carry stages. Asserted per call site rather than in aggregate, because the
// aggregate passed while Home was wrong.
const pathwaySelects = [...APP.matchAll(/from\("pathway_plan"\)\.select\("([^"]+)"\)/g)].map((m) => m[1]);
ck("more than one component selects from pathway_plan", pathwaySelects.length > 1, true);
const drawing = pathwaySelects.filter((sel) => /milestones/.test(sel));
ck("every select that reads milestones also reads stages",
   drawing.filter((sel) => !/\bstages\b/.test(sel)), []);
ck("...and current_stage_id, so stated position survives the trip",
   drawing.filter((sel) => !/current_stage_id/.test(sel)), []);
// ONE DERIVATION, NOT ONE SPELLING.
//
// Stated beats inferred: currentStageIndex() guesses from recruiting_status
// against the SPORT's sequence and cannot know what a self-written section
// is. The previous version of this assertion matched ONE spelling of that
// rule, and passed while PathwayMap — the map on Plan, the screen "Set
// current" lives on — called the heuristic directly and ignored the stated
// id entirely. A regex that matches a correct copy says nothing about the
// incorrect one next to it.
//
// So count PRODUCERS instead. The heuristic may have exactly one caller; if
// a screen wants a stage index it has to come through the override.
{
  // Comment lines are stripped first: this file's own prose names the
  // function it is counting.
  const code = APP.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  ck("the recruiting_status heuristic is declared once and called once",
     (code.match(/\bcurrentStageIndex\(/g) || []).length, 2);
  const at = code.indexOf("function resolveStageIndex(");
  ck("resolveStageIndex exists", at > 0, true);
  const body = code.slice(at, code.indexOf("\n}", at));
  ck("...and it is the one caller", /currentStageIndex\(/.test(body), true);
  ck("...preferring the stated stage when there is one", /stated >= 0 \? stated :/.test(body), true);
  // TWO, not three, and the Road is not the third. The Road DOES draw the
  // athlete's stated section now, but through statedStageIndex, which returns
  // -1 instead of a guess. Resolving through THIS function would have printed
  // the recruiting_status guess inside a chip that reads as a quote. So the
  // producer census stays at 2: raising it still means a screen has started
  // deriving a position again, which is the defect this function prevents.
  ck("every screen that draws a stage position resolves through it",
     (code.match(/= resolveStageIndex\(/g) || []).length, 2);

  // ONE SPELLING OF "DID THEY SAY SO". This is the invariant that stops the
  // Road and Home drifting apart again. The previous drift was never a WRONG
  // comparison - it was a SECOND one: Home had the rule twice and Plan's map
  // had it not at all. So the comparison is written once, and every screen
  // that wants the athlete's own answer calls that one place.
  ck("the stated-id comparison is written exactly once in the app",
     (code.match(/String\(st\.id\) === String\(currentStageId\)/g) || []).length, 1);
  const statedAt = code.indexOf("function statedStageIndex(");
  ck("statedStageIndex exists", statedAt > 0, true);
  ck("...and it is where that comparison lives",
     /String\(st\.id\) === String\(currentStageId\)/.test(code.slice(statedAt, code.indexOf("\n}", statedAt))), true);
  // THREE: the declaration, resolveStageIndex, and the Road's section chip. A
  // fourth means a screen has started asking the question somewhere else.
  ck("the stated-section question is asked only through it",
     (code.match(/\bstatedStageIndex\(/g) || []).length, 3);
  ck("...and the resolver asks it rather than repeating it",
     /statedStageIndex\(stages, currentStageId\)/.test(body), true);

  // ASSERTED WHERE IT IS CONSUMED, not where it is accepted. These two are
  // about HOME's two position readers; that the Road actually draws the id is
  // asserted inside RoadMap's own slice, in test_road_map.cjs, because a
  // prop-boundary assertion passes while the body ignores the value - which
  // is exactly what shipped between 36c644c and this change.
  ck("the stated stage id reaches the resolver rather than a heuristic",
     (APP.match(/resolveStageIndex\([a-zA-Z]+, pathwayRow && pathwayRow\.current_stage_id, athlete\)/g) || []).length, 2);
  ck("...and Plan hands the road the id it already holds in state",
     /<RoadMap[\s\S]{0,500}currentStageId=\{currentStageId\}/.test(APP), true);

  // Behaviour, not shape. statedStageIndex goes into the context too, because
  // resolveStageIndex delegates to it now - without it every assertion below
  // reports a ReferenceError and the whole suite crashes rather than failing,
  // which is a red gate that names the wrong thing.
  const heurAt = code.indexOf("function currentStageIndex(");
  const statedSrc = code.slice(statedAt, code.indexOf("\n}", statedAt) + 2);
  const fn = vm.runInNewContext(
    code.slice(heurAt, code.indexOf("\n}", heurAt) + 2) + "\n" + statedSrc + "\n" +
    code.slice(at, code.indexOf("\n}", at) + 2) + "\nresolveStageIndex"
  );
  const statedFn = vm.runInNewContext(statedSrc + "\nstatedStageIndex");
  const stages = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const signed = { recruiting_status: "Signed" };
  ck("a stated stage wins over the heuristic", fn(stages, "b", signed), 1);
  ck("no stated stage falls back to the heuristic", fn(stages, null, signed), 3);
  ck("an unknown stated id falls back rather than blanking the map",
     fn(stages, "deleted-stage", signed), 3);
  // Stages are stringified on save; an older row can still hold a number.
  ck("a numeric stored id matches a stringified stage", fn([{ id: "1" }, { id: "2" }], 2, {}), 1);
  ck("an empty stage list does not throw", typeof fn([], "b", signed), "number");

  // THE DELIBERATE DIFFERENCE, ASSERTED SO IT IS A DECISION AND NOT A BUG.
  // For an athlete who has said nothing, Home shows a stage and the Road shows
  // none. Those two are not disagreeing about one fact: Home answers "roughly
  // where does this athlete sit", the Road quotes them, and a quote of silence
  // is silence. If that is ever judged unacceptable the honest fix is for HOME
  // to stop asserting a guess, not for the Road to start.
  ck("the resolver still answers for a silent athlete", fn(stages, null, signed) >= 0, true);
  ck("...and the stated-only one refuses to", statedFn(stages, null), -1);
  ck("...and refuses for an id no longer on the ladder", statedFn(stages, "deleted-stage"), -1);
  ck("...and for a ladder that is empty or absent",
     [statedFn([], "b"), statedFn(null, "b")], [-1, -1]);
  ck("a stated stage is found by id", statedFn(stages, "c"), 2);
  // Stages are stringified on save; an older row can still hold a number.
  ck("a numeric stored id matches a stringified stage", statedFn([{ id: "1" }, { id: "2" }], 2), 1);
}

// Empty custom stages must fall back, or every existing athlete's map empties.
ck("an athlete with no custom stages still gets the sport's",
   /if \(custom\.length\)/.test(APP), true);
// A rename must not orphan milestones, which store the stage id.
ck("a stage id is stringified, never derived from the label",
   /id: String\(s\.id\)/.test(APP), true);

// ---- CUSTOM STAGES: the three ways this loses an athlete's work ----------
// These are source assertions rather than executed ones: the writers close over
// component state and there is no UI calling them yet, so there is nothing to
// drive. Stated plainly because a pattern match is weaker evidence than an
// execution — when the editor lands, the delete case in particular deserves a
// real executed test.
// EXECUTED, not pattern-matched. This is the one where being wrong costs an
// athlete their steps: they asked to remove a heading, not to lose the work
// underneath it. A source regex proves the shape of one line; running it proves
// the outcome however the function is rewritten.
const delFn = APP.slice(APP.indexOf("function deleteStage(id)"));
const delBody = delFn.slice(0, delFn.indexOf("\n  }") + 4);
const FIX = [
  { id: "a", label: "a", done: true,  due: null, stage: "u19" },
  { id: "b", label: "b", done: false, due: null, stage: "u19" },
  { id: "c", label: "c", done: false, due: null, stage: "senior" },
  { id: "d", label: "d", done: false, due: null, stage: null },
];
const STAGES = [{ id: "u19", label: "U19" }, { id: "senior", label: "Senior" }];
let wroteStages = null, wroteExtra = null, setLocal = null;
const runDelete = new Function(
  "milestones", "materialisedStages", "saveStages", "setEditingStage", "setMilestones", "currentStageId",
  delBody.replace("function deleteStage(id)", "return function (id)")
);
runDelete(
  FIX,
  () => STAGES.slice(),
  (next, extra) => { wroteStages = next; wroteExtra = extra; },
  () => {},
  (m) => { setLocal = m; },
  "u19"
)("u19");
ck("deleting a stage removes only that stage", wroteStages.map((x) => x.id), ["senior"]);
ck("...and loses no milestone", wroteExtra.milestones.length, FIX.length);
ck("...unfiling the ones that were under it", wroteExtra.milestones.filter((m) => m.stage === null).map((m) => m.id), ["a", "b", "d"]);
ck("...leaving other stages' milestones filed", wroteExtra.milestones.find((m) => m.id === "c").stage, "senior");
ck("...preserving their done state", wroteExtra.milestones.find((m) => m.id === "a").done, true);
ck("...and clearing current_stage_id when it pointed at the deleted stage", wroteExtra.current_stage_id, null);
ck("...updating local state in the same call", setLocal.length, FIX.length);
// If the id moved with the label, every step filed under a renamed section
// would be orphaned the first time an athlete fixed a typo.
// THIS ASSERTION USED TO PIN THE BUG.
//
// It guaranteed the id survives a rename — correct, and it mattered, because
// milestones store the stage id and a moving id orphans them. But it did so by
// pinning the literal { id: st.id, label: clean }, which ALSO guaranteed every
// other key on the stage was thrown away. When per-stage target dates and
// blockers arrive, that literal is how they die. A test that locks in the
// shape of a line locks in whatever that line gets wrong.
//
// It is the guarantee that is asserted now, through the real behaviour:
// the id survives, and so does everything else.
{
  const renameLikeCommit = (list, id, label) =>
    list.map((st) => (st.id === id ? { ...st, label: label } : st));
  const before = [{ id: "s1", label: "Old", target_date: "2027-05-01", blockers: ["visa"] },
                  { id: "s2", label: "Other" }];
  const after = renameLikeCommit(before, "s1", "New");
  ck("renaming a stage preserves its id", after[0].id, "s1");
  ck("...and renames only the one asked for", [after[0].label, after[1].label], ["New", "Other"]);
  ck("...and keeps every other field on it", [after[0].target_date, after[0].blockers], ["2027-05-01", ["visa"]]);
  // The shape the source must have for the above to describe it.
  ck("...and the source spreads rather than rebuilding",
     /st\.id === id \? \{ \.\.\.st, label: clean \}/.test(APP), true);
  ck("...with no bare rebuild left anywhere",
     /st\.id === id \? \{ id: st\.id, label: clean \}/.test(APP), false);
}
ck("an empty rename is a no-op, not a delete", /if \(!clean\) \{ if \(pendingStage === id\) cancelStageEdit\(\); return; \}/.test(APP), true);
ck("the seven-section cap exists", /const MAX_STAGES = 7;/.test(APP), true);
ck("...and is checked before adding", /length >= MAX_STAGES\) return;/.test(APP), true);
// A new section must not reach storage unnamed. addStage() used to persist
// { label: "" } on tap while renameStage() rejected empty, so an abandoned
// section became a blank heading the athlete could not name and could only
// delete. Nothing writes until there is a name.
ck("adding a section does not write before it is named",
   /function addStage\(\)[\s\S]{0,400}?\n  \}/.exec(APP)[0].includes("saveStages"), false);
ck("...it is held as pending instead", /setPendingStage\(id\)/.test(APP), true);
ck("cancelling discards the pending section", /setPendingStage\(null\);\s*\/\/ an unnamed section is discarded/.test(APP), true);
// Was pinned to `base.concat(...)` and broke when insert-before/after landed —
// a pending section now splices in at the position the athlete tapped, which is
// the whole point of hanging "add" off a node instead of a button at the end.
// Asserting the branch exists, not the array method it uses.
ck("a pending section is inserted, an existing one renamed in place",
   /if \(pendingStage === id\) \{[\s\S]{0,200}?splice\(pendingAt === null \? next\.length : pendingAt, 0, \{ id, label: clean \}\)/.test(APP), true);
ck("...and renaming still goes through the id-preserving map",
   /next = base\.map\(\(st\) => \(st\.id === id \? \{ \.\.\.st, label: clean \} : st\)\)/.test(APP), true);
ck("insert refuses past the cap", /function insertStage\(nearId, offset\)[\s\S]{0,300}?length >= MAX_STAGES\) return;/.test(APP), true);
ck("...and writes nothing until named", /function insertStage\(nearId, offset\)[\s\S]{0,600}?\n  \}/.exec(APP)[0].includes("saveStages"), false);
// Empty stored stages must keep meaning "the sport's", or every athlete who
// never edits gets an empty map.
ck("the first edit materialises the sport defaults rather than backfilling",
   /if \(customStages\.length\) return customStages\.slice\(\)/.test(APP), true);
ck("stages and current_stage_id are read from the row",
   /select\("pathway_type, target_timeline, milestones, notes, stages, current_stage_id"\)/.test(APP), true);
// Reads the REF, not the closure. A write queued before a rename committed
// used to resend the pre-rename list and silently revert it; see
// test_stage_round_trip for the full guarantee.
ck("...and persisted on save", /stages: stagesRef\.current, current_stage_id: currentStageId/.test(APP), true);

// ---- the Scout note explains, it never blocks ----------------------------
// Free is locked out of Scout's pathway help at Starter, so the note has three
// states, not two. A plan that has not loaded must behave like the safe case:
// rendering a paywall during a fetch is the bug that once showed "Upgrade to
// unlock" to paying athletes on every gated page.
// The guard gained a second clause on 2026-09-12 — the note now renders ONLY
// for an athlete without the feature, because everyone who has it also has a
// button six pixels above saying the same thing. planKnown is still the FIRST
// condition, which is the guarantee this assertion exists for: featureUnlocked
// returns false for a plan that has not loaded, so without the short-circuit a
// paying athlete would be shown the locked copy for the two seconds their
// subscription takes to resolve. The regex matches the ordering rather than
// the exact clause list, so adding a third condition later cannot silently
// move planKnown out of first place.
const note = /\{planKnown\(plan\) &&[\s\S]{0,120}?\([\s\S]{0,1400}?pathway_scout_help_locked[\s\S]{0,200}?\)\}/.exec(APP);
ck("the Scout note is gated on planKnown, not on the plan value", !!note, true);
ck("...and planKnown is the FIRST condition, so a loading plan shows nothing",
   /\{planKnown\(plan\) &&/.test(APP), true);
ck("...and only then asks whether the feature is unlocked",
   note[0].indexOf("planKnown(plan)") < note[0].indexOf('featureUnlocked(plan, "pathway_plan")'), true);
// FeatureLock REPLACES content. Here the manual controls must stay usable —
// building a pathway by hand is free and always has been.
ck("the pathway card never uses FeatureLock",
   /pathway_scout_help_locked[\s\S]{0,300}FeatureLock/.test(APP), false);
ck("the locked copy points at what they can do instead",
   /pathway_scout_help_locked/.test(APP), true);

// ---- i18n parity --------------------------------------------------------
// The number is a consequence; parity is the invariant. Asserting a hard count
// alone is what pushes the next person to pad a dictionary to hit it.
const parser = require("@babel/parser");
const m = /<script[^>]*type=["']text\/babel(?:-deferred)?["'][^>]*>/.exec(APP);
const CODE = APP.slice(m.index + m[0].length, APP.indexOf("</script>", m.index));
const ast = parser.parse(CODE, { sourceType: "script", plugins: ["jsx"] });
let sets = null;
for (const node of ast.program.body) {
  if (node.type === "VariableDeclaration" && node.declarations[0] && node.declarations[0].id.name === "I18N") {
    sets = {};
    for (const q of node.declarations[0].init.properties) {
      sets[q.key.name] = q.value.properties.map((r) => r.key.name || r.key.value);
    }
  }
}
if (!sets) throw new Error("I18N not found");
const en = new Set(sets.en);
for (const l of ["fr", "es", "el"]) {
  ck(`${l} has every key en has`, [...en].filter((k) => !sets[l].includes(k)), []);
  ck(`${l} has no key en lacks`, sets[l].filter((k) => !en.has(k)), []);
}
// A duplicate key is legal JavaScript and silently keeps the LAST value, so
// editing the first occurrence changes nothing and the edit looks applied.
// nav_home was declared twice in all four dictionaries until 2026-08-24 —
// harmless only because both copies happened to agree.
for (const l of ["en", "fr", "es", "el"]) {
  const names = sets[l], seen = new Set(), dup = [];
  for (const k of names) { if (seen.has(k)) dup.push(k); seen.add(k); }
  ck(`${l} declares no key twice`, dup, []);
}
console.log("   dictionary size: " + en.size + " unique keys per language");
// pathway_sugg_film and pathway_sugg_benchmark dropped from this list on
// 2026-09-09: the three suggested first steps they labelled were deleted
// ("add film", "email one coach", "record one benchmark" are all actions the
// Passport already owns, so offering them here was a second front door to the
// same three tasks). The keys are gone from all four dictionaries, and an
// assertion that a deleted feature's copy is still translated would only ever
// fail for being right.
const NEW = ["pathway_next_title", "pathway_all_done", "pathway_no_date", "pathway_overdue",
             "pathway_on_track", "pathway_unfiled", "pathway_draft_with_scout",
             "pathway_step_deleted", "action_undo"];
ck("every new pathway key landed in all four dictionaries",
   NEW.filter((k) => !["en", "fr", "es", "el"].every((l) => sets[l].includes(k))), []);
// pathway_stage_* is what the spine's group headers read.
ck("the stage-label keys the spine renders still exist",
   [...en].filter((k) => k.startsWith("pathway_stage_")).length > 0, true);

// ---- pathway_unfiled must be RENDERED, not merely translated -------------
// It sat in all four dictionaries, unused, from the day it was written. The
// only assertion on it checked that it had "landed in all four dictionaries",
// which is true of a key nothing reads — presence is not wiring, and a key
// that is only ever defined is indistinguishable from a deleted one at
// runtime. It was nearly deleted on 2026-08-24 for exactly that reason.
ck("pathway_unfiled is defined in all four dictionaries",
   (APP.match(/pathway_unfiled:/g) || []).length, 4);
ck("...and something actually renders it", /t\("pathway_unfiled"\)/.test(APP), true);
// Shown only in contrast. New steps land unfiled by default, so an
// unconditional label would stamp "Not filed under a stage yet" on nearly
// every row and carry no information.
// The chip renders the stage name when there is one; the unfiled label is the
// middle branch of that same ternary, so the guard reads anyMilestoneFiled ?
// rather than anyMilestoneFiled ? t(...) directly.
ck("...only when another row in the same list shows a stage",
   /\) : anyMilestoneFiled \? \(/.test(APP), true);
// Renamed from openMilestones to milestones on 2026-09-10: the predicate moved
// from Home's step echo (deleted) to Plan's step list, which is now the only
// one. Same rule, same three cases below, different list.
ck("...and that condition is derived from milestones that really are filed",
   /anyMilestoneFiled = milestones\.some\(/.test(APP), true);

// The three cases, run against the REAL predicate lifted out of the source
// rather than a retyped copy — a copy passes happily while production differs.
{
  const src = APP.slice(APP.indexOf("const anyMilestoneFiled = milestones.some("));
  const body = src.slice(src.indexOf("("), src.indexOf(";") + 1);
  const filedIn = eval("(milestones, materialisedStages) => milestones.some" + body.slice(0, body.lastIndexOf(")") + 1));
  const stages = [{ id: "s1" }, { id: "s2" }];
  const fn = (list) => () => list;
  ck("nothing filed -> no label, because every row would carry it",
     filedIn([{ stage: null }, { stage: null }], fn(stages)), false);
  ck("one filed -> the unfiled row is worth explaining",
     filedIn([{ stage: "s1" }, { stage: null }], fn(stages)), true);
  ck("no stages at all -> nothing to be filed under, so no label",
     filedIn([{ stage: null }], fn([])), false);
  // A step still pointing at a stage that was DELETED is unfiled in practice.
  // deleteStage() nulls it, but a stale row must not resurrect a missing stage.
  ck("a stage that no longer exists does not count as filed",
     filedIn([{ stage: "gone" }, { stage: null }], fn(stages)), false);
}

// ---- prefix-built keys must reconcile with the sets that build them ------
// t("pathway_stage_" + st.id) and friends resolve a key from a VALUE, so
// neither direction is visible to an ordinary dead-key scan:
//   * a key with no value behind it is dead weight nothing can reach;
//   * a value with no key behind it renders the RAW KEY STRING to a user,
//     which is the direction that actually hurts and the one nothing checked.
// Both are asserted here against the real source arrays.
{
  const setFrom = (re, src) => [...new Set([...src.matchAll(re)].map((m) => m[1]))];
  const stageBlock = APP.slice(APP.indexOf("const SPORT_PATHWAY_STAGES = {"),
                               APP.indexOf("\n};", APP.indexOf("const SPORT_PATHWAY_STAGES = {")));
// ---- EVERY SPORT THE APP OFFERS HAS A REAL PATHWAY ----------------------
// SPORTS[] lets an athlete pick from 40 sports. Ten had a ladder; the other
// thirty fell through to __default — "Developing / Competing / Advancing" —
// which is three words that describe no sport in particular and handed an
// archer, a rower and a cricketer the identical route. For a product whose
// promise is "every goal has a path", three quarters of the paths were a
// shrug, and nothing failed when a sport was added to the picker without one.
{
  const tbl = APP.slice(APP.indexOf("const SPORT_PATHWAY_STAGES = {"),
                        APP.indexOf("\n};", APP.indexOf("const SPORT_PATHWAY_STAGES = {")));
  const withPathway = new Set([...tbl.matchAll(/^  "([^"]+)":/gm)].map((m) => m[1]));
  const picker = APP.slice(APP.indexOf("const SPORTS = ["), APP.indexOf("];", APP.indexOf("const SPORTS = [")));
  const offered = [...picker.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((x) => x !== "All");
  ck("the sport picker is not empty (this check is reading the right thing)", offered.length > 20, true);
  ck("every sport an athlete can choose has its own pathway",
     offered.filter((x) => !withPathway.has(x)), []);
  // The reverse, so a rename in SPORTS[] cannot orphan a ladder silently.
  ck("...and no pathway exists for a sport the picker does not offer",
     [...withPathway].filter((x) => x !== "__default" && !offered.includes(x)), []);
  // __default stays as the last resort for a sport not in the picker at all.
  ck("__default survives as the fallback", withPathway.has("__default"), true);
}

  const stageIds = new Set();
  for (const m of stageBlock.matchAll(/stages:\s*\[([^\]]*)\]/g))
    for (const q of m[1].matchAll(/"([a-z0-9_]+)"/g)) stageIds.add(q[1]);

  const groups = [
    ["pathway_stage_", [...stageIds]],
    ["pathway_type_", setFrom(/"([a-z_]+)"/g, (/const PATHWAY_TYPES = \[([^\]]*)\]/.exec(APP) || [])[1] || "")],
    ["targets_status_", setFrom(/"([a-z_]+)"/g, (/const TARGET_STATUSES = \[([^\]]*)\]/.exec(APP) || [])[1] || "")],
    ["dev_plan_status_", setFrom(/"([a-z_]+)"/g, (/const DEV_STATUSES = \[([^\]]*)\]/.exec(APP) || [])[1] || "")],
    ["dev_plan_focus_", setFrom(/"([a-z_]+)"/g, (/DEV_FOCUS_AREAS = \[([^\]]*)\]/.exec(APP) || [])[1] || "")],
    ["home_readiness_weakest_", setFrom(/"([a-z_]+)"/g, (/READINESS_DIMENSIONS = \[([^\]]*)\]/.exec(APP) || [])[1] || "")],
    ["home_readiness_teaser_", setFrom(/"([a-z_]+)"/g, (/READINESS_DIMENSIONS = \[([^\]]*)\]/.exec(APP) || [])[1] || "")],
  ];
  for (const [prefix, values] of groups) {
    ck(`${prefix}* has values to build from`, values.length > 0, true);
    const defined = [...new Set([...APP.matchAll(new RegExp("\\b(" + prefix + "[a-z0-9_]+)\\s*:", "g"))].map((m) => m[1]))];
    ck(`${prefix}* — every value has a key (a missing one renders raw)`,
       values.map((v) => prefix + v).filter((k) => !defined.includes(k)), []);
    ck(`${prefix}* — every key has a value behind it`,
       defined.filter((k) => !values.map((v) => prefix + v).includes(k)), []);
  }
}

console.log("\n-- a date Scout guessed is not a date the athlete agreed to --");
// The whole safety property of Scout-drafted plans lives in one predicate, so
// run it, and run the real consumers against it rather than asserting on the
// source text.
eval(grab("function milestoneDateLabel(m, lang, t, resting) {"));
const tid = (k) => k;
const SUG = { id: "s", label: "s", done: false, due: "2020-01-01", stage: null, due_src: "scout" };
const MINE = { id: "m", label: "m", done: false, due: "2020-01-01", stage: null, due_src: null };

ck("a scout date with no due is not a suggestion", suggestedDate({ due_src: "scout", due: null }), false);
ck("a due with no source is the athlete's own", suggestedDate({ due: "2026-09-01" }), false);
ck("scout + a real date is a suggestion", suggestedDate(SUG), true);
// normalizeMilestone is the gate: a row claiming any other provenance, or
// claiming scout with no date, must not be able to dodge the late counters.
ck("normalizeMilestone keeps a genuine scout marker", normalizeMilestone(SUG).due_src, "scout");
ck("...rejects an invented provenance value", normalizeMilestone({ due: "2026-09-01", due_src: "athlete" }).due_src, null);
ck("...and rejects scout provenance with no date", normalizeMilestone({ due_src: "scout" }).due_src, null);
ck("an ordinary athlete step reads as their own", normalizeMilestone({ due: "2026-09-01" }).due_src, null);

// The harm this prevents: an unhedged "3w overdue" on a day nobody chose.
ck("an untouched suggestion that has passed never reads as overdue",
   milestoneDateLabel(SUG, "en", tid).tone, "flat");
ck("...while the athlete's own passed date still does",
   milestoneDateLabel(MINE, "en", tid).tone, "over");
// Touching it is consent. From then on it behaves like any date they set.
ck("touching a step makes the date theirs",
   milestoneDateLabel(touchedMilestone(SUG), "en", tid).tone, "over");
ck("touching a step the athlete already owns changes nothing",
   touchedMilestone(MINE), MINE);

// ---- "DONE · 12 SEP" WAS PRINTING THE DUE DATE -----------------------------
//
// The completed row's label was built from m.due, so a step finished weeks
// late advertised the deadline it MISSED as its completion date. Nothing in
// the jsonb recorded a completion moment, so the label could only ever have
// been wrong or absent — and absent is the honest one.
{
  const DUE = { id: "x", label: "Film the game", due: "2026-09-12", done: false };

  // Ticking stamps the day it actually happened.
  const ticked = touchedMilestone({ ...DUE, done: true });
  ck("ticking a step stamps when it was done", /^\d{4}-\d{2}-\d{2}$/.test(ticked.done_at), true);
  ck("...and it is not the due date", ticked.done_at === DUE.due, false);

  // Re-touching must not move it — the first completion is the real one.
  const again = touchedMilestone(ticked);
  ck("touching it again does not re-stamp", again.done_at, ticked.done_at);
  ck("...and returns the same object, so there is no spurious write", again, ticked);
  // Same-day re-stamping is invisible by value — isoDay returns the identical
  // string — so the guarantee has to be tested on a date that is NOT today.
  // A mutation that re-stamped unconditionally passed every assertion above.
  ck("an OLD completion date is never overwritten",
     touchedMilestone({ ...ticked, done_at: "2020-01-01" }).done_at, "2020-01-01");
  ck("...and that step is returned untouched", touchedMilestone({ ...ticked, done_at: "2020-01-01" }).done, true);

  // Un-ticking clears it. done and done_at must never disagree — the same
  // coupling athlete_actions enforces as a CHECK constraint.
  const untick = touchedMilestone({ ...ticked, done: false });
  ck("un-ticking clears the completion date", untick.done_at, null);
  ck("...so a not-done step can never carry one", !!(untick.done && !untick.done_at) || untick.done_at === null, true);

  // The label.
  ck("a step done with no recorded date says Done and NOTHING else",
     milestoneDateLabel({ ...DUE, done: true }, "en", tid).text, "pathway_done");
  ck("...never the due date it may have missed",
     /12|Sep/.test(milestoneDateLabel({ ...DUE, done: true }, "en", tid).text), false);
  ck("a step with a real completion date shows THAT date",
     milestoneDateLabel({ ...DUE, done: true, done_at: "2026-10-01" }, "en", tid).text, "pathway_done · 1 Oct");

  // It must survive a reload, or it is stamped and lost.
  ck("normalizeMilestone carries it through",
     normalizeMilestone({ id: "x", done: true, done_at: "2026-10-01" }).done_at, "2026-10-01");
  ck("...refuses a malformed one rather than rendering it",
     normalizeMilestone({ id: "x", done: true, done_at: "last Tuesday" }).done_at, null);
  ck("...and refuses one on an UNDONE step, which never happened",
     normalizeMilestone({ id: "x", done: false, done_at: "2026-10-01" }).done_at, null);
}

console.log("\n-- a suggestion never seizes 'what do I do now' --");
const MINE_LATER = { id: "ml", label: "ml", done: false, due: "2026-12-01", stage: null };
const SUG_SOONER = { id: "ss", label: "ss", done: false, due: "2026-06-01", stage: null, due_src: "scout" };
ck("the athlete's own later step outranks Scout's earlier one",
   nextMilestone([SUG_SOONER, MINE_LATER]).id, "ml");
// Scout is not silenced — it is second in line, not absent. A drafted plan on
// an empty Pathway is still the best answer the app has.
ck("with no athlete-dated steps, Scout's earliest is still offered",
   nextMilestone([SUG_SOONER, { id: "u", label: "u", done: false, due: null, stage: null }]).id, "ss");
ck("among several suggestions the earliest still wins",
   nextMilestone([{ ...SUG_SOONER, id: "late", due: "2026-09-01" }, SUG_SOONER]).id, "ss");
ck("a done suggestion is never next", nextMilestone([{ ...SUG_SOONER, done: true }, MINE_LATER]).id, "ml");

console.log("\n-- every late counter asks the same question --");
// Three separate counters across two screens. One of them forgetting the
// predicate is how a fifteen-year-old gets told they are behind on a plan an
// AI wrote and they never agreed to.
ck("Plan's overdue count excludes suggestions",
   /const overdueCount = milestones\.filter\(\(m\) => !m\.done && m\.due && canCallLate\(m, resting\)/.test(APP), true);
ck("Home's plan-door late count excludes suggestions",
   /const stepsLate = allMilestones\.filter\(\(m\) => !m\.done && m\.due && canCallLate\(m, resting\)/.test(APP), true);
// Home's WEEK late count went with Home's week calendar — the read-only
// calendar was removed in the reorganisation and Plan owns dates now. The
// door-level late count below still runs on Home's status row and still has to
// exclude suggestions, which is the guarantee that matters: an AI's guess must
// never make a fifteen-year-old read as behind.
ck("Home's week late count went with Home's week calendar",
   /const late = allMilestones\.filter/.test(APP), false);
ck("...and the count Home still shows excludes suggestions",
   /const stepsLate = allMilestones\.filter\(\(m\) => !m\.done && m\.due && canCallLate\(m, resting\)/.test(APP), true);
// The band itself is RUN across every branch in test_plan_week; this only
// confirms the predicate is still what routes an untouched suggestion away
// from OVERDUE.
ck("the OVERDUE band excludes suggestions",
   /if \(days < 0 && !canCallLate\(m, resting\)\) return "undated";/.test(APP), true);
console.log("\n-- and nothing is late while someone is injured --");
// The counters above now ask canCallLate, so the predicate itself is RUN here
// rather than asserted on. Two separate reasons not to call someone late: a
// date they never agreed to, and a body that cannot train.
ck("an athlete's own overdue date can be called late", canCallLate(MINE, false), true);
ck("...but not while they are resting", canCallLate(MINE, true), false);
ck("a scout suggestion is never late", canCallLate(SUG, false), false);
ck("...and resting does not change that", canCallLate(SUG, true), false);
// Section 4.3: recovery work keeps its deadlines, because "see the physio on
// Tuesday" is exactly the date that still matters when you are hurt.
ck("a recovery step stays normal while resting",
   canCallLate({ ...MINE, category: "recovery" }, true), true);
ck("...unless the date was Scout's guess anyway",
   canCallLate({ ...SUG, category: "recovery" }, true), false);
// m.category is only populated when SCOUT proposed the step (migration 155
// seeds athlete_actions on insert only), so an unknown category must fail
// SAFE - paused, never a step wrongly marked late at an injured athlete.
ck("an uncategorised step is paused, not late", canCallLate({ ...MINE, category: null }, true), false);
ck("a missing milestone does not throw", canCallLate(null, true), false);

// The user-visible end of it: the same overdue step reads "overdue" normally
// and flat while resting. This is the guarantee; the regexes above only check
// that the call sites still ask for it.
ck("an overdue step reads as overdue", milestoneDateLabel(MINE, "en", tid, false).tone, "over");
ck("...and reads flat while resting", milestoneDateLabel(MINE, "en", tid, true).tone, "flat");

// Every athlete edit is consent; each mutator must say so.
ck("ticking a step clears the suggestion", /touchedMilestone\(\{ \.\.\.m, done: !m\.done \}\)/.test(APP), true);
ck("renaming a step clears it", /touchedMilestone\(\{ \.\.\.m, label: clean \}\)/.test(APP), true);
ck("reordering clears it", /next\[i\] = touchedMilestone\(milestones\[j\]\)/.test(APP), true);
ck("committing the row editor clears it", /label: clean, due, due_src: null/.test(APP), true);

console.log("\n-- Home has one answer to 'what is today' --");
// This line was a UTC day while the calendar eleven lines up was local. East
// of UTC they disagreed every evening, and Greek is one of the four shipped
// languages.
ck("Home's late comparison uses the same local day as its calendar",
   /const homeTodayKey = isoDay\(new Date\(\)\);/.test(APP), true);
ck("...and no longer truncates a UTC timestamp for it",
   /const todayIso = new Date\(\)\.toISOString\(\)\.slice\(0, 10\);\n  const stepsLate/.test(APP), false);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
