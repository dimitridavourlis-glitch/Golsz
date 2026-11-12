#!/usr/bin/env node
// Runs the first-visit drives of tools/preview-onboarding.cjs in a real headless Chrome and prints
// what each page ended with. For a session that has no browser tool of its own; where AVA's browser
// tool exists it does the same job. Not a test (it needs Chrome), so it lives outside tests/.
//
// Usage:  node tools/run-onboarding-chrome.cjs --width 390 --theme dark [--out DIR] [--no-sandbox] [QUERY ...]
//   One run = one fresh preview server (its store) and one fresh Chrome profile, one width, one theme.
//   QUERY is what follows "/golsz-app.html?theme=<theme>&", e.g. "drive=goal&fail=pathway". With no
//   QUERY it runs PAGES below, in order (the order matters: every drive changes the store, and the
//   scout drives at the end ask Scout about the plan the drives before them built).
//   --chrome PATH (or CHROME_PATH) picks the binary; the default is Google Chrome on a Mac.
//   --no-sandbox passes Chrome's own flag of that name: needed when this runs inside another sandbox.
// Prints one JSON line per page:
//   drive         the page's query
//   result        what the drive wrote after the page title (see preview-onboarding.cjs), or "no drive result"
//   consoleErrors uncaught exceptions and console.error calls
//   failedRequests requests that did not load (web fonts fail where there is no internet)
//   doc           document scrollWidth/innerWidth, read by this runner on the last screen
//   pastEdge      how many visible elements reach past the window's left or right edge there, and the first few
//   screenshot    a PNG of the last screen, under --out (default node_modules/.cache/onboarding-run)
// The server's log (every stand-in write) goes to server-<width>-<theme>.log beside the screenshots.
// Exit code 1 when a drive failed or timed out. Console errors are printed, not judged: the
// fail=pathway page is meant to log the app's own "goal setup save error".
// Chrome talks over a private pipe, and everything but this Mac is sent to a proxy that is not there,
// so the page cannot reach the internet (or the real Supabase project) through it.
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PAGES = ["drive=signup", "drive=passport", "drive=goal", "drive=home", "drive=reloadmid",
  "drive=goal&fail=pathway", "drive=full", "drive=today", "drive=goal&overflow=1",
  "drive=scouttoday&model=honest", "drive=scoutinvent&model=date", "drive=scoutinvent&model=step",
  "drive=scoutinvent&model=count", "drive=scoutlimit", "drive=scoutlast"];
const DRIVE_WAIT_MS = 60000;

function option(name, fallback) { const i = process.argv.indexOf("--" + name); return i === -1 ? fallback : process.argv[i + 1]; }
const flags = ["--width", "--theme", "--out", "--chrome"];
const queries = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !flags.includes(all[i - 1]));
const width = Number(option("width", 390));
const theme = option("theme", "dark");
const outDir = path.resolve(option("out", path.join(__dirname, "..", "node_modules", ".cache", "onboarding-run")));
const chromePath = option("chrome", process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(logFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "preview-onboarding.cjs"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
    const log = fs.createWriteStream(logFile);
    let head = "";
    child.stdout.on("data", (chunk) => {
      log.write(chunk);
      if (head === null) return;
      head += chunk;
      const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(head);
      if (m) { head = null; resolve({ port: Number(m[1]), stop: () => child.kill() }); }
    });
    child.on("exit", () => reject(new Error("the preview server stopped before it printed its port")));
  });
}

function startChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "golsz-onboarding-chrome-"));
  const args = ["--headless=new", "--remote-debugging-pipe", "--user-data-dir=" + profile, "--no-first-run",
    "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--mute-audio", "--disable-extensions",
    "--disable-background-networking", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=localhost;127.0.0.1;[::1]"];
  if (process.argv.includes("--no-sandbox")) args.push("--no-sandbox");
  const chrome = spawn(chromePath, args.concat("about:blank"), { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const pending = new Map();
  const listeners = [];
  let nextId = 1;
  let buf = Buffer.alloc(0);
  chrome.stdio[4].on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (let end; (end = buf.indexOf(0)) >= 0; buf = buf.subarray(end + 1)) {
      const msg = JSON.parse(buf.subarray(0, end).toString("utf8"));
      const waiting = msg.id && pending.get(msg.id);
      if (!waiting) { listeners.forEach((fn) => fn(msg)); continue; }
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
  // Chrome can still be writing its profile for a moment after it is killed: retry, and never fail the run over it.
  const stop = () => {
    chrome.kill("SIGKILL");
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) {}
  };
  return { send, listeners, stop };
}

// Runs in the page once the drive is done: this runner's own reading of the last screen.
function lastScreen() {
  const vw = window.innerWidth;
  const past = Array.from(document.querySelectorAll("body *")).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && (r.right > vw + 0.5 || r.left < -0.5);
  });
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + " " + Math.round(el.getBoundingClientRect().right) + "px";
  return { title: document.title, doc: document.documentElement.scrollWidth + "/" + vw, pastEdge: past.length, firstPast: past.slice(0, 3).map(name) };
}

