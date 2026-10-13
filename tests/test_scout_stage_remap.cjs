// REPLACING SECTIONS MUST NOT SILENTLY UNFILE THE ATHLETE'S STEPS.
//
// A step stores its section as a stage ID in milestone.stage. Accepting a
// Scout pathway rewrote pathway_plan.stages wholesale, so every step filed
// under a replaced section stopped matching any rendered section — the row
// still appeared, with no section on it and nothing on screen saying why —
// and current_stage_id was left pointing at an id nothing draws, which quietly
// sent resolveStageIndex back to guessing from recruiting_status.
//
// Sections are an ordered ladder, so a replacement RE-LABELS POSITIONS.
// This suite runs the real remapper rather than grepping it, because the
// interesting cases are the shorter ladder, the longer one, and the id that
// was never in the old list at all.

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

const at = APP.indexOf("function remapStagePositions(milestones, oldStages, newStages, currentStageId) {");
ck("remapStagePositions exists", at > 0, true);
const remap = vm.runInNewContext(
  APP.slice(at, APP.indexOf("\n}", at) + 2) + "\nremapStagePositions");

const OLD = [{ id: "a" }, { id: "b" }, { id: "c" }];
const steps = [
  { id: "m1", label: "one", stage: "a" },
  { id: "m2", label: "two", stage: "b" },
  { id: "m3", label: "three", stage: "c" },
  { id: "m4", label: "undated", stage: null },
];

// ---- same length: every step keeps its position --------------------------
{
  const NEW = [{ id: "x" }, { id: "y" }, { id: "z" }];
  const r = remap(steps, OLD, NEW, "b");
  ck("a step in section 2 is still in section 2", r.milestones[1].stage, "y");
  ck("...and section 1 and 3 likewise", [r.milestones[0].stage, r.milestones[2].stage], ["x", "z"]);
  ck("nothing is unfiled when the ladder is the same length", r.unfiled, 0);
  ck("three steps moved id", r.moved, 3);
  ck("the stated position follows the same map", r.currentStageId, "y");
  ck("...and is not reported as cleared", r.markerCleared, false);
  ck("a step with no section is untouched", r.milestones[3].stage, null);
  ck("labels are not disturbed", r.milestones.map((m) => m.label), ["one", "two", "three", "undated"]);
}

// ---- SHORTER ladder: the tail genuinely has nowhere to go ----------------
{
  const NEW = [{ id: "x" }, { id: "y" }];
  const r = remap(steps, OLD, NEW, "c");
  ck("steps 1 and 2 re-file", [r.milestones[0].stage, r.milestones[1].stage], ["x", "y"]);
  ck("the step with no counterpart is unfiled, not left dangling", r.milestones[2].stage, null);
  ck("...and counted, so the athlete can be told", r.unfiled, 1);
  ck("a marker past the end is cleared", r.currentStageId, null);
  ck("...and reported as cleared, so the card can say so", r.markerCleared, true);
}

// ---- LONGER ladder: extra sections are simply empty ----------------------
{
  const NEW = [{ id: "x" }, { id: "y" }, { id: "z" }, { id: "w" }];
  const r = remap(steps, OLD, NEW, "a");
  ck("a longer ladder loses nothing", r.unfiled, 0);
  ck("...and the extra section just has no steps yet",
     r.milestones.filter((m) => m.stage === "w").length, 0);
  ck("the marker still maps", r.currentStageId, "x");
}

// ---- an id that was never in the old ladder ------------------------------
// LEFT ALONE, NOT DESTROYED. oldStages is pathway_plan.stages, which is EMPTY
// for every athlete who never renamed a section — they render the sport's
// default ladder and their steps are filed against those default ids.
// Clearing on "not found" would unfile every step of every athlete who never
// customised: a far worse bug than the one being fixed here. This case was
// written the other way round first and this test is why it changed.
{
  const r = remap([{ id: "m", stage: "ghost" }], OLD, [{ id: "x" }], null);
  ck("an unplaceable section id is left untouched", r.milestones[0].stage, "ghost");
  ck("...and not counted as unfiled, because nothing was unfiled", r.unfiled, 0);
  ck("...and not counted as moved either", r.moved, 0);
}

