#!/usr/bin/env node
// Serves the repo for a browser run of the SHARED PASSPORT (golsz-app.html?share=<token>) with the
// lookup answered by fixtures, so a signed-out page can be checked in both themes with no Supabase
// session and no production data. Not a test (it needs a browser), so it lives outside tests/.
//
// Usage:  node tools/preview-public-passport.cjs [port]        (default: a free port, printed)
//   then open  http://127.0.0.1:<port>/golsz-app.html?share=fake-token&fixture=a&theme=light
//   fixture=a  full athlete: name, sport, position, club, country, 3 benchmarks with method + date
//   fixture=b  the same athlete with club_name and country null (the athlete hid them)
//   fixture=c  null, the banned / removed / revoked case  -> "This Passport isn't available..."
//   fixture=d  first lookup is an HTTP 500 (error state + Try again), every later lookup succeeds
//   fixture=crash  the lookup succeeds (fixture a data) but rendering the component named PublicPassport
//              throws, so the root ErrorBoundary's "Something went wrong / Reload" screen shows. The
//              server answers POST /rest/v1/rpc/log_client_error with 204 and prints
//              "log_client_error auth=<kind> message=<text>" (anon-key expected: the visitor is signed out)
//   &reload=1  with fixture=crash: the page presses "Reload" once (a sessionStorage flag stops a loop), so
//              the server then prints a SECOND log_client_error line: the reload ran and crashed again
//   &retry=1   with fixture=d: the page taps "Try again" itself once the error shows, so a screenshot
//              taken afterwards shows the card the successful retry rendered
//   theme=light|dark  sets localStorage["golsz-theme"] before the page's own theme script runs
//   The server prints one "supabase request auth=<kind> <url>" line per request, and
//   GET /__requests   JSON of every request the page made to the Supabase project, with the
//                     Authorization value kind: "anon-key" (signed out) or "other" (a user token)
//
// With AVA's browser tool: "$AVA_BROWSER" --serve "node tools/preview-public-passport.cjs 8765"
//   --port 8765 "/golsz-app.html?share=t&fixture=a&theme=light" --widths 390,1280
//
// THE THREE CDN LIBRARIES: a browser with no internet cannot load them, so the served copy points them
// at local copies of the same versions, fetched once with `npm pack` (the npm registry is the only network
// this needs) into $PREVIEW_VENDOR_DIR, default ~/.cache/golsz-preview-vendor. Nothing is added to the repo.
//
// HOW IT STAYS OUT OF THE PRODUCT: the stub is added to the response for /golsz-app.html in memory
// only. The file on disk is never written, so nothing here can reach git or the deployed build.
// Every request to the Supabase host is answered locally and never forwarded; the server binds to
// 127.0.0.1 and serves only files under the repo root.
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" };

// CDN url fragment -> [npm package, file inside the tarball]. Versions are read from the page's own tags.
const LIBS = [
  { cdn: /cdnjs\.cloudflare\.com\/ajax\/libs\/react\/([\d.]+)\/umd\/react\.production\.min\.js/, pkg: (v) => "react@" + v, file: "umd/react.production.min.js" },
  { cdn: /cdnjs\.cloudflare\.com\/ajax\/libs\/react-dom\/([\d.]+)\/umd\/react-dom\.production\.min\.js/, pkg: (v) => "react-dom@" + v, file: "umd/react-dom.production.min.js" },
  { cdn: /cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@([\d.]+)\/dist\/umd\/supabase\.min\.js/, pkg: (v) => "@supabase/supabase-js@" + v, file: "dist/umd/supabase.js" },
];
const VENDOR = process.env.PREVIEW_VENDOR_DIR || path.join(os.homedir(), ".cache", "golsz-preview-vendor");

// The local copy of one library (npm pack, fetched on first use into VENDOR).
function vendorFile(i, version) {
  const lib = LIBS[i];
  const dest = path.join(VENDOR, i + "-" + version + ".js");
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(VENDOR, { recursive: true });
    const work = fs.mkdtempSync(path.join(VENDOR, "pack-"));
    const tgz = execFileSync("npm", ["pack", lib.pkg(version), "--silent"], { cwd: work }).toString().trim().split("\n").pop();
    execFileSync("tar", ["xzf", tgz, "package/" + lib.file], { cwd: work });
    fs.copyFileSync(path.join(work, "package", lib.file), dest);
    fs.rmSync(work, { recursive: true, force: true });
  }
  return dest;
}

