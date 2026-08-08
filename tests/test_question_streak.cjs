// A single closing question is normal conversation and must survive.
// Only back-to-back ones get trimmed. Real functions from api/scout.js.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const src = fs.readFileSync(REPO + "/api/scout.js", "utf8");
eval(src.slice(src.indexOf("function endsWithQuestion"), src.indexOf("function extractMemoryWrites")));
let p=0,f=0;
const ck=(l,c)=>{if(c){p++;console.log("PASS  "+l);}else{f++;console.log("FAIL  "+l);}};
const A = (t) => ({ role: "assistant", content: t });
const U = (t) => ({ role: "user", content: t });

const withQ = "Transfer is the right call. U Sports gives you the draft and the U-21 cap benefit, which the free-agent route doesn't. What's your read on your minutes right now?";
const noQ  = "Transfer is the right call. U Sports gives you the draft and the U-21 cap benefit, which the free-agent route doesn't. Start with Concordia and Laval.";

ck("first question in a while is KEPT",
   softenQuestionStreak(withQ, [A("Here's the plan. Start this week."), U("ok")]) === withQ);
ck("back-to-back question is trimmed",
   softenQuestionStreak(withQ, [A("So what's stopping you?"), U("not sure")]) !== withQ);
ck("trimmed version keeps the substance and drops only the question",
   !/minutes right now\?/.test(softenQuestionStreak(withQ, [A("So what's stopping you?")])) &&
   /U-21 cap benefit/.test(softenQuestionStreak(withQ, [A("So what's stopping you?")])));
ck("a reply with NO question is untouched",
   softenQuestionStreak(noQ, [A("And what do you think?")]) === noQ);
ck("no prior assistant turn -> keep the question",
   softenQuestionStreak(withQ, [U("hi")]) === withQ);
ck("empty conversation -> keep",  softenQuestionStreak(withQ, []) === withQ);
ck("single-sentence question is never gutted",
   softenQuestionStreak("What's stopping you?", [A("And why is that?")]) === "What's stopping you?");
ck("would-be-stub reply keeps its question rather than being truncated",
   softenQuestionStreak("Got it. Why?", [A("Really?")]) === "Got it. Why?");
ck("two trailing questions both dropped",
   !/\?/.test(softenQuestionStreak(
     "Transfer is the right call and U Sports gives you the draft plus the cap benefit. Does that land? Or are you leaning the other way?",
     [A("What do you think?")])));
ck("question mark inside quotes at the end still detected",
   endsWithQuestion('So the real question is "do I get minutes?"'));
ck("statement is not treated as a question", endsWithQuestion("Start with Concordia.") === false);

console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
