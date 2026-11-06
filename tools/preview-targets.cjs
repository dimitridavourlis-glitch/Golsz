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
//   &theme=light|dark  sets localStorage["golsz-theme"] before the page's own theme script runs
//   The server prints each write as   outreach_targets <insert|update|delete> id=<id> fields=<names>
//   and GET /__store returns the current rows as JSON.
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
    var steps = [];
    if (cfg.drive === "add" || cfg.drive === "adddouble") {
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
    var stepNo = 0;
    var timer = setInterval(function () {
      if (stepNo >= steps.length) { clearInterval(timer); return; }
      if (steps[stepNo]()) stepNo++;
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

  function handler(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/__store") return send(res, 200, state.targets);
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
      const reset = u.searchParams.get("reset");
      if (reset === "1") state.targets = [];
      if (reset === "seed") state.targets = seedTargets();
      const failParam = u.searchParams.get("fail");
      const cfg = { ...constantsFrom(local.html), userId: USER_ID, theme: u.searchParams.get("theme") || "", open: u.searchParams.get("open") === "schools" || !!u.searchParams.get("drive"), drive: ["add", "adddouble", "editbad", "editgood"].includes(u.searchParams.get("drive")) ? u.searchParams.get("drive") : "", fail: Object.values(FAIL_OF_METHOD).includes(failParam) ? failParam : "" };
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
