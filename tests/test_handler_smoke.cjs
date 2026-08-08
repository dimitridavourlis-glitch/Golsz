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
    // The classifier asks for intent; everything else is a reply.
    if (body.includes("needs_tool") || body.includes("classif")) {
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

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})();
