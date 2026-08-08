// State machine + weighted readiness. Real functions from api/scout.js.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const src = fs.readFileSync(REPO + "/api/scout.js", "utf8");
eval(src.slice(src.indexOf("const CRITICAL_FIELDS = ["), src.indexOf("async function buildAuthoritativeContext")));
let p=0,f=0;
const ck=(l,a,e)=>{const A=JSON.stringify(a),E=JSON.stringify(e);
  if(A===E){p++;console.log("PASS  "+l);}else{f++;console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`);}};

const EMPTY = {};
const FULL = { sport:"Soccer", position:"Right Back", club_name:"Tusculum", recruiting_status:"Open to offers",
  dob:"2005-03-01", current_city:"Greeneville", country:"USA", home_city:"Montreal", home_country:"Canada",
  previous_clubs:[{name:"Lakeshore FC"}], grad_year:2026, height_cm:178, weight_kg:75, citizenship:"Canada" };

ck("empty athlete scores 0", scoutReadiness(EMPTY, false).score, 0);
ck("full athlete + goal scores 100", scoutReadiness(FULL, true).score, 100);
ck("full athlete WITHOUT a goal cannot be ready", scoutReadiness(FULL, false).ready, false);
ck("goal alone is worth 15", scoutReadiness(EMPTY, true).score, 15);
ck("missing critical fields are named", scoutReadiness({sport:"Soccer"}, false).missingCritical.includes("position"), true);
ck("full + goal is ready", scoutReadiness(FULL, true).ready, true);

console.log("\n-- states --");
ck("no sport -> 0 NEW", deriveScoutState(EMPTY, scoutReadiness(EMPTY,false), {}, {}), 0);
ck("sport but not ready -> 1 TRIAGE", deriveScoutState({sport:"Soccer"}, scoutReadiness({sport:"Soccer"},false), {}, {}), 1);
ck("ready but unconfirmed -> 2 PROFILE_READY", deriveScoutState(FULL, scoutReadiness(FULL,true), {}, {}), 2);
ck("confirmed -> 3 ASSESSED", deriveScoutState(FULL, scoutReadiness(FULL,true), {profileConfirmedAt:"2026-01-01"}, {}), 3);
ck("existing athlete with a pathway resumes at 4, never re-onboarded",
   deriveScoutState(EMPTY, scoutReadiness(EMPTY,false), {}, {pathwayCreated:true}), 4);
ck("pathway + baseline -> 5 DEVELOPING",
   deriveScoutState(EMPTY, scoutReadiness(EMPTY,false), {}, {pathwayCreated:true, baselineComplete:true}), 5);

console.log("\n-- the directive is what stops premature planning --");
const d1 = stateDirective(1, scoutReadiness({sport:"Soccer"}, false));
ck("triage forbids a personalised roadmap", /Do NOT yet produce a definitive personalised career roadmap/.test(d1), true);
ck("triage still allows general help", /explain leagues, NCAA/.test(d1), true);
ck("triage names the next highest-value gap", /HIGHEST-VALUE THING YOU STILL DON'T KNOW/.test(d1), true);
ck("triage forbids sounding like a paywall", /Never sound like a paywall/.test(d1), true);
ck("state 2 asks for confirmation once", /confirm or correct it/.test(stateDirective(2, scoutReadiness(FULL,true))), true);
ck("guided state adds NO restriction", stateDirective(4, scoutReadiness(FULL,true)), "");
ck("missing goal is surfaced as the gap when criticals are done",
   /their goal/.test(stateDirective(1, scoutReadiness(FULL, false))), true);

console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
