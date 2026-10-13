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
                 status: "in_progress", blockers: ["visa"], evidence: [{ url: "x" }] };
const loaded = normalizeStage(stored);
ck("id is coerced, because the rest of the app indexes on it", loaded.id, "7");
ck("label is coerced", loaded.label, "Tusculum");
ck("a target date survives the load", loaded.target_date, "2027-05-01");
ck("...and a status", loaded.status, "in_progress");
ck("...and an array of blockers, by value", loaded.blockers, ["visa"]);
ck("...and nested evidence", loaded.evidence, [{ url: "x" }]);
ck("no key is dropped", Object.keys(loaded).sort(), Object.keys(stored).sort());

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
     /return \{ \.\.\.x, id: String\(x\.id\), label: String\(x\.label \|\| ""\) \};/.test(APP), true);
  ck("the load goes through it",
     /data\.stages\.map\(normalizeStage\)\.filter\(Boolean\)/.test(APP), true);
  ck("...and so does accepting a pathway from Scout",
     /pathway\.stages\.map\(normalizeStage\)\.filter\(Boolean\)/.test(APP), true);
  // The dead rename path is gone: a function that LOOKS like the rename path
  // but has no callers is how the next person fixes the wrong site.
  ck("no dead second rename path remains", /renameStage/.test(APP), false);
}

const JS = fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8");
ck("normalizeStage is in the compiled bundle", JS.includes("normalizeStage"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
