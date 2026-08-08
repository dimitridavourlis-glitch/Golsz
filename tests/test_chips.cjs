const REPO = require("path").join(__dirname, "..");
const fs=require("fs");
// Extract the real chipsFor() out of golsz-app.html at run time, so this
// tests the shipping function rather than a copy that can drift.
const html = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const from = html.indexOf("function chipsFor(t, isPlayer, scoutState)");
eval(html.slice(from, html.indexOf("\n}\n", from) + 3));
const t=(k)=>k;
let p=0,f=0;
const ck=(l,a,e)=>{const A=JSON.stringify(a),E=JSON.stringify(e);
  if(A===E){p++;console.log("PASS  "+l);}else{f++;console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`);}};

const EARLY=["scout_chip_early1","scout_chip_early2","scout_chip_early3","scout_chip_early4"];
const CONFIRM=["scout_chip_confirm1","scout_chip_confirm2","scout_chip_early3","scout_chip_early4"];
const PLAN=["scout_chip1","scout_chip2","scout_chip3","scout_chip4"];
const NP=["scout_np_chip1","scout_np_chip2","scout_np_chip3","scout_np_chip4"];

ck("NEW gets discovery chips, not planning chips", chipsFor(t,true,0), EARLY);
ck("TRIAGE gets discovery chips", chipsFor(t,true,1), EARLY);
ck("PROFILE_READY leads with confirm/correct", chipsFor(t,true,2), CONFIRM);
ck("ASSESSED unlocks the planning chips", chipsFor(t,true,3), PLAN);
ck("GUIDED keeps them", chipsFor(t,true,4), PLAN);
ck("DEVELOPING keeps them", chipsFor(t,true,5), PLAN);

console.log("\n-- the unknown-state case is the one that can embarrass us --");
ck("null state defaults to discovery, never to a promise Scout can't keep", chipsFor(t,true,null), EARLY);
ck("undefined behaves the same", chipsFor(t,true,undefined), EARLY);
ck("a junk string does not fall through to planning", chipsFor(t,true,"3"), EARLY);

console.log("\n-- non-players are untouched at every state --");
for (const st of [0,1,2,3,4,5,null]) ck(`non-player @ ${st}`, chipsFor(t,false,st), NP);

console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
