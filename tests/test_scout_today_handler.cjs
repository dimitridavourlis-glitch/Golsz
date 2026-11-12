// SCOUT'S "WHAT SHOULD I DO TODAY?" THROUGH THE REAL HANDLER.
//
// AVA job 216 t2. t1's pure rules (tests/test_scout_today_answer.cjs), wired
// into the exported handler of api/scout.js and run here with every network
// call mocked: the pattern of tests/test_handler_smoke.cjs. One athlete with a
// plan of 1 step due today and 3 this week, on a pinned day (Thursday
// 2026-11-12) sent as body.today, under a process clock pinned to that day so
// the server takes it as theirs. The suite reads what the athlete gets back,
// what the model was told and what the handler wrote:
//   - a today question about a plan with steps carries today_card: the numbers
//     Home shows for the day, as Home's own code computes them;
//   - a reply naming a date, a step or a this-week count that is not in the
//     plan comes back today_override, its text untouched, and the guard's log
//     holds the kinds of disagreement only, never the reply;
//   - neither the FAQ nor the response cache answers it, whatever matched;
//   - all four ways a reply goes back (Haiku, the deep reply, the Haiku and the
//     cross-provider failovers) run the guard;
//   - another question, no plan or a plan with no steps: no card; a plan that
//     could not be read: today_unavailable, and the model is told so.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const { S, homeAt, homeTileAt } = require("./_day_parity.cjs");

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "svc";
process.env.ANTHROPIC_API_KEY = "sk-test";
// The cross-provider failover only runs with a key; it is called only when
// every Anthropic call has failed.
process.env.SCOUT_FALLBACK_API_KEY = "sk-fallback-test";
process.env.SCOUT_FALLBACK_URL = "https://api.x.ai/v1";

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- the pinned day ------------------------------------------------------
// resolveAthleteDay() takes the app's day only within one day of the server's
// clock, so the clock is moved to that day (it keeps ticking).
const DAY = "2026-11-12";   // a Thursday; its week runs Monday 9 to Sunday 15 November
const RealDate = Date;
const SHIFT = RealDate.parse(`${DAY}T10:00:00Z`) - RealDate.now();
global.Date = class PinnedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + SHIFT); }
  static now() { return RealDate.now() + SHIFT; }
};

// ---- the athlete's plan --------------------------------------------------
const STEP_TODAY = "Film two full matches";
const PLAN = [
  { id: "m1", label: STEP_TODAY, due: "2026-11-12", done: false },
  { id: "m2", label: "Email Coach Rivera", due: "2026-11-13", done: false },
  { id: "m3", label: "Upload the Saturday match clip", due: "2026-11-14", done: false },
  { id: "m4", label: "Retest the 30 m sprint", due: "2026-11-03", done: true },
  { id: "m5", label: "Book a physio check", due: "2026-11-24", done: false },
  { id: "m6", label: "Update your Passport bio", due: null, done: false },
];
const ROW = { pathway_type: "ncaa", target_timeline: null, baseline_complete: true, stages: null, current_stage_id: null, milestones: PLAN };
const SHELL = { ...ROW, milestones: [] };   // a plan with no steps: Home shows "set your goal"
// The server's own card for this plan and day, and Home's view of the same.
const EXPECTED = S.todayCard(S.dayBuckets(PLAN, DAY, false), S.pickNextMilestone(PLAN), false);
const HOME = homeAt(2026, 11, 12)(PLAN, false);
const TILE = homeTileAt(2026, 11, 12)(PLAN, false);

// ---- what the model answers ----------------------------------------------
const HONEST = `Today, do "${STEP_TODAY}". This week you have done 0 of 3, and next comes "Email Coach Rivera" on Friday 13 November.`;
const INVENTED_DATE = `Today, do "${STEP_TODAY}" and have it done by 2026-11-16. This week you have done 0 of 3.`;
const INVENTED_STEP = `Today, do "Film three full matches". This week you have done 0 of 3.`;
const WRONG_WEEK = `Today, do "${STEP_TODAY}". This week you have done 2 of 3.`;
const PLAN_AS_WEEK = `Today, do "${STEP_TODAY}". This week you have done 1 of 6.`;
const PLAN_OVERALL = `Today, do "${STEP_TODAY}". Overall you have done 1 of 6 steps.`;
const UNREAD_REPLY = "I couldn't load your plan just now. Ask me again in a moment.";
const FAQ_ANSWER = "STORED FAQ ANSWER: train with purpose every day.";
const FAQ = [{ id: 7, question: "What should I do every day to get recruited?", answer: FAQ_ANSWER }];
const CACHED = { content: [{ type: "text", text: JSON.stringify({ reply: "CACHED ANSWER" }) }], stop_reason: "end_turn", reply_text: "CACHED ANSWER" };

