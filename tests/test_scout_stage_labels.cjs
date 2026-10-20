// A STAGE ID IS A TRANSLATION KEY. IT MUST NEVER REACH THE PROMPT.
//
// golsz-app.html renders a sport-default stage as t("pathway_stage_" + id):
// the id IS the key, and a stored stage carries label:null until the athlete
// renames it (SPEC-custom-pathway-stages.md, migration 128). api/scout.js had
// no dictionary and fell back to the id itself, with the comment
// "sport-default ids are the key itself" — which is the bug, not the excuse.
//
// Two sentences in the Scout prompt printed keys:
//
//   "GOLSZ'S STANDARD ROUTE FOR SOCCER (what the Plan screen draws for this
//    athlete by default, in order): academy -> u19_u21 -> senior -> professional"
//
//   "They have said they are currently at: school_club"
//
// The first was every athlete with a mapped sport, on every request, and it
// claims to be what the athlete's own screen draws while naming the stages in
// words that screen never shows. The second needs a row with current_stage_id
// set and stages empty — the shipped client materialises the ladder in the
// same write, so it is the contract from migration 128 ("empty stages means
// use the sport's defaults") waiting for the next writer that honours it.
// Either way the model was handed an internal key as a human stage name, and
// in the second case as something the athlete had said about themselves.
//
// This suite runs the REAL resolver and the REAL prompt line, lifted out of
// api/scout.js, because the interesting cases are the ones no comment can
// assert: the default id, the id nothing can name, and "constructor".
//
// tests/test_sport_pathway_parity.cjs owns the LADDERS (same sports, same
// order, both sides). This file owns their NAMES.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const MOD = fs.readFileSync(path.join(REPO, "api/_sport-pathways.js"), "utf8");
const SCOUT = fs.readFileSync(path.join(REPO, "api/scout.js"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- lift the real code, never a copy of it -----------------------------
// Same approach as test_sport_pathway_parity.cjs: slice the declaration out of
// the source and execute it. A suite that re-declares these tables passes
// happily while production prints keys.
const slice = (src, decl, close, what) => {
  const i = src.indexOf(decl);
  if (i < 0) throw new Error("could not find " + what + ": " + decl);
  const j = src.indexOf(close, i);
  if (j < 0) throw new Error("could not find the end of " + what);
  return src.slice(i, j + close.length);
};

const LADDERS = new Function(
  slice(MOD, "export const SPORT_PATHWAY_STAGES = {", "\n};", "the ladder table")
    .replace("export const SPORT_PATHWAY_STAGES =", "return"))();
const LABELS = new Function(
  slice(MOD, "export const SPORT_PATHWAY_STAGE_LABELS = {", "\n};", "the label table")
    .replace("export const SPORT_PATHWAY_STAGE_LABELS =", "return"))();
const defaultStageLabel = new Function("SPORT_PATHWAY_STAGE_LABELS",
  slice(MOD, "export function defaultStageLabel(id) {", "\n}", "defaultStageLabel")
    .replace("export function", "function") + "\nreturn defaultStageLabel;")(LABELS);

// buildAuthoritativeContext's own two lines, run for real: a pathway_plan row
// in, the name that goes in the prompt out.
const STORED = slice(SCOUT, "  const storedStages = (pathwayRow && Array.isArray(pathwayRow.stages))", "\n    : [];", "storedStages");
const NAME_OF = slice(SCOUT, "  const stageNameOf = (id) => {", "\n  };", "stageNameOf");
const stageNameOf = new Function("pathwayRow", "defaultStageLabel",
  STORED + "\n" + NAME_OF + "\nreturn stageNameOf;");
const nameFor = (pathwayRow, id) => stageNameOf(pathwayRow, defaultStageLabel)(id);

ck("the lifted ladder table is the real one (this suite is reading something)",
   Object.keys(LADDERS).length > 20, true);

// ---- every stage GOLSZ can draw has a name ------------------------------
// The route sentence renders all-or-nothing (see below), so a new sport added
// without labels does not print keys — it silently loses its route sentence.
// That is the failure this block catches.
const everyId = [...new Set(Object.values(LADDERS).flatMap((cfg) => cfg.stages))];
ck("every stage id in every ladder has a label",
   everyId.filter((id) => !defaultStageLabel(id)), []);
ck("no label is just the id again (the whole point of the table)",
   everyId.filter((id) => defaultStageLabel(id) === id), []);
ck("no label is left blank", everyId.filter((id) => !String(defaultStageLabel(id)).trim()), []);
ck("the table carries nothing no ladder uses",
   Object.keys(LABELS).filter((id) => !everyId.includes(id)), []);

// ---- the server's labels are the CLIENT's labels -------------------------
// Hand-synced copy, same as the ladder table above it: no build step on the
// client, ESM functions on the server, no import between them. If these drift,
// Scout names a stage in words the Plan screen does not use — the "two
// pictures of one object" failure the stage work exists to prevent.
//
// THE ENGLISH DICTIONARY, BOUNDED. All four languages define every
// pathway_stage_* key, so matching them across the whole file would compare
// the server's labels against whichever language came last. I18N.en runs from
// the declaration to the "fr" dictionary that follows it, and the guard below
// fails loudly rather than silently comparing against French.
const en = (() => {
  const i = APP.indexOf("const I18N = {");
  if (i < 0) throw new Error("could not find the I18N declaration");
  const j = APP.indexOf("  fr: {", i);
  if (j < 0) throw new Error("could not find the end of I18N.en");
  const out = {};
  for (const m of APP.slice(i, j).matchAll(/pathway_stage_([a-z0-9_]+):\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
})();
ck("the client dictionary was read (not an empty match)", Object.keys(en).length > 20, true);
// Establishes that it is the ENGLISH one. Without this, a reordered I18N
// turns every comparison below into a diff against another language, which
// reads as drift in the table rather than a broken extraction.
ck("...and it is I18N.en, not another language",
   [en.academy, en.school_club], ["Academy", "School or club team"]);
ck("the server names exactly the stages the client names",
   Object.keys(LABELS).sort(), Object.keys(en).sort());
ck("...with the same words for each one",
   Object.keys(en).filter((id) => LABELS[id] !== en[id]), []);

// ---- an id nothing can name must produce NOTHING ------------------------
// Returning null is the point. A caller that cannot name a stage drops the
// sentence that would have named it: "currently at: school_club" is worse than
// saying nothing, and a deleted custom section leaves current_stage_id
// pointing at a uuid that belongs in no prompt at all.
ck("an unknown id resolves to null, not to itself",
   defaultStageLabel("7f3e9c1a-0b2d-4e5f-8a91-2c3d4e5f6a7b"), null);
ck("a non-string id is null", [defaultStageLabel(null), defaultStageLabel(undefined), defaultStageLabel(7)], [null, null, null]);
ck("an empty string is null", defaultStageLabel(""), null);
// OWN PROPERTIES ONLY. The id comes from user-writable JSON, and api/scout.js
// already shipped this exact bug with LANG_NAMES and lang:"constructor",
// which put a function's source text into the system prompt.
ck('"constructor" is null, not Object', defaultStageLabel("constructor"), null);
ck('"__proto__" / "toString" are null too',
   [defaultStageLabel("__proto__"), defaultStageLabel("toString")], [null, null]);

// ---- the real resolver, on real row shapes ------------------------------
// An athlete who never touched their sections: migration 128 stores stages as
// '[]' and the client reads that as "use the sport's". This is the row the
// reported prompt line came from.
const DEFAULTED = { stages: [], current_stage_id: "school_club" };
ck("a default marker resolves to the Plan screen's words",
   nameFor(DEFAULTED, "school_club"), "School or club team");
ck("...and not to the key", nameFor(DEFAULTED, "school_club") === "school_club", false);
ck("no default id survives as itself, for any sport",
   everyId.filter((id) => nameFor({ stages: [] }, id) === id), []);
ck("a missing stages column behaves the same as an empty one",
   nameFor({ current_stage_id: "u19_u21" }, "u19_u21"), "U19/U21");
ck("no marker at all is null", nameFor(DEFAULTED, null), null);

// THEIR words win. A renamed section is not translatable and is rendered
// verbatim — that is why stored labels are checked first.
const RENAMED = { stages: [{ id: "academy", label: "Panathinaikos U17" }, { id: "senior", label: "" }] };
ck("a renamed section uses the athlete's words",
   nameFor(RENAMED, "academy"), "Panathinaikos U17");
// normalizeStage() in the client turns a stored label:null into "" (its own
// comment says so), and String(x.label || "") does the same here. An empty
// label must fall back to GOLSZ's name for that stage, never to "" and never
// to the id.
ck("a stored stage with no label falls back to GOLSZ's name for it",
   nameFor(RENAMED, "senior"), "Senior");
// The uuid case: deleteStage() clears the marker it deletes, so an id left
// over here names a section that no longer exists.
ck("a custom id that is no longer in the ladder is null",
   nameFor(RENAMED, "11111111-2222-3333-4444-555555555555"), null);
ck('a stage id of "constructor" is null through the resolver too',
   nameFor(RENAMED, "constructor"), null);

// ---- the prompt sentence itself -----------------------------------------
// Run the real block. A grep would pass on code that computes names and then
// prints ids anyway.
const ROUTE = slice(SCOUT, "    if (athleteState.sport && SPORT_PATHWAY_STAGES[athleteState.sport]) {", "\n    }", "the standard-route block");
const routeLine = new Function("athleteBlock", "athleteState", "SPORT_PATHWAY_STAGES", "defaultStageLabel",
  ROUTE + "\nreturn athleteBlock;");
const routeFor = (sport) => routeLine("", { sport }, LADDERS, defaultStageLabel);

ck("the route sentence names the stages the Plan screen draws",
   routeFor("Soccer").includes("Academy -> U19/U21 -> Senior -> Professional"), true);
ck("...and no longer joins the raw ids",
   routeFor("Soccer").includes("academy -> u19_u21 -> senior -> professional"), false);
ck("an unmapped sport still gets no route sentence", routeFor("Chess"), "");

// Every sport, not just the two with SPORT_SCHEMAS: the sentence must RENDER
// (all-or-nothing on labels) and must contain no stage id.
//
// SEGMENT BY SEGMENT, not a substring search. "international" contains
// "national", so asking whether the sentence CONTAINS a stage id reports
// eighteen sports whose route reads "National level -> International
// competition" — correctly — as leaking the key. The route is a list, so it
// is checked as one.
const silent = [], leaking = [];
for (const sport of Object.keys(LADDERS)) {
  const line = routeFor(sport);
  if (!line) { silent.push(sport); continue; }
  const route = line.slice(line.indexOf("in order): ") + 11, line.indexOf(". This is GOLSZ's model"));
  const shown = route.split(" -> ");
  const want = LADDERS[sport].stages.map((id) => LABELS[id]);
  const asKeys = shown.filter((seg) => Object.prototype.hasOwnProperty.call(LABELS, seg));
  if (asKeys.length) leaking.push(`${sport}: printed the key ${asKeys.join(",")}`);
  if (JSON.stringify(shown) !== JSON.stringify(want)) leaking.push(`${sport}: ${route} is not ${want.join(" -> ")}`);
}
ck("every sport in the table gets its route sentence", silent, []);
ck("no sport's route sentence contains a stage id", leaking, []);

// ---- the guards the null depends on -------------------------------------
// Returning null only drops a clause if the caller checks. Both of these
// already existed; they are asserted here because the resolver now relies on
// them to omit a sentence rather than print a key.
ck("the current-stage clause is conditional on a resolved name",
   /if \(athleteState\.currentStageName\) \{/.test(SCOUT), true);
ck("a step's section is only printed when it resolved",
   /\$\{m\.stage \? ` \(section: \$\{m\.stage\}\)` : ""\}/.test(SCOUT), true);
ck("api/scout.js resolves names through the shared module",
   /import \{ SPORT_PATHWAY_STAGES, defaultStageLabel \} from "\.\/_sport-pathways\.js"/.test(SCOUT), true);
// There is deliberately no grep here for the old `: id` fallback or the
// comment that justified it. api/scout.js now DESCRIBES that bug at the fix,
// which is worth more than the assertion would be — and a grep for the
// sentence would fail on the explanation rather than on a regression. "no
// default id survives as itself, for any sport" above runs the real resolver
// over all 43 ids and is what actually holds the behaviour down.

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
