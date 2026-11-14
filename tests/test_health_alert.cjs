// Alert thresholds. Pure decision function, no I/O — extracted from the
// real api/health-alert.js so the thresholds tested are the ones that ship.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SRC = fs.readFileSync(REPO + "/api/health-alert.js", "utf8");
const from = SRC.indexOf("export function shouldAlert");
eval(SRC.slice(from, SRC.indexOf("\n}\n", from) + 3).replace("export function", "function"));

const mf = SRC.indexOf("export function monitorFailurePush");
eval(SRC.slice(mf, SRC.indexOf("\n}\n", mf) + 3).replace("export function", "function"));

let p=0,f=0;
const ck=(l,a,e)=>{const A=JSON.stringify(a),E=JSON.stringify(e);
  if(A===E){p++;console.log("PASS  "+l);}else{f++;console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`);}};

const CFG = { minCalls: 5, failRate: 0.5, maxErrors: 3 };
const A = (t, fc, e) => shouldAlert({ totalCalls: t, failedCalls: fc, errorCount: e }, CFG).alert;

console.log("-- quiet when things are fine --");
ck("no traffic at all is not an alert", A(0, 0, 0), false);
ck("healthy traffic", A(100, 1, 0), false);
ck("a couple of errors is not a page", A(100, 1, 2), false);

console.log("\n-- the outage shapes that actually happened --");
ck("today's 502 storm: most calls failing", A(10, 8, 0), true);
ck("total outage", A(20, 20, 0), true);
ck("errors WITHOUT routing failures (the storedAssessment shape: it threw AFTER the model answered)",
   A(50, 0, 9), true);

console.log("\n-- low traffic must not page on noise --");
ck("1 of 1 failed is below minCalls, so no rate alert", A(1, 1, 0), false);
ck("4 of 4 failed still below minCalls", A(4, 4, 0), false);
ck("5 of 5 failed clears minCalls", A(5, 5, 0), true);
ck("but low traffic + enough errors still alerts", A(1, 1, 3), true);

console.log("\n-- boundaries --");
ck("exactly at the fail rate alerts", A(10, 5, 0), true);
ck("just under does not", A(10, 4, 0), false);
ck("exactly at maxErrors alerts", A(0, 0, 3), true);
ck("just under does not", A(0, 0, 2), false);

console.log("\n-- the message has to say what is wrong --");
const r = shouldAlert({ totalCalls: 10, failedCalls: 9, errorCount: 5 }, CFG);
ck("both reasons are reported, not just the first", r.reasons.length, 2);
ck("counts are in the text", /9\/10 Scout calls failed/.test(r.reasons[0]), true);
ck("error count is in the text", /5 errors logged/.test(r.reasons[1]), true);

console.log("\n-- the monitor crashing pushes admins, safely --");
const bad = new TypeError("fetch failed https://abc.supabase.co/rest/v1 key eyJhbGciOiJIUzI1NiJ9.secret");
const mp = monitorFailurePush(bad);
ck("title names the monitor", /health monitor/.test(mp.title), true);
ck("body has no URL", /https?:|supabase/i.test(mp.body), false);
ck("body has no key-like text", /eyJ/.test(mp.body), false);
ck("body has no error message", mp.body.includes(bad.message), false);
ck("deterministic", JSON.stringify(monitorFailurePush(bad)), JSON.stringify(mp));
ck("handles non-Error values", typeof monitorFailurePush(null).body, "string");

console.log("\n-- a guard that caught something is not the app failing --");
// api/scout.js logs each today answer that disagreed with the plan (the
// athlete was shown the plan's card instead). Those rows stay in the Errors
// tab and never count toward a page. tests/test_scout_today_handler.cjs pins
// the same name on api/scout.js's side, from the row the handler writes.
const guard = (/\nconst GUARD_SOURCE = "([^"]+)";/.exec(SRC) || [])[1];
ck("the guard's source is the one api/scout.js logs under", guard, "scout_today_guard");
ck("the error_log count leaves it out", /`error_log\?created_at=gte\.\$\{since\}&source=neq\.\$\{GUARD_SOURCE\}&select=id`/.test(SRC), true);
ck("...and counts every other error_log row (no other filter on that read)", (SRC.match(/`error_log\?[^`]*`/g) || []).length, 1);

console.log("\n-- handler source: where the push is and is not --");
const hs = SRC.slice(SRC.indexOf("export default async function handler"));
const catchAt = hs.lastIndexOf("} catch (e) {");
const catchBlock = hs.slice(catchAt);
const before = hs.slice(0, hs.indexOf("try {"));
ck("catch block calls pushAdmins", /pushAdmins\(/.test(catchBlock), true);
ck("catch push is in its own try/catch", /try \{[\s\S]*pushAdmins\([\s\S]*\} catch \(pushErr\)/.test(catchBlock), true);
ck("500 returned after the push block", catchBlock.indexOf("status(500)") > catchBlock.indexOf("catch (pushErr)"), true);
ck("500 body carries pushed", /status\(500\)\.json\(\{ error: String\(e\), pushed \}\)/.test(catchBlock), true);
ck("no push on the 401 or not-configured paths", /pushAdmins/.test(before), false);

console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
