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
// The extracted body closes over `milestones` and `save` — supply both.
const run = new Function("milestones", "save", mvFn + "; return _mv;");
const stageOf = (list) => list.map((m) => m.id + ":" + m.stage).join(",");
for (const [id, dir] of [["a", 1], ["b", -1], ["b", 1], ["c", -1], ["c", 1], ["d", -1], ["d", 1], ["a", -1]]) {
  SAVED = null;
  run(MS, (o) => { SAVED = o.milestones; })(id, dir);
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
   /currentPathway\.milestones\.map\(normalizeMilestone\)/.test(APP), true);
ck("the upsert writes the merged list, not Scout's alone",
   /milestones: merged, baseline_complete/.test(APP), true);
ck("...and setCurrentPathway mirrors the same merged list",
   /setCurrentPathway\(\{[^)]*milestones: merged \}\)/.test(APP), true);
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
ck("first-step suggestions are added with stage: null",
   /normalizeMilestone\(\{ label: t\(s\.labelKey\), stage: null \}\)/.test(APP), true);

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
ck("PathwayMap takes stages as a prop rather than deriving them",
   /function PathwayMap\(\{[^}]*stages: stagesProp/.test(APP), true);
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
// Stated beats inferred: currentStageIndex() guesses from recruiting_status
// against the SPORT's sequence and cannot know what a self-written section is.
ck("a stated current stage overrides the heuristic",
   /statedIdx >= 0 \? statedIdx : currentStageIndex\(/.test(APP), true);
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
ck("renaming a stage preserves its id", /st\.id === id \? \{ id: st\.id, label: clean \}/.test(APP), true);
ck("an empty rename is a no-op, not a delete", /if \(!clean\) return;/.test(APP), true);
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
   /next = base\.map\(\(st\) => \(st\.id === id \? \{ id: st\.id, label: clean \} : st\)\)/.test(APP), true);
ck("insert refuses past the cap", /function insertStage\(nearId, offset\)[\s\S]{0,300}?length >= MAX_STAGES\) return;/.test(APP), true);
ck("...and writes nothing until named", /function insertStage\(nearId, offset\)[\s\S]{0,600}?\n  \}/.exec(APP)[0].includes("saveStages"), false);
// Empty stored stages must keep meaning "the sport's", or every athlete who
// never edits gets an empty map.
ck("the first edit materialises the sport defaults rather than backfilling",
   /if \(customStages\.length\) return customStages\.slice\(\)/.test(APP), true);
ck("stages and current_stage_id are read from the row",
   /select\("pathway_type, target_timeline, milestones, notes, stages, current_stage_id"\)/.test(APP), true);
ck("...and persisted on save", /stages: customStages, current_stage_id: currentStageId/.test(APP), true);

// ---- the Scout note explains, it never blocks ----------------------------
// Free is locked out of Scout's pathway help at Starter, so the note has three
// states, not two. A plan that has not loaded must behave like the safe case:
// rendering a paywall during a fetch is the bug that once showed "Upgrade to
// unlock" to paying athletes on every gated page.
const note = /\{planKnown\(plan\) && \([\s\S]{0,1400}?pathway_scout_help_locked[\s\S]{0,200}?\)\}/.exec(APP);
ck("the Scout note is gated on planKnown, not on the plan value", !!note, true);
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
const m = /<script[^>]*type=["']text\/babel["'][^>]*>/.exec(APP);
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
console.log("   dictionary size: " + en.size + " unique keys per language");
const NEW = ["pathway_next_title", "pathway_all_done", "pathway_no_date", "pathway_overdue",
             "pathway_on_track", "pathway_unfiled", "pathway_add_to_stage", "pathway_draft_with_scout",
             "pathway_step_deleted", "action_undo", "pathway_sugg_film", "pathway_sugg_benchmark"];
ck("every new pathway key landed in all four dictionaries",
   NEW.filter((k) => !["en", "fr", "es", "el"].every((l) => sets[l].includes(k))), []);
// pathway_stage_* is what the spine's group headers read.
ck("the stage-label keys the spine renders still exist",
   [...en].filter((k) => k.startsWith("pathway_stage_")).length > 0, true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
