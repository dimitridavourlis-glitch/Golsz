// Scout's suggested_pathway, RUN rather than read.
//
// The other four Scout suites assert on the source text of api/scout.js.
// That is the right tool for prompt wording and for "does this call site
// exist", and it is the wrong tool for a function whose whole job is to
// decide what to trust in a model's output. A regex can confirm that
// extractSuggestedPathway() mentions stage_index; only running it can
// confirm that an out-of-range index leaves the step unfiled instead of
// filing it under whatever section happened to be last.
//
// So this lifts the real functions out of the file and executes them. A
// retyped copy would pass happily while production differed — the same rule
// test_pathway_milestones states for its own lifted predicate.
const fs = require("fs");
const path = require("path");
const SRC = fs.readFileSync(path.join(__dirname, "..", "api", "scout.js"), "utf8");

let pass = 0, fail = 0;
function ck(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + "\n      got:  " + JSON.stringify(got) + "\n      want: " + JSON.stringify(want)); }
}

function lift(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  if (a < 0) throw new Error("could not find in api/scout.js: " + startMarker);
  const b = SRC.indexOf(endMarker, a);
  if (b < 0) throw new Error("could not find end marker after: " + startMarker);
  return SRC.slice(a, b);
}

const src = [
  lift("const PATHWAY_TYPE_SET = new Set([", "function "),
  lift("function parseReplyObject(clean) {", "\n// "),
  lift("function extractSuggestedPathway(data) {", "\n// "),
  "module.exports = { extractSuggestedPathway };",
].join("\n");

const mod = { exports: {} };
new Function("module", "exports", "crypto", src)(mod, mod.exports, require("crypto"));
const { extractSuggestedPathway } = mod.exports;

// A reply is the model's JSON inside a text block, the way the API returns it.
const reply = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const pathway = (over) => reply({ suggested_pathway: Object.assign({
  pathway_type: "ncaa",
  target_timeline: "18 months",
  stages: [{ label: "Club season" }, { label: "ID camps" }, { label: "Official visits" }],
  milestones: [{ label: "Film every league game", stage_index: 0 }],
}, over) });

// ---- the happy path ------------------------------------------------------
{
  const p = extractSuggestedPathway(pathway({
    milestones: [
      { label: "Film every league game", stage_index: 0 },
      { label: "Register for two ID camps", stage_index: 1 },
      { label: "Shortlist five programmes", stage_index: 2 },
      { label: "Keep GPA above 3.0", stage_index: null },
    ],
  }));
  ck("a proposed pathway survives extraction", !!p, true);
  ck("three sections come back", p.stages.length, 3);
  ck("every section gets a server-minted id", p.stages.every((s) => typeof s.id === "string" && s.id.length > 8), true);
  ck("a filed step carries its section's real id", p.milestones[1].stage, p.stages[1].id);
  ck("...and each index maps to its own section",
     p.milestones.slice(0, 3).map((m) => p.stages.findIndex((s) => s.id === m.stage)), [0, 1, 2]);
  ck("a null index stays unfiled", p.milestones[3].stage, null);
  ck("nothing arrives pre-ticked", p.milestones.every((m) => m.done === false), true);
}

// ---- the whole point: a bad index must not file the step anywhere --------
// Wrongly filed is worse than unfiled. A step under the wrong heading reads
// as a decision GOLSZ made about the athlete's route; an unfiled step reads
// as one they still have to file, which is the truth.
for (const [name, idx] of [
  ["past the end", 3], ["far past the end", 99], ["negative", -1],
  ["a string", "1"], ["a float", 1.5], ["a boolean", true], ["missing", undefined], ["null", null],
]) {
  const p = extractSuggestedPathway(pathway({ milestones: [{ label: "A step", stage_index: idx }] }));
  ck("stage_index " + name + " leaves the step unfiled", p.milestones[0].stage, null);
}

