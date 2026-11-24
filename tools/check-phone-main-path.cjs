#!/usr/bin/env node
// RECORDED 390px MAIN-PATH WALK for AVA job 235 t3.
//
// Opens every step of GOLSZ's main path in a real headless Chrome at 390x844,
// using the three existing preview servers (stand-in auth/store — nothing
// reaches live Supabase or Stripe), and measures each last screen with the pure
// helpers in tools/_phone-measure.cjs: document scrollWidth == innerWidth, no
// visible element past the right edge, and no button clipped by an overflow
// ancestor. A 2000px bar is injected at the end as a positive control: the same
// detector must then FAIL, or the run proves nothing.
//
// Usage: node tools/check-phone-main-path.cjs [--width 390] [--theme dark]
//            [--out DIR] [--chrome PATH] [--no-sandbox]
// Prints one JSON line per step (with pass/fail and the screenshot path), then
// one for the positive control. Exit code 1 if any step passed when it should
// not, failed, or the control did not fail. Chrome is driven over a private
// pipe; a proxy with no route keeps the page off the internet and the preview
// servers bind to 127.0.0.1, so nothing here can touch production.
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const M = require("./_phone-measure.cjs");

function option(name, fallback) { const i = process.argv.indexOf("--" + name); return i === -1 ? fallback : process.argv[i + 1]; }
const width = Number(option("width", 390));
const theme = option("theme", "dark");
const outDir = path.resolve(option("out", path.join(__dirname, "..", "node_modules", ".cache", "phone-main-path")));
const shell = path.join(os.homedir(), "Library", "Caches", "ms-playwright", "chromium_headless_shell-1194", "chrome-mac", "headless_shell");
const chromePath = option("chrome", process.env.CHROME_PATH || (fs.existsSync(shell) ? shell : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each step: a human-readable name, which preview owns it, and the query after
// "?theme=<theme>&". The order is the main path in the owner's brief; on the
// onboarding server the stand-in store persists between pages, so signup must
// come first and the drives build the state later steps read.
const STEPS = [
  { step: "1. Sign up (Auth)", server: "onboarding", query: "" },
  { step: "2. Passport after sign-up", server: "onboarding", query: "drive=signup" },
  { step: "3. Goal setup", server: "onboarding", query: "drive=passport" },
  { step: "4. Home with the dated plan", server: "onboarding", query: "drive=goal" },
  { step: "5. Scout with the from-your-plan card", server: "onboarding", query: "drive=scouttoday&model=honest" },
  { step: "6. Target clubs (Plan > Schools & clubs)", server: "targets", query: "page=plan&open=schools",
    wait: "!!document.querySelector('#gz-schools button[aria-expanded=true]') && /Northfield College Soccer/.test((document.querySelector('#gz-schools')||{textContent:''}).textContent)" },
  { step: "7. Shared Passport, signed out", server: "passport", query: "share=fake-token&fixture=a",
    wait: "/DIGITAL SPORTS PASSPORT/.test(document.body.textContent||'')" },
];

const SERVERS = {
  onboarding: { file: "preview-onboarding.cjs", path: "/golsz-app.html" },
  targets: { file: "preview-targets.cjs", path: "/golsz-app.html" },
  passport: { file: "preview-public-passport.cjs", path: "/golsz-app.html" },
};

function startServer(key, logFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, SERVERS[key].file), "0"], { stdio: ["ignore", "pipe", "inherit"] });
    const log = fs.createWriteStream(logFile);
    let head = "";
    child.stdout.on("data", (chunk) => {
      log.write(chunk);
      if (head === null) return;
      head += chunk;
      const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(head);
      if (m) { head = null; resolve({ port: Number(m[1]), stop: () => child.kill() }); }
    });
    child.on("exit", () => reject(new Error(SERVERS[key].file + " stopped before it printed its port")));
  });
}

function startChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "golsz-phone-chrome-"));
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

// Runs in the page: is the app mounted (boot logo gone) on a screen with content?
function readyProbe() {
  const boot = document.querySelector("#boot");
  const root = document.querySelector("#root");
  // Auth and the signed-out shared Passport are top-level screens rendered
  // outside GolszApp's <main>, so the mounted root — not <main> — is common to
  // every step of the path (CLAUDE.md "Responsive layout").
  return !boot && !!root && (root.textContent || "").trim().length > 40;
}

const shortPast = (e) => (e.tag || "?") + (e.id ? "#" + e.id : "") + " right=" + Math.round(e.right) + "px";
const shortClipped = (b) => (b.label || "button") + " right=" + Math.round(b.right) + "px past clip";

