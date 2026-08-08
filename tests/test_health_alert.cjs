// Alert thresholds. Pure decision function, no I/O — extracted from the
// real api/health-alert.js so the thresholds tested are the ones that ship.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SRC = fs.readFileSync(REPO + "/api/health-alert.js", "utf8");
const from = SRC.indexOf("export function shouldAlert");
eval(SRC.slice(from, SRC.indexOf("\n}\n", from) + 3).replace("export function", "function"));

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

console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
