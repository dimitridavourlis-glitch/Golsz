// SPORT_SCHEMA V1 — soccer + basketball vertical slice.
//
// The architectural claim being tested is not "the data is present" but
// "the abstraction holds": common concepts live in SPORT_CORE, sport-specific
// concepts live in modular definitions, nothing soccer-shaped leaked into the
// universal model, and adding a third sport requires no change to Scout.
//
// Per tests/README.md everything is extracted from api/scout.js at run time.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SRC = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));

// Functions leak from a direct eval; the two data constants do not, so they
// come out through an appended extractor (same pattern as the other suites).
eval(slice("const SPORT_CORE = {", "\n// Deterministic recovery for the goal-capture") +
  "\nfunction __extractSchema() { return { SPORT_CORE, SPORT_SCHEMAS }; }");
const { SPORT_CORE, SPORT_SCHEMAS } = __extractSchema();
// classifyGoalText is used by the Scout-integration assertions below.
// The end marker MUST stop before the SPORT_SCHEMA block: a wider slice
// re-evaluates that block in a second scope, so the schema functions would
// close over a DIFFERENT SPORT_SCHEMAS object than the one extracted above —
// and the "adding a sport" simulation at the bottom would silently mutate an
// orphan copy.
eval(slice("const GOAL_TEXT_PATTERNS", "\n// ============================================================\n// SPORT_SCHEMA V1"));

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

console.log("-- core/sport separation: nothing sport-specific in the core --");
ck("core defines stages", SPORT_CORE.stages.length > 0, true);
ck("core defines shared development dimensions", SPORT_CORE.development_dimensions.length > 0, true);
ck("core defines an evidence hierarchy", SPORT_CORE.evidence_tiers.length > 0, true);
ck("evidence runs inferred -> verified, weakest first",
   [SPORT_CORE.evidence_tiers[0], SPORT_CORE.evidence_tiers[SPORT_CORE.evidence_tiers.length - 1]],
   ["ai_inferred", "verified_third_party"]);
// The whole point of the split: no soccer noun may appear in the core.
const coreBlob = JSON.stringify(SPORT_CORE).toLowerCase();
ck("core contains NO soccer-specific vocabulary",
   ["striker", "goalkeeper", "midfield", "clean_sheet", "foot"].some((w) => coreBlob.includes(w)), false);
ck("core contains NO basketball-specific vocabulary",
   ["rebound", "wingspan", "three_pt", "guard", "dunk"].some((w) => coreBlob.includes(w)), false);
// Goal vocabulary must match pathway_plan's enum or the two drift apart.
const PATHWAY_ENUM = ["ncaa", "naia", "juco", "canadian_university", "academy", "european_club",
  "professional", "development", "agent_representation", "trainer_performance", "other"];
ck("core goal types match the pathway_plan enum exactly (migration 093)",
   SPORT_CORE.goal_types, PATHWAY_ENUM);

console.log("\n-- soccer and basketball are STRUCTURALLY DISTINCT --");
const S = SPORT_SCHEMAS.soccer, B = SPORT_SCHEMAS.basketball;
ck("both sports exist", [!!S, !!B], [true, true]);
ck("positions differ", JSON.stringify(S.positions) !== JSON.stringify(B.positions), true);
ck("performance indicators differ",
   JSON.stringify(S.performance_indicators) !== JSON.stringify(B.performance_indicators), true);
ck("competition levels differ", JSON.stringify(S.levels) !== JSON.stringify(B.levels), true);
ck("pathways differ", JSON.stringify(S.pathways) !== JSON.stringify(B.pathways), true);
ck("terminology differs", S.terminology.showcase !== B.terminology.showcase, true);
// Concrete, meaningful differences rather than incidental ones:
ck("soccer supports a semi-professional pathway", S.pathways.some((x) => x.id === "semi_professional"), true);
ck("basketball does NOT (correctly — it isn't a basketball pathway)",
   B.pathways.some((x) => x.id === "semi_professional"), false);
ck("basketball tracks wingspan; soccer does not",
   [B.attributes.includes("wingspan_cm"), S.attributes.includes("wingspan_cm")], [true, false]);
ck("soccer tracks dominant foot; basketball tracks dominant hand",
   [S.attributes.includes("dominant_foot"), B.attributes.includes("dominant_hand")], [true, true]);

