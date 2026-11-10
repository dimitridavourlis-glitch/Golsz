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
//   &drive=signup|passport|goal|home|today|reloadmid|full   acts like a person, then reports:
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
//   Every drive that ends on Home taps the Today tile and "Show my progress", reads the TODAY and
//   THIS WEEK cells (done/total), and goes back to the tiles. The page title then ends with
//     [drive done; path: <screens in order>; screen: <last screen>; today: <done>/<total>;
//      thisWeek: <done>/<total>; badge: <the Today tile's "N to do">; next: <its step>;
//      labels: <n>/<all> on screen (<the stored step labels seen>); goalSetupFrom: <...>;
//      scroll: <scrollWidth>/<innerWidth>; goalSetupScroll: ...; todayViewScroll: ...; alerts: <...>]
//   and with fail=pathway also  failAlert="<text>"; formKept; goalKept; plansAtFail=<pathway_plan
//   rows>; goalTextAtFail (the goal sentence is saved before the plan, so it is "saved"); retry.
//   When the daily check-in ("How do you feel today?") covers Home, the drive taps "Skip for
//   today" first, as a person must, and the title says  checkin: skipped.
//   A drive that cannot go on says  [drive FAILED: timed out waiting for <what>; ...]  instead.
//   The server prints each write as  <table> <insert|update|upsert|delete> id=<id> fields=<names>
//   Use one server per width and theme: the store lives in the server and every drive changes it.
//
// WHAT IS STAND-IN: auth (signUp/getSession/getUser) answered locally; profiles, athletes,
// pathway_plan, outreach_targets, athlete_benchmarks stored in the server process; any other
// table starts empty and keeps what the app writes to it; reads honour column filters, order and
// limit; sync_athlete_actions and the other RPCs Home calls return empty. Nothing is sent to the
// real Supabase project. The stand-in knows nothing about real RLS/limits: it proves the SCREEN,
// not the database.
//
// HOW IT STAYS OUT OF THE PRODUCT: the stub is added to the response in memory only, so the file
// on disk is never written. Every request to the Supabase host is rewritten to /__sb/... on this
// server and never forwarded. The server binds to 127.0.0.1 and serves only files under the repo
// root. CDN libraries come from local npm-pack copies (see preview-public-passport.cjs).
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MIME, localiseLibraries } = require("./preview-public-passport.cjs");

const ROOT = path.resolve(__dirname, "..");
const USER_ID = "00000000-0000-4000-8000-000000000099";
const LANGS = ["en", "fr", "es", "el"];

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

// What a finished (or stuck) drive writes after the page title.
function driveTitle(f) {
  const yn = (v) => (v ? "yes" : "no");
  const parts = [f.error ? "drive FAILED: timed out waiting for " + f.error : "drive done"];
  parts.push("path: " + ((f.path || []).join(" > ") || "none"), "screen: " + (f.screen || "unknown"));
  if (f.counts) parts.push("today: " + f.counts.today, "thisWeek: " + f.counts.thisWeek);
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
  parts.push("alerts: " + (f.alerts || "none"));
  return parts.join("; ");
}

// Whether the page starts signed in. Sign-up (and full) start signed out; the other drives are an
// athlete who already has an account; a page with no drive is signed in once there is an account
// to be signed in to (a sign-up, a sport or a plan in the store).
function seedsSession(drive, store) {
  if (drive === "signup" || drive === "full") return false;
  if (drive) return true;
  return !!(store && (store.hasPlan || store.signedUp || store.hasSport));
}

