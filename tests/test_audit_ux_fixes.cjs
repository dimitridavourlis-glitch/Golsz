// THE 2026-10 UX / RESILIENCE AUDIT, RUN RATHER THAN READ WHERE IT CAN BE.
//
// Twelve findings, each a way the app told an athlete something false or left
// them stuck:
//   1. every exported PDF Passport said "Verified" ("none" is a truthy string)
//   2. Home's Next Move printed a raw key like "pathway_stage_3f2a…"
//   3. a FAILED read was treated as an EMPTY list, and the next save wrote that
//      emptiness over the real data (Plan, Highlights, Timeline)
//   4. raw Supabase English ("Invalid login credentials", "Failed to fetch")
//      shown in every language
//   5. render crashes caught by the ErrorBoundary were never logged anywhere
//      but the console, and its copy was English-only
//   6. Home's "a school replied" line compared against a status that does not
//      exist, so it could never appear
//   7. a dead unread-messages query ran on every tab change
//   8. inline outline:"none" beat the :focus-visible rule — no keyboard focus
//   9. the locked onboarding editor had no way to sign out
//  10. signing out left the device subscribed to the account's push
//  11. unnamed 13px delete targets; Targets deleted a drafted email in one tap
//  12. <html lang> never followed the chosen language
//
// Every function under test is lifted out of golsz-app.html at run time.
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// Extraction BY INDENTATION, not by brace counting: JSX text, apostrophes in
// comments and regex literals all defeat a naive brace matcher, while this
// file's formatting is reliable — a declaration at indent N ends at the first
// line that is exactly N spaces and "}". `anchor` must start at that indent;
// a leading "async " is picked up so the extracted text still parses.
function block(src, anchor) {
  let start = src.indexOf(anchor);
  if (start < 0) return null;
  if (src.slice(start - 6, start) === "async ") start -= 6;
  const indent = src.slice(src.lastIndexOf("\n", start) + 1, start);
  if (/\S/.test(indent)) return null;
  const close = new RegExp("\\n" + indent + "\\}(?=\\n|;\\n)", "g");
  close.lastIndex = start;
  const m = close.exec(src);
  return m ? src.slice(start, m.index + m[0].length) : null;
}
const fn = (name) => {
  const b = block(APP, "function " + name + "(");
  if (!b) throw new Error(name + "() not found — this suite is not reading what it thinks it is");
  return b;
};
const tKey = (k) => k;  // a t() that shows which key was asked for
// Async checks register here; the tally waits for all of them.
const pending = [];

