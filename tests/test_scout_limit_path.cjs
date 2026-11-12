// OUT OF QUESTIONS: SCOUT SAYS SO, WITH THE COUNT.
//
// AVA job 216 t4. An athlete who has used today's Scout questions must be told
// so plainly, with the number, and must never be left tapping a box that
// cannot answer. Two halves, both run from the real source:
//
//   SERVER  the exported handler of api/scout.js, every network call mocked
//           and recorded in order. reserve_scout_question answers
//           allowed:false; the suite reads the reply AND the calls the
//           handler made before it, so "refused before any plan work or model
//           call" is a fact about the request log, not about the reply text.
//   CLIENT  scoutFailureFor and the outOfQuestions rule lifted out of
//           golsz-app.html, then the real Scout component mounted with stand-in
//           hooks and driven like a person: type the question, tap send, read
//           what is on screen (the bubble, ScoutBalls, ScoutLimitCard, and
//           whether a text box is left to type into).
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { S } = require("./_day_parity.cjs");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "svc";
process.env.ANTHROPIC_API_KEY = "sk-test";

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

/* ======================================================================
   SERVER
   ====================================================================== */

// The server's own calendar day, which is also what the app sends as `today`.
const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_QUESTION = "What should I do today?";
// A real plan with steps due today, the athlete Home would show "0/2".
const DATED_PLAN = {
  pathway_type: "ncaa", target_timeline: null, baseline_complete: true, stages: null, current_stage_id: null,
  milestones: [
    { id: "m1", label: "Film a 2-minute highlight clip", due: TODAY, done: false },
    { id: "m2", label: "Email Coach Rivera", due: TODAY, done: false },
    { id: "m3", label: "Retest the 30 m sprint", due: S.shiftDayKey(TODAY, 2), done: false },
  ],
};
// An empty plan of the wrong type for an unambiguous goal: the handler
// corrects its pathway_type (autoFixPathwayType, a PATCH) when it reads it.
const SHELL_PLAN = { ...DATED_PLAN, pathway_type: "juco", milestones: [] };

let world = null;     // what the mocked services answer, per scenario
let calls = [];       // every request the handler made, in order
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String(opts.method || "GET").toUpperCase();
  const raw = opts.body ? String(opts.body) : "";
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  const rpc = u.includes("/rest/v1/rpc/") ? u.slice(u.indexOf("/rest/v1/rpc/") + 13).split("?")[0] : null;
  const table = !rpc && u.includes("/rest/v1/") ? u.slice(u.indexOf("/rest/v1/") + 9).split("?")[0] : null;
  const anthropic = u.includes("api.anthropic.com");
  calls.push({ u, method, body, rpc, table, anthropic });

  if (anthropic) {
    // The classifier's contract is the only prompt that asks for summary_so_far.
    if (raw.includes("summary_so_far")) {
      return reply(200, { id: "c", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: "text", text: JSON.stringify({ intent: "career_advice", confidence: 0.9, needs_tool: false, faq_id: null,
          summary_so_far: "s", missing_information: [], recommended_specialist: null, next_best_action: null, ...(world.classification || {}) }) }] });
    }
    return reply(200, { id: "r", stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 },
      content: [{ type: "text", text: JSON.stringify({ reply: "Film your highlight clip first, then email Coach Rivera.", profile_updates: null }) }] });
  }
  if (u.includes("/auth/v1/user")) return reply(200, { id: world.uid });
  if (rpc === "reserve_scout_question") return world.reserve === "down" ? reply(500, { message: "boom" }) : reply(200, world.reserve);
  if (rpc === "reserve_free_ai_question") return reply(200, world.freeAi || { allowed: true, used: 1 });
  if (rpc) return reply(200, {});
  if (table === "profiles") return reply(200, [{ id: world.uid, plan: world.plan, is_admin: false, ai_unlimited: false, full_access: false,
    goal_defined: true, goal_text: "Play NCAA D1 soccer", goal_source: "athlete_edited", full_name: "Test Athlete", occupation: "Player" }]);
  if (table === "athletes") return reply(200, [{ sport: "Soccer", position: "Winger", country: "USA", club_name: "Northfield FC" }]);
  if (table === "pathway_plan" && method === "GET") return reply(200, world.pathway ? [world.pathway] : []);
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

