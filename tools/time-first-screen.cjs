#!/usr/bin/env node
// Serves the repo over a SIMULATED NORMAL MOBILE CONNECTION and prints how long the first screen of the
// home page (index.html) and of the app (golsz-app.html, signed out = the Auth screen) takes to show.
// Not a test (it needs a real browser), so it lives outside tests/; tests/test_time_first_screen.cjs
// pins the parts that keep it harmless. `npm run unpublish` removes tools/ from the served tree.
//
// Usage:  node tools/time-first-screen.cjs [port] [--rtt=<ms>] [--mbps=<megabits>] [--fail-app] [--theme=light] [--lang=fr|es|el] [--late-font=<ms>]
//   defaults: a free port (printed), 150 ms extra round trip, 1.6 Mbps down. Env: TIMING_RTT_MS, TIMING_MBPS.
//   --fail-app makes /js/app.js answer 404 (the failure path: the page must show a Reload screen, not an endless loader).
//   With AVA's browser tool (one page load per width, cold: nothing is cached, "cache-control: no-store"):
//   "$AVA_BROWSER" --serve "node tools/time-first-screen.cjs 8765" --port 8765 /index.html /golsz-app.html --widths 390,1280
//   The server prints one line per page load:
//   timing page=/golsz-app.html width=390 fcp=<ms> lcp=<ms> boot=<ms> mounted=<ms> cls=<score>
//     fcp      first-contentful-paint        lcp   largest-contentful-paint (last candidate before the report)
//     boot     the #boot loading screen is in the DOM and a frame has been drawn after it
//     mounted  #boot left the DOM = the app's first screen (Auth for a new visitor) replaced it
//     cls      layout shift: how far things moved after they were first drawn (the browser's own score, shifts
//              that follow a tap or key left out). shifted=[...] names the first elements that moved.
//   The app line also says what the boot screen showed once painted, and whether it left with #boot:
//     bootText="Loading…" bootColor=rgb(...) bootOverflow=0|1 (page wider than the window) bootGone=1|0
//   --lang=<code> saves golsz-lang first, as for a visitor who chose that language (fr reads "Chargement…").
//   "-" means the page has no such moment (index.html has no #boot) or it never happened before the report.
//   --late-font=<ms> is the POSITIVE CONTROL for cls. A web font that arrives after the first screen is drawn
//   redraws its text, and that is what moves a layout. A browser with no internet never gets the web font, so
//   cls would read 0 whatever the layout does. With this flag the Google Fonts address (in the page and in
//   js/app.js) is answered here, <ms> after it is asked for, with a stand-in: the name Archivo given to this
//   machine's Arial Narrow, narrower than the fallback font as Archivo is. Pick <ms> past "mounted" (6000 is
//   enough). The stand-in is not Archivo, so the score is not production's: it shows whether the screen holds
//   still. Recorded 2026-11-10, 375 px, Chromium 141, 4x slower CPU, --late-font=6000: the sign-up screen 0.052;
//   with its plan row put back to flexWrap (the defect AVA measured at 0.23 with the real fonts) 0.164.
//
// BUDGETS (a normal mobile connection, cold load; the numbers the speed work is held to):
//   home page (index.html)       LCP     <= 3000 ms
//   app boot screen visible      boot    <= 2500 ms
//   app first screen mounted     mounted <= 5000 ms
//   layout shift, either page    cls     <= 0.10
//
// WHAT IS SIMULATED: every response waits the extra round trip, then streams at the given rate. Text
// (html/js/css/json/svg) is gzipped first, as the host does (it would use brotli, a little smaller, so
// these numbers are slightly pessimistic). Each response is throttled on its own, they do not share the
// rate, as on a connection that is not the bottleneck. No CPU throttling: the browser runs at full speed.
//
// HOW IT STAYS OUT OF THE PRODUCT: the timing script is added to copies of the HTML held in memory; the
// files on disk are never written. React, ReactDOM and supabase-js come from the npm-pack cache in
// $PREVIEW_VENDOR_DIR (default ~/.cache/golsz-preview-vendor, shared with preview-public-passport.cjs) at
// the same throttle, by rewriting their CDN URLs in the in-memory copy only. A tag KEEPS its integrity
// attribute when the local file's SHA-384 matches it (React and ReactDOM do: same bytes as the CDN). The
// supabase-js tag does not match (jsdelivr minifies on request, the npm file is a different build of
// about the same size), so only that tag loses integrity in the copy. Supabase calls are answered
// locally and never forwarded (getSession finds no session), and the server binds to 127.0.0.1.
//
// BASELINE, BEFORE any speed work (2026-11-04, today's code, 150 ms / 1.6 Mbps, cold, two runs agreed to
// within ~100 ms; ms):
//   page             width   fcp    lcp    boot   mounted
//   /index.html       390    648-760  =fcp   -       -       (budget LCP <= 3000: inside)
//   /index.html      1280    552-648  =fcp   -       -
//   /golsz-app.html   390    756    3840-3888  753-755  3717-3749   (budgets boot <= 2500, mounted <= 5000: inside)
//   /golsz-app.html  1280    708-752  3836-3840  707-748  3697-3727
// AFTER t2 (libraries deferred, js/app.js preloaded, loader gated on DOMContentLoaded; same settings, one run):
//   /golsz-app.html   390 dark   fcp 904   lcp 3028   boot 827   mounted 2916
//   /golsz-app.html   390 light  fcp 500   lcp 2668   boot 477   mounted 2548   (--theme=light)
// What the numbers leave out: Google Fonts and the Supabase host are not reachable from the test browser (fonts
// are non-blocking on the home page), and the browser runs at full CPU speed, so a real mid-range phone is
// slower than this. The app's weight at the baseline: golsz-app.html 1.44 MB (423 KB gzipped), js/app.js
// 811 KB (217 KB gzipped), plus React, ReactDOM and supabase-js; app.js is requested only after the HTML
// has downloaded and parsed, which is why "mounted" is about 3.7 s.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { LIBS, MIME, vendorFile } = require("./preview-public-passport.cjs");