// -------------------------------------------------------------------------
console.log("-- 1. the printed Passport only says Verified when it is --");
{
  const toPassport = new Function("initials", "flagFor", "SPORT_POSITION_LABEL", "SPORT_PREFERENCE",
    fn("toPassport") + " return toPassport;")(() => "AB", () => "", {}, {});
  const m = APP.match(/\{([^{}]+?) \? <span className="pp-verified">/);
  ck("the print view's verified label was found", !!m, true);
  const shows = new Function("p", "return !!(" + (m ? m[1] : "true") + ");");
  const unverified = toPassport({ full_name: "Ana", verified_tier: null }, null, null, tKey);
  ck("toPassport still defaults an unverified tier to 'none'", unverified.verifiedTier, "none");
  ck("an unverified athlete's PDF does NOT say Verified", shows(unverified), false);
  ck("...nor does a profile that never loaded", shows(toPassport(null, null, null, tKey)), false);
  ck("a pro-verified athlete's PDF does", shows(toPassport({ full_name: "Ana", verified_tier: "pro" }, null, null, tKey)), true);
  ck("an elite-verified athlete's PDF does", shows(toPassport({ full_name: "Ana", verified_tier: "elite" }, null, null, tKey)), true);
}

// -------------------------------------------------------------------------
console.log("\n-- 2. Home's Next Move names the stage, never a key --");
{
  const STAGES = { __default: { stages: ["developing", "competing"] }, Soccer: { stages: ["academy", "senior"] } };
  const lib = new Function("SPORT_PATHWAY_STAGES",
    fn("athleteStages") + fn("stageLabel") + fn("nextStepStageLabel") + " return nextStepStageLabel;")(STAGES);
  const t = (k) => ({ pathway_stage_academy: "Academy", pathway_stage_developing: "Developing" })[k] || k;
  const uuid = "3f2a9c1e-0000-4000-8000-000000000001";
  const custom = { stages: [{ id: uuid, label: "Sign with a D1 school" }, { id: "x2", label: "" }] };
  ck("a custom (UUID) stage shows the athlete's own words",
     lib({ stage: uuid }, { sport: "Soccer" }, custom, t), "Sign with a D1 school");
  ck("a sport-default stage is translated", lib({ stage: "academy" }, { sport: "Soccer" }, null, t), "Academy");
  ck("an unknown sport falls back to the default stages", lib({ stage: "developing" }, { sport: "Curling" }, null, t), "Developing");
  ck("an orphaned stage id shows nothing, not a key", lib({ stage: uuid }, { sport: "Soccer" }, null, t), null);
  ck("an unnamed custom stage shows nothing", lib({ stage: "x2" }, null, custom, t), null);
  ck("a step with no stage shows nothing", lib({ stage: null }, null, custom, t), null);
  ck("Home no longer builds a key from the stage id",
     /t\("pathway_stage_" \+ pathwayNext\.stage\)/.test(APP), false);
  ck("...it resolves through the shared helper",
     /nextStepStageLabel\(pathwayNext, athlete, pathwayRow, t\)/.test(APP), true);
}

// -------------------------------------------------------------------------
console.log("\n-- 3. a failed read never becomes a whole-array write --");
for (const [comp, col] of [["Highlights", "highlights"], ["Timeline", "timeline"]]) {
  const compSrc = block(APP, "function " + comp + "({");
  const saveSrc = block(compSrc, "function saveList(list) {");
  ck(`${comp}: saveList found`, !!saveSrc, true);
  const run = async (loaded, loadFailed) => {
    const writes = [];
    const sb = { from: () => ({ update: (row) => ({ eq: async () => { writes.push(row[col]); return { error: null }; } }) }) };
    const saveList = new Function("sb", "uid", "isOwner", "targetId", "loaded", "loadFailed", "t", "console",
      saveSrc + " return saveList;")(sb, "u1", true, "u1", loaded, loadFailed, tKey, { error() {} });
    let threw = false;
    try { await saveList([{ id: "new" }]); } catch (e) { threw = true; }
    return { writes, threw };
  };
  pending.push(Promise.all([run(true, true), run(false, false), run(true, false)]).then(([failed, early, ok]) => {
    ck(`${comp}: after a FAILED read, adding one item writes nothing`, failed.writes, []);
    ck(`${comp}: ...and the caller is told (it throws)`, failed.threw, true);
    ck(`${comp}: before the read answers, nothing is written`, early.writes, []);
    ck(`${comp}: after a good read, the write goes through`, ok.writes, [[{ id: "new" }]]);
  }));
  ck(`${comp}: the load failure is recorded`, /load error:", e\); setLoadFailed\(true\); \}/.test(compSrc), true);
  ck(`${comp}: Retry is offered in place of the empty state`, /\{loadFailed && <LoadError onRetry=\{retryLoad\} \/>\}/.test(compSrc), true);
  ck(`${comp}: the add form is hidden until a read succeeds`, /\{sb && isOwner && loaded && !loadFailed && \(/.test(compSrc), true);
  ck(`${comp}: Retry re-runs the read`, /\}, \[viewUserId, reloadKey\]\);/.test(compSrc), true);
}
{
  const tg = block(APP, "function Targets({");
  ck("Targets: a failed read is recorded", /targets load error:", e\); setTargetsLoadFailed\(true\);/.test(tg), true);
  ck("Targets: it no longer claims 'No targets yet' after a failure",
     /\{!targetsLoadFailed && items\.length === 0 && /.test(tg), true);
  ck("Targets: Retry is offered", /\{targetsLoadFailed && <LoadError onRetry=\{retryTargets\} \/>\}/.test(tg), true);
}

// -------------------------------------------------------------------------
console.log("\n-- 4. errors are sentences in the athlete's language --");
{
  const lib = new Function(fn("isNetworkError") + fn("userErrorText") + fn("loginErrorKey") +
    " return { isNetworkError, userErrorText, loginErrorKey };")();
  const fetchFail = new TypeError("Failed to fetch");
  ck("wrong password → its own sentence",
     lib.loginErrorKey({ message: "Invalid login credentials", code: "invalid_credentials", status: 400 }), "auth_err_invalid_login");
  ck("...also when only the old message text is present",
     lib.loginErrorKey({ message: "Invalid login credentials" }), "auth_err_invalid_login");
  ck("unconfirmed email → its own sentence", lib.loginErrorKey({ code: "email_not_confirmed", message: "x" }), "auth_err_unconfirmed");
  ck("...or by message", lib.loginErrorKey({ message: "Email not confirmed" }), "auth_err_unconfirmed");
  ck("offline (Chrome) → the network sentence", lib.loginErrorKey(fetchFail), "err_network");
  ck("offline (Safari) → the network sentence", lib.loginErrorKey(new TypeError("Load failed")), "err_network");
  ck("offline (supabase-js wrapper) → the network sentence",
     lib.loginErrorKey({ name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 }), "err_network");
  ck("anything else → the generic sentence, never the raw text",
     lib.loginErrorKey({ message: "Database error granting user" }), "err_generic");
  ck("a code bug's TypeError is not called a network problem",
     lib.isNetworkError(new TypeError("Cannot read properties of undefined (reading 'x')")), false);
  ck("a PostgREST error on save → the screen's own fallback",
     lib.userErrorText({ code: "42501", message: "new row violates row-level security policy" }, tKey, "editor_save_err"), "editor_save_err");
  ck("a network failure on save → the network sentence", lib.userErrorText(fetchFail, tKey, "editor_save_err"), "err_network");

  const pe = block(APP, "function ProfileEditor({");
  ck("ProfileEditor no longer shows e.message", /setErr\(\(e && e\.message\)/.test(pe), false);
  ck("...it maps through userErrorText", /setErr\(userErrorText\(e, t, "editor_save_err"\)\);/.test(pe), true);
  ck("...and still logs the raw error", /console\.error\("GOLSZ profile save error:", e\);/.test(pe), true);
  ck("GoalCard maps through userErrorText", /setErr\(userErrorText\(e, t, "goal_card_save_err"\)\);/.test(APP), true);
  const authCatch = APP.slice(APP.indexOf('console.error("GOLSZ auth error:", e);'), APP.indexOf("const cta = confirmPolling"));
  ck("login maps through loginErrorKey", /else if \(!isSignupLike\) \{[\s\S]{0,300}msg = t\(loginErrorKey\(e\)\);/.test(authCatch), true);
  ck("the unconfirmed message is translated", /msg = t\("auth_err_unconfirmed"\);/.test(authCatch), true);
  ck("the default is translated", /let msg = t\("err_generic"\);/.test(authCatch), true);
  ck("the developer text about a paused project is gone", /isn't paused/.test(APP), false);
  ck("...and so is JSON.stringify of the raw error", /"Unexpected error: " \+ JSON\.stringify/.test(APP), false);
}

// -------------------------------------------------------------------------
console.log("\n-- 5. a render crash is logged and explained in the athlete's language --");
{
  const src = APP.slice(APP.indexOf("const BOUNDARY_COPY = {"), APP.indexOf("ReactDOM.createRoot(document.getElementById('root'))"));
  ck("the boundary source was found", src.length > 500, true);
  const reports = [];
  const store = {};
  const React = {
    Component: class { constructor(props) { this.props = props; } },
    createElement: (type, props, ...children) => ({ type, props, children }),
  };
  const ErrorBoundary = new Function("React", "reportClientError", "localStorage", "window", "console",
    src + " return ErrorBoundary;")(React, (m, d) => reports.push({ m, d }),
    { getItem: (k) => (k in store ? store[k] : null) }, { location: { reload() {} } }, { error() {} });
  const b = new ErrorBoundary({ children: "app" });
  b.componentDidCatch(new Error("boom"), { componentStack: "\n    at Home" });
  ck("componentDidCatch sends the error to log_client_error's path", reports.map((r) => r.m), ["boom"]);
  ck("...with the component stack", /at Home/.test((reports[0] && reports[0].d.componentStack) || ""), true);
  const textOf = (el) => (el && el.children ? el.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("|") : "");
  b.state = { error: new Error("boom") };
  ck("English by default", textOf(b.render()).startsWith("Something went wrong."), true);
  for (const [lang, title] of [["fr", "Une erreur est survenue."], ["es", "Algo salió mal."], ["el", "Κάτι πήγε στραβά."]]) {
    store["golsz-lang"] = lang;
    ck(`${lang}: the crash screen follows the saved language`, textOf(b.render()).startsWith(title), true);
  }
  store["golsz-lang"] = "xx";
  ck("an unknown saved language falls back to English", textOf(b.render()).startsWith("Something went wrong."), true);
  ck("reportClientError is top-level so the boundary can reach it", /\nfunction reportClientError\(message, detail\) \{/.test(APP), true);
  ck("...and the window handlers still use it", (APP.match(/reportClientError\(\n/g) || []).length >= 2, true);
  const boot = APP.slice(APP.indexOf("var BOOT_COPY = {"), APP.indexOf("function bootFailed("));
  ck("the boot-failure screen carries all four languages",
     ["en:", "fr:", "es:", "el:"].every((k) => boot.includes(k)), true);
  ck("...and uses them", /\+ copy\[0\]/.test(APP) && /">' \+ copy\[1\] \+ '<\/button>/.test(APP), true);
}

// -------------------------------------------------------------------------
console.log("\n-- 6. Home's 'a school replied' line can actually appear --");
{
  const line = APP.match(/const replied = targetRows\.find\([^\n]+\);/);
  ck("the line was found", !!line, true);
  const replied = new Function("targetRows", (line ? line[0] : "const replied = null;") + " return replied;");
  ck("a 'responded' school is found",
     (replied([{ status: "contacted", name: "A" }, { status: "responded", name: "Brevard" }]) || {}).name, "Brevard");
  ck("an 'opportunity' counts as an answer too", (replied([{ status: "opportunity", name: "Tusculum" }]) || {}).name, "Tusculum");
  ck("contacted-but-silent does not", replied([{ status: "contacted", name: "A" }]), undefined);
  const statuses = APP.match(/const TARGET_STATUSES = \[([^\]]+)\]/)[1];
  ck("'responded' is a real status", /"responded"/.test(statuses), true);
  ck("'replied' is not", /"replied"/.test(statuses), false);
}

// -------------------------------------------------------------------------
console.log("\n-- 7. no dead query on every tab change --");
{
  ck("the unread flag is gone", /\[hasUnreadMsgs, setHasUnreadMsgs\]|setHasUnreadMsgs\(/.test(APP), false);
  ck("...and so is the head-count of unread messages",
     /from\("messages"\)\.select\("id", \{ count: "exact", head: true \}\)/.test(APP), false);
}

// -------------------------------------------------------------------------
console.log("\n-- 8. keyboard focus is visible on every control --");
{
  const css = APP.slice(APP.indexOf("const CSS = `"), APP.indexOf("`;", APP.indexOf("const CSS = `")));
  const rule = css.match(/([^{}]*:focus-visible[^{}]*)\{([^}]*)\}/);
  ck("a :focus-visible rule exists", !!rule, true);
  const sel = rule ? rule[1] : "", decl = rule ? rule[2] : "";
  for (const el of ["input", "textarea", "select", "button"]) {
    ck(`it covers ${el}`, new RegExp("(^|[\\s,])" + el + ":focus-visible").test(sel), true);
  }
  ck("it beats inline outline:none (!important)", /:focus-visible \{ outline: 2px solid \$\{C\.lime\} !important; outline-offset: 2px !important; \}/.test(css), true);
  ck("script-focused dialogs (tabindex=-1) are not ringed", /:not\(\[tabindex="-1"\]\)/.test(sel), true);
}

// -------------------------------------------------------------------------
console.log("\n-- 9. the locked onboarding editor has a way out --");
{
  const pe = block(APP, "function ProfileEditor({");
  ck("ProfileEditor accepts onSignOut", /^function ProfileEditor\(\{[^}]*\bonSignOut\b/.test(pe), true);
  ck("...and offers it only while locked", /\{locked && onSignOut && \(\s*<button onClick=\{onSignOut\}/.test(pe), true);
  ck("...labelled with the existing translated Sign out", /<button onClick=\{onSignOut\}[^>]*>\{t\("nav_signout"\)\}<\/button>/.test(pe), true);
  ck("Passport passes its own sign-out through", /locked=\{incomplete\}\s*onSignOut=\{onSignOut\}/.test(APP), true);
}

// -------------------------------------------------------------------------
console.log("\n-- 10. signing out detaches this device's push --");
pending.push((async () => {
  const rootSrc = block(APP, "function Root(");
  const signOutSrc = block(rootSrc, "function signOut() {");
  ck("Root's signOut found", !!signOutSrc, true);
  const make = (disable) => {
    const log = [];
    const sb = { auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1" } } } }),
      signOut: async () => { log.push("signOut"); },
    } };
    const detach = new Function("sb", "disablePushNotifications", "setTimeout", "console",
      fn("detachPushOnSignOut") + " return detachPushOnSignOut;")(sb, (uid) => { log.push("disable:" + uid); return disable(); },
      (cb) => { log.push("timer"); Promise.resolve().then(cb); }, { warn() { log.push("warned"); } });
    const signOut = new Function("sb", "detachPushOnSignOut", "setAuthed", "setRecovering", "setBanned",
      signOutSrc + " return signOut;")(sb, detach, (v) => log.push("authed:" + v), () => {}, () => {});
    return { signOut, log };
  };
  {
    const r = make(async () => {});
    await r.signOut();
    ck("the subscription is removed BEFORE the session ends (RLS needs it)",
       r.log.filter((x) => x === "disable:u1" || x === "signOut"), ["disable:u1", "signOut"]);
    ck("...and the app signs out", r.log.includes("authed:false"), true);
  }
  {
    const r = make(async () => { throw new Error("push service down"); });
    await r.signOut();
    ck("a push failure never blocks sign-out", r.log.includes("signOut") && r.log.includes("authed:false"), true);
  }
  {
    const r = make(() => new Promise(() => {}));  // never settles
    await r.signOut();
    ck("a hung push call is cut off by the timeout", r.log.includes("timer") && r.log.includes("authed:false"), true);
  }
  ck("it reuses disablePushNotifications", /disablePushNotifications\(uid\)/.test(fn("detachPushOnSignOut")), true);
})());

// -------------------------------------------------------------------------
console.log("\n-- 11. delete buttons are named, reachable, and Targets asks first --");
{
  for (const comp of ["Highlights", "Timeline", "Benchmarks", "Targets", "DevelopmentPlan"]) {
    const src = block(APP, "function " + comp + "({") || "";
    ck(`${comp}: its delete button has a translated, named label`,
       /aria-label=\{[^\n]*t\("a11y_delete_named"\)\.replace\("\{name\}"[\s\S]{0,300}?style=\{deleteBtnStyle\(/.test(src), true);
  }
  ck("the shared style gives a 44px hit area", /minWidth: 44, minHeight: 44/.test(fn("deleteBtnStyle")), true);
  const tg = block(APP, "function Targets({");
  ck("Targets deletes on the SECOND tap",
     /if \(armedTarget === it\.id\) \{ setArmedTarget\(null\); removeTarget\(it\.id\); \} else \{ setArmedTarget\(it\.id\); setTimeout/.test(tg), true);
  ck("...and no longer on the first", /onClick=\{\(\) => removeTarget\(it\.id\)\}/.test(tg), false);
  ck("...and says so when armed", /\{armedTarget === it\.id \? t\("targets_delete_confirm"\) : <X size=\{14\} \/>\}/.test(tg), true);
  for (const comp of ["Highlights", "Timeline", "DevelopmentPlan"]) {
    const src = block(APP, "function " + comp + "({");
    ck(`${comp}: no unnamed padding:0 delete icon left`,
       /<button onClick=\{\(\) => remove\w+\([^)]*\)\} style=\{\{ background: "none"/.test(src), false);
  }
}

// -------------------------------------------------------------------------
console.log("\n-- 12. <html lang> follows the chosen language --");
{
  const lp = fn("LangProvider");
  ck("LangProvider sets documentElement.lang", /document\.documentElement\.lang = lang;/.test(lp), true);
}

// -------------------------------------------------------------------------
console.log("\n-- every new string exists in all four languages --");
{
  const I18N_START = APP.indexOf("const I18N = {");
  const idx = Object.fromEntries(["en", "fr", "es", "el"].map((l) => [l, APP.indexOf("\n  " + l + ": {", I18N_START)]));
  const order = Object.keys(idx).sort((a, b) => idx[a] - idx[b]);
  const segFor = (l) => { const i = order.indexOf(l); return APP.slice(idx[l], i + 1 < order.length ? idx[order[i + 1]] : APP.indexOf("\n};", idx[l])); };
  const keys = ["load_failed", "load_retry", "err_network", "err_generic", "a11y_delete_named",
    "auth_err_invalid_login", "auth_err_unconfirmed", "targets_delete_confirm", "targets_delete_confirm_aria"];
  for (const l of order) {
    const seg = segFor(l);
    ck(`${l} defines every new key`, keys.filter((k) => !new RegExp("[\\s,{]" + k + ': "').test(seg)), []);
  }
}

Promise.all(pending).then(() => {
  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
});
