// Reproduces the classifier parse bug and verifies the fix.
function parseOld(text) {           // stopSequences:["}"] + append "}"
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "") + "}";
  try { return JSON.parse(cleaned); } catch { return { raw: text }; }
}
function parseNew(text) {           // no stop sequence, outermost {...}
  const cleaned = text.replace(/```json|```/g, "").trim();
  const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
  if (s < 0 || e <= s) return { raw: text };
  try { return JSON.parse(cleaned.slice(s, e + 1)); } catch { return { raw: text }; }
}
// EXACT shape production produced, truncated by the stop sequence at `params`:
const truncated = '```json\n{\n "intent": "web_lookup",\n "confidence": 0.88,\n "needs_tool": true,\n "faq_id": null,\n "summary_so_far": "3-year strategy",\n "missing_information": [],\n "recommended_specialist": null,\n "conversation_stage": "discovery",\n "next_best_action": {\n  "type": "none",\n  "label": "",\n  "params": {';
// What the model emits with no stop sequence (complete), possibly with chatter:
const full = '```json\n{"intent":"web_lookup","confidence":0.88,"needs_tool":true,"faq_id":null,"summary_so_far":"3-year strategy","missing_information":[],"recommended_specialist":null,"conversation_stage":"discovery","next_best_action":{"type":"none","label":"","params":{}}}\n```';
const withChatter = full + "\n\nI can help you draft that email too!";
let p=0,f=0;
const ck=(l,a,e)=>{ if(JSON.stringify(a)===JSON.stringify(e)){p++;console.log("PASS  "+l);}else{f++;console.log(`FAIL  ${l}\n   exp ${JSON.stringify(e)}\n   got ${JSON.stringify(a)}`);} };
ck("OLD parser drops needs_tool on the real truncated payload", parseOld(truncated).needs_tool, undefined);
ck("OLD parser returns a raw fallback (everything lost)", "raw" in parseOld(truncated), true);
ck("NEW parser recovers needs_tool from complete JSON", parseNew(full).needs_tool, true);
ck("NEW parser recovers intent", parseNew(full).intent, "web_lookup");
ck("NEW parser recovers summary_so_far", parseNew(full).summary_so_far, "3-year strategy");
ck("NEW parser keeps nested next_best_action intact", parseNew(full).next_best_action, {type:"none",label:"",params:{}});
ck("NEW parser survives trailing chatter", parseNew(withChatter).intent, "web_lookup");
ck("NEW parser still falls back on genuine garbage", "raw" in parseNew("sorry, I can't do that"), true);
ck("NEW parser falls back on the truncated payload rather than mis-parsing", "raw" in parseNew(truncated), true);
console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
