#!/usr/bin/env node
// Serves the repo for a browser run of the PLAN page's "Schools & clubs" card (Targets) as a signed-in
// athlete on plan 'pro' (so the Targets gate is open), with Supabase replaced by a stand-in database held
// by THIS server process. Rows survive a browser reload; they are lost when the server stops. Not a test
// (it needs a browser), so it lives outside tests/. Modelled on tools/preview-public-passport.cjs.
//
// Usage:  node tools/preview-targets.cjs [port]        (default: a free port, printed)
//   then open  http://127.0.0.1:<port>/golsz-app.html?page=plan
//   &fail=select|insert|update|delete   that one call on outreach_targets answers HTTP 500
//                (select: the card shows its load error with Retry; the others: the failed-save message)
//   &reset=1     empties the store (no targets: the empty state)
//   &reset=seed  puts the three seeded rows back (the store starts with them)
//   &open=schools  opens the "Schools & clubs" row and scrolls to it once (it is closed, below the fold)
//   &drive=add|adddouble|editbad|editgood  also opens the card, then acts like a person would (the browser tool
//                cannot click): add = fill "Montreal Impact Academy" and press Add; adddouble = the same, pressing
//                Add twice at once; editbad / editgood = edit the first row's contact email to "coach@uni" /
//                "coach@uni.edu" and press Save. Combine with &fail=update to see a refused edit.
//                &drive=expand opens the first row's panel; draft = type a draft there and press Save draft; bigdraft =
//                paste 10,001 characters into the draft box (no save). Combine draft with &fail=update.
//                draftclose = type a draft, leave the box (blur: the save starts) and press the row's chevron in the
//                same moment, so the box closes while its save is on the way; draftreopen = the same, then, once the
//                card names the target, press the chevron again; draftsection = type, leave the box and close the
//                "Schools & clubs" section itself. Combine these three with &fail=update.
//                Delete (the seeded order: row 1 Northfield College Soccer holds a draft, row 2 Lakeside FC has none):
//                arm = one tap on row 1's delete button; armplain = one tap on row 2's; delete = one tap on row 1's,
//                then a second once its armed word ("Delete?") has been on screen for a second; deletedouble = a double tap on
//                row 1's (the second click stamped right after the first, handed over 150 ms later): it must
//                delete nothing. Combine delete with &fail=delete. armother = one tap on row 1's, then one on
//                row 2's (row 1 must disarm); armwait = one tap on row 1's, then the capture waits 6.5 s (past
//                the 6 s the row stays armed). look = press nothing, only wait for the list (for a plain reload).
//   &theme=light|dark  sets localStorage["golsz-theme"] before the page's own theme script runs
//   &lang=en|fr|es|el  sets localStorage["golsz-lang"] the same way (the delete drives work in every language;
//                the add/edit/draft drives press buttons by their English words, so use those in English)
//   The server prints each page load as   page <query>   and each write after it as
//   outreach_targets <insert|update|delete> id=<id> fields=<names>
//   (a refused one as   outreach_targets <op> answered HTTP 500 on purpose fields=<names>)
//   and GET /__store returns the current rows as JSON. A drive marks its progress in the page title
//   ("[drive 1/2]", then "[drive done]") and holds GET /__hold open until it is done (see the stub). Done,
//   the title ends "[drive done; rows: <name> {<armed word>} | ...; alerts: <line> | ...]": what the card showed.
//
// With AVA's browser tool: "$AVA_BROWSER" --serve "node tools/preview-targets.cjs 8766" --port 8766
//   "/golsz-app.html?page=plan" "/golsz-app.html?page=plan&fail=select" --widths 390,1280
//
// WHAT IS STAND-IN: the signed-in user (fixed id, session written to localStorage before the app starts),
// profiles (plan 'pro'), athletes, athlete_benchmarks and outreach_targets (select/insert/update/delete,
// eq filters, order, single-object replies). Every other table answers an empty list, so the Plan page's
// other cards show their empty states. The stand-in knows nothing about the real column limits or RLS:
// it proves the SCREEN, not the database (the migrations and policies are not exercised here).
//
// HOW IT STAYS OUT OF THE PRODUCT: the stub is added to the response for /golsz-app.html in memory only,
// so the file on disk is never written. In the page, every request to the Supabase host is rewritten to
// /__sb/... on this server and never forwarded; the realtime WebSocket is replaced by an inert object.
// The server binds to 127.0.0.1 and serves only files under the repo root. The CDN libraries come from
// local npm-pack copies (see preview-public-passport.cjs).
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MIME, localiseLibraries } = require("./preview-public-passport.cjs");