console.log("\n-- position validation, and cross-sport rejection --");
ck("a soccer position resolves by label", resolvePosition("Soccer", "Right Back").id, "rb");
ck("...and by id", resolvePosition("soccer", "gk").label, "Goalkeeper");
ck("...case-insensitively", resolvePosition("SOCCER", "  striker ").id, "st");
ck("a basketball position resolves", resolvePosition("Basketball", "Point Guard").id, "pg");
// THE contamination test: both are real positions, in different sports.
ck("a basketball position is REJECTED for soccer", resolvePosition("soccer", "Point Guard"), null);
ck("a soccer position is REJECTED for basketball", resolvePosition("basketball", "Striker"), null);
ck("a nonsense position is rejected, not coerced", resolvePosition("soccer", "Quarterback"), null);
ck("an unknown sport resolves no position at all", resolvePosition("curling", "Skip"), null);

console.log("\n-- goals and pathways are representable --");
ck("soccer NCAA pathway exists with key evidence",
   pathwaysFor("soccer", "ncaa")[0].key_evidence.includes("gpa"), true);
ck("basketball NCAA pathway exists and is its OWN definition",
   pathwaysFor("basketball", "ncaa")[0].key_evidence.includes("aau_exposure"), true);
ck("soccer NCAA evidence differs from basketball NCAA evidence",
   JSON.stringify(pathwaysFor("soccer", "ncaa")[0].key_evidence) !==
   JSON.stringify(pathwaysFor("basketball", "ncaa")[0].key_evidence), true);
ck("no goal type -> every pathway the sport supports", pathwaysFor("soccer", null).length, S.pathways.length);
ck("a pathway the sport does not support -> empty, never a substitute",
   pathwaysFor("basketball", "semi_professional"), []);
ck("an unknown sport -> empty, never a default sport's pathways", pathwaysFor("curling", "ncaa"), []);
ck("every pathway declares a goal_type from the shared core vocabulary",
   [...S.pathways, ...B.pathways].every((x) => SPORT_CORE.goal_types.includes(x.goal_type)), true);
ck("a sport may be finer-grained than the shared taxonomy (semi-pro -> professional)",
   S.pathways.find((x) => x.id === "semi_professional").goal_type, "professional");
ck("every pathway's levels exist in that same sport's level list",
   [[S, S.pathways], [B, B.pathways]].every(([sc, ps]) =>
     ps.every((pw) => pw.levels.every((lv) => sc.levels.some((l) => l.id === lv)))), true);

console.log("\n-- MISSING STAYS MISSING: nothing is ever guessed --");
ck("unknown sport -> null schema, not a default", sportSchemaFor("underwater hockey"), null);
ck("empty sport -> null", sportSchemaFor(""), null);
ck("null sport -> null", sportSchemaFor(null), null);
ck("non-string sport -> null", sportSchemaFor({ sport: "soccer" }), null);
ck("unknown sport renders NO context rather than a hollow scaffold",
   renderSportContext("curling", "Skip", "ncaa"), "");
const noPos = renderSportContext("soccer", null, "ncaa");
ck("a missing position is stated as NOT ON RECORD", /NOT ON RECORD/.test(noPos), true);
ck("...and Scout is told never to assume one", /never assume one/.test(noPos), true);
ck("...and no position was invented", S.positions.every((x) => !noPos.includes(`position: ${x.label}`)), true);
const badPos = renderSportContext("soccer", "Point Guard", "ncaa");
ck("an unrecognised position is flagged unconfirmed, not silently dropped",
   /not one this schema recognises/.test(badPos), true);
ck("...and Scout is told not to reinterpret it", /do not reinterpret/.test(badPos), true);
ck("no goal yet -> all supported pathways offered, none chosen",
   /no pathway selected yet/.test(renderSportContext("soccer", "Striker", null)), true);

console.log("\n-- Scout receives the correct sport context, with no bleed --");
const soccerCtx = renderSportContext("soccer", "Right Back", "ncaa");
const basketCtx = renderSportContext("basketball", "Point Guard", "ncaa");
ck("soccer context names soccer", /SPORT CONTEXT — Soccer/.test(soccerCtx), true);
ck("basketball context names basketball", /SPORT CONTEXT — Basketball/.test(basketCtx), true);
ck("soccer context carries the athlete's actual position", /Right Back/.test(soccerCtx), true);
ck("soccer context contains NO basketball positions",
   B.positions.some((x) => soccerCtx.includes(x.label)), false);