const ROOT = path.resolve(__dirname, "..");
const DEFAULTS = { rttMs: 150, mbps: 1.6 };
const BUDGETS = { homeLcpMs: 3000, appBootMs: 2500, appMountedMs: 5000, cls: 0.1 };
// --late-font: every Google Fonts stylesheet address, and what is served in its place.
const FONT_SHEET_URL = /https:\/\/fonts\.googleapis\.com\/css2\?[^"')\s]+/g;
const LATE_FONT_PATH = "/__late-font.css";
const LATE_FONT_CSS = '@font-face{font-family:"Archivo";font-weight:100 900;font-stretch:62% 125%;src:local("Arial Narrow"),local("Courier New");}';
const PAGES = new Set(["/index.html", "/golsz-app.html"]);
const HOLD_MAX_MS = 40000;
const GZIP_TYPES = /^(text\/|application\/json|image\/svg)/;

// Runs first in <head>. Kept as a function so it is syntax-checked with this file, then serialised.
function timingScript() {
  // Nothing reaches production: Supabase calls get an empty answer (a signed-out visitor has no session).
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input.url;
    if (/^https:\/\/[a-z0-9]+\.supabase\.co\//.test(url)) return Promise.resolve(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    return realFetch(input, init);
  };
  var t = { fcp: null, lcp: null, boot: null, mounted: null };
  var seen = null; // what the painted boot screen showed: its loading line, colour, sideways overflow
  var sent = false, sawBoot = false;
  function observe(type, onEntry) {
    try { new PerformanceObserver(function (list) { list.getEntries().forEach(onEntry); }).observe({ type: type, buffered: true }); } catch (e) { /* type unsupported */ }
  }
  observe("paint", function (e) { if (e.name === "first-contentful-paint") t.fcp = e.startTime; });
  observe("largest-contentful-paint", function (e) { t.lcp = e.startTime; });
  var cls = 0, shifted = [];
  observe("layout-shift", function (e) {
    if (e.hadRecentInput) return;
    cls += e.value;
    (e.sources || []).forEach(function (s) {
      var el = s.node && (s.node.nodeType === 1 ? s.node : s.node.parentElement);
      if (el && shifted.length < 4) shifted.push(el.tagName.toLowerCase() + " " + (el.textContent || "").trim().slice(0, 24));
    });
  });
  // The <head> font stylesheet (media=print, switched on by onload). The report waits until it has loaded
  // or failed and the fonts it asked for are in, so a late font's redraw is inside cls. Listening from
  // the first line of <head>: a load that fails at once (no internet) would otherwise be missed.
  var fontSheetSettled = false, onFontSheet = null;
  function sheetEvent(e) {
    var el = e.target;
    if (!el || el.tagName !== "LINK" || el.rel !== "stylesheet" || !el.getAttribute("onload")) return;
    fontSheetSettled = true;
    if (onFontSheet) onFontSheet();
  }
  document.addEventListener("load", sheetEvent, true);
  document.addEventListener("error", sheetEvent, true);
  function afterFonts(fn) {
    // Not document.fonts.ready: it stays pending until the load event, which /__hold keeps back.
    // 500 ms lets the switched-on stylesheet ask for its fonts (and the last LCP candidate arrive), then
    // the poll waits for them, and 300 ms more lets the redraw be counted.
    var go = function () {
      onFontSheet = null;
      setTimeout(function wait() {
        if (document.fonts && document.fonts.status === "loading") { setTimeout(wait, 100); return; }
        setTimeout(fn, 300);
      }, 500);
    };
    if (fontSheetSettled || !document.querySelector('link[rel="stylesheet"][onload]')) go(); else onFontSheet = go;
  }
  function send() {
    if (sent) return;
    sent = true;
    var out = { page: location.pathname, width: window.innerWidth, cls: Math.round(cls * 1000) / 1000, shifted: shifted };
    Object.keys(t).forEach(function (k) { out[k] = t[k] === null ? null : Math.round(t[k]); });
    if (seen) { out.seen = seen; seen.gone = t.mounted !== null && !document.querySelector("#boot .m"); }
    try { navigator.sendBeacon("/__timing", JSON.stringify(out)); } catch (e) { /* ignore */ }
  }
  function check() {
    var boot = document.getElementById("boot");
    if (boot && !sawBoot) {
      sawBoot = true;
      // Two frames: the first callback runs before the paint that shows #boot, the second after it.
      requestAnimationFrame(function () { requestAnimationFrame(function () {
        t.boot = performance.now();
        var line = document.querySelector("#boot .m"), de = document.documentElement;
        if (line) seen = { text: line.textContent, color: getComputedStyle(line).color, overflow: de.scrollWidth > de.clientWidth };
      }); });
    } else if (!boot && sawBoot && t.mounted === null) {
      t.mounted = performance.now();
      afterFonts(send);
    }
  }
  new MutationObserver(check).observe(document, { childList: true, subtree: true });
  // A page without #boot is done once nothing new (resource, LCP candidate) has arrived for 1.5 s.
  var dcl = false, settle;
  function bump() { if (sawBoot || sent || !dcl) return; clearTimeout(settle); settle = setTimeout(function () { afterFonts(send); }, 1500); }
  observe("resource", bump);
  observe("largest-contentful-paint", bump);
  document.addEventListener("DOMContentLoaded", function () { dcl = true; bump(); });
  setTimeout(send, 30000); // never mounted: report what there is
}

// Adds the timing script to the copy and points the CDN libraries at /__vendor/<n>.js. `resolve(i, version)`
// returns { sha384 } of the local copy so integrity is kept exactly when it still holds. Pure: no I/O.
function buildPage(html, resolve) {
  const files = {};
  LIBS.forEach((lib, i) => {
    html = html.replace(new RegExp('<script src="https://[^"]*' + lib.cdn.source + '"([^>]*)></script>'), (tag, version, rest) => {
      const local = resolve(i, version);
      files["/__vendor/" + i + ".js"] = { version };
      const integrity = /\sintegrity="([^"]+)"/.exec(rest);
      const kept = integrity && integrity[1] === "sha384-" + local.sha384 ? rest : rest.replace(/\sintegrity="[^"]*"/, "");
      return '<script src="/__vendor/' + i + '.js"' + kept + "></script>";
    });
  });
  // The async /__hold script keeps the load event pending until the report is sent: a browser tool that
  // closes the page at "load" would otherwise leave before the app has mounted.
  const tag = '<script async src="/__hold"></script><script>(' + timingScript.toString() + ")();</script>";
  return { html: html.replace(/<head[^>]*>/i, (m) => m + tag), files };
}

