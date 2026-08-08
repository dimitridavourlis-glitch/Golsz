// §21B/21D/21E — three-way capability rendering. Real code from api/scout.js.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const src = fs.readFileSync(REPO + "/api/scout.js", "utf8");
// One contiguous slice from RETRIEVAL_BUDGET through the end of
// renderCapabilities, so clampBlock and PLAN_RANK come along in scope.
const from = src.indexOf("const RETRIEVAL_BUDGET");
const to = src.indexOf("\n}\n", src.indexOf("function renderCapabilities(")) + 3;
eval(src.slice(from, to));

let p=0,f=0;
const ck=(l,a,e)=>{const A=JSON.stringify(a),E=JSON.stringify(e);
  if(A===E){p++;console.log("PASS  "+l);}else{f++;console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`);}};

const ROWS = [
  { key:"faq", label:"Answer questions about pathways", available:true, plan_min:null, min_scout_state:0, requires_profile_ready:false, requires_fields:[] },
  { key:"pathway_plan", label:"Build a personalised pathway plan", available:true, plan_min:"starter", min_scout_state:3, requires_profile_ready:true, requires_fields:[] },
  { key:"targets", label:"Build a target school list", available:true, plan_min:"pro", min_scout_state:3, requires_profile_ready:true, requires_fields:[] },
  { key:"development_plan", label:"Build a development programme", available:true, plan_min:"starter", min_scout_state:3, requires_profile_ready:true, requires_fields:[], safety_note:"Never diagnose or prescribe rehabilitation." },
  { key:"agent_intro", label:"Introduce you to agents", available:false, plan_min:null, min_scout_state:0, requires_profile_ready:false, requires_fields:[] },
];
const NOW="RIGHT NOW", DATA="REAL, AND THEY ALREADY QUALIFY", PLAN="REAL, but on a higher plan", GONE="NOT part of GOLSZ";
const has=(txt,section,label)=>{
  const i=txt.indexOf(section); if(i<0) return false;
  const next=[NOW,DATA,PLAN,GONE].map(h=>txt.indexOf(h,i+5)).filter(x=>x>0);
  const end=next.length?Math.min(...next):txt.length;
  return txt.slice(i,end).includes(label);
};

console.log("-- a brand-new free athlete --");
let t1 = renderCapabilities(ROWS, { entitlementPlan:"free", scoutState:0, profileReady:false, athlete:{} });
ck("general help is available now", has(t1,NOW,"Answer questions"), true);
ck("pathway plan is a DATA gap, not a paywall", has(t1,DATA,"personalised pathway plan"), true);
ck("target list is also a data gap first, though it is ALSO plan-locked", has(t1,DATA,"target school list"), true);
ck("nothing is presented as plan-locked yet", t1.includes(PLAN), false);
ck("agent intros are still correctly disowned", has(t1,GONE,"Introduce you to agents"), true);
ck("Scout is told not to call these locked", /Never present these as locked/.test(t1), true);

console.log("\n-- same athlete, now ASSESSED (state 3, ready) --");
let t2 = renderCapabilities(ROWS, { entitlementPlan:"free", scoutState:3, profileReady:true, athlete:{} });
ck("pathway plan becomes a genuine upgrade case", has(t2,PLAN,"personalised pathway plan"), true);
ck("target list is an upgrade case too", has(t2,PLAN,"target school list"), true);
ck("no data gap remains", t2.includes(DATA), false);
ck("Scout is told to only point upward", /Only ever point upward/.test(t2), true);

console.log("\n-- a trialling athlete is Basic, not free --");
let t3 = renderCapabilities(ROWS, { entitlementPlan:"starter", scoutState:3, profileReady:true, athlete:{} });
ck("pathway plan is available now during the trial", has(t3,NOW,"personalised pathway plan"), true);
ck("development programme too", has(t3,NOW,"development programme"), true);
ck("target list still needs Pro", has(t3,PLAN,"target school list"), true);

console.log("\n-- elite sees everything real --");
let t4 = renderCapabilities(ROWS, { entitlementPlan:"elite", scoutState:3, profileReady:true, athlete:{} });
ck("no plan-locked section at all", t4.includes(PLAN), false);
ck("agent intros are STILL not real, whatever they pay", has(t4,GONE,"Introduce you to agents"), true);

console.log("\n-- requires_fields names the actual gap --");
const RF = [{ key:"x", label:"Compare you to committed players", available:true, plan_min:null, min_scout_state:0, requires_profile_ready:false, requires_fields:["position","grad_year"] }];
ck("missing fields are named", /still need: position, grad_year/.test(renderCapabilities(RF,{entitlementPlan:"free",scoutState:3,profileReady:true,athlete:{}})), true);
ck("present fields drop out of the list",
   /still need: grad_year/.test(renderCapabilities(RF,{entitlementPlan:"free",scoutState:3,profileReady:true,athlete:{position:"RB"}})), true);
ck("all fields present -> available now",
   has(renderCapabilities(RF,{entitlementPlan:"free",scoutState:3,profileReady:true,athlete:{position:"RB",grad_year:2026}}),NOW,"Compare you"), true);
ck("empty string counts as missing, not present",
   /still need: position/.test(renderCapabilities(RF,{entitlementPlan:"free",scoutState:3,profileReady:true,athlete:{position:""}})), true);

console.log("\n-- REGRESSION: an established athlete must never be re-gated --");
// Production, 2026-08-08: a starter-plan athlete at state 4 with a pathway
// already built had readiness 61% (missing age). requires_profile_ready
// pushed pathway/targets/dev plan into the data bucket and Scout started
// answering "I need to know more about you first" to questions it could
// already answer. State is the authority; the score is not.
const GUIDED = renderCapabilities(ROWS, { entitlementPlan:"starter", scoutState:4, profileReady:false, athlete:{} });
ck("state 4 + low score: pathway plan is AVAILABLE, not a data gap", has(GUIDED,NOW,"personalised pathway plan"), true);
ck("state 4 + low score: development programme available", has(GUIDED,NOW,"development programme"), true);
ck("state 4 + low score: nothing sits in the data bucket", GUIDED.includes(DATA), false);
ck("state 5 likewise", renderCapabilities(ROWS,{entitlementPlan:"starter",scoutState:5,profileReady:false,athlete:{}}).includes(DATA), false);
ck("state 3 likewise, the moment they confirm", renderCapabilities(ROWS,{entitlementPlan:"starter",scoutState:3,profileReady:false,athlete:{}}).includes(DATA), false);
ck("but state 1 with a low score IS still a data gap",
   has(renderCapabilities(ROWS,{entitlementPlan:"starter",scoutState:1,profileReady:false,athlete:{}}),DATA,"personalised pathway plan"), true);
ck("plan gating still applies to an established athlete",
   has(renderCapabilities(ROWS,{entitlementPlan:"starter",scoutState:4,profileReady:false,athlete:{}}),PLAN,"target school list"), true);
ck("requires_fields still bites regardless of state — a named missing field is not the same as a score",
   /still need: grad_year/.test(renderCapabilities(
     [{key:"x",label:"Compare you",available:true,plan_min:null,min_scout_state:0,requires_profile_ready:false,requires_fields:["grad_year"]}],
     {entitlementPlan:"starter",scoutState:4,profileReady:false,athlete:{}})), true);

console.log("\n-- misc --");
ck("safety notes ride along with the capability", renderCapabilities(ROWS,{entitlementPlan:"starter",scoutState:3,profileReady:true,athlete:{}}).includes("[SAFETY: Never diagnose"), true);
ck("no rows -> empty string, not a heading", renderCapabilities([], {}), "");
ck("null rows -> empty string", renderCapabilities(null, {}), "");
ck("an unknown plan_min ranks as free, never above the athlete",
   has(renderCapabilities([{key:"z",label:"Thing",available:true,plan_min:"platinum",min_scout_state:0,requires_profile_ready:false,requires_fields:[]}],
     {entitlementPlan:"free",scoutState:0,profileReady:false,athlete:{}}),NOW,"Thing"), true);
ck("output respects the 1400-char retrieval budget", renderCapabilities(ROWS,{entitlementPlan:"free",scoutState:0,profileReady:false,athlete:{}}).length <= 1400, true);

console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