// ---- no sections in this reply means no filing at all --------------------
// The indices would point into a list the model never saw, so they cannot
// mean anything. This is the case that fires on every ordinary reply.
{
  const p = extractSuggestedPathway(reply({ suggested_pathway: {
    pathway_type: "professional",
    milestones: [{ label: "Trial with two clubs", stage_index: 0 }, { label: "Get an agent", stage_index: 1 }],
  } }));
  ck("a reply with no stages still yields a pathway", !!p, true);
  ck("...with no sections", p.stages, []);
  ck("...and every step unfiled", p.milestones.map((m) => m.stage), [null, null]);
}

// ---- the rules that predate filing still hold ---------------------------
{
  ck("an unknown pathway_type is refused outright",
     extractSuggestedPathway(reply({ suggested_pathway: { pathway_type: "premier_league", milestones: [{ label: "x" }] } })), null);
  ck("a pathway with no milestones is refused",
     extractSuggestedPathway(pathway({ milestones: [] })), null);
  ck("a model-supplied stage id is discarded, never trusted", (() => {
    const p = extractSuggestedPathway(pathway({ stages: [{ id: "attacker-chosen", label: "Club season" }] }));
    return p.stages[0].id === "attacker-chosen";
  })(), false);
  ck("more than seven sections are truncated, not rejected", (() => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: "S" + i }));
    const p = extractSuggestedPathway(pathway({ stages: many }));
    return p.stages.length;
  })(), 7);
  ck("...and a step filed past the truncation point comes back unfiled", (() => {
    const many = Array.from({ length: 12 }, (_, i) => ({ label: "S" + i }));
    const p = extractSuggestedPathway(pathway({ stages: many, milestones: [{ label: "late", stage_index: 9 }] }));
    return p.milestones[0].stage;
  })(), null);
  ck("more than ten steps are truncated", (() => {
    const many = Array.from({ length: 25 }, (_, i) => ({ label: "M" + i, stage_index: 0 }));
    return extractSuggestedPathway(pathway({ milestones: many })).milestones.length;
  })(), 10);
  ck("a blank label is dropped rather than filed", (() => {
    const p = extractSuggestedPathway(pathway({ milestones: [{ label: "   ", stage_index: 0 }, { label: "Real", stage_index: 0 }] }));
    return p.milestones.map((m) => m.label);
  })(), ["Real"]);
  ck("garbage in the text block returns null, never throws",
     extractSuggestedPathway({ content: [{ type: "text", text: "not json at all {{{" }] }), null);
  ck("an empty response returns null", extractSuggestedPathway({}), null);
}

// ---- the seed the Plan button sends must read as approval ----------------
// Otherwise the app-assembled fallback never fires for that athlete and the
// button silently does less than it says. Lifted from the real patterns.
{
  const approvalSrc = [
    lift("const PATHWAY_APPROVAL_PATTERNS = [", "\n// The app's own Pathway"),
    "module.exports = { athleteApprovedPathwayBuild };",
  ].join("\n");
  const m2 = { exports: {} };
  new Function("module", "exports", approvalSrc)(m2, m2.exports);
  const { athleteApprovedPathwayBuild } = m2.exports;
  const APP = fs.readFileSync(path.join(__dirname, "..", "golsz-app.html"), "utf8");
  const seeds = [...APP.matchAll(/pathway_scout_seed:\s*"([^"]+)"/g)].map((m) => m[1]);
  ck("the seed exists in all four dictionaries", seeds.length, 4);
  ck("every seed reads as approval to build",
     seeds.filter((s) => !athleteApprovedPathwayBuild(s)), []);
  // The blockers must still win: these are the sentences that look like
  // instructions and are not.
  ck("a question is still not approval", athleteApprovedPathwayBuild("should you build my pathway?"), false);
  ck("a refusal is still not approval", athleteApprovedPathwayBuild("don't build my pathway"), false);
  ck("a deferral is still not approval", athleteApprovedPathwayBuild("build my pathway later, not yet"), false);
}

console.log("\n" + pass + "/" + (pass + fail) + " passed");
process.exit(fail ? 1 : 0);
