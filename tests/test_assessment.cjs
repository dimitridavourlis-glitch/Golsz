// Assessment extraction: bounds, rejection of empties, and the once-only rule.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const src = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const cut = (a,b) => src.slice(src.indexOf(a), src.indexOf(b));
eval(cut("function salvageJsonValue(", "function deriveReplyText("));
eval(cut("function extractAssessment(data)", "async function persistAssessment("));

let p=0,f=0;
const ck=(l,a,e)=>{const A=JSON.stringify(a),E=JSON.stringify(e);
  if(A===E){p++;console.log("PASS  "+l);}else{f++;console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`);}};
const reply=(o)=>({content:[{type:"text",text:JSON.stringify(o)}]});

const GOOD = { strengths:["Reads the game early","Two-footed"], gaps:["Aerial duels","Needs 90-minute fitness"],
               realistic_level:"NCAA D2 within 18 months", focus_next_90_days:"Strength base and highlight film" };

const a = extractAssessment(reply({reply:"here's my read", assessment: GOOD}));
ck("strengths come through", a.strengths, GOOD.strengths);
ck("gaps come through", a.gaps, GOOD.gaps);
ck("realistic level comes through", a.realistic_level, GOOD.realistic_level);
ck("90-day focus comes through", a.focus_next_90_days, GOOD.focus_next_90_days);
ck("it is stamped, so drift is visible later", typeof a.created_at === "string", true);

console.log("\n-- bounds: this ends up in EVERY later prompt, so it must not run away --");
const big = extractAssessment(reply({assessment:{strengths:Array(20).fill("s"), gaps:Array(20).fill("g"),
  realistic_level:"x".repeat(500), focus_next_90_days:"y".repeat(500)}}));
ck("strengths capped at 5", big.strengths.length, 5);
ck("gaps capped at 5", big.gaps.length, 5);
ck("realistic_level capped at 300", big.realistic_level.length, 300);
ck("focus capped at 300", big.focus_next_90_days.length, 300);
const longitem = extractAssessment(reply({assessment:{strengths:["z".repeat(400)], realistic_level:"ok"}}));
ck("each list item capped at 200", longitem.strengths[0].length, 200);

console.log("\n-- an empty assessment is not an assessment --");
ck("no assessment key -> null", extractAssessment(reply({reply:"hi"})), null);
ck("null assessment -> null", extractAssessment(reply({assessment:null})), null);
ck("empty object -> null", extractAssessment(reply({assessment:{}})), null);
ck("empty lists and no level -> null", extractAssessment(reply({assessment:{strengths:[],gaps:[]}})), null);
ck("whitespace-only strings are dropped", extractAssessment(reply({assessment:{strengths:["  ","\t"],gaps:[]}})), null);
ck("an array is not an object -> null", extractAssessment(reply({assessment:["a"]})), null);
ck("a string is not an object -> null", extractAssessment(reply({assessment:"great player"})), null);
ck("only a level is still enough to store", !!extractAssessment(reply({assessment:{realistic_level:"NAIA"}})), true);
ck("only gaps is enough to store", !!extractAssessment(reply({assessment:{gaps:["fitness"]}})), true);
ck("non-string list entries are filtered out",
   extractAssessment(reply({assessment:{strengths:[1,{a:1},"real one",null]}})).strengths, ["real one"]);
ck("prose-only reply -> null", extractAssessment({content:[{type:"text",text:"You're a good player."}]}), null);
ck("empty response -> null", extractAssessment({}), null);

console.log("\n-- write-once, and read back into later prompts --");
ck("PATCH is guarded so the first assessment wins",
   src.includes("scout_assessment=is.null"), true);
ck("only requested when state >= 3 and none stored",
   src.includes("if (scoutState >= 3 && !storedAssessment) {"), true);
ck("a stored assessment is fed back into the prompt",
   src.includes("YOUR EARLIER ASSESSMENT OF THIS ATHLETE"), true);
ck("Scout is told to say so plainly if evidence changes it",
   /say so plainly if new evidence changes it/.test(src), true);

console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
