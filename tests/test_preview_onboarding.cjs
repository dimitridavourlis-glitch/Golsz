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
const { createPreview, stubCall, homeCounts, labelsShown, driveTitle, seedsSession, DRIVES, USER_ID } = require("../tools/preview-onboarding.cjs");

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

// Runs the page stub in a fake window and sends `requests` through its fetch one after another.
// `respond(url)` is what "the network" answers. Reports where each fetch and socket really went.
async function runStub(cfg, requests, respond = () => new Response("[]")) {
  const sent = [];
  const win = { fetch: (url, init) => { sent.push({ url: String(url), init }); return Promise.resolve(respond(String(url))); }, WebSocket: function (u) { sent.push({ socket: String(u) }); return { readyState: 3, send(){}, close(){}, addEventListener(){}, removeEventListener(){} }; } };
  const store = {};
  const ctx = vm.createContext({ window: win, localStorage: { setItem: (k, v) => { store[k] = v; }, getItem: () => null, removeItem: (k) => { delete store[k]; } }, location: { origin: "http://127.0.0.1:1" }, URL, Request, Headers, Response, btoa, Date, JSON, String, Object, Array });
  vm.runInContext(stubCall(cfg), ctx);
  for (const r of requests) await win.fetch(r.url, r.init);
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
  for (const d of DRIVES) {
    ok((await call(port, "GET", "/golsz-app.html?drive=" + d)).text.includes('"drive":"' + d + '"'), "drive=" + d + " reaches page config");
  }
  ok(DRIVES.join() === "signup,passport,goal,home,today,reloadmid,full", "the drives are the ones the header lists");
  ok((await call(port, "GET", "/golsz-app.html?drive=reloadmid2")).text.includes('"drive":""'), "an unknown drive (the old reloadmid2) drives nothing");
  ok((await call(port, "GET", "/golsz-app.html?today=2026-11-15")).text.includes('"today":"2026-11-15"'), "today param reaches page config");
  ok((await call(port, "GET", "/golsz-app.html?today=tomorrow")).text.includes('"today":""'), "a today that is not YYYY-MM-DD is dropped");

  // No request leaves localhost (same assertion pattern as test_preview_targets)
  const cfg = { supabaseUrl: "https://proj.supabase.co", userId: USER_ID, theme: "", lang: "en", fail: "", drive: "", seedSession: true, today: "" };
  const run = await runStub(cfg, [{ url: "https://proj.supabase.co/auth/v1/user", init: { method: "GET" } }]);
  ok(run.sent.length >= 1 && run.sent[0].url === "http://127.0.0.1:1/__sb/auth/v1/user", "supabase auth fetch rewritten to this server");
  ok(run.sent.every((s) => !(s.url || s.socket || "").includes("supabase.co")), "no request or socket targets the real Supabase host");
  ok(Object.keys(run.store).some((k) => k === "sb-proj-auth-token"), "session seeded under supabase-js key when seedSession true");
  const signedOut = await runStub({ ...cfg, seedSession: false }, []);
  ok(!("sb-proj-auth-token" in signedOut.store), "no session is seeded when seedSession is false");

  // fail=pathway is ONE failure: the page asks for it until the first pathway_plan write is
  // refused, and not after, so Retry on the same page goes through.
  const planUrl = "https://proj.supabase.co/rest/v1/pathway_plan?on_conflict=user_id";
  const write = { url: planUrl, init: { method: "POST", body: "{}" } };
  const read = { url: "https://proj.supabase.co/rest/v1/pathway_plan?select=*", init: { method: "GET" } };
  let planWrites = 0;
  const failRun = await runStub({ ...cfg, fail: "pathway" }, [read, write, write, read], (url) => {
    const isWrite = url.includes("/rest/v1/pathway_plan?on_conflict");
    if (isWrite) planWrites++;
    return isWrite && planWrites === 1 ? new Response("{}", { status: 500 }) : new Response("[]");
  });
  const asked = failRun.sent.filter((s) => s.url).map((s) => s.init.headers.get("x-preview-fail"));
  ok(asked.length === 4 && asked[0] === "pathway" && asked[1] === "pathway", "fail=pathway is asked for up to and on the first pathway_plan write");
  ok(asked[2] === null && asked[3] === null, "after the refused write the page stops asking: the retry and later reads carry no fail header");
  const noFail = await runStub(cfg, [write]);
  ok(noFail.sent[0].init.headers.get("x-preview-fail") === null, "without fail= no fail header is ever sent");

  // ---- What each drive starts from (a fresh server each, so nothing above leaks in) ----
  const fresh = () => { const p = createPreview({ localise: (html) => ({ html, files: {} }) }); const sv = http.createServer(p.handler); return new Promise((r) => sv.listen(0, "127.0.0.1", () => r({ p, sv, port: sv.address().port }))); };
  const seeded = (text) => /"seedSession":true/.test(text);
  const plan = { user_id: USER_ID, milestones: [{ id: "s1", label: "Step 1", due: "2026-11-15" }] };

  const a = await fresh();
  ok(!seeded((await call(a.port, "GET", "/golsz-app.html")).text), "a page with no drive starts signed out on an empty store");
  ok(seeded((await call(a.port, "GET", "/golsz-app.html?drive=home")).text), "drive=home starts signed in");
  ok(seeded((await call(a.port, "GET", "/golsz-app.html?drive=today")).text), "drive=today starts signed in");
  ok(!seeded((await call(a.port, "GET", "/golsz-app.html?drive=signup")).text) && !seeded((await call(a.port, "GET", "/golsz-app.html?drive=full")).text), "signup and full start signed out");
  await call(a.port, "POST", "/__sb/auth/v1/signup", { headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.com", password: "Password123!", data: { full_name: "Test Athlete" } }) });
  ok(seeded((await call(a.port, "GET", "/golsz-app.html")).text), "after a sign-up a page with no drive is signed in");
  a.sv.close();

  const b = await fresh();
  b.p.state.athletes[0].sport = "Rugby";
  ok(seeded((await call(b.port, "GET", "/golsz-app.html")).text), "a sport in the store signs a no-drive page in");
  b.p.state.pathway_plan.push({ ...plan });
  await call(b.port, "GET", "/golsz-app.html?drive=home");
  ok(b.p.state.pathway_plan.length === 1 && b.p.state.athletes[0].sport === "Rugby", "drive=home changes nothing in the store");
  await call(b.port, "GET", "/golsz-app.html?drive=reloadmid");
  ok(b.p.state.pathway_plan.length === 0 && b.p.state.athletes[0].sport === "Rugby", "drive=reloadmid empties pathway_plan and keeps the sport");
  b.p.state.pathway_plan.push({ ...plan });
  await call(b.port, "GET", "/golsz-app.html?drive=goal");
  ok(b.p.state.pathway_plan.length === 0 && b.p.state.athletes[0].sport === "Rugby", "drive=goal starts with the sport and no plan");
  b.p.state.pathway_plan.push({ ...plan });
  await call(b.port, "GET", "/golsz-app.html?drive=passport");
  ok(b.p.state.athletes[0].sport === null && b.p.state.pathway_plan.length === 0, "drive=passport starts with no sport and no plan");
  b.p.state.athletes[0].sport = "Rugby"; b.p.state.profiles[0].goal_text = "Old goal"; b.p.state.pathway_plan.push({ ...plan });
  await call(b.port, "GET", "/golsz-app.html?drive=signup");
  ok(b.p.state.athletes[0].sport === null && b.p.state.profiles[0].goal_text === null && b.p.state.pathway_plan.length === 0, "drive=signup starts from a brand-new account");
  ok(!seeded((await call(b.port, "GET", "/golsz-app.html")).text), "and that account is signed out until it signs up");
  const noSport = { ...b.p.state.athletes[0] };
  await call(b.port, "GET", "/golsz-app.html?drive=goal");
  ok(b.p.state.athletes[0].sport === "Soccer" && noSport.sport === null, "drive=goal gives an athlete without a sport one, so Home offers the goal step");

  // Reads honour filters, order and limit; an upsert matches on its on_conflict columns.
  const snap = (day) => call(b.port, "POST", SB + "/assessment_snapshots?on_conflict=athlete_id,taken_on", { headers: { "content-type": "application/json", prefer: "resolution=ignore-duplicates" }, body: JSON.stringify({ athlete_id: USER_ID, taken_on: day, composite: 10 }) });
  await snap("2026-11-08"); await snap("2026-11-09"); await snap("2026-11-10"); await snap("2026-11-10");
  ok(b.p.state.assessment_snapshots.length === 3, "an upsert that ignores duplicates stores one row per athlete and day");
  const obj = { accept: "application/vnd.pgrst.object+json" };
  const latest = await call(b.port, "GET", SB + "/assessment_snapshots?select=taken_on&athlete_id=eq." + USER_ID + "&taken_on=lt.2026-11-10&order=taken_on.desc&limit=1", { headers: obj });
  ok(latest.status === 200 && latest.json.taken_on === "2026-11-09", "lt + order desc + limit 1 answers the latest earlier row, as one object");
  const none = await call(b.port, "GET", SB + "/assessment_snapshots?taken_on=lt.2026-11-01&limit=1", { headers: obj });
  ok(none.status === 406, "no matching row for an object read answers 406, as PostgREST does");
  const some = await call(b.port, "GET", SB + "/assessment_snapshots?taken_on=in.(2026-11-08,2026-11-10)&order=taken_on.asc");
  ok(some.json.map((r) => r.taken_on).join() === "2026-11-08,2026-11-10", "in.() and order asc are honoured");
  b.sv.close();

  // ---- The pure rules the page reports with ----
  ok(seedsSession("signup", { hasPlan: true }) === false && seedsSession("full", { signedUp: true }) === false, "seedsSession: signup and full are signed out whatever the store holds");
  ok(["passport", "goal", "home", "today", "reloadmid"].every((d) => seedsSession(d, {}) === true), "seedsSession: the other drives are signed in");
  ok(seedsSession("", {}) === false && seedsSession("", { hasPlan: true }) && seedsSession("", { signedUp: true }) && seedsSession("", { hasSport: true }), "seedsSession: no drive follows the store");

  // Home draws each cell as a heading and a done/total value: the total is what counts.
  const counts = homeCounts([{ label: "TODAY", value: "0/3" }, { label: "THIS WEEK", value: "0/4" }]);
  ok(counts.today === "0/3" && counts.todayTotal === 3 && counts.thisWeek === "0/4" && counts.weekTotal === 4, "homeCounts reads TODAY 0/3 and THIS WEEK 0/4 as totals 3 and 4, not the done count");
  const stray = homeCounts([{ label: "Ask Scout what to focus on this week", value: "7" }, { label: "Ask Scout what to focus on this week", value: "0/4" }, { label: "Today", value: "1/2" }, { label: "This week", value: "3" }]);
  ok(stray.today === "none" && stray.thisWeek === "none" && stray.todayTotal === null && stray.weekTotal === null, "a step label that says 'this week', the Today tile and stray digits are not cells");
  const dash = homeCounts([{ label: "TODAY", value: "\u2014" }, { label: "THIS WEEK", value: "2/5" }]);
  ok(dash.today === "none" && dash.thisWeek === "2/5" && dash.weekTotal === 5, "a dash is no count; the other cell still reads");
  ok(homeCounts([]).today === "none" && homeCounts(null).thisWeek === "none", "no cells, no counts");

  const stepLabels = ["Ask Scout what to focus on this week", "Record a benchmark", "Add a highlight video"];
  ok(labelsShown(stepLabels, "MY NEXT STEP Ask Scout what to   focus on this week Mark done").join() === "Ask Scout what to focus on this week", "labelsShown finds a stored label in the screen's text, whatever the spacing");
  ok(labelsShown(stepLabels, "TODAY 0/1 THIS WEEK 0/3").length === 0 && labelsShown(null, "x").length === 0, "labelsShown finds nothing that is not there");

  const homeTitle = driveTitle({ path: ["Auth", "Passport editor", "GoalSetup", "Home"], screen: "Home", counts, badge: "1 to do", next: "Record a benchmark", labels: ["Record a benchmark"], labelTotal: 7, goalSetupFrom: "the Passport save", scroll: "390/390", goalSetupScroll: "390/390", todayViewScroll: "390/390", alerts: "", error: "" });
  ok(homeTitle.startsWith("drive done; path: Auth > Passport editor > GoalSetup > Home; screen: Home; today: 0/3; thisWeek: 0/4; badge: 1 to do; next: Record a benchmark; labels: 1/7 on screen (Record a benchmark)"), "driveTitle: the order of screens, both counts, the badge and the labels: " + homeTitle);
  ok(homeTitle.endsWith("goalSetupFrom: the Passport save; scroll: 390/390; goalSetupScroll: 390/390; todayViewScroll: 390/390; alerts: none"), "driveTitle: scrollWidth/innerWidth for Home, GoalSetup and the Today view");
  const failTitle = driveTitle({ path: ["GoalSetup", "Home"], screen: "Home", fail: { alert: "Couldn't save your plan. Try again.", formKept: true, goalKept: true, plansAtFail: 0, goalTextAtFail: "saved" }, scroll: "390/390", error: "" });
  ok(failTitle.includes('failAlert="Couldn\'t save your plan. Try again."; formKept=yes; goalKept=yes; plansAtFail=0; goalTextAtFail=saved; retry=ok'), "driveTitle: the fail=pathway facts: " + failTitle);
  const stuck = driveTitle({ path: ["Auth"], screen: "Auth", scroll: "390/390", error: "the Passport editor after sign-up" });
  ok(stuck.startsWith("drive FAILED: timed out waiting for the Passport editor after sign-up; path: Auth; screen: Auth") && !stuck.includes("drive done"), "driveTitle: a stuck drive says FAILED and where, never done");

  // The drive finds each screen by the app's own markup and English labels. When one of these
  // changes in golsz-app.html the drive would wait for something that never comes: fail here first.
  const call0 = stubCall({ ...cfg, drive: "full" });
  for (const [inTool, inApp] of [
    ["#signup-email", 'id="signup-email"'], ["#signup-name", 'id="signup-name"'], ["#signup-pw", 'id="signup-pw"'], ["#signup-dob", 'id="signup-dob"'],
    ['input[list="country-options"]', 'list="country-options"'], ['input[list="position-options"]', 'list="position-options"'],
    ['aria-label="FULL NAME"', 'editor_name_label: "FULL NAME"'], ['aria-label="SPORT"', 'editor_sport_label: "SPORT"'], ['aria-label="CLUB / TEAM"', 'editor_club_label: "CLUB / TEAM"'],
    ['"Save profile"', 'editor_save: "Save profile"'], ["#goal-setup-title", 'id="goal-setup-title"'], ["#goal-setup-goal", 'htmlFor="goal-setup-goal"'],
    ['"Build my plan"', 'goal_setup_build: "Build my plan"'], ['"Set my goal"', 'goal_card_set: "Set my goal"'], ['"Set your goal to get your plan"', 'home_set_goal_title: "Set your goal to get your plan"'],
    ['"Skip for today"', 'checkin_skip: "Skip for today"'], [".gz-home", 'className="gz-home"'], ["button[aria-expanded]", "aria-expanded={showMore}"],
    ['"Today"', 'tile_today: "Today"'], ["to do$", 'tile_today_count: "{n} to do"'], ["TODAY|THIS WEEK", 'home_week_today: "TODAY"'], ["TODAY|THIS WEEK", 'home_week_title: "THIS WEEK"'],
    ['"Back"', 'home_today_back: "Back"'],
  ]) {
    ok(call0.includes(inTool) && before.includes(inApp), "the drive's " + inTool + " still matches the app (" + inApp + ")");
  }

  server.close();
  ok(hash(fs.readFileSync(appPath, "utf8")) === beforeHash, "golsz-app.html unchanged at the end");
  ok(spawned.length === 0, "no child process (npm pack) started: " + spawned.join("; "));
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
