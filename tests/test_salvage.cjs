// Truncated-reply salvage. Functions extracted from api/scout.js at run time.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const src = fs.readFileSync(REPO + "/api/scout.js", "utf8");
eval(src.slice(src.indexOf("function salvageJsonValue"), src.indexOf("function extractMemoryWrites")));
let p=0,f=0;
const ck=(l,a,e)=>{const A=JSON.stringify(a),E=JSON.stringify(e);
  if(A===E){p++;console.log("PASS  "+l);}else{f++;console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`);}};

// The real shape from production: severed inside research_note.summary.
const T = `{"reply":"Noted — targeting a move next season.","memory_writes":[{"type":"DECISION","subject":"stay or go","content":"Targeting a move for next season","source":"athlete_stated","confidence":0.9,"importance":4}],"research_note":{"summary":"NCAA Division I men's and women's soccer have two transf`;

ck("reply recovered from a truncated object", salvageJsonValue(T,"reply"), "Noted — targeting a move next season.");
ck("memory_writes recovered whole", salvageJsonValue(T,"memory_writes").length, 1);
ck("memory_writes content intact", salvageJsonValue(T,"memory_writes")[0].subject, "stay or go");
ck("severed research_note stays unrecoverable", salvageJsonValue(T,"research_note"), undefined);
ck("absent key yields undefined", salvageJsonValue(T,"drafted_email"), undefined);

const full = parseReplyObject ? null : null; // parseReplyObject lives below the eval slice
ck("brackets inside a string do not terminate early",
   salvageJsonValue(`{"memory_writes":[{"c":"a ] b } c"}]}`,"memory_writes")[0].c, "a ] b } c");
ck("escaped quote inside a string is handled",
   salvageJsonValue(`{"reply":"he said \\"go\\" then left"}`,"reply"), 'he said "go" then left');
ck("severed string yields undefined, not a partial",
   salvageJsonValue(`{"reply":"this got cut off mid`,"reply"), undefined);
ck("nested objects counted correctly",
   salvageJsonValue(`{"suggested_pathway":{"a":{"b":{"c":1}}},"x":2}`,"suggested_pathway").a.b.c, 1);
ck("key appearing inside a VALUE is not matched first",
   salvageJsonValue(`{"reply":"talk about memory_writes later","memory_writes":[{"t":1}]}`,"memory_writes").length, 1);
ck("empty array recovered as empty, not undefined",
   salvageJsonValue(`{"memory_writes":[]}`,"memory_writes"), []);
ck("whitespace after the colon tolerated",
   salvageJsonValue(`{"reply"  :   "spaced"}`,"reply"), "spaced");

console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