async function openPage(chrome, url, shotFile, hasDrive) {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  const consoleErrors = [], failedRequests = [], urls = new Map();
  let loaded = false;
  const onMessage = (m) => {
    if (m.sessionId !== sessionId) return;
    const p = m.params || {};
    if (m.method === "Page.loadEventFired") loaded = true;
    if (m.method === "Network.requestWillBeSent") urls.set(p.requestId, p.request.url);
    if (m.method === "Network.loadingFailed" && !p.canceled) failedRequests.push((urls.get(p.requestId) || "?") + " " + p.errorText);
    if (m.method === "Runtime.exceptionThrown") consoleErrors.push(String((p.exceptionDetails.exception || {}).description || p.exceptionDetails.text).slice(0, 300));
    if (m.method === "Runtime.consoleAPICalled" && p.type === "error") consoleErrors.push(p.args.map((a) => a.value || a.description || "").join(" ").slice(0, 300));
  };
  chrome.listeners.push(onMessage);
  for (const domain of ["Page", "Network", "Runtime"]) await chrome.send(domain + ".enable", {}, sessionId);
  const height = width < 700 ? 844 : 800;
  await chrome.send("Emulation.setDeviceMetricsOverride", { width, height, screenWidth: width, screenHeight: height, deviceScaleFactor: 1, mobile: width < 700 }, sessionId);
  await chrome.send("Page.navigate", { url }, sessionId);
  const read = async () => (await chrome.send("Runtime.evaluate", { expression: "(" + lastScreen + ")()", returnByValue: true }, sessionId)).result.value || {};
  const t0 = Date.now();
  let seen = {};
  while (Date.now() - t0 < DRIVE_WAIT_MS) {
    await sleep(250);
    seen = await read().catch(() => ({}));
    if (hasDrive ? /\[drive (done|FAILED)/.test(seen.title || "") : loaded) break;
  }
  await sleep(1200);
  seen = await read();
  const shot = await chrome.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(shotFile, Buffer.from(shot.data, "base64"));
  chrome.listeners.splice(chrome.listeners.indexOf(onMessage), 1);
  await chrome.send("Target.closeTarget", { targetId });
  const m = /\[(drive (?:done|FAILED).*)\]\s*$/.exec(seen.title || "");
  return { result: m ? m[1] : "no drive result", consoleErrors, failedRequests, doc: seen.doc, pastEdge: seen.pastEdge, firstPast: seen.firstPast };
}

async function main() {
  if (!fs.existsSync(chromePath)) throw new Error("Chrome not found at " + chromePath + " (use --chrome PATH)");
  fs.mkdirSync(outDir, { recursive: true });
  const tag = width + "-" + theme;
  const server = await startServer(path.join(outDir, "server-" + tag + ".log"));
  const chrome = startChrome();
  let bad = 0;
  try {
    await chrome.send("Browser.getVersion").then((v) => console.log(JSON.stringify({ browser: v.product, width, theme })));
    const pages = queries.length ? queries : PAGES;
    for (let i = 0; i < pages.length; i++) {
      const shotFile = path.join(outDir, tag + "-" + String(i + 1).padStart(2, "0") + "-" + pages[i].replace(/[^a-z0-9]+/gi, "-") + ".png");
      const url = "http://127.0.0.1:" + server.port + "/golsz-app.html?theme=" + theme + "&" + pages[i];
      const page = await openPage(chrome, url, shotFile, /(^|&)drive=/.test(pages[i]));
      if (!page.result.startsWith("drive done") && /(^|&)drive=/.test(pages[i])) bad++;
      console.log(JSON.stringify({ drive: pages[i], ...page, screenshot: path.relative(process.cwd(), shotFile) }));
    }
  } finally {
    chrome.stop();
    server.stop();
  }
  process.exitCode = bad ? 1 : 0;
}

main().catch((e) => { console.error(String(e.message || e)); process.exitCode = 1; });
