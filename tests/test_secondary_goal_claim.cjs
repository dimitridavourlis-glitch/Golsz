// GOLSZ may not tell an athlete what their goal is.
//
// THE FAILURE THIS GUARDS
// Plan showed a card reading "SECONDARY GOAL: NCAA", and Home hung an
// unlabelled NCAA node off a dashed line. Neither came from the athlete. Both
// were derived from SPORT_PATHWAY_STAGES.altBranch:
//
//   hasSecondaryGoal = sportConfig.altBranch && pathwayType !== altBranch
//
// i.e. EVERY Soccer athlete whose pathway was not NCAA was told NCAA was
// their secondary goal, whether or not college had ever been mentioned. The
// athlete under test had a stated goal of "MLS contract" and had never asked
// about NCAA.
//
// This is the Tusculum failure one layer up: presenting an unverified
// inference as the athlete's own fact. There it was a university's division;
// here it is what they want out of their career, which is worse.
//
// scout_context already stores the honest version — {value, source,
// confidence} per field, where source is "athlete_stated" or "ai_inferred".
// statedContextValue() is the reader, and it exists so a GUESS can never be
// rendered back as a statement.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const src = APP.match(/function statedContextValue\(scoutContext, field\) \{[\s\S]*?\n\}/);
if (!src) throw new Error("statedContextValue not found — markers moved, update this suite");
eval(src[0]);

const field = "secondary_goal";
const ctx = (entry) => ({ [field]: entry });

// ---- the whole point: an inference is not a statement -------------------
ck("an ai_inferred value is never returned",
   statedContextValue(ctx({ value: "NCAA scholarship", source: "ai_inferred", confidence: 0.9 }), field), null);
ck("...not even at confidence 1",
   statedContextValue(ctx({ value: "NCAA scholarship", source: "ai_inferred", confidence: 1 }), field), null);
ck("an athlete_stated value IS returned",
   statedContextValue(ctx({ value: "NCAA scholarship", source: "athlete_stated", confidence: 0.8 }), field), "NCAA scholarship");
ck("...in their own words, untranslated to a category",
   statedContextValue(ctx({ value: "play college soccer in the States", source: "athlete_stated" }), field), "play college soccer in the States");

// ---- absence is absence, not a default ----------------------------------
ck("no scout_context at all", statedContextValue(null, field), null);
ck("no such field", statedContextValue({ other: { value: "x", source: "athlete_stated" } }, field), null);
ck("field present but empty", statedContextValue(ctx({ value: "", source: "athlete_stated" }), field), null);
ck("field present but whitespace", statedContextValue(ctx({ value: "   ", source: "athlete_stated" }), field), null);
ck("field present but null value", statedContextValue(ctx({ value: null, source: "athlete_stated" }), field), null);
ck("field present but non-string", statedContextValue(ctx({ value: 42, source: "athlete_stated" }), field), null);
ck("value is trimmed", statedContextValue(ctx({ value: "  NCAA  ", source: "athlete_stated" }), field), "NCAA");

// A legacy row written before sourcing existed has no source. Treating it as
// stated is deliberate — it predates the concept, and the alternative is
// silently dropping real athlete answers.
ck("a legacy bare string is honoured", statedContextValue(ctx("NCAA scholarship"), field), "NCAA scholarship");
ck("a legacy entry with no source is honoured",
   statedContextValue(ctx({ value: "NCAA scholarship" }), field), "NCAA scholarship");

// ---- the derivation is gone from both surfaces --------------------------
ck("Plan no longer derives a secondary goal from sport config",
   /hasSecondaryGoal = sportConfig\.altBranch && pathwayState\.pathwayType !== sportConfig\.altBranch/.test(APP), false);
// The logic moved into BackupPlanCard, which owns all three states. The
// guarantee did not move: the value shown is still only ever an
// athlete_stated one, and it is still their words rather than a category.
ck("Plan's secondary goal comes from what they said",
   /const stated = statedContextValue\(ctx, "secondary_goal"\);/.test(APP), true);
ck("...and Plan renders the card rather than deriving it inline",
   /<BackupPlanCard athlete=\{pathwayState\.athlete\}/.test(APP), true);
ck("...and the card renders their words, not the category label",
   /lineHeight: 1\.35 \}\}>\{stated\}<\/div>/.test(APP), true);
// An inference may only ever be a question. If it can reach a value render,
// the whole card is back to asserting something the athlete never said.
ck("an inference is offered as a question, never as a value",
   /rawEntry\.source === "ai_inferred"/.test(APP), true);
ck("...and the question is the only place it appears",
   /t\("plan_backup_ask"\)\.replace\("\{x\}", inferred\)/.test(APP), true);
ck("declining is recorded, not just cleared",
   /write\("secondary_goal_declined", "declined"\)/.test(APP), true);
ck("...and a declined inference is never asked again",
   /if \(inferred && !declined\)/.test(APP), true);
ck("the write goes through the RPC that forces the source",
   /sb\.rpc\("set_athlete_context_field"/.test(APP), true);
ck("...and the client never sends a source of its own",
   /p_source/.test(APP), false);
ck("Home reads the same field", /statedContextValue\(athlete && athlete\.scout_context, "secondary_goal"\)/.test(APP), true);

// The alternative route may still be SHOWN — an athlete who has never
// considered college should be able to discover it exists. It just may not be
// described as theirs.
ck("an unstated alternative is still surfaced", /home_path_also_possible/.test(APP), true);
ck("...and is not called a goal",
   /\{t\("home_path_also_possible"\)\}/.test(APP), true);

// PathwayPlan must actually load the column, or Plan silently never has a
// secondary goal — a green test over data that was never fetched.
ck("PathwayPlan selects scout_context",
   /select\("sport, position, club_name, grad_year, country, recruiting_status, bio, highlights, timeline, scout_context"\)/.test(APP), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
