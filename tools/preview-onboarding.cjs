#!/usr/bin/env node
// Serves the repo for a browser run of the first visit (sign up -> Passport -> GoalSetup -> Home)
// as a stand-in flow that never touches the live database. Not a test (it needs a browser), so it
// lives outside tests/. Modelled on tools/preview-targets.cjs.
//
// Usage:  node tools/preview-onboarding.cjs [port]        (default: a free port, printed)
//   then open  http://127.0.0.1:<port>/golsz-app.html
//   &fail=pathway     the pathway_plan upsert answers HTTP 500 once: the page stops asking for the
//                     failure after the first refused write, so Retry on the same page succeeds
//   &today=YYYY-MM-DD fixes "today" in the page (the plan's dates and Home's counts follow it)
//   &theme=light|dark sets localStorage["golsz-theme"] before the page starts
//   &lang=en|fr|es|el sets localStorage["golsz-lang"] the same way (the drives read English labels:
//                     use lang= without drive=)
//   &overflow=1       with a drive: puts a 2000 px wide bar into GoalSetup, Home and the Today view
//                     (and a scout drive's answer) before each is measured. The scroll readings must
//                     then show a box wider than its room: the proof that the reading can see a
//                     sideways scroll
//   &model=honest|date|step|count   what the stand-in model behind /api/scout answers (see /api/scout
//                     below); default honest, and step for drive=scoutinvent
//   &limit=1          reserve_scout_question refuses the question (allowed:false): the daily limit
//   &last=1           reserve_scout_question allows it as the day's last: the answer leaves 0
//                     (these three go with each question as x-preview-model / -limit / -last headers)
//   &drive=signup|passport|goal|home|today|reloadmid|full|scouttoday|scoutinvent|scoutlimit|scoutlast
//                     acts like a person, then reports:
//     signup    a brand-new visitor (the store is reset): fills sign-up as an adult and submits;
//               must land in the Passport editor
//     passport  signed in, Passport unfinished, no plan. The app opens the editor itself (an
//               unfinished Passport keeps it open); the drive fills name, sport, position, club and
//               country and saves; must land on GoalSetup
//     goal      signed in, sport on file, no plan. A new page load does not reopen GoalSetup, so the
//               drive opens it from Home's "Set your goal to get your plan" card, fills the goal and
//               taps Build my plan; must land on Home
//     home      signed in, the store as it is: reports Home (a plain reload)
//     today     the same, but stays in the Today view with "Show my progress" open (for a screenshot)
//     reloadmid the goal drive, and it fails unless Home showed the "set your goal" card first
//     full      signup -> passport -> goal in ONE page, so GoalSetup opens from the Passport save
//     scouttoday  signed in with a plan: the one the store holds, or, when it holds none, one the
//               drive builds first exactly as the goal drive does. Reads Home (below), opens Scout
//               from the navigation, asks "What should I do today?" and reads the answer and the
//               "From your plan" card under it; must show a card with Home's TODAY and THIS WEEK
//     scoutinvent the same with a model that makes something up (&model=date|step|count, default
//               step); must also show the plan's own sentence in place of the model's answer
//     scoutlimit  the same at the daily limit (it implies &limit=1): no card; must show the refusal,
//               "0 left", the limit card and no text box
//     scoutlast   the same on the day's last question (it implies &last=1): must show the card,
//               "0 left", the limit card and no text box
//     Each scout drive starts a new Scout conversation (scout_history is emptied).
//   Every drive that ends on Home taps the Today tile and "Show my progress", reads the TODAY and
//   THIS WEEK cells (done/total), and goes back to the tiles. The page title then ends with
//     [drive done; path: <screens in order>; screen: <last screen>; today: <done>/<total>;
//      thisWeek: <done>/<total>; badge: <the Today tile's "N to do">; next: <its step>;
//      labels: <n>/<all> on screen (<the stored step labels seen>); goalSetupFrom: <...>;
//      scroll: <width>/<room> (<box>); goalSetupScroll: ...; todayViewScroll: ...; alerts: <...>]
//   The three scroll readings are for Home's tiles, GoalSetup and the Today view. Neither screen
//   scrolls in the document (Home is inside <main>, GoalSetup inside a fixed full-screen sheet), so
//   each reading measures the document (scrollWidth/innerWidth), the screen's own element and every
//   box around it that scrolls or clips (scrollWidth/clientWidth), and names the worst one. A
//   screen that fits reads e.g. "390/390 (document)".
//   and with fail=pathway also  failAlert="<text>"; formKept; goalKept; plansAtFail=<pathway_plan
//   rows>; goalTextAtFail (the goal sentence is saved before the plan, so it is "saved"); retry.
//   When the daily check-in ("How do you feel today?") covers Home, the drive taps "Skip for
//   today" first, as a person must, and the title says  checkin: skipped.
//   A scout drive's title puts Scout first:
//     [drive done; home today: <done>/<total>; home week: <done>/<total>; card today: <done>/<total>;
//      card week: <done>/<total>; card steps: <the names it lists> (and N more); override: yes|no;
//      usage: <n> left; limitCard: yes|no; reply: "<what the answer bubble says>";
//      replaced: "<the model's own words>" (only when the bubble shows something else);
//      box: open|closed (Scout's text box); path: ...; screen: Scout; badge: ...; next: ...; labels: ...;
//      scroll: <Home's tiles>; scoutScroll: <the answer>; alerts: ...]
//   home today/week are Home's TODAY and THIS WEEK cells, card today/week the card's (none when a
//   cell is not drawn), override is the server's today_override, usage is the "<n> left" Scout's
//   header shows, limitCard whether "That's all <n> for today" is on screen.
//   A drive that cannot go on says  [drive FAILED: timed out waiting for <what>; ...]  instead.
//   The server prints each write as  <table> <insert|update|upsert|delete> id=<id> fields=<names>
//   Use one server per width and theme: the store lives in the server and every drive changes it.
//
// /api/scout RUNS THE REAL HANDLER (api/scout.js, its default export) in this process, with the
// helpers Vercel adds (req.body parsed from JSON, res.status(code).json(body)). Its Supabase calls
// go to the same in-memory store as the page's (SUPABASE_URL is a stand-in address on the reserved
// .invalid domain) and its Anthropic calls to a scripted stand-in model:
//   the classifier call (the only prompt that asks for summary_so_far) gets one fixed classification,
//   career_advice; every other call gets one reply, built from the prompt the handler sent:
//     honest  the steps still open today and Home's counts exactly as the handler's TODAY FOR THEM
//             line gives them (read from the store's plan), as a model that keeps to its prompt does
//     date    the same, plus "Have it done by <the day after the latest date in its prompt>"
//     step    a quoted step that is in no plan ("Run a 10 km time trial") in place of today's steps
//     count   this week as "<done> of <total + 1>"
//   reserve_scout_question answers as for the day's first question (used 1) unless &limit=1 or
//   &last=1 says otherwise; the free plan's lifetime budget is never spent.
//   Questions reach the handler one at a time, each SCOUT_SPACING_MS after the previous one was
//   answered: the handler refuses a second question from one athlete inside 3 s (isRateLimited),
//   and drives on consecutive pages can ask sooner than a person would.
//   The server prints one line per question:
//     scout <status> model=<script> [limit] [last] card=today <d>/<t>, week <d>/<t> | none
//     override=yes|no usage=<remaining>/<limit> | none calls: <n> store, <n> model, <n> refused
//   &today= moves only the page's day. The handler takes the page's day only within a day of its own
//   clock, as in production, so a scout drive with &today= far from the real day can disagree.
//
// WHAT IS STAND-IN: auth (signUp/getSession/getUser) answered locally; profiles, athletes,
// pathway_plan, outreach_targets, athlete_benchmarks stored in the server process; any other
// table starts empty and keeps what the app (or the Scout handler) writes to it; an insert without
// created_at gets one, later than the last (Postgres's default now()); reads honour
// column filters, order and limit; sync_athlete_actions and the other RPCs Home calls return
// empty. Nothing is sent to the real Supabase project or to Anthropic. The stand-in knows nothing
// about real RLS/limits and the model is a script: it proves the SCREEN and the handler's own
// rules, not the database or a real model.
//
// HOW IT STAYS OUT OF THE PRODUCT: the stub is added to the response in memory only, so the file
// on disk is never written. Every request to the Supabase host is rewritten to /__sb/... on this
// server and never forwarded. The Scout handler's fetch is this process's own (serviceFetch): it
// answers the stand-in Supabase address from the store and Anthropic's messages URL from the
// script, and refuses every other address. ANTHROPIC_API_KEY and SUPABASE_SERVICE_KEY are set to the
// word "stand-in", never a key, and SCOUT_FALLBACK_API_KEY is removed so the cross-provider failover
// has nowhere to go. The server binds to 127.0.0.1 and serves only files under the repo root. CDN
// libraries come from local npm-pack copies (see preview-public-passport.cjs).
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const { pathToFileURL } = require("url");
const { MIME, localiseLibraries } = require("./preview-public-passport.cjs");

