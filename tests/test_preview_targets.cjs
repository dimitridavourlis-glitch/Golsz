// tools/preview-targets.cjs serves a signed-in Plan page backed by a stand-in database. This pins what keeps
// it harmless and honest: the file on disk is never written, nothing is sent to the real Supabase URL, the
// store keeps a row across separate page loads, and ?fail= / ?reset= do what the header says.
const fs = require("fs");
const http = require("http");
const path = require("path");
const vm = require("vm");
const { createPreview, pageWithStub, stub, seedTargets, USER_ID } = require("../tools/preview-targets.cjs");

const appPath = path.join(__dirname, "..", "golsz-app.html");
const before = fs.readFileSync(appPath, "utf8");
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.error("FAIL: " + msg); } };

function call(port, method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (e) { /* a page, not JSON */ }
        resolve({ status: res.statusCode, text, json: parsed });
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
  const win = { fetch: (url, init) => { sent.push({ url: String(url), init }); return Promise.resolve(new Response("[]")); }, WebSocket: function (u) { sent.push({ socket: String(u) }); } };
  const store = {};
  const ctx = vm.createContext({ window: win, localStorage: { setItem: (k, v) => { store[k] = v; } }, location: { origin: "http://127.0.0.1:1" }, URL, Request, Headers, Response, btoa, Date, JSON, String });
  vm.runInContext("(" + stub.toString() + ")(" + JSON.stringify(cfg) + ")", ctx);
  await win.fetch(request.url, request.init);
  new win.WebSocket("wss://proj.supabase.co/realtime/v1/websocket");
  return { sent, store };
}