let seq = 0;
async function ask(handler, scenario, question) {
  world = { uid: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, ...scenario };
  calls = [];
  const req = {
    method: "POST",
    headers: { authorization: "Bearer test.jwt", "content-type": "application/json" },
    body: { messages: [{ role: "user", content: `ATHLETE: ${question}` }], lang: "en", today: TODAY,
      requestId: "req-" + seq, conversationId: "conv-" + seq },
  };
  const res = mkRes();
  await handler(req, res);
  const made = calls.slice();
  const writes = made.filter((c) => c.method !== "GET").map((c) => c.rpc ? "rpc/" + c.rpc : `${c.method} ${c.table || c.u}`);
  return { status: res.statusCode, body: res.body || {}, made, writes, uid: world.uid,
    anthropic: made.filter((c) => c.anthropic).length, rpcs: made.filter((c) => c.rpc) };
}

async function serverHalf(handler) {
  console.log("-- a today question at the daily limit is refused, with the count --");
  ck("the question is one the server's own rule calls a today question", S.isTodayQuestion(TODAY_QUESTION), true);
  {
    const r = await ask(handler, { plan: "free", pathway: DATED_PLAN, reserve: { allowed: false, used: 4, limit: 3 } }, TODAY_QUESTION);
    ck("402", r.status, 402);
    ck("code daily_limit_reached", r.body.code, "daily_limit_reached");
    ck("scout_usage says none of the free plan's 3 are left", r.body.scout_usage, { remaining: 0, limit: 3 });
    ck("the free plan is offered an upgrade", r.body.can_upgrade, true);
    ck("the refusal carries the limit and nothing else: no answer, no plan, no today card",
       Object.keys(r.body).sort(), ["can_upgrade", "code", "error", "scout_usage"]);
    ck("no Anthropic request was made", r.anthropic, 0);
    const reserve = r.rpcs.filter((c) => c.rpc === "reserve_scout_question");
    ck("one reservation, against the free plan's limit, for this athlete",
       reserve.map((c) => c.body), [{ p_user: r.uid, p_plan_limit: 3 }]);
    ck("the reservation is the last call the handler made", r.made[r.made.length - 1].rpc, "reserve_scout_question");
    // The plan rows are READ before the gate: they ride in the same round
    // trip as the profile read that says which plan (and limit) applies.
    // Nothing is written, and nothing is asked of a model.
    ck("the only write is the reservation itself", r.writes, ["rpc/reserve_scout_question"]);
    ck("a refused ask is not refunded (the counter counts asks, migration 126)",
       r.rpcs.some((c) => c.rpc === "release_scout_question"), false);
    ck("...and does not touch the free lifetime budget", r.rpcs.some((c) => c.rpc === "reserve_free_ai_question"), false);
  }

  console.log("\n-- the same refusal before the plan is corrected --");
  {
    // An empty plan whose type disagrees with an unambiguous goal is corrected
    // (PATCH pathway_plan) on an answered question. At the limit nothing is
    // answered, so nothing about the plan is changed either.
    const r = await ask(handler, { plan: "free", pathway: SHELL_PLAN, reserve: { allowed: false, used: 3, limit: 3 } }, TODAY_QUESTION);
    ck("402 daily_limit_reached", [r.status, r.body.code], [402, "daily_limit_reached"]);
    ck("no write to the plan before the refusal", r.writes, ["rpc/reserve_scout_question"]);
    ck("no Anthropic request was made", r.anthropic, 0);
    // Control: with an allowance the same athlete's plan IS corrected, so the
    // assertion above can fail.
    const ok = await ask(handler, { plan: "free", pathway: SHELL_PLAN, reserve: { allowed: true, used: 1, limit: 3 } }, TODAY_QUESTION);
    ck("control: an answered question does correct that plan", ok.writes.includes("PATCH pathway_plan"), true);
    ck("control: ...and is answered", [ok.status, !!ok.body.reply_text], [200, true]);
  }

  console.log("\n-- every plan: its own limit, and an upgrade only where there is one --");
  for (const [plan, limit, canUpgrade] of [["starter", 8, true], ["pro", 15, true], ["elite", 20, false]]) {
    const r = await ask(handler, { plan, pathway: DATED_PLAN, reserve: { allowed: false, used: limit + 1, limit } }, TODAY_QUESTION);
    ck(`${plan}: 402 daily_limit_reached, 0 of ${limit} left, can_upgrade ${canUpgrade}, no model call`,
       [r.status, r.body.code, r.body.scout_usage, r.body.can_upgrade, r.anthropic],
       [402, "daily_limit_reached", { remaining: 0, limit }, canUpgrade, 0]);
  }

  console.log("\n-- the free plan's lifetime budget: 403, the count, and the day given back --");
  {
    const r = await ask(handler, { plan: "free", pathway: DATED_PLAN, reserve: { allowed: true, used: 2, limit: 3 },
      freeAi: { allowed: false, used: 41, limit: 40 } }, TODAY_QUESTION);
    ck("403", r.status, 403);
    ck("code free_ai_exhausted", r.body.code, "free_ai_exhausted");
    ck("scout_usage says none are left", r.body.scout_usage, { remaining: 0, limit: 3 });
    ck("the refusal carries the limit and nothing else", Object.keys(r.body).sort(), ["code", "error", "scout_usage"]);
    ck("no Anthropic request was made", r.anthropic, 0);
    const release = r.rpcs.filter((c) => c.rpc === "release_scout_question");
    ck("the daily question reserved for it is given back, for this athlete", release.map((c) => c.body), [{ p_user: r.uid }]);
    const order = r.rpcs.map((c) => c.rpc);
    ck("...after the lifetime check refused it",
       order.indexOf("release_scout_question") > order.indexOf("reserve_free_ai_question"), true);
  }
  {
    // reserve_scout_question failed (HTTP 500) and failed OPEN: nothing was
    // counted, so there is nothing to give back. Releasing here would hand
    // back a question the athlete really did ask earlier today.
    const r = await ask(handler, { plan: "free", pathway: DATED_PLAN, reserve: "down",
      freeAi: { allowed: false, used: 41, limit: 40 } }, TODAY_QUESTION);
    ck("metering down: still 403 free_ai_exhausted", [r.status, r.body.code], [403, "free_ai_exhausted"]);
    ck("...and nothing is released, because nothing was reserved",
       r.rpcs.some((c) => c.rpc === "release_scout_question"), false);
  }

  console.log("\n-- the last allowed question is answered, and says none are left --");
  {
    const r = await ask(handler, { plan: "free", pathway: DATED_PLAN, reserve: { allowed: true, used: 3, limit: 3 } }, TODAY_QUESTION);
    ck("200 with a real answer", [r.status, !!r.body.reply_text], [200, true]);
    ck("...and scout_usage 0 of 3, so the app can close the box before the next tap", r.body.scout_usage, { remaining: 0, limit: 3 });
    ck("...and the question is not refunded", r.rpcs.some((c) => c.rpc === "release_scout_question"), false);
  }

  console.log("\n-- a refunded question is counted as given back --");
  {
    // A free athlete's third question asks for a database search, which the
    // free plan does not include: refused, and the question is refunded. The
    // count it reports must include the refund, or the app shows "That's all 3
    // for today" while one is still left.
    const r = await ask(handler, { plan: "free", pathway: DATED_PLAN, reserve: { allowed: true, used: 3, limit: 3 },
      classification: { intent: "db_lookup", needs_tool: true } }, "Search the GOLSZ database for wingers like me");
    ck("402 free_tool_blocked", [r.status, r.body.code], [402, "free_tool_blocked"]);
    ck("the question is given back", r.rpcs.filter((c) => c.rpc === "release_scout_question").length, 1);
    ck("...so 1 of 3 is left, not 0", r.body.scout_usage, { remaining: 1, limit: 3 });
    const down = await ask(handler, { plan: "free", pathway: DATED_PLAN, reserve: "down",
      classification: { intent: "db_lookup", needs_tool: true } }, "Search the GOLSZ database for wingers like me");
    ck("metering down: no count is invented (nothing was reserved or given back)",
       [down.status, down.body.code, down.body.scout_usage], [402, "free_tool_blocked", undefined]);
  }
}

