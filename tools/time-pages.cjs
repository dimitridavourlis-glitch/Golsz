#!/usr/bin/env node
// Times the main marketing pages: the HTML plus the same-origin assets each page references
// (stylesheets, scripts, <img>, icons). Needs a running server, so it is NOT a test and lives
// outside tests/. Usage: node tools/time-pages.cjs [baseUrl]   (default http://localhost:8000)
// Exits 1 if any page takes LIMIT_MS or more, or any request fails.
"use strict";

const BASE = (process.argv[2] || "http://localhost:8000").replace(/\/+$/, "");
const PAGES = ["/", "/index.html", "/about.html", "/contact.html", "/terms.html", "/privacy.html"];
const LIMIT_MS = 4000;

async function get(url) {
  const res = await fetch(url, { redirect: "follow" });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body };
}

// Same-origin asset paths from <link href>, <script src>, <img src>. Fonts and other hosts are skipped.
function assetsOf(html, pageUrl) {
  const out = new Set();
  const re = /<(link|script|img)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (m[1].toLowerCase() === "link" && !/rel\s*=\s*["'][^"']*(stylesheet|icon)/i.test(tag)) continue;
    let u;
    try { u = new URL(m[2], pageUrl); } catch { continue; }
    if (u.origin !== new URL(BASE).origin) continue;
    out.add(u.origin + u.pathname + u.search);
  }
  return [...out];
}

async function timePage(path) {
  const url = BASE + path;
  const start = performance.now();
  const page = await get(url);
  if (page.status !== 200) return { path, ms: performance.now() - start, error: "HTML status " + page.status };
  const assets = assetsOf(page.body.toString("utf8"), url);
  const results = await Promise.all(assets.map((a) => get(a).then((r) => ({ a, status: r.status }), (e) => ({ a, status: String(e) }))));
  const bad = results.filter((r) => r.status !== 200).map((r) => r.a + " -> " + r.status);
  return { path, ms: performance.now() - start, assets: assets.length, error: bad.length ? bad.join(", ") : null };
}

(async () => {
  console.log("Timing " + BASE + " (limit " + LIMIT_MS + " ms)");
  let failed = false;
  for (const p of PAGES) {
    let r;
    try { r = await timePage(p); } catch (e) { r = { path: p, ms: 0, error: String(e && e.message || e) }; }
    const slow = r.ms >= LIMIT_MS;
    if (slow || r.error) failed = true;
    console.log(
      (slow || r.error ? "FAIL " : "ok   ") + p.padEnd(15) + String(Math.round(r.ms)).padStart(6) + " ms  " +
      (r.assets === undefined ? "" : r.assets + " assets") + (r.error ? "  " + r.error : "")
    );
  }
  process.exit(failed ? 1 : 0);
})();
