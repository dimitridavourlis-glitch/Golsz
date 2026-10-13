// A STAGE MUST SURVIVE load -> edit -> save WITH FIELDS NOBODY HAS WRITTEN YET.
//
// The master brief wants every pathway section to carry a status, a target
// date, blockers and evidence. Before this suite, adding any of them would
// have produced a field that saved correctly, rendered correctly, survived a
// reload — and was then erased across EVERY section the moment the athlete
// fixed a typo in a section name. Four separate places rebuilt a stage from
// {id, label} alone, and save() read the stage list out of a stale closure.
//
// That is the worst shape a data-loss bug can take: silent, total, and
// indistinguishable from "it never saved in the first place". So the guarantee
// is pinned here BEFORE any of those fields exist, and the test carries an
// unknown key through the real functions rather than asserting a shape.

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

// ---- the normaliser carries unknown keys through -------------------------
const nsAt = APP.indexOf("function normalizeStage(x) {");
ck("normalizeStage exists", nsAt > 0, true);
const normalizeStage = vm.runInNewContext(
  APP.slice(nsAt, APP.indexOf("\n}", nsAt) + 2) + "\nnormalizeStage");

const stored = { id: 7, label: "Tusculum", target_date: "2027-05-01",
                 status: "in_progress", blockers: ["visa"], evidence: ["trial invite email"],
                 // A key NO version of normalizeStage knows about. This is the
                 // real round-trip guarantee: a row written by a newer client
                 // must not be stripped by an older one saving over it.
                 some_future_field: { nested: true } };
const loaded = normalizeStage(stored);
ck("id is coerced, because the rest of the app indexes on it", loaded.id, "7");
ck("label is coerced", loaded.label, "Tusculum");
ck("a target date survives the load", loaded.target_date, "2027-05-01");
ck("...and a status", loaded.status, "in_progress");
ck("...and an array of blockers, by value", loaded.blockers, ["visa"]);
ck("...and evidence, as the free text it is", loaded.evidence, ["trial invite email"]);
ck("A KEY IT HAS NEVER HEARD OF SURVIVES INTACT", loaded.some_future_field, { nested: true });
// Every stored key survives. The normaliser may ADD known fields with their
// empty defaults — that is how a stage written before a field existed gets one
// — so this is containment, not equality.
ck("no key is dropped",
   Object.keys(stored).filter((k) => !(k in loaded)), []);

// The known fields are VALIDATED, not merely carried. An allowlist means a
// value from anywhere unexpected reads as UNKNOWN rather than rendering a
// status the UI has no label for.
ck("an unrecognised status reads as UNKNOWN", normalizeStage({ id: "a", status: "nearly" }).status, null);
ck("...as does a status that is not a string", normalizeStage({ id: "a", status: 3 }).status, null);
ck("each real status is kept",
   ["not_started", "in_progress", "completed"].map((v) => normalizeStage({ id: "a", status: v }).status),
   ["not_started", "in_progress", "completed"]);
ck("a malformed date is refused rather than rendered", normalizeStage({ id: "a", target_date: "May 2027" }).target_date, null);
ck("...and a real one kept", normalizeStage({ id: "a", target_date: "2027-05-01" }).target_date, "2027-05-01");
ck("blank blockers are dropped", normalizeStage({ id: "a", blockers: ["", "  ", "visa"] }).blockers, ["visa"]);
ck("non-strings are dropped rather than rendered as [object Object]",
   normalizeStage({ id: "a", blockers: [{ x: 1 }, "visa"] }).blockers, ["visa"]);
ck("the list is capped, so a runaway cannot bloat the row",
   normalizeStage({ id: "a", evidence: ["1","2","3","4","5","6","7"] }).evidence.length, 5);
ck("requirements are the athlete's own words, trimmed",
   normalizeStage({ id: "a", requirements: "  GPA above what the coach asked  " }).requirements,
   "GPA above what the coach asked");
ck("...and never a number GOLSZ does not hold", normalizeStage({ id: "a" }).requirements, "");

ck("a stage with no id is refused", normalizeStage({ label: "orphan" }), null);
ck("null is refused", normalizeStage(null), null);
ck("a missing label becomes empty, not undefined", normalizeStage({ id: "a" }).label, "");

// ---- the full round trip, through the real rename ------------------------
// commitStage is the path the section editor uses. Rebuilding the renamed
// stage instead of spreading it is the defect this whole suite is about.
const csAt = APP.indexOf("function commitStage(id, label) {");
ck("commitStage exists", csAt > 0, true);
const commitBody = APP.slice(csAt, APP.indexOf("\n  }", csAt));
ck("...and it spreads the stage it renames", /\{ \.\.\.st, label: clean \}/.test(commitBody), true);
ck("...rather than rebuilding it from two keys",
   /\{ id: st\.id, label: clean \}/.test(commitBody), false);

// Simulate it: load a stored stage, rename it, and check the fields are still
// there. This is the exact sequence that used to lose them.
const renameLikeCommit = (list, id, label) =>
  list.map((st) => (st.id === id ? { ...st, label: String(label).trim().slice(0, 40) } : st));
const afterRename = renameLikeCommit([normalizeStage(stored)], "7", "Tusculum University");
ck("ROUND TRIP: load -> rename -> the target date is still there",
   afterRename[0].target_date, "2027-05-01");
ck("...and the blockers", afterRename[0].blockers, ["visa"]);
ck("...and the rename actually happened", afterRename[0].label, "Tusculum University");
ck("...and the id did not move", afterRename[0].id, "7");