// Rewrites each CDN <script> to /__vendor/<n>.js (dropping integrity, which is for the CDN's bytes) and
// returns the files to serve, downloading them on first use.
function localiseLibraries(html) {
  const files = {};
  LIBS.forEach((lib, i) => {
    html = html.replace(new RegExp('<script src="https://[^"]*' + lib.cdn.source + '"[^>]*></script>'), (tag, version) => {
      files["/__vendor/" + i + ".js"] = vendorFile(i, version);
      return '<script src="/__vendor/' + i + '.js"></script>';
    });
  });
  return { html, files };
}

const BENCHMARKS = [
  { metric: "40 m sprint", value: 5.21, unit: "s", recorded_date: "2026-09-14", measured_by: "coach", protocol: { timing_method: "electronic", start_type: "standing" } },
  { metric: "Vertical jump", value: 58, unit: "cm", recorded_date: "2026-08-30", measured_by: "official", protocol: { jump_protocol: "standing_vertical" } },
  { metric: "Yo-Yo IR1", value: 2240, unit: "m", recorded_date: "2026-10-05", measured_by: "self", protocol: {} },
];
const FULL = {
  full_name: "Marco Tester", occupation: "Player", sport: "Soccer", position: "Midfielder", grad_year: 2027,
  recruiting_status: "Open", foot: "Right", club_name: "Test FC", country: "Canada", bio: "Box-to-box midfielder looking for a college pathway.",
  avatar_url: null, identity_verified: false, verified_tier: "none", highlights: [], shows_benchmarks: true, benchmarks: BENCHMARKS,
  shows_timeline: false, timeline: [],
};
const FIXTURES = { a: FULL, b: { ...FULL, club_name: null, country: null }, c: null, d: FULL, crash: FULL };

// Runs first in <head>, before the theme script, the CDN libraries and the app.
// Kept as a function so it is syntax-checked with this file, then serialised into the page.
function stub(cfg) {
  try { if (cfg.theme === "light" || cfg.theme === "dark") localStorage.setItem("golsz-theme", cfg.theme); } catch (e) { /* storage blocked */ }
  var realFetch = window.fetch.bind(window);
  var rpcCalls = 0;
  function note(url, headers, extra) {
    var auth = headers.get("authorization") || "";
    var kind = !auth ? "none" : auth === "Bearer " + cfg.anonKey ? "anon-key" : "other";
    var entry = { url: url, auth: kind };
    if (extra) entry.message = extra;
    try { navigator.sendBeacon("/__log", JSON.stringify(entry)); } catch (e) { /* ignore */ }
  }
  if (cfg.fixture === "crash") {
    // React arrives later as a UMD global: wrap createElement the moment it is assigned. terser keeps
    // function names (keep_fnames), so the compiled PublicPassport still reports its name.
    var realReact;
    Object.defineProperty(window, "React", {
      configurable: true,
      get: function () { return realReact; },
      set: function (r) {
        realReact = r;
        // The UMD wrapper assigns window.React to an EMPTY exports object and fills it afterwards, so
        // intercept the later assignment of createElement instead of reading it now.
        var create = r.createElement;
        var wrapped = function (type) {
          if (typeof type === "function" && type.name === "PublicPassport") throw new Error("fixture crash: PublicPassport render failed");
          return create.apply(this, arguments);
        };
        Object.defineProperty(r, "createElement", {
          configurable: true, enumerable: true,
          get: function () { return create ? wrapped : undefined; },
          set: function (fn) { create = fn; },
        });
      },
    });
  }
  function json(status, body) {
    return new Response(body === undefined ? "" : JSON.stringify(body), { status: status, headers: { "content-type": "application/json" } });
  }
  if (cfg.retry) {
    var tapped = false;
    new MutationObserver(function () {
      var btn = !tapped && document.querySelector('[role="alert"] button');
      if (btn) { tapped = true; setTimeout(function () { btn.click(); }, 300); }
    }).observe(document, { childList: true, subtree: true });
  }
  if (cfg.reload) {
    var pressed = false;
    try { pressed = sessionStorage.getItem("preview-reload") === "1"; } catch (e) { /* storage blocked */ }
    new MutationObserver(function () {
      var btn = !pressed && Array.prototype.filter.call(document.querySelectorAll("button"), function (b) { return b.textContent === "Reload"; })[0];
      if (btn) {
        pressed = true;
        try { sessionStorage.setItem("preview-reload", "1"); } catch (e) { /* storage blocked */ }
        setTimeout(function () { btn.click(); }, 500);
      }
    }).observe(document, { childList: true, subtree: true });
  }
  window.fetch = function (input, init) {
    var req = new Request(input, init);
    var url = req.url;
    if (url.indexOf(cfg.supabaseUrl) !== 0) return realFetch(input, init);
    if (url.indexOf("/rest/v1/rpc/log_client_error") !== -1) {
      return req.clone().text().then(function (text) {
        var message = "";
        try { message = JSON.parse(text).p_message; } catch (e) { /* not JSON */ }
        note(url, req.headers, message);
        return new Response(null, { status: 204 });
      });
    }
    note(url, req.headers);
    if (url.indexOf("/rest/v1/rpc/get_public_passport_by_token") !== -1) {
      rpcCalls += 1;
      if (cfg.fixture === "d" && rpcCalls === 1) return Promise.resolve(json(500, { message: "fixture: server error" }));
      return Promise.resolve(json(200, cfg.data));
    }
    // Anything else (auth, other tables) is answered locally: there is no session to restore.
    return Promise.resolve(json(200, []));
  };
}

