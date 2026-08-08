// Multi-block text replies must reassemble byte-exact. Uses the real
// replyTextOf from api/scout.js.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const src = fs.readFileSync(REPO + "/api/scout.js", "utf8");
eval(src.slice(src.indexOf("function replyTextOf"), src.indexOf("function sumUsage")));
let p=0,f=0;
const ck=(l,a,e)=>{const A=JSON.stringify(a),E=JSON.stringify(e);
  if(A===E){p++;console.log("PASS  "+l);}else{f++;console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`);}};
const B=(...t)=>({content:t.map(x=>({type:"text",text:x}))});

ck("split mid-string reassembles exactly",
   replyTextOf(B('{"reply":"opens in late ','November."}')), '{"reply":"opens in late November."}');
ck("split mid-string yields valid JSON",
   JSON.parse(replyTextOf(B('{"reply":"opens in late ','November.","memory_writes":[]}'))).reply, "opens in late November.");
ck("split mid-WORD reassembles without a gap",
   replyTextOf(B('{"reply":"unrecover','able"}')), '{"reply":"unrecoverable"}');
ck("real newlines inside the model output are preserved",
   JSON.parse(replyTextOf(B('{"reply":"line one\\nline two"}'))).reply, "line one\nline two");
ck("tool-use blocks between text blocks are skipped, text still contiguous",
   replyTextOf({content:[{type:"text",text:'{"reply":"a'},{type:"web_search_tool_result",content:[]},{type:"text",text:'b"}'}]}),
   '{"reply":"ab"}');
ck("single block unchanged", replyTextOf(B('{"reply":"hi"}')), '{"reply":"hi"}');
ck("no text blocks yields empty string", replyTextOf({content:[{type:"server_tool_use"}]}), "");
ck("13-block reply (the shape seen in production) parses",
   typeof JSON.parse(replyTextOf(B('{"rep','ly":"a','b','c','d','e','f','g','h','i','j','k","memory_writes":[]}'))).reply, "string");
console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
