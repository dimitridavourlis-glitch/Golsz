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

// THREE, not four. chipsFor used to return a fourth chip that the only call
// site sliced off (CHIPS.slice(0, 3)), so scout_chip4 and scout_np_chip4 were
// translated into four languages and drawn for nobody. The redesign chose
// three - they wrap onto one row at 375px where four do not - so the count is
// stated in chipsFor and nothing trims it afterwards.
//
// scout_chip4 is now unread; scout_np_chip4 is NOT - it is the gold tile on
// ScoutStart's non-player grid. An earlier version of this note called both
// unread, which is how a rendered key gets deleted as dead weight, so the
// render site is asserted below rather than described.
const PLAN = ["scout_chip1", "scout_chip2", "scout_chip3"];
const NP = ["scout_np_chip1", "scout_np_chip2", "scout_np_chip3"];

// The claim above, as an assertion: one chip4 key is drawn and one is not.
ck("scout_np_chip4 is still rendered, on the non-player start grid",
   /\{ k: "scout_np_chip4", icon: ArrowRight, gold: true \}/.test(html), true);
ck("...and scout_chip4 is the only one nothing draws",
   (html.match(/t\("scout_chip4"\)|k: "scout_chip4"/g) || []).length, 0);

ck("a player gets the planning chips, unconditionally", chipsFor(t, true), PLAN);
ck("a non-player gets the recruiter chips", chipsFor(t, false), NP);
ck("no third argument is read — a state machine cannot silently creep back in via an ignored param",
   chipsFor.length, 2);

console.log(`\n${p}/${p + f} passed`); process.exit(f ? 1 : 0);
