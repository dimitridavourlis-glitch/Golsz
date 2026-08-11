// END-TO-END handler smoke test.
//
// This exists because of a production outage on 2026-08-08: storedAssessment
// was declared inside the `if (userId)` block and read from the reply paths
// outside it, so every state-3+ athlete got a 502 after the model had already
// answered. node --check passes on that. Every other suite here eval's
// individual FUNCTIONS out of the file, so none of them ever executed the
// handler and none could have caught it.
//
// This runs the real exported handler with fetch mocked, so scope errors,
// TDZ errors and undefined-function calls surface as failures instead of as
// "Upstream model call failed" on someone's phone.
//
// Reverted 2026-08-09: the state machine, capability manifest re-gating,
// trial system and assessment generation that this file used to exercise
// were all removed in the same revert (see that commit). Scenarios below
// were cut back to what's actually still in api/scout.js — plan-based
// daily/lifetime limits, the two-bucket capability manifest, and the
// authoritative/memory context — but the handler-level shape of this test
// (real fetch mock, real exported handler, assert past-auth + no 502 + a
// real reply) is exactly what caught the original bug and stays as-is.

const REPO = require("path").join(__dirname, "..");
const path = REPO + "/api/scout.js";

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "svc";
process.env.ANTHROPIC_API_KEY = "sk-test";

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- the athlete under test, controllable per scenario ----
let PROFILE = {};
let ATHLETE = {};
let PATHWAY = [];        // rows from pathway_plan -> feeds ATHLETE STATE's pathway_created/baseline_complete
let UID = "u1";          // distinct per scenario: the rate limiter keys on it
let LAST_ANTHROPIC_BODY = ""; // raw request body of the most recent model call

function anthropicReply(obj) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: "msg_1",
      content: [{ type: "text", text: JSON.stringify(obj) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }),
    text: async () => "",
  };
}

global.fetch = async (url, opts) => {
  const u = String(url);
  const body = opts && opts.body ? String(opts.body) : "";

  if (u.includes("api.anthropic.com")) {
    // Captured so the ATHLETE STATE assertions below can inspect what the
    // model was ACTUALLY told, rather than trusting that the wiring ran.
    LAST_ANTHROPIC_BODY = body;
    // The classifier asks for intent; everything else is a reply.
    // Discriminates on a string unique to CLASSIFIER_SYSTEM's JSON contract.
    // This used to also match /classif/, which broke the moment SYSTEM_PROMPT
    // gained the line banning Scout from CLASSIFYing an organisation from
    // memory ("division, tier, league, conference, classification, ..."): the
    // ANSWERING call started matching the classifier branch, so every reply
    // came back as classifier JSON and reply_text was empty. A loose
    // discriminator in a mock is a suite that fails on unrelated prompt edits.
    if (body.includes("summary_so_far")) {
      return anthropicReply({ intent: "career_advice", confidence: 0.9, needs_tool: false, faq_id: null,
        summary_so_far: "s", missing_information: [], recommended_specialist: null,
        conversation_stage: "pathway", next_best_action: null });
    }
    return anthropicReply({ reply: "Here is a straight answer about your pathway.", profile_updates: null });
  }

  // getUserId() hits /auth/v1/user; without this the handler 401s and never
  // reaches any of the code under test.
  if (u.includes("/auth/v1/user")) return { ok: true, status: 200, json: async () => ({ id: UID }), text: async () => "" };

  // ---- Supabase REST ----
  if (u.includes("/rest/v1/profiles")) return { ok: true, status: 200, json: async () => [PROFILE], text: async () => "" };
  if (u.includes("/rest/v1/pathway_plan")) return { ok: true, status: 200, json: async () => PATHWAY, text: async () => "" };
  if (u.includes("/rest/v1/athletes")) return { ok: true, status: 200, json: async () => [ATHLETE], text: async () => "" };
  if (u.includes("/rest/v1/product_capabilities")) return { ok: true, status: 200, json: async () => ([
    { key: "faq", label: "Answer questions", available: true, plan_min: null, notes: null },
    { key: "targets", label: "Build a target school list", available: true, plan_min: "pro", notes: null },
  ]), text: async () => "" };
  if (u.includes("/rest/v1/rpc/reserve_scout_question")) return { ok: true, status: 200, json: async () => ({ allowed: true, used: 1 }), text: async () => "" };
  if (u.includes("/rest/v1/rpc/reserve_free_ai_question")) return { ok: true, status: 200, json: async () => ({ allowed: true }), text: async () => "" };
  if (u.includes("/rest/v1/rpc/")) return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  return { ok: true, status: 200, json: async () => [], text: async () => "" };
};

