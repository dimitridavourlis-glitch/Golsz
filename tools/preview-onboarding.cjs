#!/usr/bin/env node
// Serves the repo for a browser run of the first visit (sign up -> Passport -> GoalSetup -> Home)
// as a stand-in flow that never touches the live database. Not a test (it needs a browser), so it
// lives outside tests/. Modelled on tools/preview-targets.cjs.
//
// Usage:  node tools/preview-onboarding.cjs [port]        (default: a free port, printed)
//   then open  http://127.0.0.1:<port>/golsz-app.html
//   &fail=pathway     the pathway_plan upsert answers HTTP 500
//   &today=YYYY-MM-DD overrides "today" for the stub (stored as data attribute for the app)
//   &theme=light|dark sets localStorage["golsz-theme"] before the page starts
//   &lang=en|fr|es|el sets localStorage["golsz-lang"] the same way
//   &drive=signup|passport|goal|full|reloadmid
//     signup    fills sign-up as an adult and submits
//     passport  fills sport, position, club, country and saves (starts signed in, no profile sport)
//     goal      fills the goal and taps Build my plan (starts signed in, profile complete, no plan)
//     full      all three in order
//     reloadmid reloads between passport and goal
//   When a drive finishes, the page title ends with:
//     [drive done; screen: <name>; today: <n>; thisWeek: <n>; alerts: <...>]
//   The server prints each write as  <table> <insert|update|upsert|rpc> id=<id> fields=<names>
//
// WHAT IS STAND-IN: auth (signUp/getSession/getUser) answered locally; profiles, athletes,
// pathway_plan, outreach_targets, athlete_benchmarks stored in the server process; every other
// table answers empty; sync_athlete_actions and other RPCs Home calls return empty. Nothing is
// sent to the real Supabase project. The stand-in knows nothing about real RLS/limits: it proves
// the SCREEN, not the database.
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