ck("basketball context contains NO soccer positions",
   S.positions.some((x) => basketCtx.includes(x.label)), false);
ck("soccer context contains no basketball indicators", /Rebounds per game|Three-point/.test(soccerCtx), false);
ck("basketball context contains no soccer indicators", /Clean sheets|Yo-Yo/.test(basketCtx), false);
ck("each context uses its own sport's terminology",
   [/ID camp \/ showcase/.test(soccerCtx), /AAU circuit/.test(basketCtx)], [true, true]);
ck("levels are ordered weakest to strongest for the reader",
   soccerCtx.indexOf("Recreational") < soccerCtx.indexOf("Top-division professional"), true);
// The classifier that picks the pathway must not over-reach.
ck("an ambiguous goal yields no pathway lock-in",
   /no pathway selected yet/.test(renderSportContext("soccer", "Striker", classifyGoalText("I want to play college soccer"))), true);
ck("a clear goal does select the matching pathway",
   /US college soccer/.test(renderSportContext("soccer", "Striker", classifyGoalText("NCAA D1 soccer"))), true);

console.log("\n-- EXISTING PROFILES STAY COMPATIBLE --");
// Every shape currently sitting in production must keep working.
ck("an athlete with a sport GOLSZ doesn't model still renders (nothing added)",
   renderSportContext("Track", "Sprinter", null), "");
ck("an athlete with no sport at all does not throw", renderSportContext(null, null, null), "");
ck("an athlete with sport but nothing else still gets real context",
   renderSportContext("Soccer", null, null).length > 0, true);
ck("free-text position from an old profile is handled, not rejected outright",
   renderSportContext("Soccer", "right back", null).includes("Right Back"), true);
ck("a legacy position string GOLSZ can't map is surfaced verbatim for the athlete to confirm",
   renderSportContext("Soccer", "Sweeper", null).includes("Sweeper"), true);

console.log("\n-- ADDING A SPORT MUST NOT TOUCH SCOUT --");
// Simulate a third sport by adding one entry, then assert every consumer
// works with zero other changes. This is the architectural guarantee.
SPORT_SCHEMAS.tennis = {
  id: "tennis", label: "Tennis", team_or_individual: "individual",
  positions: [{ id: "singles", label: "Singles", group: "singles" }],
  attributes: ["dominant_hand", "height_cm"],
  performance_indicators: [{ key: "utr", label: "UTR", unit: "rating", higher_is_better: true }],
  development_dimensions: [{ id: "serve", label: "Serve" }],
  levels: [{ id: "junior", label: "Junior", rank: 3 }, { id: "ncaa_d1", label: "NCAA Division I", rank: 9 }],
  // goal_type is part of the pathway contract — it links a sport's own
  // pathway to the shared goal vocabulary. Omitting it makes the pathway
  // unreachable, which is the correct strict behaviour, not a bug.
  pathways: [{ id: "ncaa", goal_type: "ncaa", label: "US college tennis", levels: ["ncaa_d1"], key_evidence: ["utr", "grad_year"] }],
  terminology: { trial: "tryout", showcase: "ITF junior event", film: "match video",
    governing_examples: ["NCAA", "ITF"] },
};
ck("the new sport resolves with no code change", sportSchemaFor("tennis").label, "Tennis");
ck("its positions validate", resolvePosition("tennis", "Singles").id, "singles");
ck("cross-sport rejection works for it immediately", resolvePosition("tennis", "Striker"), null);
ck("...and it is rejected from the other sports", resolvePosition("soccer", "Singles"), null);
ck("its pathways resolve", pathwaysFor("tennis", "ncaa")[0].key_evidence.includes("utr"), true);
const tennisCtx = renderSportContext("tennis", "Singles", "ncaa");
ck("Scout's context renderer needed no change", /SPORT CONTEXT — Tennis/.test(tennisCtx), true);
ck("...and the shared core dimensions still apply to it", /Physical/.test(tennisCtx), true);
ck("...while its own dimension is added, not substituted", /Serve/.test(tennisCtx), true);
ck("no existing sport was affected by the addition",
   [sportSchemaFor("soccer").label, sportSchemaFor("basketball").label], ["Soccer", "Basketball"]);
delete SPORT_SCHEMAS.tennis;
ck("registry is restored after the simulation", knownSportIds().sort(), ["basketball", "soccer"]);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
