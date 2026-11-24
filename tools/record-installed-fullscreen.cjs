#!/usr/bin/env node
// RECORDED RUN: THE INSTALLED APP FILLS AN iPHONE SCREEN (AVA job 235, t4-r3-2).
//
// One tools/preview-onboarding.cjs server (stand-in auth and store, nothing
// reaches live Supabase), one headless Chrome at 390x844 with an iPhone user
// agent. A seed page (drive=goal) builds the athlete's plan; then the signed-in
// Home (drive=home) is opened twice:
//   standalone  as if launched from the Home Screen: display-mode standalone
//               (Emulation.setEmulatedMedia, or navigator.standalone=true when
//               Chrome ignores that feature) and safe-area insets top 47 /
//               bottom 34 (Emulation.setSafeAreaInsetsOverride);
//   tab         the same page in a browser tab, none of that.
// Each mode prints one JSON line: the REAL window.isStandaloneDisplay() from
// js/app.js (top-level names are not mangled), #root and .app-shell height
// against innerHeight, scrollWidth against innerWidth, the header's top and the
// nav's bottom padding against the insets CSS actually resolved, and any text or
// control starting under the top inset. The verdict is installedVerdict() in
// tools/_installed-fullscreen.cjs (suite: tests/test_installed_fullscreen_verdict.cjs).
// An emulation Chrome lacks is printed as "unsupported", never counted as a pass.
// After the standalone line, a positive control puts a label under the status
// bar and takes the header's inset padding away on the live page: the verdict
// must fail on both, then pass again once they are undone.
// Then, in each mode, the header's notification bell is tapped (notifyVerdict):
// installed, it asks permission, registers /sw.js and subscribes; in a tab, the
// same iPhone shows the install-first message and makes none of those calls. The
// browser's push calls are recording stand-ins (no push service is reachable).
// Its positive control taps the tab's bell again with isIOSDevice() forced false
// (the guard lost): the tab verdict must fail.
//
// Usage: node tools/record-installed-fullscreen.cjs [--no-sandbox] [--theme dark]
//            [--out DIR] [--chrome PATH]
// Exit code 1 when a mode or its bell tap fails, a page never finishes, the
// control does not fail, or the run passes 110 s.
// The Chrome launcher and page session are copied from
// tools/check-phone-main-path.cjs (that tool is the 7-step walk; this one is a
// single page, so it stays separate and small).
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const V = require("./_installed-fullscreen.cjs");

function option(name, fallback) { const i = process.argv.indexOf("--" + name); return i === -1 ? fallback : process.argv[i + 1]; }
const WIDTH = 390, HEIGHT = 844;
const INSETS = { top: 47, bottom: 34 }; // an iPhone 14's status bar and home indicator, css px
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const PAGE_MS = 40000, RUN_MS = 110000;
const theme = option("theme", "dark");
const outDir = path.resolve(option("out", path.join(__dirname, "..", "node_modules", ".cache", "installed-fullscreen")));
const shell = path.join(os.homedir(), "Library", "Caches", "ms-playwright", "chromium_headless_shell-1194", "chrome-mac", "headless_shell");
const chromePath = option("chrome", process.env.CHROME_PATH || (fs.existsSync(shell) ? shell : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const appSource = fs.readFileSync(path.join(__dirname, "..", "golsz-app.jsx"), "utf8");
const BELL = { off: V.enString(appSource, "notif_title_off"), on: V.enString(appSource, "notif_title_on"),
  install: V.enString(appSource, "notif_ios_homescreen") };

function startServer(logFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "preview-onboarding.cjs"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
    const log = fs.createWriteStream(logFile);
    let head = "";
    child.stdout.on("data", (chunk) => {
      log.write(chunk);
      if (head === null) return;
      head += chunk;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(head);
      if (m) { head = null; resolve({ port: Number(m[1]), stop: () => child.kill() }); }
    });
    child.on("exit", () => reject(new Error("preview-onboarding.cjs stopped before it printed its port")));
  });
}

function startChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "golsz-installed-chrome-"));
  const args = ["--headless=new", "--remote-debugging-pipe", "--user-data-dir=" + profile, "--no-first-run",
    "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--disable-extensions",
    "--disable-background-networking", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=localhost;127.0.0.1;[::1]"];
  if (process.argv.includes("--no-sandbox")) args.push("--no-sandbox");
  const chrome = spawn(chromePath, args.concat("about:blank"), { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 1, buf = Buffer.alloc(0);
  chrome.stdio[4].on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (let end; (end = buf.indexOf(0)) >= 0; buf = buf.subarray(end + 1)) {
      const msg = JSON.parse(buf.subarray(0, end).toString("utf8"));
      const waiting = msg.id && pending.get(msg.id);
      if (!waiting) continue;
      pending.delete(msg.id);
      if (msg.error) waiting.reject(new Error(msg.error.message)); else waiting.resolve(msg.result);
    }
  });
  chrome.on("exit", () => { pending.forEach((w) => w.reject(new Error("Chrome stopped"))); pending.clear(); });
  chrome.stdio[3].on("error", () => {});
  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    chrome.stdio[3].write(JSON.stringify({ id, method, params: params || {}, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  const stop = () => {
    chrome.kill("SIGKILL");
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {}
  };
  return { send, stop };
}

// Runs in the page: is the app mounted (boot logo gone) with content?
function readyProbe() {
  const boot = document.querySelector("#boot");
  const root = document.querySelector("#root");
  return !boot && !!root && (root.textContent || "").trim().length > 40;
}

// Turns on "launched from the Home Screen" for one page before it loads, and
// says how. Chrome's display-mode media emulation is checked in the page itself
// (an unknown feature may be accepted and ignored); without it, iOS Safari's own
// signal, navigator.standalone, is set before any of the page's scripts run.
async function emulateInstalled(chrome, sessionId, evalJs) {
  const out = {};
  try {
    await chrome.send("Emulation.setEmulatedMedia", { features: [{ name: "display-mode", value: "standalone" }] }, sessionId);
  } catch (e) { out.mediaError = e.message; }
  if (await evalJs("matchMedia('(display-mode: standalone)').matches").catch(() => false) === true) {
    out.standaloneMethod = "Emulation.setEmulatedMedia display-mode=standalone";
  } else {
    await chrome.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "Object.defineProperty(Navigator.prototype, 'standalone', { get: function () { return true; }, configurable: true });" }, sessionId);
    out.standaloneMethod = "navigator.standalone=true via Page.addScriptToEvaluateOnNewDocument (display-mode emulation not applied"
      + (out.mediaError ? ": " + out.mediaError : "") + ")";
  }
  try {
    await chrome.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: INSETS.top, topMax: INSETS.top,
      bottom: INSETS.bottom, bottomMax: INSETS.bottom, left: 0, leftMax: 0, right: 0, rightMax: 0 } }, sessionId);
    out.safeArea = "applied";
  } catch (e) { out.safeArea = "unsupported"; out.safeAreaError = e.message; }
  return out;
}