const ROOT = path.resolve(__dirname, "..");
const USER_ID = "00000000-0000-4000-8000-000000000001";
const DAY = 86400000;

function seedTargets() {
  const at = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
  const row = (n, fields) => ({
    id: "00000000-0000-4000-8000-0000000001" + String(n).padStart(2, "0"), user_id: USER_ID,
    contact_name: null, contact_email: null, status: "researching", notes: null, draft_email: null, fit_reasoning: null,
    updated_at: at(n), created_at: at(n), ...fields,
  });
  return [
    row(1, { name: "Northfield College Soccer", contact_name: "Coach Rivera", contact_email: "rivera@example.edu", status: "contacted",
      draft_email: "Hi Coach Rivera,\n\nI am a midfielder graduating in 2027 and would like to be considered for next season.\n\nThanks,\nMarco" }),
    row(2, { name: "Lakeside FC", status: "researching", fit_reasoning: "Plays the same system and recruits from the athlete's region." }),
    row(3, { name: "Metro United Academy", contact_name: "Dana Lopez", status: "follow_up", notes: "Trial day mentioned in their last post." }),
  ];
}

const PROFILE = {
  id: USER_ID, full_name: "Marco Tester", occupation: "Player", avatar_url: null, plan: "pro", is_banned: false, is_admin: false,
  onboarding_conversion_shown: true, free_ai_lifetime_used: 0, goal_defined: true, full_access: false,
};
const ATHLETE = {
  id: USER_ID, sport: "Soccer", position: "Midfielder", club_name: "Test FC", grad_year: 2027, country: "Canada",
  recruiting_status: "Open", bio: "Box-to-box midfielder looking for a college pathway.", highlights: [], timeline: [], scout_context: {},
};