/* ======================================================================
   CLIENT
   ====================================================================== */

const between = (src, a, b, label) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`could not slice ${label}: markers moved, update this suite`);
  return src.slice(i, j);
};

// ---- the app's own code, compiled on demand ------------------------------
// The real Scout component, its helpers and child components, run with
// stand-in hooks: tests/_app_mount.cjs (shared with test_scout_today_card.cjs).
const { React, makeScope, mount, settle } = require("./_app_mount.cjs");

// The signed-in athlete's own rows, as Scout's mount-time restore reads them.
function makeSb(log) {
  const ROWS = {
    profiles: { full_name: "Test Athlete", dob: null, occupation: "Player" },
    athletes: { sport: "Soccer", position: "Winger", country: "USA", club_name: "Northfield FC" },
    pathway_plan: DATED_PLAN,
  };
  const from = (table) => {
    const q = { table, single: false };
    const self = {
      select: () => self, eq: () => self, order: () => self, limit: () => self,
      single: () => { q.single = true; return self; }, maybeSingle: () => { q.single = true; return self; },
      insert: (row) => { log.writes.push({ table, row }); return Promise.resolve({ data: null, error: null }); },
      then: (res, rej) => Promise.resolve({ data: q.single ? (ROWS[table] || null) : [], error: null }).then(res, rej),
    };
    return self;
  };
  return {
    from,
    auth: { getUser: async () => ({ data: { user: { id: "athlete-1" } } }),
            getSession: async () => ({ data: { session: { access_token: "athlete-token" } } }) },
  };
}