// Runs first in <head>, before the theme script, the CDN libraries and the app.
function stub(cfg) {
  try { if (cfg.theme === "light" || cfg.theme === "dark") localStorage.setItem("golsz-theme", cfg.theme); } catch (e) {}
  try { if (cfg.lang) localStorage.setItem("golsz-lang", cfg.lang); } catch (e) {}
  try { if (cfg.today) localStorage.setItem("preview-today", cfg.today); } catch (e) {}

  function b64(obj) { return btoa(JSON.stringify(obj)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"); }
  var now = Math.floor(Date.now() / 1000);
  var user = { id: cfg.userId, aud: "authenticated", role: "authenticated", email: "newathlete@example.com", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
  var token = b64({ alg: "none", typ: "JWT" }) + "." + b64({ sub: cfg.userId, role: "authenticated", aud: "authenticated", exp: now + 86400 }) + ".preview";
  var session = { access_token: token, refresh_token: "preview", token_type: "bearer", expires_in: 86400, expires_at: now + 86400, user: user };
  var authKey = "sb-" + new URL(cfg.supabaseUrl).hostname.split(".")[0] + "-auth-token";

  // Pre-seed session for drives that start signed in (passport, goal). signup/full start unauthenticated.
  if (cfg.seedSession) {
    try { localStorage.setItem(authKey, JSON.stringify(session)); } catch (e) {}
  } else {
    try { localStorage.removeItem(authKey); } catch (e) {}
  }

  // Override Date so "today" is stable when &today= is set (helps deterministic counts in title).
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

  var setNativeVal = function (el, v, proto) {
    var P = proto || (el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype);
    var desc = Object.getOwnPropertyDescriptor(P, "value");
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  function textOf(el) { return (el && (el.textContent || "") || "").replace(/\s+/g, " ").trim(); }
  function all( sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function visible(el) { if (!el) return false; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
  function btnWithText(text, root) {
    return all("button, [role=button]", root).filter(function (b) { return visible(b) && textOf(b).indexOf(text) !== -1; });
  }
  function findInput(labelText) {
    // Try label[for], then placeholder/aria-label contains
    var labels = all("label").filter(function (l) { return textOf(l).toLowerCase().indexOf(labelText.toLowerCase()) !== -1; });
    for (var i = 0; i < labels.length; i++) {
      if (labels[i].htmlFor) { var el = document.getElementById(labels[i].htmlFor); if (el) return el; }
      var inp = labels[i].querySelector("input, textarea, select");
      if (inp) return inp;
      var next = labels[i].nextElementSibling;
      if (next && /INPUT|TEXTAREA|SELECT/.test(next.tagName)) return next;
    }
    return all("input, textarea").filter(function (i) { return ((i.placeholder||"") + " " + (i.getAttribute("aria-label")||"")).toLowerCase().indexOf(labelText.toLowerCase()) !== -1; })[0] || null;
  }

  if (cfg.drive) {
    // Hold page load so browser captures wait for drive completion (same pattern as targets).
    new Image().src = "/__hold?" + Date.now() + Math.random();
    var baseTitle = null;
    var mark = function (t) { if (baseTitle === null) baseTitle = document.title; document.title = baseTitle + " [" + t + "]"; };
    var done = false;

    function finishSummary() {
      // Screen name: look for headings / key UI markers
      var screen = "unknown";
      if (all("h1,h2,h3").some(function (h) { return /goal|plan|pathway/i.test(textOf(h)); }) && btnWithText("Build").length) screen = "GoalSetup";
      else if (btnWithText("Today").length || btnWithText("This week").length || /TODAY|THIS WEEK/i.test(document.body.textContent)) screen = "Home";
      else if (all("input,select,textarea").some(function (i) { return /sport/i.test((i.placeholder||"") + (i.id||"") + (i.name||"")); }) || btnWithText("Save").length) screen = "Passport";
      else if (btnWithText("Sign up").length || btnWithText("Create").length || all("input[type=password]").length) screen = "Auth";
      // Today / This week counts: look for number tiles near those labels
      var body = document.body.textContent || "";
      var todayN = (body.match(/TODAY[\s\S]{0,40}?(\d+)/i) || body.match(/Today[\s\S]{0,40}?(\d+)/) || [])[1] || "?";
      var weekN = (body.match(/THIS WEEK[\s\S]{0,40}?(\d+)/i) || body.match(/This week[\s\S]{0,40}?(\d+)/) || [])[1] || "?";
      var alerts = all("[role=alert]").map(function (a) { return textOf(a); }).filter(Boolean).join(" | ");
      mark('drive done; screen: ' + screen + '; today: ' + todayN + '; thisWeek: ' + weekN + '; alerts: ' + (alerts || "none"));
      fetch("/__release").catch(function () {});
    }

    var step = 0;
    var timer = setInterval(function () {
      if (done) { clearInterval(timer); return; }
      try {
        if (cfg.drive === "signup" || (cfg.drive === "full" && step < 10)) {
          // Sign up flow
          if (step === 0) {
            // Switch to sign-up tab if there's a toggle
            var su = btnWithText("Sign up").concat(btnWithText("Create account")).concat(btnWithText("Get started"));
            var toggle = su.filter(function (b) { return !/submit/i.test(b.type || ""); })[0];
            if (toggle && !/password/i.test(document.body.innerHTML.slice(0,500))) { toggle.click(); step = 1; mark("drive 1"); return; }
            step = 1; mark("drive 1");
          }
          if (step === 1) {
            var nameI = document.getElementById("signup-name") || findInput("name") || findInput("full");
            var emailI = document.getElementById("signup-email") || all('input[type="email"]')[0] || findInput("email");
            var pwI = document.getElementById("signup-pw") || all('input[type="password"]')[0] || findInput("password");
            if (!emailI || !pwI) return;
            if (nameI) setNativeVal(nameI, "Test Athlete");
            setNativeVal(emailI, "test@example.com");
            // email2 if present
            var e2 = document.getElementById("signup-email2"); if (e2) setNativeVal(e2, "test@example.com");
            setNativeVal(pwI, "Password123!");
            // DOB fields
            var day = document.getElementById("signup-dob-day") || document.getElementById("signup-dob");
            var month = document.getElementById("signup-dob-month");
            var year = document.getElementById("signup-dob-year");
            if (day && month && year) { setNativeVal(day, "15"); setNativeVal(month, "6"); setNativeVal(year, "1998"); }
            else if (day && day.type === "date") setNativeVal(day, "1998-06-15");
            step = 2; mark("drive 2"); return;
          }
          if (step === 2) {
            var sub = btnWithText("Create account").concat(btnWithText("Sign up")).concat(btnWithText("Start free")).concat(btnWithText("Continue"));
            var b = sub.filter(function (x) { return x.type === "submit" || x.tagName === "BUTTON"; })[0];
            if (b) { b.click(); step = cfg.drive === "full" ? 10 : 99; mark(cfg.drive === "full" ? "drive signup done" : "drive 3"); }
            return;
          }
        }
        if (cfg.drive === "passport" || (cfg.drive === "full" && step >= 10 && step < 20)) {
          if (step < 10) step = 10;
          if (step === 10) {
            // Wait for passport editor / onboarding form
            var sportI = findInput("sport") || all('input[placeholder*="sport" i], select[id*="sport" i]').filter(visible)[0];
            var saveB = btnWithText("Save").concat(btnWithText("Continue")).concat(btnWithText("Next"));
            if (!sportI && !saveB.length) return;
            if (sportI) {
              if (sportI.tagName === "SELECT") { sportI.value = "Soccer"; sportI.dispatchEvent(new Event("change",{bubbles:true})); }
              else setNativeVal(sportI, "Soccer");
            }
            var pos = findInput("position"); if (pos) setNativeVal(pos, "Midfielder");
            var club = findInput("club"); if (club) setNativeVal(club, "Test FC");
            var country = findInput("country"); if (country) setNativeVal(country, "Canada");
            step = 11; mark("drive passport filled"); return;
          }
          if (step === 11) {
            var sb2 = btnWithText("Save").concat(btnWithText("Continue")).concat(btnWithText("Next")).concat(btnWithText("Done"))[0];
            if (sb2) { sb2.click(); step = cfg.drive === "full" ? 20 : 99; mark(cfg.drive === "full" ? "drive passport done" : "drive passport saved"); }
            return;
          }
        }
        if (cfg.drive === "goal" || (cfg.drive === "full" && step >= 20 && step < 30)) {
          if (step < 20) step = 20;
          if (step === 20) {
            var goalI = document.getElementById("goal-setup-goal") || findInput("goal") || all("textarea").filter(visible)[0];
            if (!goalI) return;
            setNativeVal(goalI, "Play college soccer in the US", window.HTMLTextAreaElement.prototype);
            step = 21; mark("drive goal filled"); return;
          }
          if (step === 21) {
            var buildB = btnWithText("Build my plan").concat(btnWithText("Build")).concat(btnWithText("plan"))[0];
            if (buildB) { buildB.click(); step = 99; mark("drive building"); }
            return;
          }
        }
        if (cfg.drive === "reloadmid" || (cfg.drive === "full" && cfg.reloadMid)) {
          // handled via separate logic below
        }
        if (step === 99) {
          // Wait for Home (or done state)
          var onHome = /TODAY|This week/i.test(document.body.textContent) || btnWithText("Mark done").length > 0 || all("[id*=home],[data-page=home]").length > 0;
          if (onHome || step === 99) {
            // give React a moment to settle
            if (!cfg._settled) { cfg._settled = Date.now(); }
            if (Date.now() - cfg._settled < 800) return;
            done = true;
            setTimeout(finishSummary, 400);
          }
        }
        // Standalone passport/goal drives: kick off
        if (cfg.drive === "passport" && step === 0) { step = 10; }
        if (cfg.drive === "goal" && step === 0) { step = 20; }
        if (cfg.drive === "reloadmid") {
          // passport first, then reload, then goal
          if (step === 0) step = 10;
          if (step === 12) { step = 13; window.location.href = window.location.pathname + window.location.search.replace(/drive=reloadmid/, "drive=reloadmid2"); return; }
        }
        if (cfg.drive === "reloadmid2") {
          if (step === 0) step = 20;
        }
      } catch (e) { /* keep trying */ }
    }, 200);
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var req = new Request(input, init);
    if (req.url.indexOf(cfg.supabaseUrl) !== 0) return realFetch(input, init);
    var headers = new Headers(req.headers);
    if (cfg.fail) headers.set("x-preview-fail", cfg.fail);
    var target = location.origin + "/__sb" + req.url.slice(cfg.supabaseUrl.length);
    var hasBody = req.method !== "GET" && req.method !== "HEAD";
    return (hasBody ? req.text() : Promise.resolve(undefined)).then(function (body) {
      return realFetch(target, { method: req.method, headers: headers, body: body || undefined });
    });
  };
  var RealSocket = window.WebSocket;
  window.WebSocket = function (url) {
    if (String(url).indexOf(new URL(cfg.supabaseUrl).host) === -1) return new RealSocket(url);
    return { readyState: 3, send: function () {}, close: function () {}, addEventListener: function () {}, removeEventListener: function () {} };
  };
}

function pageWithStub(html, cfg) {
  const tag = "<script>(" + stub.toString() + ")(" + JSON.stringify(cfg).replace(/</g, "\\u003c") + ");</script>";
  return html.replace(/<head[^>]*>/i, (m) => m + tag);
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
  function filtered(rows, params) {
    return rows.filter((r) => [...params].every(([k, v]) => {
      if (k === "select" || k === "order" || k === "limit" || k === "on_conflict" || k === "columns") return true;
      if (!v.startsWith("eq.")) return true;
      return String(r[k]) === v.slice(3);
    }));
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
      // Ensure profile/athlete rows exist in store
      if (!state.profiles.find(p => p.id === USER_ID)) state.profiles.push(defaultProfile());
      if (!state.athletes.find(a => a.id === USER_ID)) state.athletes.push(defaultAthlete());
      let input = {}; try { input = JSON.parse(body || "{}"); } catch(e){}
      const p = state.profiles.find(x => x.id === USER_ID);
      if (p && input.data && input.data.full_name) p.full_name = input.data.full_name;
      console.log("auth signup email=" + (input.email || ""));
      return send(res, 200, { ...sessionObj(), session: sessionObj() });
    }
    if (sub === "/auth/v1/token" && req.method === "POST") {
      return send(res, 200, sessionObj());
    }
    if (sub === "/auth/v1/user" && req.method === "GET") {
      // If not seeded/signed up and no auth header, return 401-like or user; for preview be permissive when session seeded
      const auth = req.headers["authorization"] || "";
      if (!auth && !signedUp) return send(res, 200, userObj()); // permissive for drive flows
      return send(res, 200, userObj());
    }
    if (sub === "/auth/v1/user" && req.method === "PUT") {
      return send(res, 200, userObj());
    }
    if (sub.startsWith("/auth/v1/logout") || sub.startsWith("/auth/v1/signout")) {
      return send(res, 204);
    }
    // getSession is client-side from storage in supabase-js v2; but some flows may hit endpoints
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
      const rows = filtered(state[table] || [], params);
      return reply(req, res, 200, rows);
    }
    const input = body ? JSON.parse(body) : {};
    const row = Array.isArray(input) ? input[0] : input;
    const idField = table === "profiles" || table === "athletes" ? "id" : (table === "pathway_plan" ? "user_id" : "id");
    const eqId = params.get(idField) ? params.get(idField).replace(/^eq\./, "") : (row[idField] || row.user_id || row.id || USER_ID);

    if (req.method === "POST") {
      // upsert detection: Prefer header with resolution=merge-duplicates or on_conflict param
      const isUpsert = /resolution=merge-duplicates/.test(req.headers.prefer || "") || params.has("on_conflict");
      const col = state[table] || (state[table] = []);
      const existing = col.find(r => String(r[idField]) === String(eqId));
      if (isUpsert && existing) {
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
      if (state[table]) state[table] = filtered(state[table], params).length ? state[table].filter(r => !filtered([r], params).length) : state[table];
      console.log(table + " delete id=" + eqId);
      return send(res, 204);
    }
    return send(res, 200, []);
  }

  // Hold/release for drive completion (same pattern as targets)
  const holds = new Map();
  function hold(res) {
    const done = () => { if (!holds.delete(res)) return; clearTimeout(timer); res.writeHead(204, { "cache-control": "no-store" }).end(); };
    const timer = setTimeout(done, 25000);
    holds.set(res, done);
    res.on("close", () => { holds.delete(res); clearTimeout(timer); });
  }

  function handler(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/__store") return send(res, 200, { profiles: state.profiles, athletes: state.athletes, pathway_plan: state.pathway_plan });
    if (u.pathname === "/__hold") return hold(res);
    if (u.pathname === "/__release") { [...holds.values()].forEach((d) => d()); return send(res, 204); }
    if (u.pathname === "/__log" && req.method === "POST") {
      let body = ""; req.on("data", c => body += c); req.on("end", () => { res.writeHead(204).end(); }); return;
    }
    if (u.pathname.startsWith("/__sb/")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const sub = u.pathname.slice("/__sb".length);
        if (sub.startsWith("/auth/v1/")) return handleAuth(req, res, sub, body);
        if (sub.startsWith("/rest/v1/rpc/")) {
          // All RPCs return empty/null - sync_athlete_actions and others Home calls
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
      const drive = ["signup","passport","goal","full","reloadmid","reloadmid2"].includes(u.searchParams.get("drive")) ? u.searchParams.get("drive") : "";
      // Seed session for passport/goal standalone drives; full/signup start unauth; reloadmid2 continues signed in
      const seedSession = drive === "passport" || drive === "goal" || drive === "reloadmid2";
      // For passport drive, ensure athlete has no sport so onboarding triggers
      if (drive === "passport" || drive === "full" || drive === "reloadmid") {
        const a = state.athletes.find(x => x.id === USER_ID) || defaultAthlete();
        if (drive === "passport") { a.sport = null; }
        if (!state.athletes.find(x => x.id === USER_ID)) state.athletes.push(a);
      }
      // For goal drive, ensure profile complete, no pathway
      if (drive === "goal") {
        const a = state.athletes.find(x => x.id === USER_ID); if (a) { a.sport = "Soccer"; a.position = "Midfielder"; }
      }
      const failParam = u.searchParams.get("fail");
      const cfg = {
        ...constantsFrom(local.html), userId: USER_ID,
        theme: u.searchParams.get("theme") || "",
        lang: LANGS.includes(u.searchParams.get("lang")) ? u.searchParams.get("lang") : "",
        today: u.searchParams.get("today") || "",
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

module.exports = { createPreview, pageWithStub, stub, USER_ID, defaultProfile, defaultAthlete };
