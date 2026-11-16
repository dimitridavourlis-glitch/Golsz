#!/usr/bin/env node
// RECORDED KEYBOARD-FOCUS CHECK for AVA job 235 t2.
//
// Opens the real app (tools/preview-onboarding.cjs, stand-in auth/store — no
// live Supabase) in headless Chrome at one width, walks Home, Passport and
// Scout, presses Tab like a keyboard user, and reads the browser's own answer
// for the focused control: its accessible name, whether :focus-visible
// matched, and the computed outline. A screenshot is saved per screen with the
// ring showing. This is a recording tool, not a suite: it needs Chrome.
//
// Usage: node tools/record-a11y-focus.cjs --width 390 [--theme dark] [--out DIR]
//            [--chrome PATH] [--no-sandbox]
// Prints one JSON line per screen, then exits non-zero if any screen had no
// focusable control with a visible outline.
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function option(name, fallback) { const i = process.argv.indexOf("--" + name); return i === -1 ? fallback : process.argv[i + 1]; }
const width = Number(option("width", 390));
const theme = option("theme", "dark");
const outDir = path.resolve(option("out", path.join(__dirname, "..", "node_modules", ".cache", "a11y-focus")));
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "golsz-a11y-chrome-"));
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

// Runs in the page: everything the recording needs about the focused control.
function focusInfo() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { tag: el ? el.tagName : null, none: true };
  const cs = getComputedStyle(el);
  const label = el.getAttribute("aria-label")
    || (el.getAttribute("aria-labelledby") || "").split(/\s+/).map((id) => {
      const t = document.getElementById(id); return t ? (t.textContent || "").trim() : "";
    }).join(" ").trim()
    || (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60)
    || el.getAttribute("title") || "";
  return {
    tag: el.tagName.toLowerCase(), label,
    inMain: !!el.closest("main"),
    focusVisible: el.matches(":focus-visible"),
    outline: cs.outlineStyle + " " + cs.outlineWidth + " " + cs.outlineColor,
    outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor,
    outlineOffset: cs.outlineOffset,
  };
}

async function openAndTab(chrome, url, shotFile, height) {
  const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
  await chrome.send("Runtime.enable", {}, sessionId);
  await chrome.send("Page.enable", {}, sessionId);
  await chrome.send("Emulation.setDeviceMetricsOverride", { width, height, screenWidth: width, screenHeight: height,
    deviceScaleFactor: 1, mobile: width < 700 }, sessionId);
  await chrome.send("Page.navigate", { url }, sessionId);

  // Wait for the app's first screen to have real controls, not the boot logo.
  const count = async () => (await chrome.send("Runtime.evaluate", {
    expression: "document.querySelectorAll('main button, main [role=button]').length", returnByValue: true }, sessionId)).result.value || 0;
  const t0 = Date.now();
  let n = 0;
  while (Date.now() - t0 < 25000) { await sleep(250); n = await count().catch(() => 0); if (n >= 2) break; }
  const bootMs = Date.now() - t0;

  // Tab until a control is focused with a visible outline. Each Tab is a real
  // keyboard event, so Chrome applies :focus-visible to the focused control.
  const tabs = [];
  for (let i = 0; i < 14; i++) {
    await chrome.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, sessionId);
    await chrome.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, sessionId);
    await sleep(90);
    const info = (await chrome.send("Runtime.evaluate", { expression: "(" + focusInfo + ")()", returnByValue: true }, sessionId)).result.value || {};
    tabs.push(info);
    if (!info.none && info.inMain && info.focusVisible && info.outlineStyle !== "none" && parseFloat(info.outlineWidth) > 0) break;
  }
  const ringed = tabs.find((x) => !x.none && x.inMain && x.focusVisible && x.outlineStyle !== "none" && parseFloat(x.outlineWidth) > 0) || null;
  const shot = await chrome.send("Page.captureScreenshot", { format: "png" }, sessionId);
  fs.writeFileSync(shotFile, Buffer.from(shot.data, "base64"));
  await chrome.send("Target.closeTarget", { targetId });
  return { bootMs, controls: n, tabs: tabs.length, ringed, focused: tabs[tabs.length - 1], screenshot: path.relative(process.cwd(), shotFile) };
}

async function main() {
  if (!fs.existsSync(chromePath)) throw new Error("Chrome not found at " + chromePath + " (use --chrome PATH)");
  fs.mkdirSync(outDir, { recursive: true });
  const server = await startServer(path.join(outDir, "server-" + width + ".log"));
  const chrome = startChrome();
  const height = width < 700 ? 844 : 800;
  let bad = 0;
  try {
    const v = await chrome.send("Browser.getVersion");
    console.log(JSON.stringify({ browser: v.product, width, theme }));
    // One server, so the stand-in store persists between pages. drive=goal
    // builds the plan (and seeds the session); the three screens below then
    // each open on that signed-in store.
    const seedUrl = "http://127.0.0.1:" + server.port + "/golsz-app.html?theme=" + theme + "&drive=goal";
    await openAndTab(chrome, seedUrl, path.join(outDir, width + "-seed.png"), height);
    const screens = [
      ["Home", "drive=home"],
      ["Passport", "page=profile"],
      ["Scout", "page=scout"],
    ];
    for (const [name, query] of screens) {
      const url = "http://127.0.0.1:" + server.port + "/golsz-app.html?theme=" + theme + "&" + query;
      const shotFile = path.join(outDir, width + "-" + name.toLowerCase() + ".png");
      const r = await openAndTab(chrome, url, shotFile, height);
      const ok = !!(r.ringed && r.ringed.label);
      if (!ok) bad++;
      console.log(JSON.stringify({ screen: name, width, ...r, ok }));
    }
  } finally {
    chrome.stop();
    server.stop();
  }
  process.exitCode = bad ? 1 : 0;
}

main().catch((e) => { console.error(String(e.message || e)); process.exitCode = 1; });
