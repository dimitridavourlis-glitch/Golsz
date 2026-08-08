// State 2->3 confirmation gate + boolean salvage. Real code from api/scout.js.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const src = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const cut = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
eval(cut("function salvageJsonValue(", "function deriveReplyText("));
eval(cut("async function recordProfileConfirmation(", "async function buildAuthoritativeContext("));

let p=0,f=0;
const ck=(l,a,e)=>{const A=JSON.stringify(a),E=JSON.stringify(e);
  if(A===E){p++;console.log("PASS  "+l);}else{f++;console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`);}};

// no env -> the write can never happen, so these prove the GATE, not the write
delete process.env.SUPABASE_SERVICE_KEY;
const reply = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
const run = (state, obj) => recordProfileConfirmation("u1", state, reply(obj));

console.log("-- boolean salvage (was silently unrecoverable) --");
ck("salvages true",  salvageJsonValue('{"a":1,"profile_confirmed":true,"b":2}', "profile_confirmed"), true);
ck("salvages false", salvageJsonValue('{"profile_confirmed":false}', "profile_confirmed"), false);
ck("salvages a number", salvageJsonValue('{"confidence":0.82}', "confidence"), 0.82);
ck("still salvages strings", salvageJsonValue('{"reply":"hi there"}', "reply"), "hi there");
ck("still salvages arrays", salvageJsonValue('{"m":[1,2]}', "m"), [1,2]);
ck("absent key stays undefined", salvageJsonValue('{"x":1}', "profile_confirmed"), undefined);
ck("truncated boolean is not guessed", salvageJsonValue('{"profile_confirmed":tr', "profile_confirmed"), undefined);

(async () => {
  console.log("\n-- the gate: only state 2 can advance, and only with real consent --");
  ck("TRIAGE cannot be skipped by claiming confirmation", await run(1, {profile_confirmed:true}), false);
  ck("NEW cannot be skipped either", await run(0, {profile_confirmed:true}), false);
  ck("an already-ASSESSED athlete is not re-confirmed", await run(3, {profile_confirmed:true}), false);
  ck("GUIDED is untouched", await run(4, {profile_confirmed:true}), false);
  ck("state 2 without the flag does not advance", await run(2, {reply:"here is my read on you"}), false);
  ck("state 2 with false does not advance", await run(2, {profile_confirmed:false}), false);
  ck("null (model's default) does not advance", await run(2, {profile_confirmed:null}), false);
  ck("prose-only reply does not advance", await recordProfileConfirmation("u1", 2, {content:[{type:"text",text:"Yes that's right!"}]}), false);
  ck("no user id, no write", await recordProfileConfirmation(null, 2, reply({profile_confirmed:true})), false);
  ck("empty response is safe", await recordProfileConfirmation("u1", 2, {}), false);
  ck("missing env is safe (reaches the write, has no key)", await run(2, {profile_confirmed:true}), false);
  console.log(`\n${p}/${p+f} passed`); process.exit(f?1:0);
})();