// ---- degenerate inputs ---------------------------------------------------
{
  ck("no steps does not throw", remap([], OLD, [{ id: "x" }], null).milestones, []);
  ck("null steps does not throw", remap(null, OLD, [], null).milestones, []);
  ck("an empty new ladder unfiles everything that was filed",
     remap(steps, OLD, [], "a").unfiled, 3);
  // THE CASE THAT MATTERS MOST IN PRODUCTION: an athlete who never renamed a
  // section has stages = [], so no step can be placed. Every one of them must
  // come through untouched.
  ck("no old ladder means nothing is touched",
     remap(steps, [], [{ id: "x" }], null).milestones.map((m) => m.stage), ["a", "b", "c", null]);
  ck("...and nothing is reported as lost", remap(steps, [], [{ id: "x" }], null).unfiled, 0);
  // Ids are compared as strings: stages are stringified on save but an older
  // row can still hold a number.
  ck("a numeric stored id still matches",
     remap([{ id: "m", stage: 2 }], [{ id: "1" }, { id: "2" }], [{ id: "p" }, { id: "q" }], null).milestones[0].stage, "q");
}

// ---- it is wired in, and only where it belongs ---------------------------
{
  ck("the accept path re-files before writing",
     /const remap = stagesReplaced[\s\S]{0,200}?remapStagePositions\(merged, existingStages, nextStages,/.test(APP), true);
  // Scout proposing NO sections must not touch the marker at all: PostgREST
  // writes only the columns it is given, and currentPathway is a snapshot from
  // when Scout loaded. An athlete who set their stage on Plan afterwards would
  // otherwise have it overwritten by a write with no business touching it.
  ck("the marker is written only when sections actually change",
     /if \(stagesReplaced\) row\.current_stage_id = remap\.currentStageId;/.test(APP), true);
  ck("...and the row does not carry it unconditionally",
     /const row = \{[^}]*current_stage_id/.test(APP), false);
  ck("stagesReplaced is decided by the proposal, not by the merge",
     /const stagesReplaced = proposedStages\.length > 0;/.test(APP), true);
}

// ---- THE CARD STATES THE SAME NUMBERS THE WRITE WILL PRODUCE -------------
//
// The card used to promise, in words, that steps "simply become unfiled".
// Vague before, and wrong now that sections re-file by position. A disclosure
// computed by a DIFFERENT path than the write is a number that drifts.
{
  ck("the preview calls the same remapper",
     /const preview = previewStages\.length[\s\S]{0,160}?remapStagePositions\(previewMerged,/.test(APP), true);
  ck("...against the athlete's current sections and marker",
     /\(currentPathway && currentPathway\.stages\) \|\| \[\], previewStages,[\s\S]{0,120}?currentPathway\.current_stage_id/.test(APP), true);
  // The preview must merge the way the write merges, or the counts describe a
  // different set of steps than the one that gets stored.
  ck("the preview merges the way the write does",
     /const previewMerged = replacing[\s\S]{0,140}?mine\.map\(normalizeMilestone\)\.concat\(previewIncoming\)/.test(APP), true);

  for (const key of ["scout_stages_moved", "scout_stages_unfiled", "scout_stages_none_lost", "scout_stages_marker_cleared"]) {
    const hits = APP.match(new RegExp("\\b" + key + ': "[^"]+"', "g")) || [];
    ck(`  ${key} in four dictionaries`, hits.length, 4);
    ck(`  ...as four distinct strings`, new Set(hits).size, 4);
    ck(`  ...and rendered`, APP.includes('t("' + key + '")'), true);
  }
  // A count line with no count is the bug this replaced.
  for (const key of ["scout_stages_moved", "scout_stages_unfiled"]) {
    const hits = APP.match(new RegExp("\\b" + key + ': "([^"]+)"', "g")) || [];
    ck(`  ${key} interpolates {n} in every language`, hits.every((h) => h.includes("{n}")), true);
  }
  // Losing a section is a warning, not an achievement — amber, never gold.
  const unfiledAt = APP.indexOf('t("scout_stages_unfiled")');
  ck("an unfiled count is flagged amber", /C\.amber/.test(APP.slice(Math.max(0, unfiledAt - 200), unfiledAt)), true);
  ck("...and never gold", /C\.lime/.test(APP.slice(Math.max(0, unfiledAt - 200), unfiledAt)), false);
  // "No step loses its section" must be the ELSE of a real count, not a
  // standing reassurance like the string it replaced.
  ck("the all-safe line is the else of the unfiled count",
     /preview\.unfiled > 0 \?[\s\S]{0,420}?t\("scout_stages_none_lost"\)/.test(APP), true);
}

const JS = fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8");
ck("the remapper is in the compiled bundle", JS.includes("remapStagePositions"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