// Runs first in <head>, before the theme script, the CDN libraries and the app.
// Kept as a function so it is syntax-checked with this file, then serialised into the page.
function stub(cfg) {
  try { if (cfg.theme === "light" || cfg.theme === "dark") localStorage.setItem("golsz-theme", cfg.theme); } catch (e) { /* storage blocked */ }
  try { if (cfg.lang) localStorage.setItem("golsz-lang", cfg.lang); } catch (e) { /* storage blocked */ }
  function b64(obj) { return btoa(JSON.stringify(obj)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"); }
  var now = Math.floor(Date.now() / 1000);
  var user = { id: cfg.userId, aud: "authenticated", role: "authenticated", email: "marco@example.com", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" };
  // An unsigned token, so nothing here resembles a real credential.
  var token = b64({ alg: "none", typ: "JWT" }) + "." + b64({ sub: cfg.userId, role: "authenticated", aud: "authenticated", exp: now + 86400 }) + ".preview";
  var session = { access_token: token, refresh_token: "preview", token_type: "bearer", expires_in: 86400, expires_at: now + 86400, user: user };
  try { localStorage.setItem("sb-" + new URL(cfg.supabaseUrl).hostname.split(".")[0] + "-auth-token", JSON.stringify(session)); } catch (e) { /* storage blocked */ }

  // Today's "How do you feel?" check-in is marked answered (local day, as isoDay() reads it), or it would cover the Plan page.
  var d = new Date();
  var today = d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  try { localStorage.setItem("golsz-checkin", cfg.userId + ":" + today); } catch (e) { /* storage blocked */ }

  if (cfg.drive) {
    // Acts on the page like a person: polls for each element, sets values through the native setter so React sees them.
    var setVal = function (el, v) {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    var btnByText = function (text) {
      return Array.prototype.filter.call(document.querySelectorAll("#gz-schools button"), function (b) { return b.textContent.trim() === text; });
    };
    var setText = function (el, v) {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    };
    // The first row's chevron button sits right after its status select.
    var expandFirst = function () {
      if (document.querySelector("#gz-schools textarea")) return true;
      var sel = document.querySelector("#gz-schools select"); if (!sel || !sel.nextElementSibling) return false;
      sel.nextElementSibling.click(); return !!document.querySelector("#gz-schools textarea");
    };
    var draftBox = function () { var a = document.querySelectorAll("#gz-schools textarea"); return a[2] || null; };
    var chevron = function () { var sel = document.querySelector("#gz-schools select"); return sel && sel.nextElementSibling; };
    // A real tap blurs the box before its click lands; this does both in one go, so the save is still on the way.
    var typeLeaveAndPress = function (pressed) {
      return function () {
        var x = draftBox(), b = pressed(); if (!x || !b) return false;
        x.focus(); setText(x, "Hello Coach Rivera, I would love a trial.");
        if (document.activeElement === x) x.blur(); else x.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        b.click(); return true;
      };
    };
    // Row n's delete button follows its chevron, which follows its status select (found by place, not by
    // its words, so the delete drives work in every &lang=). Armed, its X icon gives way to a word.
    var deleteButton = function (n) {
      var sel = document.querySelectorAll("#gz-schools select")[n];
      return (sel && sel.nextElementSibling && sel.nextElementSibling.nextElementSibling) || null;
    };
    var armed = function (b) { return !!b && !b.querySelector("svg"); };
    var armedAt = 0;
    var steps = [];
    if (cfg.drive === "arm" || cfg.drive === "armplain") {
      steps = [function () { var b = deleteButton(cfg.drive === "arm" ? 0 : 1); if (!b) return false; b.click(); return true; }];
    } else if (cfg.drive === "armother") {
      steps = [
        function () { var b = deleteButton(0); if (!b) return false; b.click(); return true; },
        function () { var b = deleteButton(1); if (!armed(deleteButton(0)) || !b) return false; b.click(); return true; },
      ];
    } else if (cfg.drive === "armwait") {
      steps = [
        function () { var b = deleteButton(0); if (!b) return false; b.click(); armedAt = Date.now(); return true; },
        function () { return Date.now() - armedAt >= 6500; },
      ];
    } else if (cfg.drive === "look") {
      // Presses nothing: waits until the section is open (its rows are drawn with it), so a plain reload is
      // captured with its list on screen rather than the loading skeleton.
      steps = [function () { return !!document.querySelector('#gz-schools button[aria-expanded="true"]'); }];
    } else if (cfg.drive === "delete") {
      steps = [
        function () { var b = deleteButton(0); if (!b) return false; b.click(); armedAt = Date.now(); return true; },
        // A person reads the warning before the second tap: well past the double-tap window.
        function () { var b = deleteButton(0); if (!armed(b) || Date.now() - armedAt < 1000) return false; b.click(); return true; },
      ];
    } else if (cfg.drive === "deletedouble") {
      // A phone stamps a tap when it happens and a busy page handles it later, so the second click is made
      // (stamped) right after the first and handed to the page 150 ms later, once the first has re-rendered it.
      steps = [function () {
        var b = deleteButton(0); if (!b) return false;
        b.click();
        var second = new MouseEvent("click", { bubbles: true, cancelable: true, view: window });
        setTimeout(function () { b.dispatchEvent(second); }, 150);
        return true;
      }];
    } else if (cfg.drive === "expand") {
      steps = [expandFirst];
    } else if (cfg.drive === "draftclose" || cfg.drive === "draftreopen") {
      steps = [expandFirst, typeLeaveAndPress(chevron)];
      if (cfg.drive === "draftreopen") {
        steps.push(
          function () { var a = document.querySelector("#gz-schools [role=alert]"); return !!a && a.textContent.indexOf("Northfield") >= 0; },
          function () { var c = chevron(); if (!c) return false; c.click(); return true; });
      }
    } else if (cfg.drive === "draftsection") {
      steps = [expandFirst, typeLeaveAndPress(function () { return document.querySelector('#gz-schools button[aria-expanded="true"]'); })];
    } else if (cfg.drive === "draft" || cfg.drive === "bigdraft") {
      steps = [
        expandFirst,
        function () { var x = draftBox(); if (!x) return false; setText(x, cfg.drive === "bigdraft" ? new Array(10002).join("a") : "Hello Coach Rivera, I would love a trial."); return true; },
        function () { var b = btnByText("Save draft")[0]; if (!b) return false; if (cfg.drive === "draft") b.click(); return true; },
      ];
    } else if (cfg.drive === "add" || cfg.drive === "adddouble") {
      steps = [
        function () { var b = btnByText("Add")[0]; if (!b) return false; b.click(); return true; },
        function () { var i = document.getElementById("target-add-name"); if (!i) return false; setVal(i, "Montreal Impact Academy"); return true; },
        function () {
          var b = btnByText("Add")[0]; if (!b) return false;
          b.click(); if (cfg.drive === "adddouble") b.click();
          return true;
        },
      ];
    } else {
      steps = [
        function () { var r = document.querySelector("#gz-schools [role=button][title]"); if (!r) return false; r.click(); return true; },
        function () { var i = document.getElementById("target-edit-contact_email"); if (!i) return false; setVal(i, cfg.drive === "editbad" ? "coach@uni" : "coach@uni.edu"); return true; },
        function () { var b = btnByText("Save")[0]; if (!b) return false; b.click(); return true; },
      ];
    }
    // A browser that captures the page after its load event could catch a drive half done (the delete drive
    // waits a second between taps). An image started now delays that event (a fetch would not) and the server
    // answers it only when /__release arrives, or after 20 s. Its URL is new on every page load: Chrome's
    // in-memory image cache answered a repeated "/__hold" without asking the server, and the capture then
    // landed mid-drive. The title says how far the drive got.
    new Image().src = "/__hold?" + Date.now() + Math.random();
    var baseTitle = null;
    var mark = function (text) { if (baseTitle === null) baseTitle = document.title; document.title = baseTitle + " [" + text + "]"; };
    // What the card shows, for the title: each row's name (with its delete button's word while armed), then
    // every alert line, so a recorded run's JSON says what was on screen wherever the capture was scrolled.
    var describe = function () {
      var rows = Array.prototype.map.call(document.querySelectorAll("#gz-schools select"), function (sel, n) {
        var name = sel.parentElement.firstElementChild.firstElementChild.textContent.trim();
        var b = deleteButton(n);
        return armed(b) ? name + " {" + b.textContent.trim() + "}" : name;
      });
      var alerts = Array.prototype.map.call(document.querySelectorAll("#gz-schools [role=alert]"), function (a) { return a.textContent.trim(); });
      return "rows: " + (rows.join(" | ") || "none") + (alerts.length ? "; alerts: " + alerts.join(" | ") : "");
    };
    var stepNo = 0;
    var timer = setInterval(function () {
      if (stepNo >= steps.length) {
        clearInterval(timer); mark("drive done");
        // Time for the last write's answer to reach the screen. Then the card again, just before the capture
        // (the open step's scroll can come before the page has finished growing), and what it shows.
        setTimeout(function () {
          var card = document.getElementById("gz-schools"); if (card) card.scrollIntoView();
          mark("drive done; " + describe());
          fetch("/__release").catch(function () { /* the page was closed */ });
        }, 500);
        return;
      }
      if (steps[stepNo]()) { stepNo++; mark("drive " + stepNo + "/" + steps.length); }
    }, 100);
  }

  if (cfg.open) {
    // The card is a closed row below the fold: open it and scroll to it once, so a screenshot shows it.
    var opened = false;
    new MutationObserver(function () {
      var btn = !opened && document.querySelector('#gz-schools button[aria-expanded="false"]');
      if (btn) { opened = true; btn.click(); setTimeout(function () { document.getElementById("gz-schools").scrollIntoView(); }, 300); }
    }).observe(document, { childList: true, subtree: true });
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
  // Realtime would open a socket to the real project; an inert object keeps the app quiet.
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

const FAIL_OF_METHOD = { GET: "select", POST: "insert", PATCH: "update", DELETE: "delete" };
const LANGS = ["en", "fr", "es", "el"];
const OP_OF_METHOD = { POST: "insert", PATCH: "update", DELETE: "delete" };

// The stand-in database plus the handler for the app's Supabase calls (/__sb/rest/v1/<table>?<filters>).
// `localise` swaps the CDN script tags for local copies; it runs `npm pack` (network) when the vendor cache
// is empty, so tests/test_preview_targets.cjs passes one that leaves the page alone and stays offline.
function createPreview({ localise = localiseLibraries } = {}) {
  const state = { targets: seedTargets() };
  const vendorFiles = {};

  function send(res, status, body) {
    if (body === undefined) { res.writeHead(status).end(); return; }
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  }

  // PostgREST replies with ONE object when the request asks for it (.single()), else with a list.
  function reply(req, res, status, rows) {
    if (!/vnd\.pgrst\.object\+json/.test(req.headers.accept || "")) return send(res, status, rows);
    if (rows.length !== 1) return send(res, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" });
    return send(res, status, rows[0]);
  }

  function filtered(rows, params) {
    return rows.filter((r) => [...params].every(([k, v]) => !v.startsWith("eq.") || String(r[k]) === v.slice(3)));
  }

  function rest(req, res, table, params, body) {
    const failing = req.headers["x-preview-fail"];
    if (table === "outreach_targets" && failing && failing === FAIL_OF_METHOD[req.method]) {
      let fields = "";
      try { fields = body ? Object.keys(JSON.parse(body)).join(",") : ""; } catch (e) { /* not JSON: no field list */ }
      console.log("outreach_targets " + failing + " answered HTTP 500 on purpose" + (fields ? " fields=" + fields : ""));
      return send(res, 500, { message: "preview: " + failing + " failed on purpose" });
    }
    if (table === "outreach_targets") return targets(req, res, params, body);
    if (req.method !== "GET") return send(res, 204);
    const one = { profiles: PROFILE, athletes: ATHLETE }[table];
    return reply(req, res, 200, one ? filtered([one], params) : []);
  }

  function targets(req, res, params, body) {
    const op = OP_OF_METHOD[req.method];
    const wantsRows = /return=representation/.test(req.headers.prefer || "");
    if (req.method === "GET") {
      const rows = filtered(state.targets, params).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return reply(req, res, 200, rows);
    }
    const input = body ? JSON.parse(body) : {};
    if (op === "insert") {
      const made = (Array.isArray(input) ? input : [input]).map((r) => {
        const now = new Date().toISOString();
        const row = { contact_name: null, contact_email: null, status: "researching", notes: null, draft_email: null, fit_reasoning: null, ...r, id: crypto.randomUUID(), created_at: now, updated_at: now };
        state.targets.push(row);
        console.log("outreach_targets insert id=" + row.id + " fields=" + Object.keys(r).join(","));
        return row;
      });
      return wantsRows ? reply(req, res, 201, made) : send(res, 201);
    }
    const hit = filtered(state.targets, params);
    const id = params.get("id") ? params.get("id").replace(/^eq\./, "") : "";
    hit.forEach((r) => { if (op === "update") Object.assign(r, input); });
    if (op === "delete") state.targets = state.targets.filter((r) => !hit.includes(r));
    console.log("outreach_targets " + op + " id=" + id + " fields=" + (op === "update" ? Object.keys(input).join(",") : ""));
    return wantsRows && op === "update" ? reply(req, res, 200, hit) : send(res, 204);
  }

  // A drive's open request (see the stub): answered by /__release, or after 20 s.
  const holds = new Map();
  function hold(res) {
    const done = () => { if (!holds.delete(res)) return; clearTimeout(timer); res.writeHead(204, { "cache-control": "no-store" }).end(); };
    const timer = setTimeout(done, 20000);
    holds.set(res, done);
    res.on("close", () => { holds.delete(res); clearTimeout(timer); });
  }

  function handler(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/__store") return send(res, 200, state.targets);
    if (u.pathname === "/__hold") return hold(res);
    if (u.pathname === "/__release") { [...holds.values()].forEach((done) => done()); return send(res, 204); }
    if (u.pathname.startsWith("/__sb/")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const sub = u.pathname.slice("/__sb".length);
        if (sub === "/auth/v1/user") return send(res, 200, { id: USER_ID, aud: "authenticated", role: "authenticated", email: "marco@example.com", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" });
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
      const reset = u.searchParams.get("reset");
      if (reset === "1") state.targets = [];
      if (reset === "seed") state.targets = seedTargets();
      const failParam = u.searchParams.get("fail");
      const cfg = { ...constantsFrom(local.html), userId: USER_ID, theme: u.searchParams.get("theme") || "", lang: LANGS.includes(u.searchParams.get("lang")) ? u.searchParams.get("lang") : "", open: u.searchParams.get("open") === "schools" || !!u.searchParams.get("drive"), drive: ["add", "adddouble", "editbad", "editgood", "expand", "draft", "bigdraft", "draftclose", "draftreopen", "draftsection", "look", "arm", "armplain", "armother", "armwait", "delete", "deletedouble"].includes(u.searchParams.get("drive")) ? u.searchParams.get("drive") : "", fail: Object.values(FAIL_OF_METHOD).includes(failParam) ? failParam : "" };
      res.writeHead(200, { "content-type": type });
      res.end(pageWithStub(local.html, cfg));
    });
  }

  return { handler, state };
}

if (require.main === module) {
  const server = http.createServer(createPreview().handler);
  server.listen(Number(process.argv[2]) || 0, "127.0.0.1", () => console.log("Targets preview on http://127.0.0.1:" + server.address().port + "/golsz-app.html?page=plan"));
}

module.exports = { createPreview, pageWithStub, stub, seedTargets, USER_ID };