const ROOT = path.resolve(__dirname, "..");
const USER_ID = "00000000-0000-4000-8000-000000000099";
const LANGS = ["en", "fr", "es", "el"];

// /api/scout (the header's "/api/scout RUNS THE REAL HANDLER").
const SCRIPTS = ["honest", "date", "step", "count"];
const ANTHROPIC_MESSAGES = "https://api.anthropic.com/v1/messages";   // api/scout.js's ANTHROPIC_URL
const STAND_IN_SUPABASE = "https://supabase.preview.invalid";        // .invalid never resolves (RFC 6761)
// More than RATE_LIMIT_MIN_INTERVAL_MS (3000) in api/scout.js. Counted from the end of the previous
// question, which is after the handler stamped it.
const SCOUT_SPACING_MS = 3200;
const INVENTED_STEP = "Run a 10 km time trial";
const CLASSIFICATION = {
  intent: "career_advice", confidence: 0.9, needs_tool: false, is_correction: false, faq_id: null,
  summary_so_far: "The athlete asked what to do today.", missing_information: [], recommended_specialist: null,
  conversation_stage: "action", next_best_action: null,
};
// The two prompt rules (TODAY_ANSWER_RULE, TODAY_PLAN_UNREAD_RULE in api/scout.js) open with these.
const TODAY_RULE_OPENS = "THEY ARE ASKING WHAT TO DO TODAY OR THIS WEEK. ";
const UNREAD_RULE_OPENS = "THEY ARE ASKING WHAT TO DO TODAY OR THIS WEEK, AND THEIR PLAN COULD NOT BE LOADED";

function defaultProfile() {
  return {
    id: USER_ID, full_name: "", occupation: "Player", avatar_url: null, plan: "free",
    is_banned: false, is_admin: false, goal_defined: false, goal_text: null,
    onboarding_conversion_shown: true, free_ai_lifetime_used: 0, full_access: false,
    identity_verified: false, verified_tier: "none", dob: "1998-06-15", created_at: "2026-01-01T00:00:00Z",
  };
}
function defaultAthlete() {
  return {
    id: USER_ID, sport: null, position: null, club_name: null, grad_year: null,
    gpa: null, country: null, citizenship: null, height_cm: null, weight_kg: null,
    recruiting_status: null, bio: null, highlights: [], timeline: [], scout_context: {},
    license: null, looking_for_players: null, education_level: null,
  };
}

// ---- Pure rules. Each is self-contained: its source is also sent to the page (PAGE_RULES). ----

// Home's number cells, read one per cell as { label, value }. Only a cell whose label IS the heading
// counts (exact, case-sensitive: "this week" inside a step label is not the THIS WEEK cell), and
// only a done/total value is a count. `today` and `thisWeek` are that text; the totals are numbers.
function homeCounts(cells) {
  const out = { today: "none", thisWeek: "none", todayTotal: null, weekTotal: null };
  (cells || []).forEach((c) => {
    const label = String((c && c.label) || "").trim();
    const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String((c && c.value) || "").trim());
    if (!m) return;
    if (label === "TODAY") { out.today = m[1] + "/" + m[2]; out.todayTotal = Number(m[2]); }
    if (label === "THIS WEEK") { out.thisWeek = m[1] + "/" + m[2]; out.weekTotal = Number(m[2]); }
  });
  return out;
}

// The stored step labels that the screen's text shows, in plan order.
function labelsShown(labels, text) {
  const flat = String(text || "").replace(/\s+/g, " ");
  return (labels || []).filter((l) => l && flat.indexOf(String(l).replace(/\s+/g, " ").trim()) !== -1);
}

// What a finished (or stuck) drive writes after the page title. A scout drive (f.scout, what
// readScout() saw) puts Home's cells, the card and the answer first.
function driveTitle(f) {
  const yn = (v) => (v ? "yes" : "no");
  const parts = [f.error ? "drive FAILED: timed out waiting for " + f.error : "drive done"];
  const s = f.scout;
  if (s) {
    const c = s.card;
    parts.push("home today: " + (f.counts ? f.counts.today : "none"), "home week: " + (f.counts ? f.counts.thisWeek : "none"),
      "card today: " + (c ? c.today : "none"), "card week: " + (c ? c.week : "none"),
      "card steps: " + ((c && [c.steps.join(" | "), c.more].filter(Boolean).join(" ")) || "none"),
      "override: " + yn(s.override), "usage: " + (s.usage || "none"), "limitCard: " + yn(s.limitCard), 'reply: "' + s.reply + '"');
    if (s.modelReply && s.modelReply !== s.reply) parts.push('replaced: "' + s.modelReply + '"');
    parts.push("box: " + s.box);
  }
  parts.push("path: " + ((f.path || []).join(" > ") || "none"), "screen: " + (f.screen || "unknown"));
  if (f.counts && !s) parts.push("today: " + f.counts.today, "thisWeek: " + f.counts.thisWeek);
  if (f.badge !== undefined) parts.push("badge: " + (f.badge || "none"), "next: " + (f.next || "none"));
  if (f.labels) parts.push("labels: " + f.labels.length + "/" + f.labelTotal + " on screen (" + (f.labels.join(" | ") || "none") + ")");
  if (f.checkin) parts.push("checkin: " + f.checkin);
  if (f.goalSetupFrom) parts.push("goalSetupFrom: " + f.goalSetupFrom);
  if (f.sawSetGoalCard !== undefined) parts.push("sawSetGoalCard=" + yn(f.sawSetGoalCard));
  if (f.fail) {
    parts.push('failAlert="' + f.fail.alert + '"', "formKept=" + yn(f.fail.formKept), "goalKept=" + yn(f.fail.goalKept),
      "plansAtFail=" + f.fail.plansAtFail, "goalTextAtFail=" + f.fail.goalTextAtFail, "retry=" + (f.error ? "FAILED" : f.screen === "Home" ? "ok" : "not on Home"));
  }
  if (f.scroll) parts.push("scroll: " + f.scroll);
  if (f.goalSetupScroll) parts.push("goalSetupScroll: " + f.goalSetupScroll);
  if (f.todayViewScroll) parts.push("todayViewScroll: " + f.todayViewScroll);
  if (f.scoutScroll) parts.push("scoutScroll: " + f.scoutScroll);
  if (f.overflow) parts.push("overflow=on purpose");
  parts.push("alerts: " + (f.alerts || "none"));
  return parts.join("; ");
}