// The two rules the model may be given, read out of the source.
const constString = (name) => {
  const m = new RegExp(`\\nconst ${name} = (\`[^\`]*\`);`).exec(SCOUT);
  if (!m) throw new Error(`${name} not found in api/scout.js — update this suite`);
  return new Function(`return ${m[1]};`)();
};
const RULE = constString("TODAY_ANSWER_RULE");
const UNREAD_RULE = constString("TODAY_PLAN_UNREAD_RULE");

// ---- the services, mocked and recorded ----------------------------------
let world = null;     // what the services answer, per scenario
let calls = [];       // every request the handler made, in order
let answers = [];     // the raw body of every answering model call
let logs = { warn: [], error: [] };
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const anthropicMessage = (model, obj) => ({ id: "msg", type: "message", role: "assistant", model, stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  content: [{ type: "text", text: JSON.stringify(obj) }] });

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String(opts.method || "GET").toUpperCase();
  const raw = opts.body ? String(opts.body) : "";
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  const rpc = u.includes("/rest/v1/rpc/") ? u.slice(u.indexOf("/rest/v1/rpc/") + 13).split("?")[0] : null;
  const table = !rpc && u.includes("/rest/v1/") ? u.slice(u.indexOf("/rest/v1/") + 9).split("?")[0] : null;
  calls.push({ u, method, raw, body, rpc, table });

  if (u.includes("api.anthropic.com")) {
    // The classifier's contract is the only prompt that asks for summary_so_far.
    const classifier = raw.includes("summary_so_far");
    const model = (body && body.model) || "";
    if (world.down === "all" || (world.down === "sonnet" && !classifier && /sonnet/.test(model))) {
      return reply(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    }
    if (classifier) {
      return reply(200, anthropicMessage(model, { intent: "career_advice", confidence: 0.9, needs_tool: false, is_correction: false, faq_id: null,
        summary_so_far: "s", missing_information: [], recommended_specialist: null, conversation_stage: "pathway", next_best_action: null,
        ...world.classification }));
    }
    answers.push(raw);
    return reply(200, anthropicMessage(model, { reply: world.reply, profile_updates: null }));
  }
  if (u.includes("/chat/completions")) {
    answers.push(raw);
    return reply(200, { id: "chatcmpl", model: "fallback-model",
      choices: [{ message: { role: "assistant", content: JSON.stringify({ reply: world.reply }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10 } });
  }
  if (u.includes("/auth/v1/user")) return reply(200, { id: world.uid });
  if (rpc === "reserve_scout_question") return reply(200, { allowed: true, used: 1 });
  if (rpc) return reply(200, {});
  if (table === "profiles") return reply(200, [{ plan: "pro", is_admin: false, ai_unlimited: false, full_access: false,
    goal_defined: true, goal_text: "Play NCAA D1 soccer", goal_source: "athlete_edited", full_name: "Test Athlete", occupation: "Player" }]);
  if (table === "athletes") return reply(200, [{ sport: "Soccer", position: "Winger", country: "USA", club_name: "Northfield FC" }]);
  if (table === "pathway_plan" && method === "GET") {
    return world.pathway === "fail" ? reply(500, { message: "upstream timeout" }) : reply(200, world.pathway ? [world.pathway] : []);
  }
  if (table === "scout_faq") return reply(200, FAQ);
  if (table === "scout_response_cache" && method === "GET") {
    return reply(200, world.cache && u.includes("cache_key=eq.simple_knowledge") ? [{ id: 1, response: JSON.parse(JSON.stringify(world.cache)), hit_count: 0 }] : []);
  }
  return reply(200, []);
};

function mkRes() {
  const r = { statusCode: null, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.end = () => r;
  return r;
}

const handler = require(REPO + "/api/scout.js").default;
let seq = 0;
// One question, as the app sends it: the latest turn is "ATHLETE: <words>".
async function ask(scenario, content) {
  seq++;
  world = { uid: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, pathway: ROW, classification: {}, reply: HONEST, ...scenario };
  calls = []; answers = []; logs = { warn: [], error: [] };
  const req = {
    method: "POST",
    headers: { authorization: "Bearer test.jwt.token", "content-type": "application/json" },
    body: { messages: [{ role: "user", content }], lang: "en", today: DAY, requestId: "req-" + seq, conversationId: "conv-" + seq },
  };
  const res = mkRes();
  const keep = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = (...a) => logs.warn.push(a.map(String).join(" "));
  console.error = (...a) => logs.error.push(a.map(String).join(" "));
  try { await handler(req, res); } finally { Object.assign(console, keep); }
  if (res.statusCode !== 200) console.log("   (handler errors:", JSON.stringify(logs.error), ")");
  const made = calls.slice();
  return {
    status: res.statusCode, body: res.body || {}, answers: answers.slice(), calls: made, logs,
    writes: (table) => made.filter((c) => c.table === table && c.method !== "GET"),
  };
}
const typed = (q) => `ATHLETE: ${q}`;
const TODAY_Q = typed("What should I do today?");
// What the model was told last, and how a phrase sits inside that JSON body.
const told = (r) => r.answers[r.answers.length - 1] || "";
const esc = (s) => JSON.stringify(s).slice(1, -1);
const guardRows = (r) => r.writes("error_log").filter((c) => c.body && c.body.source === "scout_today_guard");
const guardWarns = (r) => r.logs.warn.filter((l) => l.includes("today answer"));
const TODAY_KEYS = ["today_card", "today_override", "today_unavailable"];
const keysIn = (body) => TODAY_KEYS.map((k) => k in body);
// The reply the athlete sees, whichever shape it came back in.
const said = (body) => {
  if (typeof body.reply_text === "string") return body.reply_text;
  try { return JSON.parse(body.content[0].text).reply; } catch { return null; }
};
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o ? o[k] : undefined]));

(async () => {
  console.log("-- the plan and the day this suite runs on --");
  ck("the app's day is taken as theirs (the clock is pinned to it)", S.resolveAthleteDay(DAY, Date.now()).source, "device");
  ck("Home for that day: 0 of 1 today, 0 of 3 this week, nothing late",
     [HOME.todayDone, HOME.todayTotal, HOME.weekDone, HOME.weekTotal, HOME.lateCount], [0, 1, 0, 3, 0]);
  ck("...its Today tile lists the one step due today and names it next", [TILE.todayOpen, TILE.next.label], [[STEP_TODAY], STEP_TODAY]);

  console.log("\n-- an honest answer: the card is Home's, the reply goes back untouched --");
  const honest = await ask({}, TODAY_Q);
  const card = honest.body.today_card || {};
  ck("200", honest.status, 200);
  ck("today_card is todayCard() over dayBuckets for that plan and day", honest.body.today_card, EXPECTED);
  const BUCKET_KEYS = ["today", "weekday", "todayTotal", "todayDone", "todayOpen", "todayOpenMore", "weekTotal", "weekDone", "lateCount"];
  ck("...every number dayBuckets gives", pick(card, BUCKET_KEYS), pick(S.dayBuckets(PLAN, DAY, false), BUCKET_KEYS));
  ck("...which are the numbers Home's own code shows: TODAY, THIS WEEK, late",
     [card.today, card.todayDone, card.todayTotal, card.weekDone, card.weekTotal, card.lateCount],
     [HOME.today, HOME.todayDone, HOME.todayTotal, HOME.weekDone, HOME.weekTotal, HOME.lateCount]);
  ck("...todayOpen is the 1 label due today, as Home's Today tile lists it", [card.todayOpen, TILE.todayOpen], [[STEP_TODAY], [STEP_TODAY]]);
  ck("...weekDone/weekTotal 0/3", [card.weekDone, card.weekTotal], [0, 3]);
  ck("...and next is the step Home's Today tile names", card.next && card.next.label, TILE.next.label);
  ck("no today_override and no today_unavailable", [("today_override" in honest.body), ("today_unavailable" in honest.body)], [false, false]);
  ck("reply_text is the model's reply, unchanged", honest.body.reply_text, HONEST);
  ck("nothing logged by the guard", [guardRows(honest).length, guardWarns(honest).length], [0, 0]);
  ck("the model was called once to answer", honest.answers.length, 1);
  ck("the model is told the new quoting rule", told(honest).includes(esc(RULE)), true);
  ck("...at the end of the TODAY FOR THEM line",
     told(honest).includes(esc(`Use only dates written in this context; never work out another date or weekday yourself. ${RULE}`)), true);
  ck("...which has their own day", told(honest).includes(esc("TODAY FOR THEM: Thursday 2026-11-12 (their own calendar day).")), true);
  ck("...Home's numbers for today, with the step open today in quotes",
     told(honest).includes(esc(`Due today: 0 of 1 done; still open today: "${STEP_TODAY}".`)), true);
  ck("...and this week's", told(honest).includes(esc("This week: 0 of 3 dated steps done.")), true);
  const replay = honest.writes("scout_response_cache").find((c) => c.body && String(c.body.cache_key).startsWith("req:"));
  ck("the replay a retry would get carries the same card", replay && replay.body.response.today_card, EXPECTED);

  // An answer that says something the plan does not: flagged, text untouched,
  // and the guard's log names what kind of thing it was, never the words.
  for (const [what, text, kind, piece] of [
    ["an invented ISO date", INVENTED_DATE, "date", "2026-11-16"],
    ["an invented quoted step", INVENTED_STEP, "step", "Film three full matches"],
    ["a wrong this-week count", WRONG_WEEK, "count", "2 of 3"],
    ["the whole plan's count given as this week's", PLAN_AS_WEEK, "count", "1 of 6"],
  ]) {
    console.log(`\n-- ${what} --`);
    const r = await ask({ reply: text }, TODAY_Q);
    ck("200", r.status, 200);
    ck("today_override is true", r.body.today_override, true);
    ck("today_card is still there, unchanged", r.body.today_card, EXPECTED);
    ck("reply_text is left as it was", r.body.reply_text, text);
    const rows = guardRows(r);
    ck(`one scout_today_guard row in error_log, naming the kind: ${kind}`, rows.map((x) => x.body.detail && x.body.detail.kinds), [[kind]]);
    ck("...and which model answered, for whoever reads it", rows.map((x) => x.body.detail && x.body.detail.model), ["claude-sonnet-5"]);
    ck("nothing written to error_log holds the reply, or the piece of it the check found",
       r.writes("error_log").some((x) => x.raw.includes(text) || x.raw.includes(piece)), false);
    ck("console.warn says it once, with the kind and none of the reply",
       [guardWarns(r).length, guardWarns(r).some((l) => l.includes(`"${kind}"`)), guardWarns(r).some((l) => l.includes(piece) || l.includes(text))],
       [1, true, false]);
  }
  console.log("\n-- the whole plan's count said as the whole plan's --");
  {
    const r = await ask({ reply: PLAN_OVERALL }, TODAY_Q);
    ck("passes: the prompt gives the model that pair (1 of 6 already done)", [("today_override" in r.body), guardRows(r).length], [false, 0]);
    ck("...and it is in what the model was told", told(r).includes(esc("1 of 6 already done")), true);
  }

  console.log("\n-- the FAQ never answers a today question about their plan --");
  const FAQ_MATCH = { intent: "simple_knowledge", confidence: 0.95, faq_id: 7 };
  {
    const r = await ask({ classification: FAQ_MATCH }, TODAY_Q);
    ck("the classifier's FAQ match is not served", said(r.body) === FAQ_ANSWER, false);
    ck("the model is called instead, and its reply goes back with the card", [r.answers.length, r.body.reply_text, r.body.today_card], [1, HONEST, EXPECTED]);
    const other = await ask({ classification: FAQ_MATCH }, typed("What is a redshirt year?"));
    ck("control: the same match on another question is served from the FAQ, with no model call",
       [said(other.body), other.answers.length], [FAQ_ANSWER, 0]);
    ck("...and no card", keysIn(other.body), [false, false, false]);
  }

  console.log("\n-- nor does the response cache --");
  const CACHEABLE = { intent: "simple_knowledge", confidence: 0.95, faq_id: null };
  {
    const r = await ask({ classification: CACHEABLE, cache: CACHED }, TODAY_Q);
    ck("the cached reply is not served", said(r.body) === "CACHED ANSWER", false);
    ck("the response cache is not even read",
       r.calls.some((c) => c.table === "scout_response_cache" && c.method === "GET" && c.u.includes("cache_key=eq.simple_knowledge")), false);
    ck("the model answers, with the card", [r.answers.length, r.body.reply_text, r.body.today_card], [1, HONEST, EXPECTED]);
    ck("...and nothing is written to the response cache, only the replay",
       r.writes("scout_response_cache").map((c) => String(c.body && c.body.cache_key).split(":")[0]), ["req"]);
    // The classifier matched no FAQ entry. That is not a gap in the FAQ: no
    // stored answer could ever answer this for them.
    ck("...and the question is not logged as a gap in the FAQ", r.writes("scout_faq_misses").length, 0);
    const other = await ask({ classification: CACHEABLE, cache: CACHED }, typed("What is a redshirt year?"));
    ck("control: another question is served from that cache, with no model call", [said(other.body), other.answers.length], ["CACHED ANSWER", 0]);
    ck("control: and it is logged as an FAQ gap", other.writes("scout_faq_misses").length, 1);
  }

  console.log("\n-- every way a reply goes back runs the guard --");
  for (const [path, scenario, routed] of [
    ["the fast model (Haiku)", { classification: CACHEABLE }, ["haiku", "none"]],
    ["the deep reply (Sonnet)", {}, ["sonnet", "none"]],
    ["the Haiku failover, every Sonnet attempt down", { down: "sonnet" }, ["haiku", "haiku_cross_model"]],
    ["the cross-provider failover, Anthropic down", { down: "all" }, ["cross_provider", "cross_provider"]],
  ]) {
    const r = await ask({ ...scenario, reply: INVENTED_STEP }, TODAY_Q);
    ck(`${path}: answered there`, r.writes("scout_routing_log").map((c) => [c.body.answered_by, c.body.fallback_used]), [routed]);
    ck(`${path}: 200 with the card, the override and the reply untouched`,
       [r.status, r.body.today_card, r.body.today_override, r.body.reply_text], [200, EXPECTED, true, INVENTED_STEP]);
    ck(`${path}: one guard row`, guardRows(r).length, 1);
  }

  console.log("\n-- no card where there is nothing to hold the answer to --");
  {
    const other = await ask({ reply: INVENTED_STEP }, typed("Which clubs fit me?"));
    ck("a non-today question: no today_card, no override, nothing unavailable", keysIn(other.body), [false, false, false]);
    ck("...no rule in the prompt, no guard row", [told(other).includes(esc(RULE)), guardRows(other).length], [false, 0]);
    const none = await ask({ pathway: null, reply: INVENTED_STEP }, TODAY_Q);
    ck("an athlete with no pathway: no card and no override", keysIn(none.body), [false, false, false]);
    ck("...no rule in the prompt, no guard row", [told(none).includes(esc(RULE)), guardRows(none).length], [false, 0]);
    const shell = await ask({ pathway: SHELL, reply: INVENTED_STEP }, TODAY_Q);
    ck("a plan with no steps (Home shows 'set your goal'): no card and no override", keysIn(shell.body), [false, false, false]);
  }

  console.log("\n-- the plan cannot be read --");
  {
    const r = await ask({ pathway: "fail", reply: UNREAD_REPLY }, TODAY_Q);
    ck("200", r.status, 200);
    ck("today_card null and today_unavailable true", [("today_card" in r.body), r.body.today_card, r.body.today_unavailable], [true, null, true]);
    ck("...and no override for a reply that says it could not load the plan", "today_override" in r.body, false);
    ck("the model is told the plan could not be loaded, on the TODAY FOR THEM line",
       told(r).includes(esc(`never work out another date or weekday yourself. ${UNREAD_RULE}`)), true);
    ck("...and is not handed the rule that assumes it has the steps", told(r).includes(esc(RULE)), false);
    const invents = await ask({ pathway: "fail", classification: FAQ_MATCH, reply: INVENTED_STEP }, TODAY_Q);
    ck("a stored FAQ answer is not served there either: the model is told, and answers", [said(invents.body), invents.answers.length], [INVENTED_STEP, 1]);
    ck("...and a reply that names a step anyway is flagged",
       [invents.body.today_card, invents.body.today_unavailable, invents.body.today_override], [null, true, true]);
    ck("...logged as a plan that could not be read", guardRows(invents).map((x) => x.body.detail.plan_unavailable), [true]);
  }

  console.log("\n-- the app's wire format, and its What's next button --");
  {
    const nextButton = JSON.parse((/\bscout_big_next: ("(?:[^"\\]|\\.)*")/.exec(APP) || [])[1] || "null");
    ck("the button's English text is read from the app", nextButton, "What's next for me?");
    const wire = `LATEST RECORDED BENCHMARKS: {"30m sprint":"4.1s"}\n\nATHLETE: ${nextButton}`;
    ck("control: the turn as sent is no today question to the patterns alone", S.isTodayQuestion(wire), false);
    ck("typedQuestion hands them what was typed", [S.typedQuestion(wire), S.typedQuestion("COACH: What is due this week?")], [nextButton, "What is due this week?"]);
    ck("...and text with no label as it is", [S.typedQuestion("What's next for me?"), S.typedQuestion("Note: plan"), S.typedQuestion(null)], ["What's next for me?", "Note: plan", ""]);
    const r = await ask({}, wire);
    ck("the button, sent as the app sends it, gets the card", r.body.today_card, EXPECTED);
    const tonight = await ask({}, typed("Today, what should I focus on?"));
    ck("so does a question that starts with 'Today,'", tonight.body.today_card, EXPECTED);
  }

  console.log("\n-- a check that throws: the reply is kept, and not passed as checked --");
  {
    // finishTodayAnswer itself, lifted, with a checker that throws.
    const from = SCOUT.indexOf("async function finishTodayAnswer(data, ctx) {");
    const src = SCOUT.slice(from, SCOUT.indexOf("\n}\n", from) + 3);
    const logged = [], warned = [], errored = [];
    const stubConsole = { log: () => {}, warn: (...a) => warned.push(a.join(" ")), error: (...a) => errored.push(a.join(" ")) };
    const finish = new Function("checkReplyAgainstPlan", "logError", "console", `${src}\nreturn finishTodayAnswer;`)(
      () => { throw new TypeError("Cannot read properties of undefined (reading 'toLowerCase')"); },
      async (...a) => { logged.push(a); }, stubConsole);
    const data = { reply_text: INVENTED_STEP, model: "claude-sonnet-5" };
    await finish(data, { card: EXPECTED, unavailable: false, lang: "en", requestId: "req-x" });
    ck("the card goes back", data.today_card, EXPECTED);
    ck("the reply is flagged rather than vouched for, and kept as it was", [data.today_override, data.reply_text], [true, INVENTED_STEP]);
    ck("logged once as a check that failed", logged.map((a) => [a[0], a[2].kinds]), [["scout_today_guard", ["check_failed"]]]);
    ck("...and nothing logged holds the reply", JSON.stringify([logged, warned, errored]).includes("Film three"), false);
    const none = {};
    await finish(none, null);
    ck("no today question: the reply is not touched at all", none, {});
  }

  console.log("\n-- the guard sits on every reply the handler sends --");
  {
    const H = SCOUT.slice(SCOUT.indexOf("export default async function handler"));
    ck("the handler's 200s: a replay, the FAQ, a cache hit, and four replies",
       [...H.matchAll(/return res\.status\(200\)\.json\((\w+)\)/g)].map((m) => m[1]), ["replayed", "payload", "cached", "data", "data", "data", "data"]);
    const chunks = H.split(/return res\.status\(200\)\.json\(data\)/).slice(0, 4);
    const GUARD = "await finishTodayAnswer(data, todayAnswer);";
    ck("...each of the four runs finishTodayAnswer once", chunks.map((c) => c.split(GUARD).length - 1), [1, 1, 1, 1]);
    ck("...after the last field is attached and before the replay is written", chunks.map((c) => {
      const g = c.lastIndexOf(GUARD), w = c.lastIndexOf('setCachedResponse(replayCacheKey(userId, requestId), "replay"');
      return g > c.lastIndexOf("data.drafted_email = extractDraftedEmail(data);") && (w < 0 || g < w);
    }), [true, true, true, true]);
  }

  console.log("\n-- the rule lives in api/scout.js only --");
  // CLAUDE.md asked for each SYSTEM_PROMPT change to be mirrored into
  // golsz-app.html's SYS. That copy was deleted as dead code on 2026-08-08
  // (49e5b5c: it fed a browser-to-Anthropic fallback that could never run), so
  // there is nothing to mirror into, and nothing that can drift from the rule.
  ck("golsz-app.html holds no copy of Scout's prompt", [/\bconst SYS\s*=/.test(APP), APP.includes("You are GOLSZ Scout")], [false, false]);
  ck("api/scout.js states the rule once", SCOUT.split(RULE).length - 1, 1);

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log("FAIL  the suite crashed:", e && e.stack); console.log(`\n${p}/${p + f + 1} passed`); process.exit(1); });