(async () => {
  const preview = createPreview();
  const server = http.createServer(preview.handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const json = { "content-type": "application/json", prefer: "return=representation", accept: "application/vnd.pgrst.object+json" };
  const T = "/__sb/rest/v1/outreach_targets";

  // Nothing is written to the committed page; the served copy carries the stub.
  ok(!/__sb|x-preview-fail|preview-reload/.test(before), "committed golsz-app.html has no preview hooks");
  const page1 = await call(port, "GET", "/golsz-app.html?page=plan");
  ok(page1.status === 200 && page1.text.includes("window.fetch = function") && page1.text.search(/<head[^>]*><script>/) >= 0, "served copy has the stub first in <head>");
  ok(fs.readFileSync(appPath, "utf8") === before, "file on disk unchanged after serving");

  // The store keeps a row across two separate page loads.
  const seeded = (await call(port, "GET", T + "?user_id=eq." + USER_ID)).json;
  ok(seeded.length === seedTargets().length, "store starts with the seeded rows");
  const added = await call(port, "POST", T, { headers: json, body: JSON.stringify({ user_id: USER_ID, name: "Reload FC", contact_email: null }) });
  ok(added.status === 201 && added.json.id && added.json.name === "Reload FC", "insert returns the new row as one object");
  await call(port, "GET", "/golsz-app.html?page=plan");
  await call(port, "GET", "/golsz-app.html?page=plan");
  const afterLoads = (await call(port, "GET", T + "?user_id=eq." + USER_ID)).json;
  ok(afterLoads.length === seeded.length + 1 && afterLoads.some((r) => r.id === added.json.id), "row survives two further page loads");
  ok(afterLoads[0].id === added.json.id, "newest row comes first (order by created_at desc)");
  const other = await call(port, "GET", T + "?user_id=eq.someone-else");
  ok(other.json.length === 0, "eq filter on user_id hides other users' rows");

  // update and delete change the store; the other reads the Plan page makes answer.
  const upd = await call(port, "PATCH", T + "?id=eq." + added.json.id + "&user_id=eq." + USER_ID, { headers: { "content-type": "application/json" }, body: JSON.stringify({ draft_email: "Hello" }) });
  ok(upd.status === 204 && preview.state.targets.find((r) => r.id === added.json.id).draft_email === "Hello", "update changes the stored row");
  const del = await call(port, "DELETE", T + "?id=eq." + added.json.id + "&user_id=eq." + USER_ID);
  ok(del.status === 204 && !preview.state.targets.some((r) => r.id === added.json.id), "delete removes the stored row");
  const prof = await call(port, "GET", "/__sb/rest/v1/profiles?id=eq." + USER_ID, { headers: { accept: "application/vnd.pgrst.object+json" } });
  ok(prof.json && prof.json.plan === "pro", "profiles answers one object on plan 'pro'");
  ok((await call(port, "GET", "/__sb/rest/v1/athlete_benchmarks?user_id=eq." + USER_ID)).json.length === 0, "benchmarks answer an empty list");
  ok((await call(port, "GET", "/__sb/auth/v1/user")).json.id === USER_ID, "auth user answers the signed-in athlete");

  // ?fail= fails exactly that call on outreach_targets; ?reset= empties or reseeds.
  const FAILING = { select: "GET", insert: "POST", update: "PATCH", delete: "DELETE" };
  for (const [op, method] of Object.entries(FAILING)) {
    const r = await call(port, method, T + "?id=eq.x", { headers: { "x-preview-fail": op, "content-type": "application/json" }, body: method === "POST" || method === "PATCH" ? "{}" : undefined });
    ok(r.status === 500, "fail=" + op + " answers HTTP 500");
  }
  ok((await call(port, "GET", T, { headers: { "x-preview-fail": "insert" } })).status === 200, "fail=insert leaves select working");
  ok((await call(port, "GET", "/__sb/rest/v1/profiles", { headers: { "x-preview-fail": "select" } })).status === 200, "fail= touches outreach_targets only");
  await call(port, "GET", "/golsz-app.html?reset=1");
  ok(preview.state.targets.length === 0, "reset=1 empties the store");
  await call(port, "GET", "/golsz-app.html?reset=seed");
  ok(preview.state.targets.length === seedTargets().length, "reset=seed restores the seeded rows");

  // The config carries ?fail= into the page, and only a known operation.
  const failPage = await call(port, "GET", "/golsz-app.html?fail=select");
  ok(failPage.text.includes('"fail":"select"'), "fail=select reaches the page config");
  ok((await call(port, "GET", "/golsz-app.html?fail=bogus")).text.includes('"fail":""'), "an unknown fail value is ignored");

  // Static serving stays inside the repo.
  ok((await call(port, "GET", "/..%2f..%2fetc/passwd")).status !== 200, "no file outside the repo is served");
  server.close();

  // Nothing leaves for the real Supabase URL: fetches go to this server, sockets are inert, the session is local.
  const cfg = { supabaseUrl: "https://proj.supabase.co", userId: USER_ID, theme: "", fail: "update" };
  const run = await runStub(cfg, { url: "https://proj.supabase.co/rest/v1/outreach_targets?id=eq.1", init: { method: "PATCH", body: "{}" } });
  ok(run.sent.length === 1 && run.sent[0].url === "http://127.0.0.1:1/__sb/rest/v1/outreach_targets?id=eq.1", "supabase fetch is rewritten to this server");
  ok(run.sent.every((s) => !(s.url || s.socket || "").includes("supabase.co")), "no request or socket targets the real Supabase host");
  ok(run.sent[0].init.headers.get("x-preview-fail") === "update", "the fail option travels as a header");
  ok(Object.keys(run.store).some((k) => k === "sb-proj-auth-token") && JSON.parse(run.store["sb-proj-auth-token"]).user.id === USER_ID, "a local session is stored under supabase-js's key");
  ok(/^[\w-]+\.[\w-]+\.preview$/.test(JSON.parse(run.store["sb-proj-auth-token"]).access_token), "the token is an unsigned stand-in");

  ok(fs.readFileSync(appPath, "utf8") === before, "file on disk unchanged at the end");
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
