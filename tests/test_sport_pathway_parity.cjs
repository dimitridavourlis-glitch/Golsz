// THE CLIENT AND THE SERVER MUST DRAW THE SAME ROUTE.
//
// golsz-app.html owns SPORT_PATHWAY_STAGES — the ladder the Plan screen draws
// for each of the 40 sports in the picker. api/_sport-pathways.js is a
// verbatim copy so api/scout.js can put the same ladder in the prompt.
//
// A copy is only safe if something fails when it drifts. Without this file,
// adding a sport or reordering a ladder on the client would leave Scout
// advising an older route than the one on the athlete's own screen — the
// exact failure the copy exists to prevent, and one nothing else can see.
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const MOD = fs.readFileSync(REPO + "/api/_sport-pathways.js", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// Parsed by EXECUTING both, not by comparing text: the copy deliberately
// strips comments, so a textual diff would fail on formatting while a
// semantic one fails only on meaning.
const lift = (src, decl) => {
  const i = src.indexOf(decl);
  if (i < 0) throw new Error("could not find: " + decl);
  const j = src.indexOf("\n};", i);
  const body = src.slice(i, j + 3).replace(/^export /, "").replace(/^const /, "return ");
  return new Function(body.replace("return SPORT_PATHWAY_STAGES =", "return") + "")();
};

const clientTable = lift(APP, "const SPORT_PATHWAY_STAGES = {");
const serverTable = lift(MOD, "export const SPORT_PATHWAY_STAGES = {");

ck("the client table is non-trivial (this check is reading the right thing)",
   Object.keys(clientTable).length > 20, true);
ck("both tables list exactly the same sports",
   Object.keys(serverTable).sort(), Object.keys(clientTable).sort());

const mismatched = [];
for (const sport of Object.keys(clientTable)) {
  const a = clientTable[sport], b = serverTable[sport] || {};
  if (JSON.stringify(a.stages) !== JSON.stringify(b.stages)) mismatched.push(`${sport}: stages`);
  if ((a.altBranch || null) !== (b.altBranch || null)) mismatched.push(`${sport}: altBranch`);
}
ck("every sport's ladder is identical on both sides, in the same order", mismatched, []);

// Scout must actually USE it — a synced copy nothing reads is dead weight.
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
ck("api/scout.js imports the shared table",
   /import \{ SPORT_PATHWAY_STAGES \} from "\.\/_sport-pathways\.js"/.test(SCOUT), true);
ck("...and renders the athlete's own ladder into the prompt",
   /GOLSZ'S STANDARD ROUTE FOR \$\{athleteState\.sport\.toUpperCase\(\)\}/.test(SCOUT), true);
// The blanket disclaimer had to go with it, or Scout contradicts the screen.
ck("...and no longer claims it has no pathway list for uncovered sports",
   /no position structure, no competition ladder, no pathway list/.test(SCOUT), false);
ck("...and is told explicitly never to deny having a route",
   /never tell an athlete you have no pathway data for their sport/.test(SCOUT), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