// --late-font: points every Google Fonts stylesheet address in `text` at the stand-in, one address per `n`. Pure: no I/O.
function lateFont(text, n) { return text.replace(FONT_SHEET_URL, LATE_FONT_PATH + "?n=" + n); }

function resolveFromCache(i, version) {
  const file = vendorFile(i, version);
  return { file, sha384: crypto.createHash("sha384").update(fs.readFileSync(file)).digest("base64") };
}

// Sends `body` after the round trip, at `mbps`. Chunks are paced against the clock, so a slow event loop
// does not make the response faster than the rate.
function sendThrottled(res, status, headers, body, opts) {
  const bytesPerMs = (opts.mbps * 1e6) / 8 / 1000;
  const chunk = Math.max(1024, Math.round(bytesPerMs * 20));
  setTimeout(() => {
    res.writeHead(status, { ...headers, "content-length": body.length });
    const start = Date.now();
    let sent = 0;
    (function next() {
      if (sent >= body.length) return res.end();
      const end = Math.min(body.length, sent + chunk);
      res.write(body.subarray(sent, end));
      sent = end;
      setTimeout(next, Math.max(0, start + sent / bytesPerMs - Date.now()));
    })();
  }, opts.rttMs);
}

function makeHandler(opts) {
  const vendorFiles = {};
  const holds = new Set();
  let lateFontCount = 0;
  const release = () => { holds.forEach((res) => res.end()); holds.clear(); };
  const respond = (req, res, status, type, buf) => {
    const headers = { "content-type": type, "cache-control": "no-store" };
    if (GZIP_TYPES.test(type) && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) { buf = zlib.gzipSync(buf, { level: 6 }); headers["content-encoding"] = "gzip"; }
    sendThrottled(res, status, headers, buf, opts);
  };
  return function handler(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname === "/__hold") {
      res.writeHead(200, { "content-type": MIME[".js"], "cache-control": "no-store" });
      holds.add(res);
      setTimeout(() => { if (holds.delete(res)) res.end(); }, HOLD_MAX_MS);
      return;
    }
    if (u.pathname === "/__timing" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        try {
          const m = JSON.parse(body), v = (x) => (typeof x === "number" ? x : "-");
          const b = m.seen ? ` bootText=${JSON.stringify(m.seen.text)} bootColor=${String(m.seen.color).replace(/\s/g, "")} bootOverflow=${m.seen.overflow ? 1 : 0} bootGone=${m.seen.gone ? 1 : 0}` : "";
          const moved = Array.isArray(m.shifted) && m.shifted.length ? ` shifted=${JSON.stringify(m.shifted)}` : "";
          console.log(`timing page=${m.page} width=${m.width} fcp=${v(m.fcp)} lcp=${v(m.lcp)} boot=${v(m.boot)} mounted=${v(m.mounted)} cls=${v(m.cls)}${moved}${b}`);
        } catch (e) { /* malformed beacon */ }
        res.writeHead(204).end();
        release();
      });
      return;
    }
    // --fail-app: js/app.js answers 404, to see the "Something stopped GOLSZ loading." screen.
    if (opts.failApp && u.pathname === "/js/app.js") return respond(req, res, 404, "text/plain", Buffer.from("not found"));
    if (vendorFiles[u.pathname]) return respond(req, res, 200, MIME[".js"], fs.readFileSync(vendorFiles[u.pathname]));
    // --late-font: the stand-in font stylesheet, answered late (see the header). It may be cached, as
    // Google's is: switching the <link> from media=print to all asks for it again, and a second wait
    // would put the redraw after the report. Each served page and bundle gets its own address (?n=),
    // so the next page load waits again.
    if (opts.lateFontMs !== undefined && u.pathname === LATE_FONT_PATH) {
      setTimeout(() => sendThrottled(res, 200, { "content-type": MIME[".css"], "cache-control": "max-age=3600" }, Buffer.from(LATE_FONT_CSS), opts), opts.lateFontMs);
      return;
    }
    if (u.pathname.startsWith("/api/")) return respond(req, res, 404, "application/json", Buffer.from("{}"));

    let rel = decodeURIComponent(u.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.resolve(ROOT, "." + rel);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end("not found"); return; }
      const type = MIME[path.extname(file)] || "application/octet-stream";
      if (opts.lateFontMs !== undefined && (PAGES.has(rel) || rel === "/js/app.js")) buf = Buffer.from(lateFont(buf.toString("utf8"), ++lateFontCount));
      if (!PAGES.has(rel)) return respond(req, res, 200, type, buf);
      const built = buildPage(buf.toString("utf8"), (i, version) => { const r = resolveFromCache(i, version); vendorFiles["/__vendor/" + i + ".js"] = r.file; return r; });
      // --theme=light: the page's own head script reads this key, as for a visitor who chose light.
      // --lang=<code>: likewise for golsz-lang, which the boot line and the app read.
      const saves = (opts.light ? 'localStorage.setItem("golsz-theme","light");' : "") + (opts.lang ? 'localStorage.setItem("golsz-lang","' + opts.lang + '");' : "");
      const page = saves ? built.html.replace(/<head[^>]*>/i, (m) => m + "<script>try{" + saves + "}catch(e){}</script>") : built.html;
      respond(req, res, 200, type, Buffer.from(page));
    });
  };
}