async function openPage(chrome, url, installed) {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const evalJs = async (expression) => (await chrome.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId)).result.value;
  await chrome.send("Runtime.enable", {}, sessionId);
  await chrome.send("Page.enable", {}, sessionId);
  await chrome.send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: HEIGHT, screenWidth: WIDTH, screenHeight: HEIGHT,
    deviceScaleFactor: 1, mobile: true }, sessionId);
  await chrome.send("Emulation.setUserAgentOverride", { userAgent: IPHONE_UA, platform: "iPhone" }, sessionId);
  const how = installed ? await emulateInstalled(chrome, sessionId, evalJs) : { standaloneMethod: "none (browser tab)", safeArea: "not set (browser tab)" };
  await chrome.send("Page.navigate", { url }, sessionId);
  const t0 = Date.now();
  let done = false;
  while (Date.now() - t0 < PAGE_MS) {
    await sleep(250);
    if (await evalJs("(" + readyProbe.toString() + ")()").catch(() => false) !== true) continue;
    const title = await evalJs("document.title").catch(() => "");
    if (/\[drive (done|FAILED)/.test(title || "")) { done = /\[drive done/.test(title); break; }
  }
  const title = await evalJs("document.title").catch(() => "");
  return { sessionId, targetId, evalJs, how, done, title, ms: Date.now() - t0 };
}

async function screenshot(chrome, sessionId, shotFile) {
  const shot = await chrome.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(shotFile, Buffer.from(shot.data, "base64"));
}

async function main() {
  if (!fs.existsSync(chromePath)) throw new Error("Chrome not found at " + chromePath + " (use --chrome PATH)");
  fs.mkdirSync(outDir, { recursive: true });
  const server = await startServer(path.join(outDir, "server.log"));
  const chrome = startChrome();
  const guard = setTimeout(() => { console.error("run passed " + RUN_MS / 1000 + " s, stopping"); chrome.stop(); server.stop(); process.exit(1); }, RUN_MS);
  const base = "http://127.0.0.1:" + server.port + "/golsz-app.html?theme=" + theme + "&";
  let bad = 0;
  try {
    const v = await chrome.send("Browser.getVersion");
    console.log(JSON.stringify({ browser: v.product, width: WIDTH, height: HEIGHT, theme, userAgent: "iPhone (iOS 17.5 Safari)", insets: INSETS }));

    // The plan Home shows: built once, in a plain tab, before either measured page.
    const seed = await openPage(chrome, base + "drive=goal", false);
    await chrome.send("Target.closeTarget", { targetId: seed.targetId }).catch(() => {});
    if (!seed.done) { bad++; console.log(JSON.stringify({ seed: "drive=goal", done: false, ms: seed.ms, title: seed.title.slice(0, 160) })); }

    for (const mode of ["standalone", "tab"]) {
      const page = await openPage(chrome, base + "drive=home", mode === "standalone");
      const raw = page.done ? await page.evalJs(V.snapshotExpression()) : {};
      const snap = Object.assign({ mode, insetTop: INSETS.top, insetBottom: INSETS.bottom, safeArea: page.how.safeArea }, raw);
      const verdict = V.installedVerdict(snap);
      const shotFile = path.join(outDir, (mode === "standalone" ? "1-standalone" : "2-browser-tab") + "-" + WIDTH + "x" + HEIGHT + "-" + theme + ".png");
      await screenshot(chrome, page.sessionId, shotFile);
      const pass = page.done && verdict.pass;
      if (!pass) bad++;
      // How much the under-the-status-bar check looked at, and the highest item it saw.
      const content = snap.content || [];
      const topmost = content.reduce((a, c) => (!a || c.top < a.top ? c : a), null);
      console.log(JSON.stringify({ mode, pass, drive: page.done ? "done" : "not done", ms: page.ms,
        standaloneMethod: page.how.standaloneMethod, safeArea: page.how.safeArea, safeAreaError: page.how.safeAreaError,
        isStandaloneDisplay: snap.isStandalone, matchMediaStandalone: snap.matchStandalone, navigatorStandalone: snap.navigatorStandalone,
        inner: snap.innerWidth + "x" + snap.innerHeight, doc: verdict.doc, root: verdict.root, shell: verdict.shell,
        envTop: snap.envTop, envBottom: snap.envBottom, headerPadTop: snap.headerPadTop, navPadBottom: snap.navPadBottom,
        contentChecked: content.length, topmostContent: topmost,
        underTopInset: verdict.underTopInset.slice(0, 3), reasons: verdict.reasons, unsupported: verdict.unsupported,
        screenshot: path.relative(process.cwd(), shotFile) }));
      // An emulation Chrome lacks gets its own line, so it cannot be missed or read as a pass.
      verdict.unsupported.forEach((u) => console.log(JSON.stringify({ mode, unsupported: u })));
      if (!page.done) console.log(JSON.stringify({ mode, title: page.title.slice(0, 200) }));
      if (mode === "standalone" && page.done && verdict.pass) {
        // Positive control on the live page: a label under the status bar and a
        // header without its inset padding must FAIL, and pass again once undone.
        // The header's padding is an inline shorthand holding env(), whose longhands read
        // back as "", so it is overridden by a removable !important rule, not edited.
        await page.evalJs("(function(){var l=document.createElement('div');l.id='gz-control';l.textContent='Under the status bar';l.style.cssText='position:fixed;top:8px;left:16px;z-index:9';document.body.appendChild(l);var s=document.createElement('style');s.id='gz-control-style';s.textContent='.app-shell > header{padding-top:12px!important}';document.head.appendChild(s);})()");
        const during = V.installedVerdict(Object.assign({}, snap, await page.evalJs(V.snapshotExpression())));
        await page.evalJs("(function(){document.getElementById('gz-control').remove();document.getElementById('gz-control-style').remove();})()");
        const after = V.installedVerdict(Object.assign({}, snap, await page.evalJs(V.snapshotExpression())));
        const controlOk = during.pass === false && during.reasons.length === 2 && after.pass === true;
        if (!controlOk) bad++;
        console.log(JSON.stringify({ mode, control: "label at top 8px + header padding 12px", pass: controlOk,
          duringPass: during.pass, duringReasons: during.reasons, undonePass: after.pass }));
      }
      if (page.done) {
        // Tap the header bell: installed, it must go on to permission, /sw.js and subscribe;
        // in a tab, the same iPhone gets the install-first message and no push call.
        const tap = await page.evalJs(V.bellExpression({ labelOff: BELL.off, labelOn: BELL.on, timeoutMs: 8000 }));
        const nv = V.notifyVerdict(mode, tap, BELL.install);
        if (!nv.pass) bad++;
        const bellShot = path.join(outDir, (mode === "standalone" ? "3-standalone" : "4-browser-tab") + "-bell-" + WIDTH + "x" + HEIGHT + "-" + theme + ".png");
        await screenshot(chrome, page.sessionId, bellShot);
        console.log(JSON.stringify({ mode, notifications: "header bell tapped (push service replaced by recording stand-ins)", pass: nv.pass,
          calls: tap && tap.calls, message: tap && tap.alert, bell: tap && tap.label, reasons: nv.reasons,
          screenshot: path.relative(process.cwd(), bellShot) }));
        if (mode === "tab" && nv.pass) {
          // Positive control: the same tab with the install-first guard lost (the bundle's
          // global isIOSDevice() made to say false) must FAIL the tab verdict.
          await page.evalJs("window.isIOSDevice = function () { return false; }");
          const lost = V.notifyVerdict(mode, await page.evalJs(V.bellExpression({ labelOff: BELL.off, labelOn: BELL.on, timeoutMs: 8000 })), BELL.install);
          if (lost.pass !== false) bad++;
          console.log(JSON.stringify({ mode, control: "bell tapped again with isIOSDevice() forced false", pass: lost.pass === false,
            lostPass: lost.pass, lostReasons: lost.reasons }));
        }
      }
      await chrome.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
    }
  } finally {
    clearTimeout(guard);
    chrome.stop();
    server.stop();
  }
  process.exitCode = bad ? 1 : 0;
}

main().catch((e) => { console.error(String(e.message || e)); process.exitCode = 1; });