// The sentence the app puts in place of an answer the server refused (today_override), in English,
// from the card as a scout drive reads it ({ today, week: "<done>/<total>" or "none", steps, more }).
// scoutTodaySentence() in golsz-app.jsx builds it from the same card; the suite compares the two.
function cardSentence(card) {
  if (!card) return "";
  const t = /^(\d+)\/(\d+)$/.exec(card.today || ""), w = /^(\d+)\/(\d+)$/.exec(card.week || "");
  const steps = card.steps || [];
  const today = steps.length ? "Today: " + steps.map((s) => '"' + s + '"').join(", ") + (card.more ? " " + card.more : "") + "."
    : t ? "Today: " + t[1] + " of " + t[2] + " done." : "Nothing is due today.";
  return today + " " + (w ? "This week: " + w[1] + " of " + w[2] + " done." : "Nothing in this week yet.");
}

// Where a too-wide screen would scroll sideways, as boxes for worstScroll: the document
// (scrollWidth against the window's innerWidth), the screen's own element, and each box around it
// that scrolls or clips (Home's <main>, GoalSetup's fixed sheet). `win` is the page's window.
function scrollBoxes(root, win) {
  const doc = win.document.documentElement;
  const boxes = [{ name: "document", scrollWidth: doc.scrollWidth, clientWidth: win.innerWidth }];
  for (let el = root; el && el !== doc; el = el.parentElement) {
    const cs = win.getComputedStyle(el);
    if (el !== root && cs.overflowX === "visible" && cs.overflowY === "visible") continue;
    const cls = typeof el.className === "string" ? el.className.split(/\s+/)[0] : "";
    boxes.push({ name: el.tagName.toLowerCase() + (el.id ? "#" + el.id : cls ? "." + cls : ""), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
  }
  return boxes;
}

// Of the boxes measured for one screen ({ name, scrollWidth, clientWidth }), the one whose content
// runs furthest past its own room, as "<scrollWidth>/<clientWidth> (<name>)". The first box wins a
// tie, and the page lists the document first, so a screen that fits reads "390/390 (document)".
function worstScroll(boxes) {
  let worst = null;
  (boxes || []).forEach((b) => {
    if (!b || !(b.clientWidth > 0)) return;
    if (!worst || b.scrollWidth - b.clientWidth > worst.scrollWidth - worst.clientWidth) worst = b;
  });
  return worst ? worst.scrollWidth + "/" + worst.clientWidth + " (" + worst.name + ")" : "none";
}

// Whether the page starts signed in. Sign-up (and full) start signed out; the other drives are an
// athlete who already has an account; a page with no drive is signed in once there is an account
// to be signed in to (a sign-up, a sport or a plan in the store).
function seedsSession(drive, store) {
  if (drive === "signup" || drive === "full") return false;
  if (drive) return true;
  return !!(store && (store.hasPlan || store.signedUp || store.hasSport));
}

const PAGE_RULES = { homeCounts, labelsShown, driveTitle, scrollBoxes, worstScroll, cardSentence };
const SCOUT_DRIVES = ["scouttoday", "scoutinvent", "scoutlimit", "scoutlast"];
const DRIVES = ["signup", "passport", "goal", "home", "today", "reloadmid", "full"].concat(SCOUT_DRIVES);

// ---- Pure rules of the stand-in model and the /api/scout route (server side only). ----

// What the handler tells the model on its TODAY FOR THEM line (api/scout.js): "Due today: 0 of 1
// done; still open today: "<label>"; "<label>" and N more not named here. This week: 0 of 3 dated
// steps done." Null when the prompt has no such line. `dates` is every YYYY-MM-DD in the prompt.
function promptFacts(prompt) {
  const text = String(prompt || "");
  const line = (/TODAY FOR THEM:[^\n]*/.exec(text) || [""])[0];
  const today = /Due today: (?:(\d+) of (\d+) done|nothing)/.exec(line);
  const week = /This week: (?:(\d+) of (\d+) dated steps done|no dated steps)/.exec(line);
  if (!today || !week) return null;
  const open = /; still open today: (.*?)(?: and (\d+) more not named here)?\. This week:/.exec(line);
  return {
    todayDone: Number(today[1] || 0), todayTotal: Number(today[2] || 0),
    weekDone: Number(week[1] || 0), weekTotal: Number(week[2] || 0),
    steps: open ? [...open[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]) : [],
    more: open && open[2] ? Number(open[2]) : 0,
    dates: [...new Set(text.match(/\d{4}-\d{2}-\d{2}/g) || [])].sort(),
  };
}

// The stand-in model's answer to the prompt it was sent, by script (the header lists them).
// Only a today question is answered from the plan; the handler marks one with TODAY_ANSWER_RULE.
function scriptedReply(script, prompt) {
  const text = String(prompt || "");
  if (text.includes(UNREAD_RULE_OPENS)) return "I couldn't load your plan just now. Home shows today's steps.";
  const f = text.includes(TODAY_RULE_OPENS) ? promptFacts(text) : null;
  if (!f) return "This is the preview's stand-in model. Ask it what to do today.";
  const steps = script === "step" ? [INVENTED_STEP] : f.steps;
  let reply = steps.length ? "Today: " + steps.map((s) => '"' + s + '"').join(", ") + (script !== "step" && f.more ? " and " + f.more + " more" : "") + "."
    : f.todayTotal ? "Everything due today is done: " + f.todayDone + " of " + f.todayTotal + "."
    : "Nothing is due today.";
  const weekTotal = f.weekTotal + (script === "count" ? 1 : 0);
  reply += weekTotal ? " This week you have done " + f.weekDone + " of " + weekTotal + "." : " Nothing is dated this week.";
  if (script === "date") {
    const latest = f.dates[f.dates.length - 1];
    reply += " Have it done by " + new Date(Date.parse(latest + "T00:00:00Z") + 86400000).toISOString().slice(0, 10) + ".";
  }
  return reply;
}

// How long a question waits before it reaches the handler: until SCOUT_SPACING_MS after the
// previous question was answered (lastAt).
function scoutWait(lastAt, now) {
  return Math.max(0, lastAt + SCOUT_SPACING_MS - now);
}

// The line the server prints for one question (`run`: the route's record of it).
function scoutLine(run) {
  const a = run.answer || {}, c = a.today_card, u = a.scout_usage;
  const to = (kind) => run.calls.filter((x) => x.to === kind).length;
  return "scout " + run.status + " model=" + run.script + (run.limit ? " limit" : "") + (run.last ? " last" : "") +
    " card=" + (c ? "today " + c.todayDone + "/" + c.todayTotal + ", week " + c.weekDone + "/" + c.weekTotal : "none") +
    " override=" + (a.today_override ? "yes" : "no") + " usage=" + (u ? u.remaining + "/" + u.limit : "none") +
    " calls: " + to("store") + " store, " + to("model") + " model, " + to("refused") + " refused";
}

// Runs first in <head>, before the theme script, the CDN libraries and the app.
function stub(cfg, rules) {
  try { if (cfg.theme === "light" || cfg.theme === "dark") localStorage.setItem("golsz-theme", cfg.theme); } catch (e) {}
  try { if (cfg.lang) localStorage.setItem("golsz-lang", cfg.lang); } catch (e) {}

  function b64(obj) { return btoa(JSON.stringify(obj)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"); }
  var now = Math.floor(Date.now() / 1000);
  var user = { id: cfg.userId, aud: "authenticated", role: "authenticated", email: "newathlete@example.com", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
  var token = b64({ alg: "none", typ: "JWT" }) + "." + b64({ sub: cfg.userId, role: "authenticated", aud: "authenticated", exp: now + 86400 }) + ".preview";
  var session = { access_token: token, refresh_token: "preview", token_type: "bearer", expires_in: 86400, expires_at: now + 86400, user: user };
  var authKey = "sb-" + new URL(cfg.supabaseUrl).hostname.split(".")[0] + "-auth-token";

  // Signed in or signed out, as the server decided (seedsSession).
  if (cfg.seedSession) {
    try { localStorage.setItem(authKey, JSON.stringify(session)); } catch (e) {}
  } else {
    try { localStorage.removeItem(authKey); } catch (e) {}
  }

  // &today=: a fixed "now" for the page, so the plan's dates and Home's counts do not move.
  if (cfg.today) {
    var parts = cfg.today.split("-");
    var fixed = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0);
    var RealDate = window.Date;
    function FakeDate() {
      if (arguments.length === 0) return new RealDate(fixed.getTime());
      return new (RealDate.bind.apply(RealDate, [null].concat(Array.prototype.slice.call(arguments))))();
    }
    FakeDate.now = function () { return fixed.getTime(); };
    FakeDate.parse = RealDate.parse;
    FakeDate.UTC = RealDate.UTC;
    FakeDate.prototype = RealDate.prototype;
    window.Date = FakeDate;
  }

  // Every request to the Supabase host goes to this server instead. With &fail=pathway the page
  // asks for the failure until the first pathway_plan write is refused, then stops: one failure.
  // A question to /api/scout carries the page's &model=, &limit= and &last=, and its answer is
  // kept for the scout drives (scoutWire: the status and the JSON the server sent).
  var realFetch = window.fetch.bind(window);
  var scoutWire = null;
  window.fetch = function (input, init) {
    var req = new Request(input, init);
    if (req.url === location.origin + "/api/scout") {
      var asked = new Headers(req.headers);
      if (cfg.model) asked.set("x-preview-model", cfg.model);
      if (cfg.limit) asked.set("x-preview-limit", "1");
      if (cfg.last) asked.set("x-preview-last", "1");
      return realFetch(input, Object.assign({}, init, { headers: asked })).then(function (resp) {
        resp.clone().json().then(function (data) { scoutWire = { status: resp.status, body: data }; },
          function () { scoutWire = { status: resp.status, body: null }; });
        return resp;
      });
    }
    if (req.url.indexOf(cfg.supabaseUrl) !== 0) return realFetch(input, init);
    var headers = new Headers(req.headers);
    if (cfg.fail) headers.set("x-preview-fail", cfg.fail);
    var target = location.origin + "/__sb" + req.url.slice(cfg.supabaseUrl.length);
    var hasBody = req.method !== "GET" && req.method !== "HEAD";
    return (hasBody ? req.text() : Promise.resolve(undefined)).then(function (body) {
      return realFetch(target, { method: req.method, headers: headers, body: body || undefined }).then(function (resp) {
        if (!resp.ok && hasBody && cfg.fail === "pathway" && req.url.indexOf("/rest/v1/pathway_plan") !== -1) cfg.fail = "";
        return resp;
      });
    });
  };
  var RealSocket = window.WebSocket;
  window.WebSocket = function (url) {
    if (String(url).indexOf(new URL(cfg.supabaseUrl).host) === -1) return new RealSocket(url);
    return { readyState: 3, send: function () {}, close: function () {}, addEventListener: function () {}, removeEventListener: function () {} };
  };

  if (!cfg.drive) return;

  // ---- The drive: what a person would tap and type, then one line in the page title. ----
  // The page keeps "loading" until the drive is done, so a screenshot shows its last screen.
  new Image().src = "/__hold?" + Date.now() + Math.random();

  // How long a step may take before the drive gives up and says FAILED. It checks where the person
  // lands, not how fast (tools/time-first-screen.cjs measures speed): steps take under a second, but
  // on a busy Mac sign-up once reached the Passport editor after 12-14 s. The app's first screen
  // gets its own allowance, BOOT_MS: booting is the CPU-heavy part, and with the Mac's load average
  // at 35 (2026-11-14) pages that boot in 7 s took 30-45 s, so STEP_MS alone failed drives whose app
  // did arrive. A broken step or boot is still reported inside the runner's 180 s per page and the
  // server's 120 s hold.
  var STEP_MS = 30000;
  var BOOT_MS = 90000;
  var GOAL = "Play college soccer in the US";
  var failing = cfg.fail === "pathway";
  var facts = { path: [] };

  function textOf(el) { return ((el && el.textContent) || "").replace(/\s+/g, " ").trim(); }
  function all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function one(sel, root) { return (root || document).querySelector(sel); }
  function visible(el) { if (!el) return false; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function withText(sel, text, root) { return all(sel, root).filter(function (el) { return visible(el) && textOf(el) === text; }); }
  function type(el, v) {
    var P = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype
      : el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(P, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function pause(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Resolves with what `test` returns once it is truthy; rejects with `what` after `ms`.
  function until(test, what, ms) {
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function poll() {
        var v = null;
        try { v = test(); } catch (e) {}
        if (v) return resolve(v);
        if (Date.now() - t0 > (ms || STEP_MS)) return reject(new Error(what));
        setTimeout(poll, 100);
      })();
    });
  }
  function store() { return realFetch("/__store").then(function (r) { return r.json(); }); }

  // The screens, by their own markup.
  function authForm() { return one("#signup-email"); }
  function editor() { var c = one('[role=dialog] input[list="country-options"]'); return c ? c.closest("[role=dialog]") : null; }
  function goalSetup() { var h = one("#goal-setup-title"); return h ? h.closest("[role=dialog]") : null; }
  function home() { return one(".gz-home"); }
  function setGoalButton() { var h = home(); return h ? withText("button", "Set my goal", h)[0] : null; }
  function todayTile() {
    var h = home();
    return (h && all("button", h).filter(function (b) { return visible(b) && withText("span", "Today", b).length; })[0]) || null;
  }
  function tileSpans() { var t = todayTile(); return t ? Array.prototype.slice.call(t.children).filter(function (c) { return c.tagName === "SPAN"; }).map(textOf) : []; }
  function tileBadge() { return tileSpans().filter(function (s) { return /^\d+ to do$/.test(s); })[0] || ""; }
  function progressToggle() { var h = home(); return h ? one("button[aria-expanded]", h) : null; }
  // Number cells, Home's and Scout's card's alike: a heading span and, right after it, the value span.
  function cells(root) {
    return root ? all("span", root).filter(function (s) { return visible(s) && s.nextElementSibling && /^(TODAY|THIS WEEK)$/.test(textOf(s)); })
      .map(function (s) { return { label: textOf(s), value: textOf(s.nextElementSibling) }; }) : [];
  }
  // Scout's screen. The nav button reads "Scout" on a phone and "AI Scout" in the desktop sidebar.
  function scoutNav() { return all("nav button").filter(function (b) { return visible(b) && /^(AI )?Scout$/.test(textOf(b)); })[0] || null; }
  function scoutPane() { return one('button[title="History"]'); }
  function scoutBox() { return one('textarea[aria-label="Talk to your scout…"]'); }
  function scoutSend() { var s = one('button[title="Send"]'); return s && !s.disabled ? s : null; }
  function lastBubble() { var b = all(".msg").filter(visible); return b[b.length - 1] || null; }
  function screenName() {
    if (goalSetup()) return "GoalSetup";
    if (editor()) return "Passport editor";
    if (authForm()) return "Auth";
    if (scoutPane()) return "Scout";
    if (home()) return setGoalButton() ? "Home (set-goal card)" : "Home";
    return "unknown";
  }
  function reached(name) { if (facts.path[facts.path.length - 1] !== name) facts.path.push(name); }
  // The daily check-in ("How do you feel today?") covers the app on the day's first open, and
  // right after the plan is built. A person has to answer or skip it before tapping what is under it.
  function checkinSkip() { return withText("button", "Skip for today")[0] || null; }
  async function passCheckin() {
    await until(checkinSkip, "", 800).catch(function () {});
    if (!checkinSkip()) return;
    reached("Daily check-in");
    facts.checkin = "skipped";
    checkinSkip().click();
    await until(function () { return !checkinSkip(); }, "the daily check-in to close after 'Skip for today'");
  }
  // &overflow=1 (the positive control): a bar far wider than any screen, inside the screen measured.
  function widen(root) {
    if (!cfg.overflow || !root || one("[data-preview-overflow]", root)) return;
    var bar = document.createElement("div");
    bar.setAttribute("data-preview-overflow", "");
    bar.style.cssText = "width:2000px;height:1px;flex:none";
    root.appendChild(bar);
    facts.overflow = true;
  }
  function scrollNow(root) { widen(root); return rules.worstScroll(rules.scrollBoxes(root, window)); }

  async function signup() {
    await until(authForm, "the sign-up form");
    reached("Auth");
    type(one("#signup-name"), "Test Athlete");
    type(one("#signup-email"), "newathlete@example.com");
    type(one("#signup-pw"), "Password123!");
    var day = one("#signup-dob"), month = day.nextElementSibling, year = month.nextElementSibling;
    type(day, "15"); type(month, "06"); type(year, "1998");
    await pause(150);
    one("#signup-email").closest("form").querySelector('button[type="submit"]').click();
    await until(editor, "the Passport editor after sign-up");
    reached("Passport editor");
  }

  async function passport() {
    // An unfinished Passport opens its own editor (locked until a sport is saved): nothing to tap.
    await until(editor, "the Passport editor");
    reached("Passport editor");
    var nameField = one('input[aria-label="FULL NAME"]', editor());
    if (!nameField.value) type(nameField, "Test Athlete");
    type(one('select[aria-label="SPORT"]', editor()), "Soccer");
    type(await until(function () { return one('input[list="position-options"]', editor()); }, "the position field"), "Midfielder");
    type(one('input[aria-label="CLUB / TEAM"]', editor()), "Test FC");
    type(one('input[list="country-options"]', editor()), "Canada");
    await pause(150);
    withText("button", "Save profile", editor())[0].click();
    await until(goalSetup, "GoalSetup after the Passport save");
    facts.goalSetupFrom = "the Passport save";
    reached("GoalSetup");
  }

  async function goal(needCard) {
    if (!goalSetup()) {
      await until(function () { return goalSetup() || setGoalButton(); }, "GoalSetup, or Home's 'Set your goal to get your plan' card");
      if (!goalSetup()) {
        await passCheckin();
        reached("Home (set-goal card)");
        facts.sawSetGoalCard = withText("div", "Set your goal to get your plan", home()).length > 0;
        await pause(300);
        setGoalButton().click();
        facts.goalSetupFrom = "Home's 'Set my goal'";
        await until(goalSetup, "GoalSetup after tapping 'Set my goal'");
      }
    }
    if (needCard && !facts.sawSetGoalCard) { facts.sawSetGoalCard = false; throw new Error("Home's 'set your goal' card before GoalSetup"); }
    reached("GoalSetup");
    var field = await until(function () { return one("#goal-setup-goal"); }, "GoalSetup's goal field");
    facts.goalSetupScroll = scrollNow(goalSetup());
    type(field, GOAL);
    await pause(150);
    withText("button", "Build my plan", goalSetup())[0].click();
    if (failing) {
      var alert = await until(function () { var g = goalSetup(); return g && all("[role=alert]", g).filter(visible)[0]; }, "the save error on GoalSetup");
      await pause(300);
      var rows = await store();
      facts.fail = { alert: textOf(one("span", alert) || alert), formKept: !!goalSetup(),
        goalKept: one("#goal-setup-goal").value === GOAL, plansAtFail: (rows.pathway_plan || []).length,
        goalTextAtFail: ((rows.profiles || [])[0] || {}).goal_text ? "saved" : "not saved" };
      one("button", alert).click();
    }
    await until(function () { return !goalSetup() && todayTile(); }, "Home after 'Build my plan'");
  }

  // Home as the athlete lands on it (the tiles), then the Today view's number cells.
  async function readHome(stay) {
    await until(todayTile, "Home's Today tile");
    await passCheckin();
    await until(tileBadge, "", 3000).catch(function () {});
    reached(setGoalButton() ? "Home (set-goal card)" : "Home");
    var spans = tileSpans();
    facts.badge = tileBadge();
    facts.next = spans.filter(function (s) { return s !== "Today" && s !== facts.badge; })[0] || "";
    facts.scroll = scrollNow(home());
    var plan = ((await store()).pathway_plan || [])[0];
    var labels = ((plan && plan.milestones) || []).map(function (m) { return m && m.label; }).filter(Boolean);
    var seen = textOf(home());
    todayTile().click();
    var toggle = await until(progressToggle, "the Today view");
    await pause(300);
    seen += " " + textOf(home());
    if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
    await until(function () { return cells(home()).length; }, "", 3000).catch(function () {});
    facts.counts = rules.homeCounts(cells(home()));
    facts.todayViewScroll = scrollNow(home());
    seen += " " + textOf(home());
    facts.labels = rules.labelsShown(labels, seen);
    facts.labelTotal = labels.length;
    if (stay) return;
    withText("button", "Back", home())[0].click();
    await until(todayTile, "Home's tiles after 'Back'");
  }

  // What the newest Scout answer shows: its text, the "From your plan" card under it (cells read as
  // Home's are, the step names it lists, its "and N more" line), Scout's "<n> left", the limit card
  // and the text box; and from the server, today_override and the model's own words.
  function readCard(bubble) {
    var title = bubble ? withText("span", "FROM YOUR PLAN", bubble)[0] : null;
    var card = title && title.parentElement && title.parentElement.parentElement;
    if (!card) return null;
    var c = rules.homeCounts(cells(card));
    return { today: c.today, week: c.thisWeek, steps: all("li", card).map(textOf),
      more: all("div", card).map(textOf).filter(function (s) { return /^and \d+ more$/.test(s); })[0] || "" };
  }
  function readScout() {
    var b = lastBubble(), body = (scoutWire && scoutWire.body) || {};
    var left = all("span").filter(function (s) { return visible(s) && /^\d+ left$/.test(textOf(s)); })[0];
    return { reply: textOf(b && one('[style*="pre-wrap"]', b)), card: readCard(b), usage: left ? textOf(left) : "",
      limitCard: all("div").some(function (d) { return visible(d) && /^That's all \d+ for today$/.test(textOf(d)); }),
      box: scoutBox() ? "open" : "closed", override: body.today_override === true,
      modelReply: typeof body.reply_text === "string" ? body.reply_text.replace(/\s+/g, " ").trim() : "" };
  }

  // Opens Scout, asks the today question, and holds the answer to what this drive must show.
  async function scout(d) {
    (await until(scoutNav, "the Scout button in the navigation")).click();
    await until(scoutPane, "the Scout screen");
    reached("Scout");
    type(await until(scoutBox, "Scout's text box"), "What should I do today?");
    (await until(scoutSend, "Scout's Send button")).click();
    await until(function () { return scoutWire && !one(".running") && lastBubble(); }, "Scout's answer", 30000);
    facts.scout = readScout();
    facts.scoutScroll = scrollNow(lastBubble());
    function check(test, what) { return until(function () { facts.scout = readScout(); return test(facts.scout); }, what, 3000); }
    if (d !== "scoutlimit") {
      await check(function (s) { return s.card && facts.counts && s.card.today === facts.counts.today && s.card.week === facts.counts.thisWeek; },
        "Scout's card to show Home's TODAY and THIS WEEK");
    }
    if (d === "scoutinvent") {
      await check(function (s) { return s.override && s.reply !== s.modelReply && s.reply === rules.cardSentence(s.card); },
        "the plan's own sentence in place of the model's answer");
    }
    if (d === "scoutlimit" || d === "scoutlast") {
      await check(function (s) { return !!s.reply && s.usage === "0 left" && s.limitCard && s.box === "closed"; },
        "an answer, '0 left', the limit card and no text box");
    }
  }

  async function run() {
    var d = cfg.drive, scoutDrive = /^scout/.test(d);
    // Any screen the drives know (each drive's own first wait then finds its screen at once).
    await until(function () { return screenName() !== "unknown"; }, "the app's first screen", BOOT_MS);
    if (d === "signup" || d === "full") await signup();
    if (d === "passport" || d === "full") await passport();
    if (d === "goal" || d === "reloadmid" || d === "full" || (scoutDrive && cfg.buildPlan)) await goal(d === "reloadmid");
    if (d !== "signup" && d !== "passport") await readHome(d === "today");
    if (scoutDrive) await scout(d);
  }
  function finish(err) {
    facts.error = err ? String(err.message || err) : "";
    facts.screen = screenName();
    if (!facts.scroll) facts.scroll = scrollNow(goalSetup() || editor() || home());
    facts.alerts = all("[role=alert]").filter(visible).map(textOf).filter(Boolean).join(" | ");
    document.title = document.title + " [" + rules.driveTitle(facts) + "]";
    realFetch("/__release").catch(function () {});
  }
  run().then(function () { finish(null); }, finish);
}

// The call the page runs first: the stub, its settings and the pure rules it reports with.
function stubCall(cfg) {
  const rules = "{" + Object.keys(PAGE_RULES).map((k) => JSON.stringify(k) + ":" + PAGE_RULES[k].toString()).join(",") + "}";
  return "(" + stub.toString() + ")(" + JSON.stringify(cfg).replace(/</g, "\\u003c") + "," + rules + ")";
}

function pageWithStub(html, cfg) {
  return html.replace(/<head[^>]*>/i, (m) => m + "<script>" + stubCall(cfg) + "</script>");
}

// The Supabase address the stub answers locally, read from js/app.js: the bundle the page runs
// (compiled from golsz-app.jsx), so it is the address the app really calls. The page holds no app code.
function constantsFrom(bundle) {
  const grab = (name) => { const m = new RegExp(name + '\\s*=\\s*"([^"]+)"').exec(bundle); if (!m) throw new Error(name + " not found in js/app.js"); return m[1]; };
  return { supabaseUrl: grab("SUPABASE_URL") };
}
const appBundle = () => fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");

// ---- The Scout handler's services (the header's "HOW IT STAYS OUT OF THE PRODUCT") ----

// The question being answered: its script, every address the handler fetched, and the two
// stand-ins it is answered by (store, model). Per question, never module state that two questions
// could share.
const scoutRun = new AsyncLocalStorage();

// The handler's fetch, for this whole process (nothing else here fetches). Inside a question it
// answers the stand-in Supabase address and Anthropic's messages URL; everything else, and any
// call outside a question, is refused the way a dead network refuses: a rejected TypeError.
function serviceFetch(input, init) {
  const run = scoutRun.getStore();
  const url = typeof input === "string" ? input : (input && input.url) || String(input);
  const to = !run ? "refused" : url === ANTHROPIC_MESSAGES ? "model" : url.startsWith(STAND_IN_SUPABASE + "/") ? "store" : "refused";
  if (run) run.calls.push({ url, to });
  if (to === "model") return Promise.resolve(run.model(init));
  if (to === "store") return run.store(url, init);
  console.log("scout fetch REFUSED " + url);
  return Promise.reject(new TypeError("fetch failed: the preview sends nothing out (" + url + ")"));
}

// api/scout.js, imported once, after its environment points at the stand-ins (some of it is read
// when the module loads).
let scoutModule = null;
function scoutHandler() {
  if (!scoutModule) {
    process.env.SUPABASE_URL = STAND_IN_SUPABASE;
    process.env.SUPABASE_SERVICE_KEY = "stand-in";
    process.env.ANTHROPIC_API_KEY = "stand-in";
    delete process.env.SCOUT_FALLBACK_API_KEY;
    globalThis.fetch = serviceFetch;
    scoutModule = import(pathToFileURL(path.join(ROOT, "api", "scout.js")).href).then((m) => m.default);
  }
  return scoutModule;
}

// The stand-in for Anthropic's Messages API. The classifier's system prompt is the only one that
// asks for summary_so_far (tests/test_scout_today_handler.cjs tells the calls apart the same way).
function modelAnswer(init, script) {
  let req = {};
  try { req = JSON.parse((init && init.body) || "{}"); } catch (e) {}
  const text = (v) => (typeof v === "string" ? v : Array.isArray(v) ? v.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n") : "");
  const system = text(req.system);
  const prompt = system + "\n" + (Array.isArray(req.messages) ? req.messages.map((m) => text(m && m.content)).join("\n") : "");
  const out = system.includes("summary_so_far") ? CLASSIFICATION : { reply: scriptedReply(script, prompt), profile_updates: null };
  return new Response(JSON.stringify({
    id: "msg_stand_in", type: "message", role: "assistant", model: req.model || "stand-in",
    content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

// The helpers Vercel adds to a Node response, which the handler answers with:
// res.status(code).json(body). What it answered is kept on `run`.
function vercelResponse(res, run) {
  res.status = (code) => { res.statusCode = code; run.status = code; return res; };
  res.json = (body) => { run.answer = body; res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(body)); return res; };
  return res;
}

function bodyOf(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function createPreview({ localise = localiseLibraries } = {}) {
  const state = { profiles: [defaultProfile()], athletes: [defaultAthlete()], pathway_plan: [], outreach_targets: [], athlete_benchmarks: [] };
  const vendorFiles = {};
  let signedUp = false;

  function send(res, status, body) {
    if (body === undefined) { res.writeHead(status).end(); return; }
    res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(JSON.stringify(body));
  }
  function reply(req, res, status, rows) {
    if (!/vnd\.pgrst\.object\+json/.test(req.headers.accept || "")) return send(res, status, rows);
    if (rows.length !== 1) return send(res, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" });
    return send(res, status, rows[0]);
  }
  // The PostgREST the app's reads rely on: column filters, then order and limit. Without them a
  // "latest row before today" read (.lt().order().limit(1).maybeSingle()) gets every row back and
  // fails, which the app reports as a failed read. Anything else in the query is ignored.
  const NOT_COLUMNS = ["select", "order", "limit", "offset", "on_conflict", "columns", "or", "and"];
  function matches(value, filter) {
    const dot = filter.indexOf(".");
    const op = dot === -1 ? "" : filter.slice(0, dot), arg = filter.slice(dot + 1);
    if (op === "eq") return String(value) === arg;
    if (op === "neq") return String(value) !== arg;
    if (op === "is") return arg === "null" ? value == null : String(value) === arg;
    if (op === "in") return arg.replace(/^\(|\)$/g, "").split(",").map((x) => x.replace(/^"|"$/g, "")).includes(String(value));
    if (["lt", "lte", "gt", "gte"].includes(op)) {
      if (value == null) return false;
      const c = String(value) < arg ? -1 : String(value) > arg ? 1 : 0;
      return op === "lt" ? c < 0 : op === "lte" ? c <= 0 : op === "gt" ? c > 0 : c >= 0;
    }
    return true;
  }
  function filtered(rows, params) {
    return rows.filter((r) => [...params].every(([k, v]) => NOT_COLUMNS.includes(k) || matches(r[k], v)));
  }
  // Postgres stamps created_at (default now()) on an insert that leaves it out, and the app orders
  // by it: Scout reopens its latest conversation newest first and turns it back into reading order,
  // so unstamped rows (all equal) came back with the answer above the question. Each stamp is later
  // than the one before, as two inserts' now() are, even inside one millisecond.
  let lastStampMs = 0;
  function createdAt() { lastStampMs = Math.max(Date.now(), lastStampMs + 1); return new Date(lastStampMs).toISOString(); }
  function ordered(rows, params) {
    let out = rows.slice();
    const order = (params.get("order") || "").split(",")[0];
    if (order) {
      const [col, dir] = order.split(".");
      out.sort((x, y) => (String(x[col]) < String(y[col]) ? -1 : String(x[col]) > String(y[col]) ? 1 : 0) * (dir === "desc" ? -1 : 1));
    }
    const limit = Number(params.get("limit"));
    if (params.has("limit") && Number.isInteger(limit) && limit >= 0) out = out.slice(0, limit);
    return out;
  }

  const now = Math.floor(Date.now() / 1000);
  function userObj() {
    return { id: USER_ID, aud: "authenticated", role: "authenticated", email: "newathlete@example.com",
      app_metadata: { provider: "email" }, user_metadata: { full_name: "Test Athlete" }, created_at: "2026-01-01T00:00:00Z" };
  }
  function sessionObj() {
    function b64(obj) { return Buffer.from(JSON.stringify(obj)).toString("base64url"); }
    const token = b64({ alg: "none", typ: "JWT" }) + "." + b64({ sub: USER_ID, role: "authenticated", aud: "authenticated", exp: now + 86400 }) + ".preview";
    return { access_token: token, refresh_token: "preview", token_type: "bearer", expires_in: 86400, expires_at: now + 86400, user: userObj() };
  }

  function handleAuth(req, res, sub, body) {
    if (sub === "/auth/v1/signup" && req.method === "POST") {
      signedUp = true;
      if (!state.profiles.find(p => p.id === USER_ID)) state.profiles.push(defaultProfile());
      if (!state.athletes.find(a => a.id === USER_ID)) state.athletes.push(defaultAthlete());
      let input = {}; try { input = JSON.parse(body || "{}"); } catch(e){}
      const p = state.profiles.find(x => x.id === USER_ID);
      if (p && input.data && input.data.full_name) p.full_name = input.data.full_name;
      console.log("auth signup email=" + (input.email || ""));
      return send(res, 200, { ...sessionObj(), session: sessionObj() });
    }
    if (sub === "/auth/v1/token" && req.method === "POST") return send(res, 200, sessionObj());
    if (sub === "/auth/v1/user" && req.method === "GET") return send(res, 200, userObj());
    if (sub === "/auth/v1/user" && req.method === "PUT") return send(res, 200, userObj());
    if (sub.startsWith("/auth/v1/logout") || sub.startsWith("/auth/v1/signout")) return send(res, 204);
    if (sub.startsWith("/auth/v1/")) return send(res, 200, { user: userObj(), session: sessionObj() });
    return send(res, 200, {});
  }

  function rest(req, res, table, params, body) {
    const failing = req.headers["x-preview-fail"];
    if (table === "pathway_plan" && (req.method === "POST" || req.method === "PATCH") && failing === "pathway") {
      let fields = ""; try { fields = body ? Object.keys(JSON.parse(body)).join(",") : ""; } catch(e){}
      console.log("pathway_plan " + (req.method === "POST" ? "upsert" : "update") + " answered HTTP 500 on purpose" + (fields ? " fields=" + fields : ""));
      return send(res, 500, { message: "preview: pathway failed on purpose" });
    }
    if (req.method === "GET") {
      return reply(req, res, 200, ordered(filtered(state[table] || [], params), params));
    }
    const input = body ? JSON.parse(body) : {};
    const row = Array.isArray(input) ? input[0] : input;
    const idField = table === "pathway_plan" ? "user_id" : "id";
    const eqId = params.get(idField) ? params.get(idField).replace(/^eq\./, "") : (row[idField] || row.user_id || row.id || USER_ID);

    if (req.method === "POST") {
      // An upsert matches on its on_conflict columns (one row per athlete and day, say).
      const prefer = req.headers.prefer || "";
      const isUpsert = /resolution=(merge|ignore)-duplicates/.test(prefer) || params.has("on_conflict");
      const keys = (params.get("on_conflict") || idField).split(",");
      const col = state[table] || (state[table] = []);
      const existing = isUpsert && col.find((r) => keys.every((k) => r[k] !== undefined && String(r[k]) === String(row[k])));
      if (existing && /resolution=ignore-duplicates/.test(prefer)) return reply(req, res, 200, []);
      if (existing) {
        Object.assign(existing, row, { updated_at: new Date().toISOString() });
        console.log(table + " upsert id=" + eqId + " fields=" + Object.keys(row).join(","));
        return reply(req, res, 200, [existing]);
      }
      const made = { ...row, id: row.id || crypto.randomUUID() };
      if (made.created_at === undefined) made.created_at = createdAt();
      if (table === "pathway_plan" && !made.updated_at) made.updated_at = new Date().toISOString();
      col.push(made);
      console.log(table + " insert id=" + (made.id || eqId) + " fields=" + Object.keys(row).join(","));
      return reply(req, res, 201, [made]);
    }
    if (req.method === "PATCH") {
      const col = state[table] || [];
      const hits = filtered(col, params);
      hits.forEach(r => Object.assign(r, row));
      console.log(table + " update id=" + eqId + " fields=" + Object.keys(row).join(","));
      return /return=representation/.test(req.headers.prefer || "") ? reply(req, res, 200, hits) : send(res, 204);
    }
    if (req.method === "DELETE") {
      state[table] = (state[table] || []).filter((r) => !filtered([r], params).length);
      console.log(table + " delete id=" + eqId);
      return send(res, 204);
    }
    return send(res, 200, []);
  }

  function athlete() {
    let ath = state.athletes.find((x) => x.id === USER_ID);
    if (!ath) { ath = defaultAthlete(); state.athletes.push(ath); }
    return ath;
  }
  function storeFacts() {
    return { hasPlan: state.pathway_plan.some((p) => Array.isArray(p.milestones) && p.milestones.length > 0), signedUp, hasSport: !!athlete().sport };
  }
  // Puts the store where each drive says it starts (the tool's header). home, today and a page with
  // no drive change nothing: they show what the earlier drives left. A scout drive keeps a plan the
  // store holds; with none it starts where the goal drive does, and builds one.
  function prepareStore(drive) {
    if (drive === "signup" || drive === "full") {
      Object.assign(state, { profiles: [defaultProfile()], athletes: [defaultAthlete()], pathway_plan: [], outreach_targets: [], athlete_benchmarks: [] });
      signedUp = false;
    }
    if (drive === "passport") { athlete().sport = null; state.pathway_plan = []; }
    if (SCOUT_DRIVES.includes(drive)) state.scout_history = [];
    if (drive === "goal" || drive === "reloadmid" || (SCOUT_DRIVES.includes(drive) && !storeFacts().hasPlan)) {
      const ath = athlete();
      ath.sport = ath.sport || "Soccer";
      ath.position = ath.position || "Midfielder";
      state.pathway_plan = [];
    }
  }

  // What the stand-in Supabase answers: the page's requests (through /__sb/) and the Scout
  // handler's own (through serviceFetch) alike. `run` is the question being answered, or null.
  function supabase(req, res, sub, params, body, run) {
    if (sub.startsWith("/auth/v1/")) return handleAuth(req, res, sub, body);
    if (sub.startsWith("/rest/v1/rpc/")) {
      const rpc = sub.replace("/rest/v1/rpc/", "").split("?")[0];
      console.log("rpc " + rpc);
      return send(res, 200, rpcAnswer(rpc, body, run));
    }
    const m = /^\/rest\/v1\/([a-z_]+)$/.exec(sub);
    if (m) return rest(req, res, m[1], params, body);
    return send(res, 200, {});
  }
  // The metering RPCs the handler reads an answer from (migrations 053, 068); any other RPC is null.
  function rpcAnswer(name, body, run) {
    let args = {};
    try { args = JSON.parse(body || "{}") || {}; } catch (e) {}
    if (name === "reserve_scout_question") {
      const limit = Number(args.p_plan_limit) || 0;
      if (run && run.limit) return { allowed: false, used: limit + 1, limit };
      return { allowed: true, used: run && run.last ? limit : 1, limit };
    }
    if (name === "reserve_free_ai_question") return { allowed: true, used: 1, limit: Number(args.p_lifetime_limit) || 0 };
    return null;
  }
  // One of the handler's own Supabase requests, answered by the code above, in this process.
  function storeAnswer(url, init, run) {
    const u = new URL(url);
    const headers = Object.fromEntries(new Headers((init && init.headers) || {}).entries());
    const method = String((init && init.method) || "GET").toUpperCase();
    return new Promise((resolve) => {
      const res = {
        code: 200, head: {},
        writeHead(code, head) { this.code = code; this.head = head || {}; return this; },
        end(text) { resolve(new Response(text == null || this.code === 204 ? null : text, { status: this.code, headers: this.head })); return this; },
      };
      supabase({ method, headers }, res, u.pathname, u.searchParams, init && init.body != null ? String(init.body) : "", run);
    });
  }

  // ---- /api/scout: the real handler, its services stood in ----
  const scoutRuns = [];
  let lastAnsweredAt = -Infinity;
  let turn = Promise.resolve();
  // One question at a time, each SCOUT_SPACING_MS after the one before was answered: the handler's
  // rate limiter stamps a question somewhere inside its run, so the end of the run is the safe mark.
  function inTurn(ask) {
    const mine = turn.then(async () => {
      const wait = scoutWait(lastAnsweredAt, Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try { return await ask(); } finally { lastAnsweredAt = Date.now(); }
    });
    turn = mine.catch(() => {});
    return mine;
  }
  async function askScout(req, res) {
    let body;
    try { const raw = await bodyOf(req); body = raw ? JSON.parse(raw) : undefined; } catch (e) { return send(res, 400, { error: "Invalid JSON body" }); }
    const h = req.headers;
    const run = { script: SCRIPTS.includes(h["x-preview-model"]) ? h["x-preview-model"] : "honest",
      limit: h["x-preview-limit"] === "1", last: h["x-preview-last"] === "1", calls: [], status: null, answer: null };
    run.store = (url, init) => storeAnswer(url, init, run);
    run.model = (init) => modelAnswer(init, run.script);
    const scout = await scoutHandler();
    req.body = body;
    try {
      await inTurn(() => scoutRun.run(run, () => scout(req, vercelResponse(res, run))));
    } catch (e) {
      console.log("scout handler threw: " + ((e && e.stack) || e));
    }
    if (!res.writableEnded) send(res, 500, { error: "The handler sent no answer (see the preview's log)." });
    scoutRuns.push(run);
    console.log(scoutLine(run));
  }

  // Hold/release for drive completion (same pattern as targets)
  const holds = new Map();
  function hold(res) {
    const done = () => { if (!holds.delete(res)) return; clearTimeout(timer); res.writeHead(204, { "cache-control": "no-store" }).end(); };
    const timer = setTimeout(done, 120000);
    holds.set(res, done);
    res.on("close", () => { holds.delete(res); clearTimeout(timer); });
  }

  function handler(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/__store") return send(res, 200, { profiles: state.profiles, athletes: state.athletes, pathway_plan: state.pathway_plan });
    if (u.pathname === "/__hold") return hold(res);
    if (u.pathname === "/__release") { [...holds.values()].forEach((d) => d()); return send(res, 204); }
    if (u.pathname.startsWith("/__sb/")) {
      bodyOf(req).then((body) => supabase(req, res, u.pathname.slice("/__sb".length), u.searchParams, body, null));
      return;
    }
    if (u.pathname === "/api/scout") return askScout(req, res);
    if (u.pathname.startsWith("/api/")) return send(res, 200, {});
    if (vendorFiles[u.pathname]) { res.writeHead(200, { "content-type": MIME[".js"] }); return fs.createReadStream(vendorFiles[u.pathname]).pipe(res); }

    let rel = decodeURIComponent(u.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(ROOT, "." + rel);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      const type = MIME[path.extname(file)] || "application/octet-stream";
      res.setHeader("cache-control", "no-store");
      if (rel !== "/golsz-app.html") { res.writeHead(200, { "content-type": type }); return res.end(buf); }
      const local = localise(buf.toString("utf8"));
      Object.assign(vendorFiles, local.files);
      console.log("page " + (u.search || "(no query)"));
      const drive = DRIVES.includes(u.searchParams.get("drive")) ? u.searchParams.get("drive") : "";
      const buildPlan = SCOUT_DRIVES.includes(drive) && !storeFacts().hasPlan;
      prepareStore(drive);
      const seedSession = seedsSession(drive, storeFacts());
      const failParam = u.searchParams.get("fail");
      const modelParam = u.searchParams.get("model");
      const cfg = {
        ...constantsFrom(appBundle()), userId: USER_ID,
        theme: u.searchParams.get("theme") || "",
        lang: LANGS.includes(u.searchParams.get("lang")) ? u.searchParams.get("lang") : "",
        today: /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get("today") || "") ? u.searchParams.get("today") : "",
        fail: failParam === "pathway" ? "pathway" : "",
        overflow: u.searchParams.get("overflow") === "1",
        model: SCRIPTS.includes(modelParam) ? modelParam : drive === "scoutinvent" ? "step" : "",
        limit: u.searchParams.get("limit") === "1" || drive === "scoutlimit",
        last: u.searchParams.get("last") === "1" || drive === "scoutlast",
        drive, seedSession, buildPlan,
      };
      res.writeHead(200, { "content-type": type });
      res.end(pageWithStub(local.html, cfg));
    });
  }

  return { handler, state, scoutRuns };
}

if (require.main === module) {
  const server = http.createServer(createPreview().handler);
  server.listen(Number(process.argv[2]) || 0, "127.0.0.1", () => console.log("Onboarding preview on http://127.0.0.1:" + server.address().port + "/golsz-app.html"));
}

module.exports = { createPreview, pageWithStub, stubCall, stub, homeCounts, labelsShown, driveTitle, scrollBoxes, worstScroll, seedsSession, DRIVES, USER_ID, defaultProfile, defaultAthlete,
  cardSentence, promptFacts, scriptedReply, scoutWait, scoutLine, serviceFetch, SCOUT_DRIVES, SCRIPTS, SCOUT_SPACING_MS, ANTHROPIC_MESSAGES, STAND_IN_SUPABASE, INVENTED_STEP };