// ---- the save reads a ref, not a stale closure ---------------------------
// Chained writes cannot read state from the closure: React has not re-rendered
// yet, so a write queued before a rename committed resends the PRE-rename list
// and silently reverts it. milestonesRef exists for exactly this; stages had
// the same bug and no ref.
{
  const code = APP.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  ck("a stagesRef is declared", /const stagesRef = useRef\(customStages\);/.test(code), true);
  ck("...and tracks state every render", /stagesRef\.current = customStages;/.test(code), true);
  ck("the save payload reads the ref", /stages: stagesRef\.current,/.test(code), true);
  ck("...and NOT the closure variable", /stages: customStages,/.test(code), false);
  ck("an overridden stage list moves the ref too",
     /if \(overrides && overrides\.stages\) stagesRef\.current = overrides\.stages;/.test(code), true);
  ck("a failed save puts the stages back",
     /stagesRef\.current = beforeStages;/.test(code), true);

  // Both refs are plain unconditional useRef calls at the top of the
  // component. A hook below a state-gated early return took production down
  // once; test_hook_order guards that generally, this pins the pairing.
  const mAt = code.indexOf("const milestonesRef = useRef(milestones);");
  const sAt = code.indexOf("const stagesRef = useRef(customStages);");
  ck("the two refs sit together", mAt > 0 && sAt > mAt && sAt - mAt < 400, true);
}

// ---- there is ONE definition of what a stage is on the way in ------------
// Four sites rebuilt a stage from {id, label}. Any that remain are sites a
// future per-stage field would die at.
{
  // A BARE rebuild is one with no spread in front of it. normalizeStage's own
  // line has `...x,` first, so it must not be counted here — the first version
  // of this assertion counted it and expected 1, which would have passed with
  // a second bare rebuild still in the file.
  const bare = (APP.match(/\{ id: String\(x\.id\), label: String\(x\.label \|\| ""\) \}/g) || []).length;
  ck("no site rebuilds a stage from id and label alone", bare, 0);
  ck("...and normalizeStage itself spreads before coercing",
     /return \{\s*\.\.\.x,\s*id: String\(x\.id\),/.test(APP), true);
  ck("the load goes through it",
     /data\.stages\.map\(normalizeStage\)\.filter\(Boolean\)/.test(APP), true);
  ck("...and so does accepting a pathway from Scout",
     /pathway\.stages\.map\(normalizeStage\)\.filter\(Boolean\)/.test(APP), true);
  // The dead rename path is gone: a function that LOOKS like the rename path
  // but has no callers is how the next person fixes the wrong site.
  ck("no dead second rename path remains", /renameStage/.test(APP), false);
}

// ---- THE FIELDS ARE EDITABLE, AND THROUGH ONE WRITER ---------------------
{
  ck("there is a single per-field writer", /function setStageField\(id, patch\) \{/.test(APP), true);
  ck("...and it goes through saveStages, so it inherits the ref and the rollback",
     /function setStageField\(id, patch\) \{\s*saveStages\(/.test(APP), true);
  ck("...normalising on the way in, so a field cannot be stored unvalidated",
     /setStageField\(id, patch\)[\s\S]{0,200}?normalizeStage\(\{ \.\.\.st, \.\.\.patch \}\)/.test(APP), true);

  const panelAt = APP.indexOf("function stagePanel() {");
  const panel = APP.slice(panelAt, APP.indexOf("\n  function ", panelAt + 40));
  for (const k of ["pathway_field_status", "pathway_field_date", "pathway_field_reqs",
                   "pathway_field_blockers", "pathway_field_evidence", "pathway_field_note"]) {
    ck(`  the panel renders ${k}`, panel.includes('t("' + k + '")'), true);
  }
  // Text commits on blur, never per keystroke: each save is a write to a jsonb
  // column on a shared row.
  ck("free text commits on blur, not on every keystroke",
     (panel.match(/onBlur=\{\(e\) =>/g) || []).length >= 3, true);
  ck("...and the fields are uncontrolled, keyed per section so they remount",
     (panel.match(/key=\{st\.id \+ "/g) || []).length >= 3, true);
  ck("a status click toggles off rather than trapping the athlete in one",
     /status: st\.status === v \? null : v/.test(panel), true);
  ck("the panel says GOLSZ checks none of it", panel.includes('t("pathway_field_note")'), true);

  // pathway_stage_<id> is COMPUTED — stageLabel does t("pathway_stage_" + id).
  // Field labels must never live in that namespace or they read as stage ids;
  // test_pathway_milestones enforces it and caught these on first write.
  ck("no field label squats on the computed stage-id namespace",
     /pathway_stage_(status|date|reqs|blockers|evidence|lines_ph|note)\b/.test(APP), false);

  for (const k of ["pathway_field_status", "pathway_field_date", "pathway_field_reqs",
                   "pathway_field_reqs_ph", "pathway_field_blockers", "pathway_field_evidence",
                   "pathway_field_lines_ph", "pathway_field_note", "pathway_status_not_started",
                   "pathway_status_in_progress", "pathway_status_completed", "pathway_status_unknown"]) {
    const hits = APP.match(new RegExp("\\b" + k + ': "[^"]+"', "g")) || [];
    ck(`  ${k} in four dictionaries, four distinct strings`,
       [hits.length, new Set(hits).size], [4, 4]);
  }
}

const JS = fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8");
ck("normalizeStage is in the compiled bundle", JS.includes("normalizeStage"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
