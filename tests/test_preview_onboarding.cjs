// tools/preview-onboarding.cjs serves the first-visit flow backed by a stand-in database. This pins
// what keeps it harmless and honest: the file on disk is never written, nothing is sent to the real
// Supabase URL, and /__store returns the profiles, athletes and pathway_plan rows written.
const fs = require("fs");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");
// The suite runs in the deploy gate, which needs no network: record any child process (the vendor
// copy's `npm pack`) instead of starting it. Patched before the tool is required.
const childProcess = require("child_process");
const spawned = [];
for (const fn of ["exec", "execFile", "execFileSync", "execSync", "spawn", "spawnSync", "fork"]) {
  childProcess[fn] = (...args) => { spawned.push(fn + " " + String(args[0])); throw new Error("no child process in this suite"); };
}
const { createPreview, stub, USER_ID } = require("../tools/preview-onboarding.cjs");

const appPath = path.join(__dirname, "..", "golsz-app.html");
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const before = fs.readFileSync(appPath, "utf8");
const beforeHash = hash(before);
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("FAIL: " + msg); } };

function call(port, method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let parsed = null; try { parsed = JSON.parse(text); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, text, json: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Runs the page stub in a fake window: reports where each fetch and socket really went.
async function runStub(cfg, request) {
  const sent = [];
  const win = { fetch: (url, init) => { sent.push({ url: String(url), init }); return Promise.resolve(new Response("[]")); }, WebSocket: function (u) { sent.push({ socket: String(u) }); return { readyState: 3, send(){}, close(){}, addEventListener(){}, removeEventListener(){} }; } };
  const store = {};
  const ctx = vm.createContext({ window: win, localStorage: { setItem: (k, v) => { store[k] = v; }, getItem: () => null, removeItem: () => {} }, location: { origin: "http://127.0.0.1:1" }, URL, Request, Headers, Response, btoa, Date, JSON, String, Object, Array, document: { querySelectorAll: () => [], getElementById: () => null, body: { textContent: "" }, title: "" }, MutationObserver: function(){ return { observe(){} }; }, Image: function(){}, setInterval: function(){ return 1; }, clearInterval: function(){}, setTimeout: function(){ return 1; }, navigator: { sendBeacon: () => true } });
  vm.runInContext("(" + stub.toString() + ")(" + JSON.stringify(cfg) + ")", ctx);
  await win.fetch(request.url, request.init);
  new win.WebSocket("wss://proj.supabase.co/realtime/v1/websocket");
  return { sent, store };
}

(async () => {
  const preview = createPreview({ localise: (html) => ({ html, files: {} }) });
  const server = http.createServer(preview.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const json = { "content-type": "application/json", prefer: "return=representation, resolution=merge-duplicates", accept: "application/vnd.pgrst.object+json" };
  const SB = "/__sb/rest/v1";

  // Fetching /golsz-app.html returns the app with the stub, and the git hash is the same before/after.
  ok(!/__sb|x-preview-fail|preview-onboarding|onboarding stub/i.test(before.slice(0, 5000)), "committed golsz-app.html has no preview hooks near head");
  const page = await call(port, "GET", "/golsz-app.html");
  ok(page.status === 200 && page.text.includes("window.fetch = function") && page.text.search(/<head[^>]*><script>/) >= 0, "served copy has the stub first in <head");
  ok(hash(fs.readFileSync(appPath, "utf8")) === beforeHash, "golsz-app.html git hash unchanged after serving");

  // /__store returns profiles, athletes and pathway_plan (shape)
  const store0 = await call(port, "GET", "/__store");
  ok(store0.status === 200 && Array.isArray(store0.json.profiles) && Array.isArray(store0.json.athletes) && Array.isArray(store0.json.pathway_plan), "__store returns profiles, athletes and pathway_plan arrays");

  // Writes via REST (as a drive would produce) show up in /__store
  await call(port, "PATCH", SB + "/profiles?id=eq." + USER_ID, { headers: { "content-type": "application/json" }, body: JSON.stringify({ full_name: "Test Athlete", goal_text: "Play college soccer" }) });
  await call(port, "PATCH", SB + "/athletes?id=eq." + USER_ID, { headers: { "content-type": "application/json" }, body: JSON.stringify({ sport: "Soccer", position: "Midfielder", club_name: "Test FC", country: "Canada" }) });
  const planBody = JSON.stringify({ user_id: USER_ID, pathway_type: "ncaa", target_timeline: "Fall 2027", milestones: [{ id: "s1", title: "Step 1", due_date: "2026-11-15" }], updated_at: new Date().toISOString() });
  await call(port, "POST", SB + "/pathway_plan?on_conflict=user_id", { headers: json, body: planBody });
  const store1 = await call(port, "GET", "/__store");
  ok(store1.json.profiles.some(p => p.id === USER_ID && p.full_name === "Test Athlete"), "__store reflects profiles written during a drive");
  ok(store1.json.athletes.some(a => a.id === USER_ID && a.sport === "Soccer"), "__store reflects athletes written during a drive");
  ok(store1.json.pathway_plan.some(p => p.user_id === USER_ID && p.pathway_type === "ncaa"), "__store reflects pathway_plan rows written during a drive");

  // fail=pathway makes pathway_plan upsert answer 500
  const failUp = await call(port, "POST", SB + "/pathway_plan?on_conflict=user_id", { headers: { ...json, "x-preview-fail": "pathway" }, body: planBody });
  ok(failUp.status === 500, "fail=pathway answers HTTP 500 on pathway_plan upsert");
  const failPage = await call(port, "GET", "/golsz-app.html?fail=pathway");
  ok(failPage.text.includes('"fail":"pathway"'), "fail=pathway reaches the page config");

  // Auth endpoints answered locally
  const signup = await call(port, "POST", "/__sb/auth/v1/signup", { headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.com", password: "Password123!", data: {} }) });
  ok(signup.status === 200 && signup.json && (signup.json.user || signup.json.session || signup.json.access_token), "signUp answered locally");
  const user = await call(port, "GET", "/__sb/auth/v1/user");
  ok(user.status === 200 && user.json && user.json.id, "getUser answered locally");

  // RPCs return empty (sync_athlete_actions and others)
  const rpc = await call(port, "POST", "/__sb/rest/v1/rpc/sync_athlete_actions", { headers: { "content-type": "application/json" }, body: "{}" });
  ok(rpc.status === 200, "sync_athlete_actions RPC returns 200 (empty)");

  // Drive/config params reach page
  for (const d of ["signup","passport","goal","full","reloadmid"]) {
    ok((await call(port, "GET", "/golsz-app.html?drive=" + d)).text.includes('"drive":"' + d + '"'), "drive=" + d + " reaches page config");
  }
  ok((await call(port, "GET", "/golsz-app.html?today=2026-11-15")).text.includes('"today":"2026-11-15"'), "today param reaches page config");

  // No request leaves localhost (same assertion pattern as test_preview_targets)
  const cfg = { supabaseUrl: "https://proj.supabase.co", userId: USER_ID, theme: "", lang: "en", fail: "", drive: "", seedSession: true, today: "" };
  const run = await runStub(cfg, { url: "https://proj.supabase.co/auth/v1/user", init: { method: "GET" } });
  ok(run.sent.length >= 1 && run.sent[0].url === "http://127.0.0.1:1/__sb/auth/v1/user", "supabase auth fetch rewritten to this server");
  ok(run.sent.every((s) => !(s.url || s.socket || "").includes("supabase.co")), "no request or socket targets the real Supabase host");
  ok(Object.keys(run.store).some((k) => k === "sb-proj-auth-token"), "session seeded under supabase-js key when seedSession true");

  // reloadmid2 (internal) also valid
  ok((await call(port, "GET", "/golsz-app.html?drive=reloadmid2")).status === 200, "reloadmid2 serves ok");

  server.close();
  ok(hash(fs.readFileSync(appPath, "utf8")) === beforeHash, "golsz-app.html unchanged at the end");
  ok(spawned.length === 0, "no child process (npm pack) started: " + spawned.join("; "));
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
