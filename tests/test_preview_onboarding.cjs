// tools/preview-onboarding.cjs serves the first-visit flow backed by a stand-in database. This pins
// what keeps it harmless and honest: the file on disk is never written, nothing is sent to the real
// Supabase URL, and /__store returns the profiles, athletes and pathway_plan rows written. Its
// /api/scout runs the real api/scout.js handler: the stand-in model's four scripts, the limit and
// last-question answers, and that every request the handler makes is answered in this process.
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
// The same for fetch: a request that reached this recorder would have left the process.
const network = [];
globalThis.fetch = (url) => { network.push(String(url)); return Promise.reject(new TypeError("no network in this suite")); };
const { createPreview, stubCall, homeCounts, labelsShown, driveTitle, scrollBoxes, worstScroll, seedsSession, DRIVES, USER_ID,
  cardSentence, promptFacts, scriptedReply, scoutWait, scoutLine, serviceFetch, SCOUT_DRIVES, SCOUT_SPACING_MS, ANTHROPIC_MESSAGES,
  STAND_IN_SUPABASE, INVENTED_STEP } = require("../tools/preview-onboarding.cjs");
const { S } = require("./_day_parity.cjs");
const scoutPath = path.join(__dirname, "..", "api", "scout.js");
const SCOUT = fs.readFileSync(scoutPath, "utf8");