async function newSession(chrome, url, height, hasDrive, waitExpression) {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  await chrome.send("Runtime.enable", {}, sessionId);
  await chrome.send("Page.enable", {}, sessionId);
  await chrome.send("Emulation.setDeviceMetricsOverride", { width, height, screenWidth: width, screenHeight: height,
    deviceScaleFactor: 1, mobile: width < 700 }, sessionId);
  await chrome.send("Page.navigate", { url }, sessionId);
  const evalJs = async (expression) => (await chrome.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value;
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 90000) {
    await sleep(250);
    ready = await evalJs("(" + readyProbe.toString() + ")()").catch(() => false);
    if (!ready) continue;
    if (waitExpression) { if (await evalJs("!!(" + waitExpression + ")").catch(() => false) !== true) continue; }
    if (!hasDrive) break;
    const title = await evalJs("document.title").catch(() => "");
    if (/\[drive (done|FAILED)/.test(title || "")) break;
  }
  return { sessionId, targetId, evalJs, ready, ms: Date.now() - t0 };
}

async function screenshot(chrome, sessionId, shotFile) {
  const shot = await chrome.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(shotFile, Buffer.from(shot.data, "base64"));
}

async function closeSession(chrome, sessionId, targetId) { await chrome.send("Target.closeTarget", { targetId }).catch(() => {}); }

async function main() {
  if (!fs.existsSync(chromePath)) throw new Error("Chrome not found at " + chromePath + " (use --chrome PATH)");
  fs.mkdirSync(outDir, { recursive: true });
  const height = width < 700 ? 844 : 800;
  const servers = {};
  for (const key of Object.keys(SERVERS)) servers[key] = await startServer(key, path.join(outDir, "server-" + key + ".log"));
  const chrome = startChrome();
  let bad = 0;
  try {
    const v = await chrome.send("Browser.getVersion");
    console.log(JSON.stringify({ browser: v.product, width, height, theme }));
    for (let i = 0; i < STEPS.length; i++) {
      const s = STEPS[i];
      const url = "http://127.0.0.1:" + servers[s.server].port + SERVERS[s.server].path + "?theme=" + theme + "&" + s.query;
      const hasDrive = /(^|&)drive=/.test(s.query);
      const shotFile = path.join(outDir, String(i + 1).padStart(2, "0") + "-" + s.step.replace(/[^a-z0-9]+/gi, "-") + ".png");
      const page = await newSession(chrome, url, height, hasDrive, s.wait);
      let verdict = {};
      if (page.ready) verdict = await page.evalJs(M.measureExpression()) || {};
      const title = await page.evalJs("document.title").catch(() => "");
      const errorScreen = await page.evalJs("/Something stopped GOLSZ loading|Something went wrong/.test(document.body.innerText||'')").catch(() => false);
      const failed = !page.ready || errorScreen === true || verdict.pass !== true || /drive FAILED/.test(title || "");
      if (failed) bad++;
      await screenshot(chrome, page.sessionId, shotFile);
      console.log(JSON.stringify({ step: s.step, server: s.server, query: s.query, pass: !failed, ready: page.ready,
        ms: page.ms, doc: verdict.doc, pastCount: verdict.pastCount, clippedCount: verdict.clippedCount,
        reasons: verdict.reasons || [], firstPast: (verdict.past || []).slice(0, 3).map(shortPast),
        firstClipped: (verdict.clipped || []).slice(0, 3).map(shortClipped),
        screenshot: path.relative(process.cwd(), shotFile) }));
      await closeSession(chrome, page.sessionId, page.targetId);
    }

    // Positive control: the same detector on a real page must FAIL once a
    // 2000px bar is injected, then pass again when it is removed. A run where
    // every screen says pass without this would be indistinguishable from a
    // detector that always says pass.
    const seed = STEPS.find((s) => s.step.indexOf("Home") !== -1) || STEPS[3];
    const url = "http://127.0.0.1:" + servers[seed.server].port + SERVERS[seed.server].path + "?theme=" + theme + "&" + seed.query;
    const shotFile = path.join(outDir, "99-positive-control-bar.png");
    const page = await newSession(chrome, url, height, /(^|&)drive=/.test(seed.query));
    const base = page.ready ? await page.evalJs(M.measureExpression()) : {};
    // A clipped wrapper keeps the mobile layout viewport at 390 (a body-level
    // 2000px bar makes Chrome widen innerWidth under mobile emulation), so the
    // *edge* detector — not the document-width check — is what must catch it.
    await page.evalJs("(function(){var w=document.createElement('div');w.id='gz-positive-control';w.style.cssText='width:100%;height:1px;overflow:hidden';var b=document.createElement('div');b.style.cssText='width:2000px;height:1px';w.appendChild(b);(document.querySelector('main')||document.querySelector('#root')||document.body).appendChild(w);})()");
    await sleep(200);
    const during = await page.evalJs(M.measureExpression()) || {};
    await screenshot(chrome, page.sessionId, shotFile);
    await page.evalJs("(function(){var b=document.getElementById('gz-positive-control');if(b)b.remove();})()");
    await sleep(200);
    const after = await page.evalJs(M.measureExpression()) || {};
    const controlOk = base.pass === true && during.pass === false && after.pass === true
      && (during.reasons || []).some((r) => r.indexOf("past the right edge") !== -1);
    if (!controlOk) bad++;
    console.log(JSON.stringify({ step: "Positive control: 2000px bar", pass: controlOk,
      title: (await page.evalJs("document.title").catch(() => "")).slice(0, 90),
      innerWidth: during.innerWidth, baseDoc: base.doc, barDoc: during.doc,
      basePass: base.pass, barPass: during.pass, barReasons: during.reasons || [], removedPass: after.pass,
      screenshot: path.relative(process.cwd(), shotFile) }));
    await closeSession(chrome, page.sessionId, page.targetId);
  } finally {
    chrome.stop();
    Object.keys(servers).forEach((k) => servers[k].stop());
  }
  process.exitCode = bad ? 1 : 0;
}

main().catch((e) => { console.error(String(e.message || e)); process.exitCode = 1; });
