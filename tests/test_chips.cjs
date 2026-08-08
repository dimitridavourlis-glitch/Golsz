const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
// Extract the real chipsFor() out of golsz-app.html at run time, so this
// tests the shipping function rather than a copy that can drift.
//
// Reverted 2026-08-09: chipsFor used to branch on Scout's state machine
// (state-aware discovery/confirm/planning chips). That machine was removed
// wholesale — see the same date's commit — so this now just confirms the
// plain plan-based chip set survived the revert intact.
const html = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const from = html.indexOf("function chipsFor(t, isPlayer)");
eval(html.slice(from, html.indexOf("\n}\n", from) + 3));
const t = (k) => k;
let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const PLAN = ["scout_chip1", "scout_chip2", "scout_chip3", "scout_chip4"];
const NP = ["scout_np_chip1", "scout_np_chip2", "scout_np_chip3", "scout_np_chip4"];

ck("a player gets the planning chips, unconditionally", chipsFor(t, true), PLAN);
ck("a non-player gets the recruiter chips", chipsFor(t, false), NP);
ck("no third argument is read — a state machine cannot silently creep back in via an ignored param",
   chipsFor.length, 2);

console.log(`\n${p}/${p + f} passed`); process.exit(f ? 1 : 0);