const appPath = path.join(__dirname, "..", "golsz-app.html");
const sourcePath = path.join(__dirname, "..", "golsz-app.jsx");
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const before = fs.readFileSync(appPath, "utf8");
const beforeHash = hash(before);
const sourceHash = hash(fs.readFileSync(sourcePath, "utf8"));
// The app's code (golsz-app.jsx, read the way every suite reads it): labels, rules and settings below.
const APP = require("./_app_source.cjs").appSource();
const appSupabase = /SUPABASE_URL\s*=\s*"([^"]+)"/.exec(APP)[1];
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
  ok(page.text.includes('"supabaseUrl":"' + appSupabase + '"'), "the stub answers the app's own Supabase address (" + appSupabase + "), read from the bundle the page runs");
  ok(hash(fs.readFileSync(appPath, "utf8")) === beforeHash && hash(fs.readFileSync(sourcePath, "utf8")) === sourceHash, "golsz-app.html and golsz-app.jsx unchanged after serving");

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
  ok(DRIVES.join() === "signup,passport,goal,home,today,reloadmid,full,scouttoday,scoutinvent,scoutlimit,scoutlast", "the drives are the ones the header lists");
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
  ok(["passport", "goal", "home", "today", "reloadmid"].concat(SCOUT_DRIVES).every((d) => seedsSession(d, {}) === true), "seedsSession: the other drives are signed in");
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

  const homeTitle = driveTitle({ path: ["Auth", "Passport editor", "GoalSetup", "Home"], screen: "Home", counts, badge: "1 to do", next: "Record a benchmark", labels: ["Record a benchmark"], labelTotal: 7, goalSetupFrom: "the Passport save", scroll: "390/390 (document)", goalSetupScroll: "390/390 (document)", todayViewScroll: "390/390 (document)", alerts: "", error: "" });
  ok(homeTitle.startsWith("drive done; path: Auth > Passport editor > GoalSetup > Home; screen: Home; today: 0/3; thisWeek: 0/4; badge: 1 to do; next: Record a benchmark; labels: 1/7 on screen (Record a benchmark)"), "driveTitle: the order of screens, both counts, the badge and the labels: " + homeTitle);
  ok(homeTitle.endsWith("goalSetupFrom: the Passport save; scroll: 390/390 (document); goalSetupScroll: 390/390 (document); todayViewScroll: 390/390 (document); alerts: none"), "driveTitle: the worst box for Home, GoalSetup and the Today view");
  ok(driveTitle({ path: ["Home"], screen: "Home", scroll: "2032/390 (main)", overflow: true }).includes("scroll: 2032/390 (main); overflow=on purpose; alerts: none"), "driveTitle: a run with the wide bar says so");

  // The scroll reading. Neither screen scrolls in the document: Home is inside <main overflow-y:auto>,
  // GoalSetup inside a fixed sheet. A reading of the document alone says 390/390 on a screen that
  // scrolls sideways, so the boxes around the screen are measured too and the worst one is reported.
  const el = (tagName, o) => ({ tagName, id: "", className: "", scrollWidth: 390, clientWidth: 390, parentElement: null, overflow: "visible", ...o });
  const docEl = el("HTML", {});
  const win = { innerWidth: 390, document: { documentElement: docEl }, getComputedStyle: (e) => ({ overflowX: e.overflow, overflowY: e.overflow }) };
  const body = el("BODY", { parentElement: docEl });
  const shell = el("DIV", { className: "app-shell", parentElement: body });
  const main = el("MAIN", { parentElement: shell, overflow: "auto" });
  const homeEl = el("DIV", { className: "gz-home wide", parentElement: main });
  ok(scrollBoxes(homeEl, win).map((b) => b.name).join() === "document,div.gz-home,main", "scrollBoxes: the document, the screen itself and the boxes around it that scroll; not the ones that do not");
  ok(worstScroll(scrollBoxes(homeEl, win)) === "390/390 (document)", "worstScroll: a screen that fits reads as the document's own pair");
  main.scrollWidth = 2032;
  ok(docEl.scrollWidth === 390 && worstScroll(scrollBoxes(homeEl, win)) === "2032/390 (main)", "a sideways scroll inside <main> is reported although the document still reads 390/390");
  main.scrollWidth = 390;
  const sheet = el("DIV", { parentElement: body, overflow: "auto", scrollWidth: 2040 });
  const dialog = el("DIV", { id: "goal-panel", parentElement: sheet, scrollWidth: 2040 });
  ok(worstScroll(scrollBoxes(dialog, win)) === "2040/390 (div#goal-panel)", "the same for GoalSetup's sheet (the first of two equal boxes is named)");
  ok(worstScroll(scrollBoxes(null, win)) === "390/390 (document)" && worstScroll([]) === "none" && worstScroll([{ name: "hidden", scrollWidth: 50, clientWidth: 0 }]) === "none", "worstScroll: no screen element means the document alone; a box with no width is not a reading");
  ok(worstScroll([{ name: "document", scrollWidth: 1280, clientWidth: 1280 }, { name: "main", scrollWidth: 1039, clientWidth: 1040 }]) === "1280/1280 (document)", "worstScroll compares the overrun, not the width");
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
    // The scout drives: Scout's nav button (phone and desktop), its screen, text box, Send, the
    // answer bubble and its text, the card under it, the "<n> left" count and the limit card.
    ['"nav button"', "<nav style={{"], ["/^(AI )?Scout$/", 'nav_scout: "Scout"'], ["/^(AI )?Scout$/", 'nav_ai_scout: "AI Scout"'],
    ['button[title="History"]', 'title={t("scout_history_title")}'], ['button[title="History"]', 'scout_history_title: "History"'],
    ['textarea[aria-label="Talk to your scout…"]', '<textarea rows={1} value={input} aria-label={t("scout_input_ph")}'], ["Talk to your scout…", 'scout_input_ph: "Talk to your scout…"'],
    ['button[title="Send"]', 'title={t("scout_send")}'], ['button[title="Send"]', 'scout_send: "Send"'],
    ['".msg"', 'className="msg"'], ['".running"', 'className="running"'], ['[style*="pre-wrap"]', '<div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>'],
    ['"FROM YOUR PLAN"', 'scout_today_title: "FROM YOUR PLAN"'], ['all("li", card)', "<li key={k} style="], ["/^and \\d+ more$/", 'scout_today_more: "and {n} more"'],
    ["/^\\d+ left$/", 'scout_left: "{n} left"'], ["/^That's all \\d+ for today$/", `scout_limit_title: "That's all {n} for today"`],
  ]) {
    ok(call0.includes(inTool) && APP.includes(inApp), "the drive's " + inTool + " still matches the app (" + inApp + ")");
  }
  ok(call0.includes('"What should I do today?"') && S.isTodayQuestion("What should I do today?"), "the scout drives ask what api/scout.js's own rule calls a today question");
  const runner = fs.readFileSync(path.join(__dirname, "..", "tools", "run-onboarding-chrome.cjs"), "utf8");
  ok(SCOUT_DRIVES.every((d) => runner.includes('"drive=' + d)), "tools/run-onboarding-chrome.cjs runs every scout drive");
  // A stuck step says FAILED in the title before the server answers the hold image on its own (the
  // page then finishes loading, and the browser tool takes its picture) and before the runner stops
  // reading the title.
  const tool = fs.readFileSync(path.join(__dirname, "..", "tools", "preview-onboarding.cjs"), "utf8");
  const stepMs = Number(/var STEP_MS = (\d+);/.exec(call0)[1]), holdMs = Number(/const timer = setTimeout\(done, (\d+)\);/.exec(tool)[1]);
  const driveWaitMs = Number(/const DRIVE_WAIT_MS = (\d+);/.exec(runner)[1]);
  ok(stepMs < holdMs && stepMs < driveWaitMs, "a step gives up (STEP_MS " + stepMs + ") before the hold is answered (" + holdMs + ") and before the runner stops waiting (" + driveWaitMs + ")");
  // The app's first screen has its own, longer allowance (a busy Mac boots the app slowly), and so must
  // still fail inside the hold and the runner's wait; every drive waits for it before its first step.
  const bootMs = Number((/var BOOT_MS = (\d+);/.exec(call0) || [])[1]);
  ok(bootMs > stepMs && bootMs < holdMs && bootMs < driveWaitMs, "the first screen gives up (BOOT_MS " + bootMs + ") after STEP_MS, before the hold is answered and before the runner stops waiting");
  const runBody = call0.slice(call0.indexOf("async function run()"), call0.indexOf("function finish("));
  ok(/^async function run\(\) \{\s*var d = cfg\.drive[^\n]*\n(\s*\/\/[^\n]*\n)*\s*await until\(function \(\) \{ return screenName\(\) !== "unknown"; \}, "the app's first screen", BOOT_MS\);/.test(runBody),
    "run() waits BOOT_MS for any known screen before the drive's first step");

  // The positive control: &overflow=1 reaches the page, and only then does the drive add the bar.
  const widePage = (await call(port, "GET", "/golsz-app.html?drive=home&overflow=1")).text;
  const plainPage = (await call(port, "GET", "/golsz-app.html?drive=home&overflow=2")).text;
  ok(widePage.includes('"overflow":true') && plainPage.includes('"overflow":false'), "overflow=1 (and nothing else) asks the page for the wide bar");
  ok(/if \(!cfg\.overflow \|\|/.test(call0) && call0.includes("width:2000px") && call0.includes("rules.worstScroll(rules.scrollBoxes(root, window))"), "the page adds the bar only when asked, and measures the screen's boxes with the two rules above");

  // ==== Scout: the page side of the scout drives ====
  // &model=, &limit= and &last= reach the page; scoutinvent, scoutlimit and scoutlast bring their own.
  const pageCfg = async (q) => (await call(port, "GET", "/golsz-app.html?" + q)).text;
  ok((await pageCfg("drive=scouttoday")).includes('"model":"","limit":false,"last":false'), "scouttoday asks for nothing: the stand-in model is honest");
  ok((await pageCfg("drive=scoutinvent")).includes('"model":"step"') && (await pageCfg("drive=scoutinvent&model=count")).includes('"model":"count"'), "scoutinvent's model is step unless &model= names another");
  ok((await pageCfg("drive=scoutlimit")).includes('"limit":true,"last":false') && (await pageCfg("drive=scoutlast")).includes('"limit":false,"last":true'), "scoutlimit implies &limit=1, scoutlast &last=1");
  ok((await pageCfg("model=date&limit=1&last=1")).includes('"model":"date","limit":true,"last":true'), "the three reach a page with no drive too");
  ok((await pageCfg("model=bogus&limit=2&last=yes")).includes('"model":"","limit":false,"last":false'), "anything else asks for nothing");

  // Each question to /api/scout carries them as headers; nothing else does.
  const scoutUrl = "http://127.0.0.1:1/api/scout";
  const scoutReq = { url: scoutUrl, init: { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer t" }, body: "{}" } };
  const moderate = { url: "http://127.0.0.1:1/api/moderate", init: { method: "POST", body: "{}" } };
  const scripted = await runStub({ ...cfg, model: "date", limit: true, last: false }, [scoutReq, moderate]);
  const askedWith = new Headers(scripted.sent[0].init.headers);
  ok(scripted.sent[0].url === scoutUrl && askedWith.get("x-preview-model") === "date" && askedWith.get("x-preview-limit") === "1" && askedWith.get("x-preview-last") === null, "a question carries x-preview-model and x-preview-limit as the page asked");
  ok(askedWith.get("authorization") === "Bearer t" && askedWith.get("content-type") === "application/json", "...next to the question's own headers");
  ok(new Headers(scripted.sent[1].init.headers || {}).get("x-preview-model") === null, "other requests carry none");
  const unscripted = new Headers((await runStub(cfg, [scoutReq])).sent[0].init.headers);
  ok(["x-preview-model", "x-preview-limit", "x-preview-last"].every((k) => unscripted.get(k) === null), "a page that asks for nothing sends none");

  // A scout drive keeps the store's plan; with none it builds one first, from the goal drive's start.
  const sd = await fresh();
  sd.p.state.scout_history = [{ id: "old" }];
  const noPlan = (await call(sd.port, "GET", "/golsz-app.html?drive=scouttoday")).text;
  ok(noPlan.includes('"buildPlan":true') && seeded(noPlan) && sd.p.state.athletes[0].sport === "Soccer" && sd.p.state.pathway_plan.length === 0, "no plan in the store: the drive is signed in, has a sport, and builds the plan first");
  ok(sd.p.state.scout_history.length === 0, "...on a new Scout conversation");
  sd.p.state.pathway_plan.push({ ...plan });
  ok((await call(sd.port, "GET", "/golsz-app.html?drive=scoutlast")).text.includes('"buildPlan":false') && sd.p.state.pathway_plan.length === 1, "a plan in the store is kept, and not built again");
  sd.sv.close();

  // ==== Scout: the stand-in model's four scripts ====
  // Lines as api/scout.js writes TODAY FOR THEM (the handler run below checks the real one), with
  // the rule it adds for a today question. Each reply is checked by api/scout.js's own check.
  const ruleFrom = (name) => new Function("return " + new RegExp("\\nconst " + name + " = (`[^`]*`);").exec(SCOUT)[1])();
  const RULE = ruleFrom("TODAY_ANSWER_RULE"), UNREAD = ruleFrom("TODAY_PLAN_UNREAD_RULE");
  const todayLine = (counts) => `TODAY FOR THEM: Thursday 2026-11-12 (their own calendar day). This week runs Monday 2026-11-09 to Sunday 2026-11-15. ${counts} Late (dates they chose themselves that have passed): 0. These are the numbers Home shows them. Use only dates written in this context; never work out another date or weekday yourself. ${RULE}`;
  const LABELS = ["Ask Scout what to focus on this week", "Add 3 target clubs or coaches", "Record a benchmark with the date and how it was measured"];
  const promptCases = [
    { what: "two open steps, one more, 1 of 5 this week",
      prompt: "ATHLETE STATE ...\n\nTHEIR OPEN STEPS:\n- Record a benchmark with the date and how it was measured — due 2026-11-14\n\n" + todayLine(`Due today: 0 of 3 done; still open today: "${LABELS[0]}"; "${LABELS[1]}" and 1 more not named here. This week: 1 of 5 dated steps done.`),
      card: { todayDone: 0, todayTotal: 3, todayOpen: LABELS.slice(0, 2), todayOpenMore: 1, weekDone: 1, weekTotal: 5 },
      honest: `Today: "${LABELS[0]}", "${LABELS[1]}" and 1 more. This week you have done 1 of 5.` },
    { what: "everything due today done",
      prompt: todayLine("Due today: 2 of 2 done. This week: 2 of 4 dated steps done."),
      card: { todayDone: 2, todayTotal: 2, todayOpen: [], todayOpenMore: 0, weekDone: 2, weekTotal: 4 },
      honest: "Everything due today is done: 2 of 2. This week you have done 2 of 4." },
    { what: "nothing dated at all",
      prompt: todayLine("Due today: nothing. This week: no dated steps."),
      card: { todayDone: 0, todayTotal: 0, todayOpen: [], todayOpenMore: 0, weekDone: 0, weekTotal: 0 },
      honest: "Nothing is due today. Nothing is dated this week." },
  ];
  for (const c of promptCases) {
    const f = promptFacts(c.prompt);
    ok(f && [f.todayDone, f.todayTotal, f.weekDone, f.weekTotal, f.more].join() === [c.card.todayDone, c.card.todayTotal, c.card.weekDone, c.card.weekTotal, c.card.todayOpenMore].join()
      && f.steps.join("|") === c.card.todayOpen.join("|"), "promptFacts reads the line (" + c.what + ")");
    const check = (reply) => S.checkReplyAgainstPlan(reply, { allowedDates: S.datesInContext(c.prompt), labels: LABELS, card: c.card, lang: "en" });
    ok(scriptedReply("honest", c.prompt) === c.honest && check(c.honest).ok, "honest names only what the line gives, and api/scout.js's check passes it (" + c.what + "): " + scriptedReply("honest", c.prompt));
    for (const script of ["date", "step", "count"]) {
      const said = scriptedReply(script, c.prompt);
      const kinds = check(said).reasons.map((r) => r.kind);
      ok(kinds.join() === script, script + " makes up exactly one " + script + " and the check finds it (" + c.what + "): " + said + " -> " + kinds.join());
    }
  }
  ok(/Have it done by 2026-11-16\.$/.test(scriptedReply("date", promptCases[0].prompt)), "date names the day after the latest date in the prompt (2026-11-15 there)");
  ok(scriptedReply("step", promptCases[0].prompt).startsWith(`Today: "${INVENTED_STEP}".`) && !LABELS.includes(INVENTED_STEP), "step quotes a step that is in no plan");
  ok(scriptedReply("count", promptCases[0].prompt).endsWith("This week you have done 1 of 6."), "count gives this week one step too many");
  const unread = todayLine('Due today: 0 of 1 done; still open today: "x". This week: 0 of 1 dated steps done.').replace(RULE, UNREAD);
  ok(["honest", "date", "step", "count"].every((s) => scriptedReply(s, unread) === "I couldn't load your plan just now. Home shows today's steps."), "a plan the handler could not read: every script says so and names nothing from it");
  ok(scriptedReply("honest", promptCases[0].prompt.replace(RULE, "")) === "This is the preview's stand-in model. Ask it what to do today.", "no today rule (another question): no plan facts");
  ok(promptFacts("no line here") === null, "promptFacts: no TODAY FOR THEM line, no facts");

  // ==== Scout: /api/scout runs the REAL api/scout.js, its Supabase and Anthropic stood in ====
  // A plan around the server's own day (the handler takes the app's day only within one of its own).
  const DAY = new Date().toISOString().slice(0, 10);
  const PLAN = [
    { id: "p1", label: LABELS[0], due: DAY, done: false },
    { id: "p2", label: LABELS[2], due: S.shiftDayKey(DAY, 1), done: false },
    { id: "p3", label: LABELS[1], due: S.shiftDayKey(DAY, -1), done: true },
    { id: "p4", label: "Share your Passport link with a coach", due: S.shiftDayKey(DAY, 9), done: false },
  ];
  const EXPECTED = S.todayCard(S.dayBuckets(PLAN, DAY, false), S.pickNextMilestone(PLAN), false);
  const sc = await fresh();
  sc.p.state.athletes[0].sport = "Soccer";
  sc.p.state.pathway_plan.push({ user_id: USER_ID, pathway_type: "ncaa", target_timeline: null, milestones: PLAN, updated_at: new Date().toISOString() });
  // The handler refuses a second question inside 3 s and the preview holds one until then: each
  // question below moves the clock both read forward instead of waiting, except the pair that
  // tests that hold on the real clock.
  const realNow = Date.now;
  let shift = 0;
  Date.now = () => realNow() + shift;
  let questionNo = 0;
  const post = (headers = {}) => call(sc.port, "POST", "/api/scout", {
    headers: { "content-type": "application/json", authorization: "Bearer preview", ...headers },
    body: JSON.stringify({ messages: [{ role: "user", content: "ATHLETE: What should I do today?" }], lang: "en", today: DAY,
      requestId: "q-" + (++questionNo), conversationId: "11111111-1111-4111-8111-111111111111" }) });
  // What the server and the handler print, kept instead of shown.
  async function quietly(fn) {
    const said = { log: [], warn: [], error: [] }, keep = { log: console.log, warn: console.warn, error: console.error };
    for (const k of Object.keys(said)) console[k] = (...a) => { said[k].push(a.map(String).join(" ")); };
    try { return { ...(await fn()), said }; } finally { Object.assign(console, keep); }
  }
  const ask = (headers) => { shift += 5000; return quietly(() => post(headers)); };
  const lastRun = () => sc.p.scoutRuns[sc.p.scoutRuns.length - 1];
  const guardRows = () => (sc.p.state.error_log || []).filter((r) => r.source === "scout_today_guard");
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const honest = await ask();
  ok(honest.status === 200 && same(honest.json.today_card, EXPECTED), "honest: 200 and today_card is todayCard() over dayBuckets for the store's plan: Home's numbers (" + JSON.stringify(honest.json.today_card) + ")");
  ok(EXPECTED.todayOpen.length === 1 && EXPECTED.todayOpen.every((l) => honest.json.reply_text.includes('"' + l + '"')) && honest.json.reply_text.includes(EXPECTED.weekDone + " of " + EXPECTED.weekTotal + "."), "...the reply quotes the store's step due today and this week's count: " + honest.json.reply_text);
  ok(!("today_override" in honest.json) && guardRows().length === 0, "...and the server's check finds nothing to replace");
  ok(same(honest.json.scout_usage, { remaining: 2, limit: 3 }), "...2 of the free plan's 3 left (reserve_scout_question: the day's first question)");
  ok(honest.said.error.length === 0, "...and the handler logged no error: every service it called answered in a shape it reads (" + honest.said.error.join(" | ") + ")");
  ok(lastRun().calls.filter((c) => c.to === "model").length === 2 && (sc.p.state.scout_routing_log || []).some((r) => r.intent === "career_advice")
    && (sc.p.state.scout_conversation_summaries || []).some((r) => r.summary === "The athlete asked what to do today."), "two model calls: the classifier got the fixed classification, the answer the script");
  ok(honest.said.log.some((l) => new RegExp("^scout 200 model=honest card=today 0/1, week " + EXPECTED.weekDone + "/" + EXPECTED.weekTotal + " override=no usage=2/3 calls: \\d+ store, 2 model, 0 refused$").test(l)), "the server prints the question's line");

  for (const script of ["date", "step", "count"]) {
    const guards = guardRows().length;
    const r = await ask({ "x-preview-model": script });
    ok(r.status === 200 && r.json.today_override === true && same(r.json.today_card, EXPECTED), script + ": the handler flags the answer (today_override) and still sends Home's card");
    const rows = guardRows().slice(guards);
    ok(rows.length === 1 && same(rows[0].detail.kinds, [script]), script + ": its guard logs one scout_today_guard row, kind " + script + " (" + JSON.stringify(rows.map((x) => x.detail.kinds)) + ")");
    const made = script === "date" ? /Have it done by \d{4}-\d{2}-\d{2}\.$/.test(r.json.reply_text) : script === "step" ? r.json.reply_text.includes('"' + INVENTED_STEP + '"')
      : r.json.reply_text.endsWith(EXPECTED.weekDone + " of " + (EXPECTED.weekTotal + 1) + ".");
    ok(made, script + ": the reply the handler got is the script's: " + r.json.reply_text);
  }

  const limited = await ask({ "x-preview-limit": "1" });
  ok(limited.status === 402 && limited.json.code === "daily_limit_reached" && same(limited.json.scout_usage, { remaining: 0, limit: 3 }), "limit=1: 402 daily_limit_reached, 0 of 3 left");
  ok(!("today_card" in limited.json) && lastRun().calls.every((c) => c.to !== "model"), "...no card, and refused before any model call");
  const last = await ask({ "x-preview-last": "1" });
  ok(last.status === 200 && same(last.json.today_card, EXPECTED) && same(last.json.scout_usage, { remaining: 0, limit: 3 }), "last=1: answered, with the card, and 0 of 3 left");
  ok(sc.p.scoutRuns.map((r) => r.script + ":" + r.status).join() === "honest:200,date:200,step:200,count:200,honest:402,honest:200", "the route records each question's script and status");

  // Two questions at once, on the real clock: the second waits until SCOUT_SPACING_MS after the
  // first was answered, so the handler's own rate limiter (3 s) lets both through.
  const limiter = Number(/\nconst RATE_LIMIT_MIN_INTERVAL_MS = (\d+);/.exec(SCOUT)[1]);
  ok(SCOUT_SPACING_MS > limiter, "SCOUT_SPACING_MS (" + SCOUT_SPACING_MS + ") is more than api/scout.js's RATE_LIMIT_MIN_INTERVAL_MS (" + limiter + ")");
  ok(scoutWait(-Infinity, 5) === 0 && scoutWait(1000, 1500) === SCOUT_SPACING_MS - 500 && scoutWait(1000, 1000 + SCOUT_SPACING_MS) === 0, "scoutWait: nothing before the first answer, then the rest of SCOUT_SPACING_MS");
  shift += 5000;
  const t0 = realNow();
  const pair = await quietly(async () => ({ both: await Promise.all([post(), post()]) }));
  ok(pair.both.every((r) => r.status === 200) && realNow() - t0 >= limiter, "two questions sent at once are both answered, " + (realNow() - t0) + " ms apart (without the wait the handler answers the second 429)");
  Date.now = realNow;

  // The fetch target check: every request the handler made was answered in this process.
  const calls = sc.p.scoutRuns.flatMap((r) => r.calls);
  ok(calls.length > 20 && calls.every((c) => (c.to === "store" && c.url.startsWith(STAND_IN_SUPABASE + "/")) || (c.to === "model" && c.url === ANTHROPIC_MESSAGES)),
    "every one of the handler's " + calls.length + " requests went to the stand-in store or the stand-in model");
  ok(calls.every((c) => !/supabase\.co/.test(new URL(c.url).hostname)) && /\.supabase\.co$/.test(new URL(appSupabase).hostname), "none to *.supabase.co (the app's own project is one)");
  ok(sc.p.scoutRuns.every((r) => r.calls.filter((c) => c.to === "model").length === (r.status === 200 ? 2 : 0)), "Anthropic's address is only ever answered by the script: two calls per answer, none for a refusal");
  ok(process.env.SUPABASE_URL === STAND_IN_SUPABASE && process.env.ANTHROPIC_API_KEY === "stand-in" && process.env.SUPABASE_SERVICE_KEY === "stand-in" && !("SCOUT_FALLBACK_API_KEY" in process.env), "the handler runs with the stand-in address and no key");
  ok(SCOUT.includes('\nconst ANTHROPIC_URL = "' + ANTHROPIC_MESSAGES + '";'), "the address the stand-in model answers is api/scout.js's ANTHROPIC_URL");
  ok(globalThis.fetch === serviceFetch && network.length === 0, "the handler's fetch is the preview's, and nothing reached the network");
  const probes = await quietly(async () => ({ settled: await Promise.allSettled([serviceFetch(appSupabase + "/rest/v1/profiles"), serviceFetch(ANTHROPIC_MESSAGES, { method: "POST", body: "{}" }), serviceFetch(STAND_IN_SUPABASE + "/rest/v1/profiles")]) }));
  ok(probes.settled.every((p) => p.status === "rejected" && p.reason instanceof TypeError) && network.length === 0, "outside a question every address is refused, the real project's and Anthropic's too");
  sc.sv.close();

  // ==== Scout: what a scout drive writes after the title ====
  const step0 = LABELS[0];
  const scoutFacts = { path: ["Home", "Scout"], screen: "Scout", counts: { today: "0/1", thisWeek: "0/3" }, badge: "1 to do", next: step0, labels: [step0], labelTotal: 7,
    scroll: "390/390 (document)", scoutScroll: "390/390 (document)", alerts: "", error: "",
    scout: { reply: `Today: "${step0}". This week you have done 0 of 3.`, card: { today: "0/1", week: "0/3", steps: [step0], more: "" }, usage: "2 left", limitCard: false, box: "open", override: false, modelReply: `Today: "${step0}". This week you have done 0 of 3.` } };
  const told = driveTitle(scoutFacts);
  ok(told.startsWith(`drive done; home today: 0/1; home week: 0/3; card today: 0/1; card week: 0/3; card steps: ${step0}; override: no; usage: 2 left; limitCard: no; reply: "Today: "${step0}". This week you have done 0 of 3."; box: open; path: Home > Scout; screen: Scout; badge: 1 to do; next: ${step0}`), "driveTitle: a scout drive puts Home's cells, the card and the answer first: " + told);
  ok(!told.includes("replaced:") && !told.includes("; today: ") && told.endsWith("scroll: 390/390 (document); scoutScroll: 390/390 (document); alerts: none"), "...no replaced field for an answer shown as it came, Home's cells once, and the answer's scroll reading");
  const swapped = driveTitle({ ...scoutFacts, scout: { ...scoutFacts.scout, override: true, reply: `Today: "${step0}". This week: 0 of 3 done.`, modelReply: `Today: "${INVENTED_STEP}". This week you have done 0 of 3.` } });
  ok(swapped.includes(`override: yes; usage: 2 left; limitCard: no; reply: "Today: "${step0}". This week: 0 of 3 done."; replaced: "Today: "${INVENTED_STEP}". This week you have done 0 of 3."; box: open`), "driveTitle: a replaced answer shows both, the bubble and the model's words: " + swapped);
  const refused = driveTitle({ ...scoutFacts, scout: { reply: "You've used today's Scout questions. 0 of 3 left today. More tomorrow.", card: null, usage: "0 left", limitCard: true, box: "closed", override: false, modelReply: "" } });
  ok(refused.startsWith(`drive done; home today: 0/1; home week: 0/3; card today: none; card week: none; card steps: none; override: no; usage: 0 left; limitCard: yes; reply: "You've used today's Scout questions. 0 of 3 left today. More tomorrow."; box: closed`), "driveTitle: the limit, with no card: " + refused);
  ok(driveTitle({ ...scoutFacts, scout: { ...scoutFacts.scout, card: { today: "0/4", week: "1/6", steps: ["A", "B"], more: "and 2 more" } } }).includes("card today: 0/4; card week: 1/6; card steps: A | B and 2 more;"), "driveTitle: every name on the card, then its 'and N more'");
  const stuckScout = driveTitle({ path: ["Home", "Scout"], screen: "Scout", error: "Scout's card to show Home's TODAY and THIS WEEK", scout: { ...scoutFacts.scout, card: { today: "0/2", week: "0/3", steps: [], more: "" } } });
  ok(stuckScout.startsWith("drive FAILED: timed out waiting for Scout's card to show Home's TODAY and THIS WEEK; home today: none; home week: none; card today: 0/2;"), "driveTitle: a scout drive that failed says what it waited for, and what it saw");
  ok(scoutLine({ status: 402, script: "honest", limit: true, last: false, calls: [{ to: "store" }, { to: "store" }], answer: { scout_usage: { remaining: 0, limit: 3 } } }) === "scout 402 model=honest limit card=none override=no usage=0/3 calls: 2 store, 0 model, 0 refused", "scoutLine: a refusal");

  // ==== Scout: the replacement sentence the scoutinvent drive waits for is the app's ====
  // scoutTodaySentence() from golsz-app.jsx, in English, against cardSentence() over the card as
  // the drive reads it from the screen (the TODAY / THIS WEEK values, the names, "and N more").
  const between = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("markers moved: " + a); return src.slice(i, j); };
  const appCard = new Function(between(APP, "function scoutTodayLines(card, t) {", "\n// Read-only, so no button") + "\nreturn { scoutTodayLines, scoutTodaySentence };")();
  const en = (key) => { const m = new RegExp("\\b" + key + ': ("(?:[^"\\\\]|\\\\.)*")').exec(APP); return m ? JSON.parse(m[1]) : key; };
  for (const c of [
    { todayTotal: 1, todayDone: 0, todayOpen: [step0], todayOpenMore: 0, weekTotal: 3, weekDone: 0, lateCount: 0 },
    { todayTotal: 4, todayDone: 0, todayOpen: ["Film two matches", "Email Coach Rivera"], todayOpenMore: 2, weekTotal: 6, weekDone: 1, lateCount: 2 },
    { todayTotal: 2, todayDone: 2, todayOpen: [], todayOpenMore: 0, weekTotal: 4, weekDone: 2, lateCount: 0 },
    { todayTotal: 0, todayDone: 0, todayOpen: [], todayOpenMore: 0, weekTotal: 0, weekDone: 0, lateCount: 1 },
    { todayTotal: 2, todayDone: 0, todayOpen: ["", "Email Coach Rivera"], todayOpenMore: 0, weekTotal: 2, weekDone: 0, lateCount: 0 },
  ]) {
    const lines = appCard.scoutTodayLines(c, en);
    const seen = { today: lines[0].value || "none", week: lines[1].value || "none", steps: lines[0].steps, more: lines[0].more || "" };
    ok(cardSentence(seen) === appCard.scoutTodaySentence(c, en), "cardSentence is the app's sentence for the card on screen: " + cardSentence(seen));
  }

  // ==== Scout: a conversation reopened from the store reads in order ====
  // Scout reopens its latest conversation newest first by created_at and turns it back into reading
  // order (latestScoutConversation, from golsz-app.jsx). Postgres stamps created_at on insert; while
  // the store did not, the answer came back above the question. Both turns here land in one millisecond.
  const latestScoutConversation = new Function(between(APP, "function latestScoutConversation(", "\nfunction scoutHistoryList(") + "\nreturn latestScoutConversation;")();
  const hs = await fresh();
  const logTurn = (row) => call(hs.port, "POST", SB + "/scout_history", { headers: { "content-type": "application/json" }, body: JSON.stringify({ user_id: USER_ID, ...row }) });
  const clock = Date.now, frozenAt = Date.now();
  Date.now = () => frozenAt;
  for (const role of ["user", "assistant"]) await logTurn({ conversation_id: "c1", messages: [{ role, content: "a " + role + " turn" }] });
  Date.now = clock;
  await logTurn({ conversation_id: "c0", messages: [{ role: "user", content: "an older question" }], created_at: "2026-01-02T00:00:00.000Z" });
  const reopened = await call(hs.port, "GET", SB + "/scout_history?select=conversation_id,messages,created_at&user_id=eq." + USER_ID + "&order=created_at.desc&limit=1000");
  const stamps = reopened.json.map((r) => r.created_at);
  ok(new Set(stamps).size === 3 && stamps.join() === [...stamps].sort().reverse().join() && stamps[2] === "2026-01-02T00:00:00.000Z",
    "an insert without created_at gets one, each later than the last inside one millisecond; one that brings its own keeps it: " + stamps.join());
  ok(latestScoutConversation(reopened.json).turns.map((m) => m.role).join() === "user,assistant", "Scout's own restore reads the store's conversation back in order: the question, then the answer");
  hs.sv.close();

  server.close();
  ok(hash(fs.readFileSync(appPath, "utf8")) === beforeHash && hash(fs.readFileSync(sourcePath, "utf8")) === sourceHash, "golsz-app.html and golsz-app.jsx unchanged at the end");
  ok(fs.readFileSync(scoutPath, "utf8") === SCOUT, "api/scout.js unchanged at the end");
  ok(spawned.length === 0, "no child process (npm pack) started: " + spawned.join("; "));
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})();
