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
  lift("function extractSuggestedPathway(data", "\n// "),
  "module.exports = { extractSuggestedPathway };",
].join("\n");

const mod = { exports: {} };
new Function("module", "exports", "crypto", src)(mod, mod.exports, require("crypto"));
const { extractSuggestedPathway } = mod.exports;

// The athlete's real sections, as the handler passes them in: id + label, in
// the order the prompt numbers them for the model.
const EXISTING = [{ id: "st-a", label: "Club season" }, { id: "st-b", label: "Trials" }];

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

// ---- no NEW sections: the index means the athlete's existing ones --------
// This is the ordinary case. The athlete already has a route and Scout is
// adding steps to it; before existingStages was passed in, every one of those
// steps landed unfiled, which is to say nowhere near the map it belonged to.
{
  const body = reply({ suggested_pathway: {
    pathway_type: "professional",
    milestones: [{ label: "Trial with two clubs", stage_index: 1 }, { label: "Finish the season fit", stage_index: 0 }],
  } });
  const p = extractSuggestedPathway(body, EXISTING);
  ck("a reply with no stages still yields a pathway", !!p, true);
  ck("...proposing no sections of its own", p.stages, []);
  ck("...files its steps under the athlete's existing sections",
     p.milestones.map((m) => m.stage), ["st-b", "st-a"]);
  // Same reply, no existing sections to point at: unfiled, not guessed.
  const q = extractSuggestedPathway(body, []);
  ck("...and files nothing when the athlete has no sections either",
     q.milestones.map((m) => m.stage), [null, null]);
  const r = extractSuggestedPathway(body, EXISTING.concat([{ label: "no id" }]));
  ck("...ignoring a section with no id rather than filing under undefined",
     r.milestones.every((m) => m.stage === null || m.stage.startsWith("st-")), true);
  const bad = extractSuggestedPathway(reply({ suggested_pathway: {
    pathway_type: "professional", milestones: [{ label: "x", stage_index: 5 }],
  } }), EXISTING);
  ck("...and an index past the athlete's own list stays unfiled", bad.milestones[0].stage, null);
}

// ---- proposed sections WIN over existing ones ---------------------------
// Accepting a reply that proposes sections replaces the athlete's list, so
// those are the sections that will exist when the steps land. Indexing the
// old list here would file every step under a section about to be deleted.
{
  const p = extractSuggestedPathway(pathway({ milestones: [{ label: "Film every league game", stage_index: 0 }] }), EXISTING);
  ck("a proposed section wins over the athlete's existing one", p.milestones[0].stage, p.stages[0].id);
  ck("...and that id is not one of the athlete's old ones",
     ["st-a", "st-b"].includes(p.milestones[0].stage), false);
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

// ---- dates arrive as an offset, and the server owns the arithmetic -------
// The model is never told today's date. It sends a whole number of days and
// extractSuggestedPathway resolves it, which is what makes a past date
// UNREPRESENTABLE rather than merely discouraged — an athlete must never be
// handed a plan that is already late the moment they accept it.
{
  const dayOf = (n) => { const d = new Date(); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0,10); };
  const one = (over) => extractSuggestedPathway(pathway({ milestones: [Object.assign({ label: "A step", stage_index: 0 }, over)] })).milestones[0];

  ck("an offset of 1 resolves to tomorrow", one({ due_in_days: 1 }).due, dayOf(1));
  ck("an offset of 30 resolves to thirty days out", one({ due_in_days: 30 }).due, dayOf(30));
  ck("the two-year ceiling is inclusive", one({ due_in_days: 730 }).due, dayOf(730));
  // Beyond two years a date stops being a plan and becomes a prediction about
  // a teenager's life.
  ck("past the ceiling the step is undated, not clamped", one({ due_in_days: 731 }).due, null);

  // The three shapes that would put a date in the past if the server trusted
  // the model's arithmetic instead of doing its own.
  ck("zero is not today, it is no date", one({ due_in_days: 0 }).due, null);
  ck("a negative offset cannot produce a past date", one({ due_in_days: -5 }).due, null);
  ck("an absolute date in the field is refused outright", one({ due_in_days: "2020-01-01" }).due, null);

  ck("a fractional offset is refused", one({ due_in_days: 3.5 }).due, null);
  ck("a numeric string is refused", one({ due_in_days: "7" }).due, null);
  ck("null means undated, which is the default", one({ due_in_days: null }).due, null);
  ck("an absent field means undated", one({}).due, null);

  // Provenance travels with the date from the moment it is minted. Without it
  // the client cannot tell an AI's guess from the athlete's own commitment on
  // the next page load, and a guess would be free to call them late.
  ck("a resolved date is marked as Scout's suggestion", one({ due_in_days: 7 }).due_src, "scout");
  ck("an undated step carries no provenance", one({ due_in_days: null }).due_src, null);
  ck("a refused offset carries no provenance either", one({ due_in_days: -5 }).due_src, null);

  // A date must never cost a step its filing, or its label, or its done-state.
  const full = one({ due_in_days: 14 });
  ck("dating a step leaves its label and done-state intact",
     [full.label, full.done], ["A step", false]);
  // Filing is resolved against stages this reply mints fresh each call, so the
  // two must be compared inside ONE extraction: what matters is that carrying
  // a date did not change WHICH section the step landed under.
  const pair = extractSuggestedPathway(pathway({ milestones: [
    { label: "Dated", stage_index: 1, due_in_days: 14 },
    { label: "Undated", stage_index: 1 },
  ] })).milestones;
  ck("...and files it under exactly the section it would have had anyway",
     pair[0].stage === pair[1].stage && typeof pair[0].stage === "string", true);
  ck("the undated twin really is undated", [pair[1].due, pair[1].due_src], [null, null]);
}

// ---- the prompt has to ask for the offset, and rule out the guesses ------
{
  const P = SRC.slice(SRC.indexOf('"due_in_days" puts a step'), SRC.indexOf("Only set fields that actually changed"));
  ck("the milestone shape declares the field", /"due_in_days": null/.test(SRC), true);
  ck("the prompt found its own rules block", P.length > 400, true);
  ck("it is stated as days from today, never a date", /WHOLE NUMBER OF\n?DAYS FROM TODAY/.test(P), true);
  ck("the model is told it does not know today's date", /You are not told today's date/.test(P), true);
  ck("the range is stated", /Range 1 to 730/.test(P), true);
  // The failure mode that matters most: a date on a step whose timing belongs
  // to somebody else is a deadline the athlete cannot meet by working harder.
  ck("steps gated on another person must not be dated", /NEVER date a step that needs someone else to act first/.test(P), true);
  ck("...and the examples name the real ones",
     /trial invitation[\s\S]*coach replying[\s\S]*offer[\s\S]*signing[\s\S]*call-up[\s\S]*selection/.test(P), true);
  ck("fixtures whose date the model does not know are excluded", /NEVER date a step tied to a real fixture/.test(P), true);
  ck("dates must be spread rather than piled", /SPREAD THEM/.test(P), true);
  ck("route order is preserved", /must never fall before one in an earlier section/.test(P), true);
  // Approval is not a licence to guess: most fifteen-year-olds will not audit
  // twelve dates on a confirm card.
  ck("the prompt says approval is not licence to guess", /not licence to\s+guess/.test(P), true);
}

console.log("\n" + pass + "/" + (pass + fail) + " passed");
process.exit(fail ? 1 : 0);