// Supabase auth token verification goes through the same fetch mock; the
// handler resolves the user id from the JWT it is handed.
const handler = require(path);
const fn = handler.default || handler;

function mkRes() {
  const r = { statusCode: null, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.end = () => r;
  return r;
}

let uidSeq = 0;
async function run(label, profile, athlete, pathway) {
  PROFILE = profile; ATHLETE = athlete; PATHWAY = pathway || [];
  UID = "u" + (++uidSeq);
  const req = {
    method: "POST",
    headers: { authorization: "Bearer test.jwt.token", "content-type": "application/json" },
    body: { messages: [{ role: "user", content: "Build my target school list" }], lang: "en" },
  };
  const res = mkRes();
  let threw = null;
  try { await fn(req, res); } catch (e) { threw = e; }
  return { res, threw, label };
}

(async () => {
  const BASE_ATHLETE = { sport: "Soccer", position: "Right Back", club_name: "Tusculum", recruiting_status: "Open",
    dob: "2005-03-01", country: "USA", current_city: "Greeneville", grad_year: 2026 };

  console.log("-- an established starter-plan athlete with a pathway --");
  const r1 = await run("starter", { id: "u1", plan: "starter", is_admin: false, ai_unlimited: false,
    goal_defined: true, goal_text: "NCAA D2" }, BASE_ATHLETE, [{ baseline_complete: false }]);
  ck("handler did not throw", !!r1.threw, false);
  console.log("   status:", r1.res.statusCode, "| body keys:", r1.res.body ? Object.keys(r1.res.body).join(",") : "none");
  ck("got past auth (401 here would make this test meaningless)", r1.res.statusCode !== 401, true);
  ck("did not 502", r1.res.statusCode === 502, false);
  ck("returned a real reply", !!(r1.res.body && r1.res.body.reply_text), true);
  if (r1.res.statusCode === 502) console.log("   detail:", r1.res.body && r1.res.body.detail);

  console.log("\n-- an established pro-plan athlete --");
  const r2 = await run("pro", { id: "u1", plan: "pro", is_admin: false, ai_unlimited: false,
    goal_defined: true, goal_text: "NCAA D1" }, BASE_ATHLETE, [{ baseline_complete: true }]);
  ck("handler did not throw", !!r2.threw, false);
  console.log("   status:", r2.res.statusCode, "| body keys:", r2.res.body ? Object.keys(r2.res.body).join(",") : "none");
  ck("got past auth", r2.res.statusCode !== 401, true);
  ck("did not 502", r2.res.statusCode === 502, false);
  ck("returned a real reply", !!(r2.res.body && r2.res.body.reply_text), true);
  if (r2.res.statusCode === 502) console.log("   detail:", r2.res.body && r2.res.body.detail);

  console.log("\n-- a brand-new free athlete --");
  const r3 = await run("free", { id: "u1", plan: "free", is_admin: false, ai_unlimited: false,
    goal_defined: false, goal_text: null }, {});
  ck("handler did not throw", !!r3.threw, false);
  console.log("   status:", r3.res.statusCode, "| body keys:", r3.res.body ? Object.keys(r3.res.body).join(",") : "none");
  ck("got past auth", r3.res.statusCode !== 401, true);
  ck("did not 502", r3.res.statusCode === 502, false);
  ck("returned a real reply", !!(r3.res.body && r3.res.body.reply_text), true);
  if (r3.res.statusCode === 502) console.log("   detail:", r3.res.body && r3.res.body.detail);

  console.log("\n-- triage readiness actually reaches the model (Prompt #1) --");
  // assessmentReady is assigned inside the `if (process.env.SUPABASE_URL)`
  // block and read further down by the ATHLETE STATE builder and
  // persistAiMeta() — the exact shape of the 2026-08-08 storedAssessment
  // outage. The three scenarios above already prove no ReferenceError (they
  // ran the real handler end to end); these assert the VALUE is wired
  // through, not merely that nothing threw.
  // Anchored to the unique COMPUTED block. An unanchored regex here was a
  // real weakness found during the 2026-08-09 athlete-journey audit: the
  // phrase "assessment_ready=true" ALSO appears in the system prompt's own
  // instruction text, and the captured body is raw JSON where newlines are
  // the two characters \ and n — so [^\n]* never terminates and a loose match
  // reads a constant instead of the value GOLSZ computed.
  const stateBlock = () => {
    const i = LAST_ANTHROPIC_BODY.indexOf("ATHLETE STATE (app-computed");
    return i === -1 ? "" : LAST_ANTHROPIC_BODY.slice(i, i + 700);
  };
  ck("the computed ATHLETE STATE block is present at all", stateBlock().length > 0, true);
  ck("ATHLETE STATE carries assessment_ready", /assessment_ready=(true|false)/.test(stateBlock()), true);
  // r3 is the brand-new free athlete: empty athlete row, no goal. It cannot
  // be assessment-ready, and the block must name what is still missing.
  ck("a brand-new athlete is reported NOT ready", stateBlock().includes("assessment_ready=false"), true);
  ck("...and still_missing names the blockers", /still_missing=[a-z_/]+/.test(LAST_ANTHROPIC_BODY), true);

  // A fully-specified NCAA athlete must flip it the other way, or the signal
  // is stuck false and the recap would never fire for anyone.
  const r4 = await run("ready-ncaa",
    { id: "u1", plan: "free", is_admin: false, ai_unlimited: false, goal_defined: true, goal_text: "NCAA D1 soccer" },
    { ...BASE_ATHLETE, gpa: 3.4, height_cm: 180,
      scout_context: {
        target_level: { value: "NCAA D1", source: "athlete_stated" },
        timeline: { value: "18 months", source: "athlete_stated" },
        perceived_strengths: { value: "reads the game", source: "athlete_stated" },
        perceived_weaknesses: { value: "pace", source: "athlete_stated" },
        exposure_need: { value: "no film", source: "ai_inferred", confidence: 0.7 },
      } });
  ck("handler did not throw on the ready path", !!r4.threw, false);
  ck("a complete NCAA athlete IS reported ready", stateBlock().includes("assessment_ready=true"), true);
  ck("...and no still_missing clause is emitted", /still_missing=/.test(stateBlock()), false);

  console.log("\n-- DOB is read from profiles.dob, not athletes.dob (Step 1 age-pointer fix) --");
  // Real production state found 2026-08-09: date of birth is collected at
  // signup into profiles.dob (10/13 athletes filled) but every downstream
  // reader used athletes.dob, which was 0/13. resolveAge() therefore returned
  // null for everyone and Scout never knew any athlete's age.
  // athletes.dob here is deliberately set to a WILDLY different (older) date
  // so precedence is provable from the resulting age alone, with no dependence
  // on today's date beyond "these two cannot be confused".
  const r5 = await run("dob-from-profiles",
    { id: "u1", plan: "starter", is_admin: false, ai_unlimited: false, goal_defined: false, goal_text: null,
      dob: "2008-05-01" },                       // profiles.dob -> a teenager
    { ...BASE_ATHLETE, dob: "1970-01-01" });     // athletes.dob -> a 50-something
  ck("handler did not throw", !!r5.threw, false);
  const ageMatch = LAST_ANTHROPIC_BODY.match(/- age: (\d+) \(date of birth\)/);
  ck("an age is resolved and reaches the model at all", !!ageMatch, true);
  ck("...and it came from profiles.dob, not the stale athletes.dob",
     !!(ageMatch && Number(ageMatch[1]) < 30), true);

  // Fallback still works: no profiles.dob -> athletes.dob is used rather than
  // the athlete silently losing an age they do have on file.
  const r6 = await run("dob-fallback-to-athletes",
    { id: "u1", plan: "starter", is_admin: false, ai_unlimited: false, goal_defined: false, goal_text: null },
    { ...BASE_ATHLETE, dob: "2005-03-01" });
  ck("handler did not throw", !!r6.threw, false);
  ck("with no profiles.dob, athletes.dob is still used",
     /- age: \d+ \(date of birth\)/.test(LAST_ANTHROPIC_BODY), true);

  console.log("\n-- TOTAL ANTHROPIC OUTAGE: cross-provider fallback keeps Scout alive --");
  // Non-Negotiable #2. Every Anthropic call now fails; only the emergency
  // OpenAI-compatible provider answers. This is the scenario the whole
  // second-provider work exists for, run through the REAL handler.
  process.env.SCOUT_FALLBACK_API_KEY = "sk-fallback-test";
  process.env.SCOUT_FALLBACK_MODEL = "grok-4.20-0309-non-reasoning";
  process.env.SCOUT_FALLBACK_URL = "https://api.x.ai/v1";  // base url, as xAI publishes it
  const realFetch = global.fetch;
  let hitFallbackProvider = false;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("api.anthropic.com")) {
      return { ok: false, status: 529, json: async () => ({ error: { type: "overloaded_error" } }), text: async () => "overloaded" };
    }
    if (u.includes("/chat/completions")) {
      // Proves the base-url normalisation too: the config above sets the
      // BASE, so a request only lands here if /chat/completions was appended.
      if (!/api\.x\.ai\/v1\/chat\/completions$/.test(u)) throw new Error("wrong xAI endpoint: " + u);
      hitFallbackProvider = true;
      return {
        ok: true, status: 200,
        json: async () => ({
          id: "chatcmpl-fb",
          choices: [{ message: { role: "assistant", content: '{"reply":"Answering while our main provider is down.","memory_writes":[]}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 900, completion_tokens: 120 },
        }),
        text: async () => "",
      };
    }
    return realFetch(url, opts);
  };
  const rOut = await run("anthropic-outage",
    { id: "u1", plan: "starter", is_admin: false, ai_unlimited: false, goal_defined: true, goal_text: "NCAA D2" },
    BASE_ATHLETE, [{ baseline_complete: false }]);
  ck("handler did not throw during a full outage", !!rOut.threw, false);
  ck("the emergency provider was actually called", hitFallbackProvider, true);
  ck("athlete gets a real 200, not an error page", rOut.res.statusCode, 200);
  ck("...with actual reply text", !!(rOut.res.body && rOut.res.body.reply_text), true);
  ck("...from the fallback provider",
     !!(rOut.res.body && /main provider is down/.test(rOut.res.body.reply_text)), true);
  // Subscription metering must survive a provider swap — the athlete used a
  // question and must be told what they have left, same as any other reply.
  ck("subscription usage is still reported", !!(rOut.res.body && rOut.res.body.scout_usage), true);

  // And with NO fallback key the behaviour must be exactly as before: a
  // graceful failure, never a crash and never a silent empty 200.
  delete process.env.SCOUT_FALLBACK_API_KEY;
  const rNoFb = await run("outage-no-fallback-configured",
    { id: "u1", plan: "starter", is_admin: false, ai_unlimited: false, goal_defined: true, goal_text: "NCAA D2" },
    BASE_ATHLETE, [{ baseline_complete: false }]);
  ck("unconfigured fallback = unchanged graceful failure, no crash", !!rNoFb.threw, false);
  ck("...and does not return a bogus 200 with no answer",
     rNoFb.res.statusCode === 200 && !rNoFb.res.body.reply_text, false);
  global.fetch = realFetch;
  delete process.env.SCOUT_FALLBACK_MODEL;

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})();