async function clientHalf(handler) {
  const I18N = makeScope({ React }).get("I18N");
  const LANGS = ["en", "fr", "es", "el"];
  const t = (k) => (typeof I18N.en[k] === "string" ? I18N.en[k] : k);

  console.log("\n-- scoutFailureFor and the outOfQuestions rule, lifted from golsz-app.html --");
  const scoutFailureFor = new Function(between(APP, "function scoutFailureFor(", "// ---- Scout photos", "scoutFailureFor") + "\nreturn scoutFailureFor;")();
  const OUT_RULE = between(APP, "  const outOfQuestions = limitHit", ";\n", "the outOfQuestions rule") + ";";
  const outOfQuestions = new Function("limitHit", "scoutUsage", OUT_RULE + "\nreturn outOfQuestions;");
  const daily402 = (limit, canUpgrade) => ({ error: "Free daily limit reached.", code: "daily_limit_reached", can_upgrade: canUpgrade, scout_usage: { remaining: 0, limit } });
  {
    const free = scoutFailureFor(402, daily402(3, true), t);
    ck("a daily 402 gives non-empty text", typeof free.text === "string" && free.text.trim().length > 0, true);
    ck("...says the count and when more come", free.text, "You've used today's Scout questions. 0 of 3 left today. More tomorrow.");
    ck("...offers the upgrade, not a retry, and hands back the code",
       [free.upgrade, free.retry, free.code], [true, false, "daily_limit_reached"]);
    const elite = scoutFailureFor(402, daily402(20, false), t);
    ck("Elite: no upgrade (there is none), same count sentence with Elite's limit",
       [elite.upgrade, elite.retry, elite.text], [false, false, "You've used today's Scout questions. 0 of 20 left today. More tomorrow."]);
    for (const lang of LANGS) {
      const s = I18N[lang].scout_err_daily_left;
      ck(`${lang}: the count sentence exists, with the number in it`,
         typeof s === "string" && s.includes("{n}") && s.includes("0"), true);
      const text = scoutFailureFor(402, daily402(8, true), (k) => I18N[lang][k]).text;
      ck(`${lang}: the bubble reads 0 of 8`, text.includes("8") && !text.includes("{n}"), true);
    }
    // No scout_usage (a server from before it sent one): no number is guessed.
    ck("no limit known: the sentence without a number", scoutFailureFor(402, { code: "daily_limit_reached" }, t).text, t("scout_err_daily_limit"));
    // The lifetime cap's wording is not touched by this change.
    const life = scoutFailureFor(403, { code: "free_ai_exhausted", scout_usage: { remaining: 0, limit: 3 } }, t);
    ck("the lifetime refusal keeps its own wording", [life.text, life.upgrade, life.code],
       [t("scout_err_free_exhausted"), true, "free_ai_exhausted"]);

    ck("usage {remaining:0} makes outOfQuestions 'daily'", outOfQuestions(null, { remaining: 0, limit: 3 }), "daily");
    ck("...one left is not out", outOfQuestions(null, { remaining: 1, limit: 3 }), null);
    ck("...no usage (an unlimited account) is never out", outOfQuestions(null, null), null);
    ck("...a refusal the server sent wins", [outOfQuestions("life", { remaining: 0, limit: 3 }), outOfQuestions("daily", null)], ["life", "daily"]);
  }

  // ---- the real Scout component, driven like a person ----------------------
  // Its request to /api/scout goes to the REAL handler above, so what the
  // screen shows is what the server really answered to what the app really
  // sent.
  async function openScout(plan, scenario) {
    const log = { app: [], writes: [], errors: [], server: null };
    const fetchFromApp = async (url, opts = {}) => {
      const u = String(url);
      log.app.push(u);
      if (u === "/api/moderate") return { ok: true, status: 200, json: async () => ({ decision: "allow" }) };
      if (u !== "/api/scout") throw new Error("unexpected request from the app: " + u);
      world = { uid: `00000000-0000-4000-9000-${String(++seq).padStart(12, "0")}`, plan, ...scenario };
      calls = [];
      const headers = {};
      for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
      const res = mkRes();
      await handler({ method: opts.method, headers, body: JSON.parse(opts.body) }, res);
      log.server = { status: res.statusCode, calls: calls.slice(), sent: JSON.parse(opts.body) };
      const wire = JSON.stringify(res.body);
      return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(wire) };
    };
    const scope = makeScope({
      React, useState: React.useState, useRef: React.useRef, useEffect: React.useEffect,
      sb: makeSb(log), fetch: fetchFromApp, AbortSignal: undefined,
      useLang: () => ({ t, lang: "en" }),
      console: { log() {}, warn() {}, info() {}, error: (...a) => log.errors.push(a.map(String).join(" ")) },
    });
    let upgrades = 0;
    const ui = mount(scope.get("Scout"), { plan, onUpgrade: () => { upgrades++; }, onGoToProfile() {}, onNavigate() {},
      actingFor: null, seedPrompt: null, onSeedSent() {} });
    await settle();   // the mount-time restore: greeting, profile, plan
    const textBox = () => ui.find((n) => n.type === "textarea");
    const sendButton = () => ui.find((n) => n.type === "button" && n.props.title === t("scout_send"));
    const lastBubble = () => ui.findAll((n) => n.props && n.props.className === "msg").slice(-1)[0] || null;
    return {
      ui, log, textBox, sendButton,
      // Everything a tap could send: the text box, its send button, and the
      // row of reply chips under the conversation (each chip sends a question).
      ways: () => [!!textBox(), !!sendButton(), ui.findAll((n) => n.props && n.props.className === "noscroll").length],
      async askToday() {
        textBox().props.onChange({ target: { value: TODAY_QUESTION } });
        await sendButton().props.onClick();
        await settle();
      },
      // The newest message on screen: what it says (its text block, not the
      // time stamp under it) and the labels of its buttons.
      last: () => { const b = lastBubble(); if (!b) return null;
        const said = ui.find((n) => n.type === "div" && n.props.style && n.props.style.whiteSpace === "pre-wrap", b);
        return { text: said ? ui.textOf(said).trim() : "", buttons: ui.findAll((n) => n.type === "button", b).map((n) => ui.textOf(n).trim()) }; },
      // A child component is drawn the way React would: its own function, its own props.
      balls: () => { const el = ui.byType("ScoutBalls")[0]; return el ? { usage: el.props.usage, text: mount(el.type, el.props).text() } : null; },
      card: () => { const el = ui.byType("ScoutLimitCard")[0]; if (!el) return null; const c = mount(el.type, el.props);
        return { kind: el.props.kind, text: c.text(), upgradeButton: !!c.find((n) => n.type === "button") }; },
    };
  }
  const scoutRequests = (s) => s.log.app.filter((u) => u === "/api/scout").length;
  const SEE_PLANS = t("scout_upgrade_cta"), TRY_AGAIN = t("scout_try_again");

  console.log("\n-- the app, at the free plan's limit: a today question --");
  {
    const s = await openScout("free", { pathway: DATED_PLAN, reserve: { allowed: false, used: 4, limit: 3 } });
    ck("before asking: a text box to type into", !!s.textBox(), true);
    await s.askToday();
    ck("the app's own request reached the handler and was refused 402", s.log.server && s.log.server.status, 402);
    ck("...it carried the question, after the greeting, as production sends it",
       s.log.server && s.log.server.sent.messages.map((m) => m.role), ["assistant", "user"]);
    ck("...one request to Scout, no model call behind it",
       [scoutRequests(s), s.log.server && s.log.server.calls.filter((c) => c.anthropic).length], [1, 0]);
    const last = s.last();
    ck("a failure bubble is on screen with the translated count sentence, and See plans",
       last, { text: "You've used today's Scout questions. 0 of 3 left today. More tomorrow.", buttons: [SEE_PLANS] });
    ck("...no Try again in it (trying again cannot help)", last && last.buttons.includes(TRY_AGAIN), false);
    const balls = s.balls();
    ck("ScoutBalls shows '0 left'", balls, { usage: { remaining: 0, limit: 3 }, text: "0 left" });
    const card = s.card();
    ck("ScoutLimitCard shows the limit number", card && [card.kind, card.text.includes("That's all 3 for today")], ["daily", true]);
    ck("...and offers more questions", card && card.upgradeButton, true);
    ck("the text box is closed, and there are no reply chips to tap", s.ways(), [false, false, 0]);
    ck("nothing was written to the conversation history (a refusal is not an answer)", s.log.writes.length, 0);
  }

  console.log("\n-- the app, on the free plan's LAST question --");
  {
    const s = await openScout("free", { pathway: DATED_PLAN, reserve: { allowed: true, used: 3, limit: 3 } });
    await s.askToday();
    ck("answered 200", s.log.server && s.log.server.status, 200);
    ck("the answer is shown, as an answer: no Try again, no See plans",
       s.last(), { text: "Film your highlight clip first, then email Coach Rivera.", buttons: [] });
    const card = s.card();
    ck("the limit card appears right after it, with no further request",
       [card && card.kind, card && card.text.includes("That's all 3 for today"), scoutRequests(s)], ["daily", true, 1]);
    ck("ScoutBalls shows '0 left'", s.balls() && s.balls().text, "0 left");
    ck("the text box and reply chips are gone, so the next tap is not spent on a refusal", s.ways(), [false, false, 0]);
    ck("the question and its answer were saved", s.log.writes.map((w) => w.row.messages[0].role), ["user", "assistant"]);
    // A new chat does not refill the day: the start buttons stay hidden and
    // the box stays closed.
    s.ui.find((n) => n.type === "button" && n.props["aria-label"] === t("scout_new_chat")).props.onClick();
    ck("after New chat: still the limit card, no start buttons, no text box",
       [!!s.card(), s.ui.byType("ScoutStart").length, !!s.textBox()], [true, 0, false]);
  }

  console.log("\n-- the app, at Elite's limit --");
  {
    const s = await openScout("elite", { pathway: DATED_PLAN, reserve: { allowed: false, used: 21, limit: 20 } });
    await s.askToday();
    ck("the bubble says 0 of Elite's 20, with no upgrade button (there is no plan above Elite)",
       s.last(), { text: "You've used today's Scout questions. 0 of 20 left today. More tomorrow.", buttons: [] });
    const card = s.card();
    ck("the limit card says all 20, and offers no upgrade", card && [card.text.includes("That's all 20 for today"), card.upgradeButton], [true, false]);
    ck("ScoutBalls shows '0 left' (no dots above 8)", s.balls() && s.balls().text, "0 left");
    ck("the text box and reply chips are gone", s.ways(), [false, false, 0]);
  }

  console.log("\n-- the app, at the free plan's lifetime budget --");
  {
    const s = await openScout("free", { pathway: DATED_PLAN, reserve: { allowed: true, used: 2, limit: 3 }, freeAi: { allowed: false, used: 41, limit: 40 } });
    await s.askToday();
    ck("403, and the lifetime sentence, unchanged",
       [s.log.server && s.log.server.status, s.last()], [403, { text: t("scout_err_free_exhausted"), buttons: [SEE_PLANS] }]);
    const card = s.card();
    ck("the lifetime card, with the lifetime number", card && [card.kind, card.text.includes("You've used all 40 free questions")], ["life", true]);
    ck("the text box and reply chips are gone", s.ways(), [false, false, 0]);
  }

  console.log("\n-- control: questions still left --");
  {
    const s = await openScout("free", { pathway: DATED_PLAN, reserve: { allowed: true, used: 1, limit: 3 } });
    await s.askToday();
    ck("answered, 2 left, no limit card",
       [s.log.server && s.log.server.status, s.balls() && s.balls().text, !!s.card()], [200, "2 left", false]);
    ck("...and the text box, send button and reply chips are all there", s.ways(), [true, true, 1]);
  }
}

async function main() {
  let handler = null;
  try {
    handler = (await import(pathToFileURL(path.join(REPO, "api", "scout.js")).href)).default;
    await serverHalf(handler);
  } catch (e) { f++; console.log("FAIL  the server half threw: " + (e && e.stack || e)); }
  try { await clientHalf(handler); } catch (e) { f++; console.log("FAIL  the client half threw: " + (e && e.stack || e)); }
  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
}
main();
