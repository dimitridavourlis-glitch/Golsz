// Non-negotiable health rules in the Scout system prompt.
//
// These were dropped in the 2026-08-11 prompt rewrite and restored on the
// owner's instruction. They are guarded here on their own rather than inside
// a style suite, because they are the rules with a real-world floor under
// them: GOLSZ serves minors, and unsafe weight cuts, premature return to
// play and unsupervised supplementation are documented harms in youth sport.
//
// A future prompt rewrite that drops them again fails this file.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const a = SCOUT.indexOf("const SYSTEM_PROMPT = `") + "const SYSTEM_PROMPT = `".length;
let b = a; while (b < SCOUT.length) { if (SCOUT[b] === "`" && SCOUT[b - 1] !== "\\") break; b++; }
const P = SCOUT.slice(a, b);

let p = 0, f = 0;
const ck = (l, c) => { if (c) { p++; console.log("PASS  " + l); } else { f++; console.log("FAIL  " + l); } };

// ---- weight ---------------------------------------------------------------
ck("weight-cutting instructions refused", /weight-cutting/i.test(P));
ck("dehydration refused", /dehydration/i.test(P));
ck("calorie restriction refused", /calorie-restriction|calorie restriction/i.test(P));
ck('"making weight" refused', /making weight/i.test(P));
ck("...and the loopholes are closed too (no plan, no shortcut, no 'what some athletes do')",
   /not a plan, not a shortcut, not "what some athletes do\.?"/i.test(P));

// ---- return to play -------------------------------------------------------
ck("return-to-play timelines refused", /return-to-play timelines/i.test(P));
ck("...and clearance with them", /clearance/i.test(P));

// ---- medication and supplements ------------------------------------------
ck("individual medication advice refused", /medication/i.test(P));
ck("supplement counselling refused", /supplements/i.test(P));
ck("...covering recommend, dose AND counsel", /recommend, dose, or counsel/i.test(P));

// ---- the reason, and the redirect ----------------------------------------
ck("the minor-safety rationale is stated, not just the rule", /minors/i.test(P) && /documented harms in youth sport/i.test(P));
ck("a real professional is named instead", /registered dietitian/i.test(P) && /physician/i.test(P));
ck("the redirect is one sentence, then Scout keeps helping",
   /in one natural sentence and move on, then help with what's left/i.test(P));

// ---- scope ----------------------------------------------------------------
// The old prompt's failure mode was a boundary that only applied on the
// physio route. This must bind everywhere, however the question is framed.
ck("it is its own top-level section, not buried in a persona branch",
   /HEALTH AND SAFETY, EVERY REPLY/.test(P));
ck("it binds on every reply", /This applies to every reply/i.test(P));
ck("...to every athlete", /to every athlete/i.test(P));
ck("...regardless of who is asking", /whoever you are talking to/i.test(P));
ck("...and regardless of framing", /however the question is framed/i.test(P));

// ---- it must sit ABOVE the sport/style sections so it is not read as advice
ck("it precedes SPORTS KNOWLEDGE", P.indexOf("HEALTH AND SAFETY") < P.indexOf("SPORTS KNOWLEDGE"));

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
