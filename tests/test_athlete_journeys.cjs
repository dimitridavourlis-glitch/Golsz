// PHASE 15 — standardised athlete journeys.
//
// The Build Roadmap's own acceptance criterion for this phase is blunt:
// "Each test athlete should produce logically different questions,
// assessments and pathways. If Scout treats them similarly, the architecture
// is not functioning correctly."
//
// This runs the REAL exported handler once per turn, per persona, with fetch
// mocked — so it exercises context assembly, readiness, goal capture and the
// prompt the model actually receives. It asserts on the DETERMINISTIC inputs
// (what GOLSZ computed and told the model), never on model prose, so it can
// live in `npm run check` without flaking or costing anything.
//
// Personas are the roadmap's A-F, minus the ones needing features that do not
// exist (see the note on D/E below).

const REPO = require("path").join(__dirname, "..");
const path = REPO + "/api/scout.js";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "svc";
process.env.ANTHROPIC_API_KEY = "sk-test";
delete process.env.SCOUT_FALLBACK_API_KEY; // journeys run on the normal path

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

let PROFILE = {}, ATHLETE = {}, PATHWAY = [], UID = "j1", LAST_PROMPT = "";
const WRITES = { profiles: [], athletes: [] };

function reply(obj) {
  return { ok: true, status: 200, text: async () => "",
    json: async () => ({ id: "m", content: [{ type: "text", text: JSON.stringify(obj) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) };
}

// What the model "says" this turn — set per turn so a journey can simulate an
// athlete revealing new information.
let MODEL_REPLY = { reply: "ok", profile_updates: null };

global.fetch = async (url, opts) => {
  const u = String(url), body = opts && opts.body ? String(opts.body) : "";
  if (u.includes("api.anthropic.com")) {
    LAST_PROMPT = body;
    // Unique to CLASSIFIER_SYSTEM's JSON contract — see the same fix in
    // test_handler_smoke.cjs. Matching /classif/ made the ANSWERING call look
    // like a classifier call as soon as SYSTEM_PROMPT mentioned
    // "classification", emptying reply_text on every scenario.
    if (body.includes("summary_so_far")) {
      return reply({ intent: "career_advice", confidence: 0.9, needs_tool: false, faq_id: null,
        summary_so_far: "s", missing_information: [], recommended_specialist: null,
        conversation_stage: "discovery", next_best_action: null });
    }
    return reply(MODEL_REPLY);
  }
  if (u.includes("/auth/v1/user")) return { ok: true, status: 200, json: async () => ({ id: UID }), text: async () => "" };
  // Capture writes so goal capture / persistence can be asserted per journey.
  if (u.includes("/rest/v1/profiles") && opts && opts.method === "PATCH") {
    WRITES.profiles.push(JSON.parse(opts.body)); return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
  }
  if (u.includes("/rest/v1/athletes") && opts && opts.method === "PATCH") {
    WRITES.athletes.push(JSON.parse(opts.body)); return { ok: true, status: 204, json: async () => ({}), text: async () => "" };
  }
  if (u.includes("/rest/v1/profiles")) return { ok: true, status: 200, json: async () => [PROFILE], text: async () => "" };
  if (u.includes("/rest/v1/pathway_plan")) return { ok: true, status: 200, json: async () => PATHWAY, text: async () => "" };
  if (u.includes("/rest/v1/athletes")) return { ok: true, status: 200, json: async () => [ATHLETE], text: async () => "" };
  if (u.includes("/rest/v1/rpc/reserve_scout_question")) return { ok: true, status: 200, json: async () => ({ allowed: true, used: 1 }), text: async () => "" };
  if (u.includes("/rest/v1/rpc/reserve_free_ai_question")) return { ok: true, status: 200, json: async () => ({ allowed: true }), text: async () => "" };
  if (u.includes("/rest/v1/rpc/")) return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  return { ok: true, status: 200, json: async () => [], text: async () => "" };
};

const handler = require(path);
const fn = handler.default || handler;
let seq = 0;

// One conversational turn for one athlete. Returns what GOLSZ computed.
async function turn(persona, text, modelReply) {
  PROFILE = persona.profile; ATHLETE = persona.athlete; PATHWAY = persona.pathway || [];
  UID = "j" + (++seq);
  MODEL_REPLY = modelReply || { reply: "ok", profile_updates: null };
  const res = { statusCode: null, body: null, headers: {},
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    setHeader() { return this; }, end() { return this; } };
  let threw = null;
  try { await fn({ method: "POST", headers: { authorization: "Bearer t" },
    body: { messages: [{ role: "user", content: text }], lang: "en" } }, res); } catch (e) { threw = e; }
  // Anchored to the unique COMPUTED block, "ATHLETE STATE (app-computed...".
  // Two traps here, both hit while writing this:
  //   1. The phrase "assessment_ready=true" also appears in the SYSTEM
  //      PROMPT's own instruction text, so an unanchored match reads a
  //      constant instead of the computed value.
  //   2. LAST_PROMPT is the raw JSON request body, where newlines are the
  //      two characters \ and n — NOT real newlines. So [^\n]* does not stop
  //      at a line end and happily runs across the entire prompt. There are
  //      7 separate "ATHLETE STATE" mentions for it to collide with.
  const at = LAST_PROMPT.indexOf("ATHLETE STATE (app-computed");
  const stateLine = at === -1 ? "" : LAST_PROMPT.slice(at, at + 700);
  const m = stateLine.match(/assessment_ready=(true|false)/);
  const miss = stateLine.match(/still_missing=([a-z_\/]+)/);
  return { res, threw,
    ready: m ? m[1] === "true" : null,
    missing: miss ? miss[1].split("/") : [],
    stateLine,
    prompt: LAST_PROMPT };
}

// ---- the personas (roadmap Phase 15) ----
const A = { // 17yo high-level male soccer, NCAA D1
  profile: { id: "a", plan: "starter", goal_defined: true, goal_text: "NCAA D1 soccer", dob: "2009-02-01" },
  athlete: { sport: "Soccer", position: "Centre Back", club_name: "Omonia U19", grad_year: 2027, gpa: 3.6,
    scout_context: { target_level: { value: "NCAA D1", source: "athlete_stated" },
      timeline: { value: "2 years", source: "athlete_stated" } } } };
const B = { // 16yo female basketball, scholarship
  profile: { id: "b", plan: "free", goal_defined: true, goal_text: "basketball scholarship", dob: "2010-06-15" },
  athlete: { sport: "Basketball", position: "Guard", club_name: "Montreal Prep", grad_year: 2028, gpa: 3.9,
    scout_context: { timeline: { value: "3 years", source: "athlete_stated" } } } };
const C = { // 18yo baseball considering JUCO — no goal on record yet
  profile: { id: "c", plan: "starter", goal_defined: false, goal_text: null, dob: "2008-03-20" },
  athlete: { sport: "Baseball", position: "Pitcher", club_name: "Lakeshore", scout_context: {} } };
const F = { // 17yo tennis, strong academics, no exposure
  profile: { id: "f", plan: "pro", goal_defined: true, goal_text: "play college tennis in the US", dob: "2009-09-09" },
  athlete: { sport: "Tennis", position: "Singles", club_name: "Cyprus TC", grad_year: 2027, gpa: 4.0,
    scout_context: { exposure_need: { value: "no ranking yet", source: "athlete_stated" } } } };
// Roadmap D (NCAA transfer) and E (academy progression) are deliberately not
// modelled: both hinge on transfer/academy pathway logic that does not exist
// yet. Asserting on them would be testing an intention, not the product.

let factsOf;
(async () => {
  console.log("=== JOURNEY A — 17yo soccer CB, NCAA D1, complete profile ===");
  const a1 = await turn(A, "What should I be working on?");
  ck("handler did not throw", !!a1.threw, false);
  ck("returns a real reply", !!(a1.res.body && a1.res.body.reply_text), true);
  ck("A is assessment-ready (full profile + stated goal)", a1.ready, true);
  ck("...with nothing critical outstanding", a1.missing, []);

  console.log("\n=== JOURNEY B — 16yo basketball guard, free plan ===");
  const b1 = await turn(B, "How do I get a scholarship?");
  ck("handler did not throw", !!b1.threw, false);
  ck("B is also ready (different sport, complete)", b1.ready, true);
  // Checked against the athlete-facts block, not the whole prompt: the static
  // system prompt legitimately uses soccer in generic worked examples, so a
  // global "no Soccer anywhere" assertion tests the wrong thing.
  factsOf = (r) => (r.prompt.match(/VERIFIED PROFILE[\s\S]{0,600}/) || [""])[0];
  ck("B's athlete facts say Basketball, not Soccer",
     /Basketball/.test(factsOf(b1)) && !/Soccer/.test(factsOf(b1)), true);

  console.log("\n=== JOURNEY C — 18yo pitcher, NO goal on record ===");
  const c1 = await turn(C, "I want to keep playing after high school.");
  ck("handler did not throw", !!c1.threw, false);
  ck("C is NOT ready — no stated goal", c1.ready, false);
  ck("...and goal is named as the blocker", c1.missing.includes("goal"), true);
  // §18: an ambiguous aspiration must not be silently promoted to a goal.
  ck("a vague 'keep playing' did not write a goal",
     WRITES.profiles.some((w) => w.goal_text), false);

  console.log("\n--- C turn 2: the athlete states a real goal ---");
  const c2 = await turn(C, "I want to play JUCO baseball then transfer.",
    { reply: "Got it.", profile_updates: { goal: "JUCO baseball then transfer to a four-year program" } });
  ck("handler did not throw", !!c2.threw, false);
  ck("a clearly stated goal IS captured to the Passport",
     WRITES.profiles.some((w) => w.goal_text === "JUCO baseball then transfer to a four-year program"), true);
  ck("...and goal_defined is derived in the same write, not model-reported",
     WRITES.profiles.some((w) => w.goal_text && w.goal_defined === true), true);

  console.log("\n--- C turn 3: goal now on record, athlete asks again ---");
  const C2 = { ...C, profile: { ...C.profile, goal_defined: true, goal_text: "JUCO baseball then transfer" } };
  const c3 = await turn(C2, "So what now?");
  ck("with a goal on record, C becomes ready", c3.ready, true);
  ck("...and the goal is no longer a blocker", c3.missing.includes("goal"), false);

  console.log("\n=== JOURNEY F — 17yo tennis, strong academics, no exposure ===");
  const f1 = await turn(F, "What is holding me back?");
  ck("handler did not throw", !!f1.threw, false);
  ck("F is ready", f1.ready, true);
  ck("F's prompt carries tennis", /Tennis/.test(f1.prompt), true);

  console.log("\n=== THE PHASE 15 CRITERION: different athletes, different treatment ===");
  // Same question, four different athletes. If GOLSZ computed the same state
  // for all of them, the architecture is not doing its job.
  const states = [a1, b1, c1, f1].map((r) => `${r.ready}:${r.missing.join(",")}`);
  ck("not every athlete produced an identical state", new Set(states).size > 1, true);
  ck("the athlete missing a goal is distinguishable from the three who aren't",
     [a1.ready, b1.ready, f1.ready].every((x) => x === true) && c1.ready === false, true);
  // Sport genuinely reaches the model rather than being generic filler.
  ck("each journey has its OWN sport in its own athlete facts",
     [[a1, "Soccer"], [b1, "Basketball"], [f1, "Tennis"]].every(([r, s]) => factsOf(r).includes(s)), true);
  ck("no journey leaked another athlete's sport into its facts",
     factsOf(b1).includes("Tennis") || factsOf(f1).includes("Basketball"), false);

  console.log("\n=== cross-journey integrity ===");
  ck("every journey got a 200, none degraded to an error page",
     [a1, b1, c1, c2, c3, f1].every((r) => r.res.statusCode === 200), true);
  ck("subscription metering reported on every paid-plan journey",
     [a1, c1, f1].every((r) => !!(r.res.body && r.res.body.scout_usage)), true);
  ck("no journey threw", [a1, b1, c1, c2, c3, f1].every((r) => !r.threw), true);

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})();