function pageWithStub(html, cfg) {
  const tag = "<script>(" + stub.toString() + ")(" + JSON.stringify(cfg).replace(/</g, "\\u003c") + ");</script>";
  return html.replace(/<head[^>]*>/i, (m) => m + tag);
}

function constantsFrom(html) {
  const grab = (name) => { const m = new RegExp(name + '\\s*=\\s*"([^"]+)"').exec(html); if (!m) throw new Error(name + " not found in golsz-app.html"); return m[1]; };
  return { supabaseUrl: grab("SUPABASE_URL"), anonKey: grab("SUPABASE_ANON_KEY") };
}

const log = [];
const vendorFiles = {};

function handler(req, res) {
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname === "/__log" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { try { const entry = JSON.parse(body); log.push(entry); console.log(entry.message !== undefined ? "log_client_error auth=" + entry.auth + " message=" + entry.message : "supabase request auth=" + entry.auth + " " + entry.url); } catch (e) { /* ignore */ } res.writeHead(204).end(); });
    return;
  }
  if (u.pathname === "/__requests") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(log)); }

  if (vendorFiles[u.pathname]) { res.writeHead(200, { "content-type": MIME[".js"] }); return fs.createReadStream(vendorFiles[u.pathname]).pipe(res); }

  let rel = decodeURIComponent(u.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(ROOT, "." + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    const type = MIME[path.extname(file)] || "application/octet-stream";
    if (rel === "/golsz-app.html") {
      const local = localiseLibraries(buf.toString("utf8"));
      Object.assign(vendorFiles, local.files);
      const html = local.html;
      const fixture = FIXTURES.hasOwnProperty(u.searchParams.get("fixture")) ? u.searchParams.get("fixture") : "a";
      const cfg = { ...constantsFrom(html), fixture, data: FIXTURES[fixture], theme: u.searchParams.get("theme") || "", retry: u.searchParams.get("retry") === "1", reload: u.searchParams.get("reload") === "1" };
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      return res.end(pageWithStub(html, cfg));
    }
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(buf);
  });
}

if (require.main === module) {
  const want = Number(process.argv[2]) || 0;
  const server = http.createServer(handler);
  server.listen(want, "127.0.0.1", () => console.log("Shared Passport preview on http://127.0.0.1:" + server.address().port));
}

module.exports = { pageWithStub, FIXTURES, LIBS, MIME, vendorFile, localiseLibraries };