const PAGE_RULES = { homeCounts, labelsShown, driveTitle };
const DRIVES = ["signup", "passport", "goal", "home", "today", "reloadmid", "full"];

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
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var req = new Request(input, init);
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

  var STEP_MS = 12000;
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
  // Home's number cells: a heading span and, right after it, the value span.
  function cells() {
    var h = home();
    return h ? all("span", h).filter(function (s) { return visible(s) && s.nextElementSibling && /^(TODAY|THIS WEEK)$/.test(textOf(s)); })
      .map(function (s) { return { label: textOf(s), value: textOf(s.nextElementSibling) }; }) : [];
  }
  function screenName() {
    if (goalSetup()) return "GoalSetup";
    if (editor()) return "Passport editor";
    if (authForm()) return "Auth";
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
  function scrollNow() { return document.documentElement.scrollWidth + "/" + window.innerWidth; }

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
    facts.goalSetupScroll = scrollNow();
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
    facts.scroll = scrollNow();
    var plan = ((await store()).pathway_plan || [])[0];
    var labels = ((plan && plan.milestones) || []).map(function (m) { return m && m.label; }).filter(Boolean);
    var seen = textOf(home());
    todayTile().click();
    var toggle = await until(progressToggle, "the Today view");
    await pause(300);
    seen += " " + textOf(home());
    if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
    await until(function () { return cells().length; }, "", 3000).catch(function () {});
    facts.counts = rules.homeCounts(cells());
    facts.todayViewScroll = scrollNow();
    seen += " " + textOf(home());
    facts.labels = rules.labelsShown(labels, seen);
    facts.labelTotal = labels.length;
    if (stay) return;
    withText("button", "Back", home())[0].click();
    await until(todayTile, "Home's tiles after 'Back'");
  }

  async function run() {
    var d = cfg.drive;
    if (d === "signup" || d === "full") await signup();
    if (d === "passport" || d === "full") await passport();
    if (d === "goal" || d === "reloadmid" || d === "full") await goal(d === "reloadmid");
    if (d !== "signup" && d !== "passport") await readHome(d === "today");
  }
  function finish(err) {
    facts.error = err ? String(err.message || err) : "";
    facts.screen = screenName();
    if (!facts.scroll) facts.scroll = scrollNow();
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

function constantsFrom(html) {
  const grab = (name) => { const m = new RegExp(name + '\\s*=\\s*"([^"]+)"').exec(html); if (!m) throw new Error(name + " not found in golsz-app.html"); return m[1]; };
  return { supabaseUrl: grab("SUPABASE_URL") };
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
  // no drive change nothing: they show what the earlier drives left.
  function prepareStore(drive) {
    if (drive === "signup" || drive === "full") {
      Object.assign(state, { profiles: [defaultProfile()], athletes: [defaultAthlete()], pathway_plan: [], outreach_targets: [], athlete_benchmarks: [] });
      signedUp = false;
    }
    if (drive === "passport") { athlete().sport = null; state.pathway_plan = []; }
    if (drive === "goal" || drive === "reloadmid") {
      const ath = athlete();
      ath.sport = ath.sport || "Soccer";
      ath.position = ath.position || "Midfielder";
      state.pathway_plan = [];
    }
  }

  // Hold/release for drive completion (same pattern as targets)
  const holds = new Map();
  function hold(res) {
    const done = () => { if (!holds.delete(res)) return; clearTimeout(timer); res.writeHead(204, { "cache-control": "no-store" }).end(); };
    const timer = setTimeout(done, 45000);
    holds.set(res, done);
    res.on("close", () => { holds.delete(res); clearTimeout(timer); });
  }

  function handler(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/__store") return send(res, 200, { profiles: state.profiles, athletes: state.athletes, pathway_plan: state.pathway_plan });
    if (u.pathname === "/__hold") return hold(res);
    if (u.pathname === "/__release") { [...holds.values()].forEach((d) => d()); return send(res, 204); }
    if (u.pathname.startsWith("/__sb/")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const sub = u.pathname.slice("/__sb".length);
        if (sub.startsWith("/auth/v1/")) return handleAuth(req, res, sub, body);
        if (sub.startsWith("/rest/v1/rpc/")) {
          const rpc = sub.replace("/rest/v1/rpc/", "").split("?")[0];
          console.log("rpc " + rpc);
          return send(res, 200, null);
        }
        const m = /^\/rest\/v1\/([a-z_]+)$/.exec(sub);
        if (m) return rest(req, res, m[1], u.searchParams, body);
        return send(res, 200, {});
      });
      return;
    }
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
      prepareStore(drive);
      const seedSession = seedsSession(drive, storeFacts());
      const failParam = u.searchParams.get("fail");
      const cfg = {
        ...constantsFrom(local.html), userId: USER_ID,
        theme: u.searchParams.get("theme") || "",
        lang: LANGS.includes(u.searchParams.get("lang")) ? u.searchParams.get("lang") : "",
        today: /^\d{4}-\d{2}-\d{2}$/.test(u.searchParams.get("today") || "") ? u.searchParams.get("today") : "",
        fail: failParam === "pathway" ? "pathway" : "",
        drive, seedSession,
      };
      res.writeHead(200, { "content-type": type });
      res.end(pageWithStub(local.html, cfg));
    });
  }

  return { handler, state };
}

if (require.main === module) {
  const server = http.createServer(createPreview().handler);
  server.listen(Number(process.argv[2]) || 0, "127.0.0.1", () => console.log("Onboarding preview on http://127.0.0.1:" + server.address().port + "/golsz-app.html"));
}

module.exports = { createPreview, pageWithStub, stubCall, stub, homeCounts, labelsShown, driveTitle, seedsSession, DRIVES, USER_ID, defaultProfile, defaultAthlete };