function parseArgs(argv, env) {
  const opts = { port: 0, rttMs: Number(env.TIMING_RTT_MS) || DEFAULTS.rttMs, mbps: Number(env.TIMING_MBPS) || DEFAULTS.mbps };
  argv.forEach((a) => {
    if (a === "--theme=light") { opts.light = true; return; }
    if (a === "--fail-app") { opts.failApp = true; return; }
    const lang = /^--lang=(en|fr|es|el)$/.exec(a);
    if (lang) { opts.lang = lang[1]; return; }
    const late = /^--late-font=(\d+)$/.exec(a);
    if (late) { opts.lateFontMs = Number(late[1]); return; }
    const flag = /^--(rtt|mbps)=(\d+(?:\.\d+)?)$/.exec(a);
    if (flag) opts[flag[1] === "rtt" ? "rttMs" : "mbps"] = Number(flag[2]);
    else if (/^\d+$/.test(a)) opts.port = Number(a);
  });
  return opts;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2), process.env);
  const server = http.createServer(makeHandler(opts));
  server.listen(opts.port, "127.0.0.1", () => console.log(`First-screen timing on http://127.0.0.1:${server.address().port} (rtt ${opts.rttMs} ms, ${opts.mbps} Mbps)`));
}

module.exports = { buildPage, parseArgs, lateFont, DEFAULTS, BUDGETS, LATE_FONT_PATH };
