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


// TOOL-USE SCRATCHPAD (production, 2026-08-11). Five web searches, the model
// ran out of output budget before writing the envelope, and the joined
// between-search commentary was shipped to a real athlete — in the third
// person. Commentary between tool calls is never the answer; null puts the
// client on its honest retry path instead.
const T = (...blocks) => ({ content: blocks });
const txt = (t) => ({ type: "text", text: t });
const toolUse = { type: "server_tool_use", id: "x", name: "web_search", input: {} };
const toolRes = { type: "web_search_tool_result", tool_use_id: "x", content: [] };
ck("tool-use scratchpad with no envelope yields null, never the scratchpad",
   deriveReplyText(T(toolUse, toolRes, txt("Good, that confirms the U-21 cutoff detail I need to flag."), toolUse, toolRes, txt("Now I'll write the answer."))) === null);
ck("a tool-use reply that DID produce an envelope is still extracted",
   deriveReplyText(T(toolUse, toolRes, txt("Let me check that."), txt('{"reply":"The window opens May 1.","memory_writes":[]}'))) === "The window opens May 1.");
ck("tool-use envelope split across blocks still reassembles",
   deriveReplyText(T(toolUse, toolRes, txt('{"reply":"opens in late '), txt('November.","memory_writes":[]}'))) === "opens in late November.");
ck("plain prose with NO tool blocks still passes through (unchanged)",
   deriveReplyText(B("Noted on the ankle. What is your plan for minutes?")).startsWith("Noted on the ankle"));

console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
