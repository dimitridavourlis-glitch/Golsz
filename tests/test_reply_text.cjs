// The athlete must never see the JSON envelope. Uses the real deriveReplyText.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const src = fs.readFileSync(REPO + "/api/scout.js", "utf8");
eval(src.slice(src.indexOf("function salvageJsonValue"), src.indexOf("function extractMemoryWrites")));
const B = (...t) => ({ content: t.map(x => ({ type: "text", text: x })) });
let p=0,f=0;
const ck=(l,c)=>{if(c){p++;console.log("PASS  "+l);}else{f++;console.log("FAIL  "+l);}};
const clean = (r) => r !== null && !r.includes('"reply"') && !/^\s*[{[]/.test(r) && !r.includes('"confidence"');

ck("normal reply extracted",
   deriveReplyText(B('{"reply":"Here is the plan.","memory_writes":[]}')) === "Here is the plan.");

// THE SCREENSHOT CASE: prose preamble before the {, which defeated the client.
const withPreamble = 'Let me look that up for you.\n\n{"reply":"CPL U21 roster rules: domestic U21 players do not count toward the salary budget.","research_note":{"confidence":0.95,"valid_days":365},"profile_updates":null,"suggested_dev_items":[{"focus_area":"playing time"}]}';
ck("preamble before { — reply extracted, envelope NOT shown",
   deriveReplyText(B(withPreamble)).startsWith("CPL U21 roster rules") && clean(deriveReplyText(B(withPreamble))));

// Truncated mid-object (the max_tokens case)
ck("truncated object still yields clean reply",
   clean(deriveReplyText(B('{"reply":"The window opens May 1.","research_note":{"summary":"NCAA men'))));

// Multi-block web-search reply split mid-string
ck("multi-block split reassembles then extracts",
   deriveReplyText(B('{"reply":"opens in late ','November.","memory_writes":[]}')) === "opens in late November.");

// No reply key at all, but real prose before the JSON
ck("prose kept when there is no reply key",
   deriveReplyText(B('Here is what I found about the window.\n\n{"memory_writes":[]}')).startsWith("Here is what I found"));

// Pure prose (no JSON) — the old broken-output mode
ck("pure prose passes through",
   deriveReplyText(B('Noted on the ankle. What is your plan for minutes?')).startsWith("Noted on the ankle"));

// Unrecoverable garbage -> null, so the client shows honest copy, not braces
ck("unrecoverable JSON yields null (client shows a real message)",
   deriveReplyText(B('{"memory_writes":[{"a":1}]}')) === null);
ck("empty content yields null", deriveReplyText({content:[]}) === null);

// Regression guard: nothing returned may ever look like an envelope
const cases = [withPreamble, '{"reply":"x","a":1}', 'prose only', '{"reply":"y"', 'Look:\n{"reply":"z"}'];
ck("NO case ever returns something containing \"reply\": or leading brace",
   cases.every(c => { const r = deriveReplyText(B(c)); return r === null || clean(r); }));

console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
