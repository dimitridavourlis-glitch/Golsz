// Scout may not attach a level to an organisation it did not verify.
//
// THE FAILURE THIS GUARDS (2026-08-11, production)
// The athlete said "I just finished Tusculum University" — a statement, not a
// question. Scout replied "So you just graduated from Tusculum University
// (NCAA Division III)." Tusculum is Division II. The athlete never asked.
//
// Every existing guardrail is built around QUESTIONS: classifyIntent()
// classifies what a message ASKS, needs_tool fires on lookup-shaped
// questions, WHEN TO SEARCH lists things to search when you need them to
// ANSWER. The classifier even had the right rule, and it was question-shaped,
// so it could not fire on a statement. The hallucination did not arrive
// through an answer. It arrived through a parenthetical.
//
// "Make it admit uncertainty" would not have helped: a small Presbyterian
// college in Tennessee is an extremely strong D3 prior, and the model was not
// uncertain — it was confidently wrong. So the rule keys off the SHAPE OF THE
// CLAIM, not the model's felt confidence, and is written as an output-shape
// ban ("never attach a level to a named organisation unless verified") rather
// than an epistemic nudge ("be careful"). One is checkable. The other is not.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// Extract SYSTEM_PROMPT with the guard that caught the dead-anchor bug: an
// indexOf miss returning -1 silently produced slice(-1, n) garbage, and ~24
// assertions were evaluating against nothing while reporting PASS.
const PROMPT_OPEN = "const SYSTEM_PROMPT = `";
const _ps = SCOUT.indexOf(PROMPT_OPEN) + PROMPT_OPEN.length;
let _pe = _ps;
while (_pe < SCOUT.length) { if (SCOUT[_pe] === "`" && SCOUT[_pe - 1] !== "\\") break; _pe++; }
const PROMPT = SCOUT.slice(_ps, _pe);
if (PROMPT.length < 5000) throw new Error("SYSTEM_PROMPT extraction failed");

const CLASSIFIER_OPEN = "const CLASSIFIER_SYSTEM = `";
const _cs = SCOUT.indexOf(CLASSIFIER_OPEN) + CLASSIFIER_OPEN.length;
let _ce = _cs;
while (_ce < SCOUT.length) { if (SCOUT[_ce] === "`" && SCOUT[_ce - 1] !== "\\") break; _ce++; }
const CLASSIFIER = SCOUT.slice(_cs, _ce);
if (CLASSIFIER.length < 2000) throw new Error("CLASSIFIER_SYSTEM extraction failed");

function has(hay, needle, label) {
  const i = hay.indexOf(needle);
  if (i < 0) throw new Error(`dead anchor: ${label} — "${needle.slice(0, 60)}" is no longer present`);
  return true;
}

// ---- the ban exists, and says the checkable thing ------------------------
ck("the prompt bans classifying an organisation from memory",
   has(PROMPT, "NEVER CLASSIFY A REAL ORGANISATION FROM MEMORY", "ban heading"), true);
ck("the banned output shapes are enumerated, not gestured at",
   /division, tier, league, conference, classification, ranking, or standard/.test(PROMPT), true);
for (const escape of ["The athlete told you this conversation.", "It is in their GOLSZ record.", "You searched for it this turn."]) {
  ck(`the only three ways to state a level: "${escape.slice(0, 34)}"`, PROMPT.includes(escape), true);
}
ck("the ban explicitly covers statements, not just questions",
   /This applies to statements, not just questions/.test(PROMPT), true);
ck("the real failing message is named in the prompt",
   PROMPT.includes('"I just finished Tusculum University" is not a request for Tusculum\'s division'), true);
ck("the reason it is damaging is stated: they did not ask",
   /the athlete has no reason to doubt a detail they did not ask for/.test(PROMPT), true);
ck("omitting the level is shown to be a complete answer",
   /is a complete and correct sentence/.test(PROMPT), true);

// ---- the rule keys off claim shape, NOT felt uncertainty ----------------
// This is the load-bearing distinction. A rule that says "say so when unsure"
// cannot fire on a confident hallucination, which is the actual failure mode.
ck("the prompt says being unsure is NOT the trigger",
   /Being unsure is not the trigger/.test(PROMPT), true);
ck("...and names confident wrongness directly",
   /you will often feel certain and be wrong/.test(PROMPT), true);
ck("...and names the shape of the claim as the trigger",
   /The trigger is the shape of the claim/.test(PROMPT), true);
ck("the prompt names where recall is weakest",
   /small colleges, youth leagues, lower divisions, clubs outside the top flight/.test(PROMPT), true);

// ---- corrections ---------------------------------------------------------
ck("the prompt has a WHEN THEY CORRECT YOU section",
   has(PROMPT, "WHEN THEY CORRECT YOU", "correction heading"), true);
ck("a correction is ranked as the most reliable fact available",
   /the most reliable fact you will get all conversation/.test(PROMPT), true);
ck("no apology paragraph is demanded",
   /No apology paragraph, no explaining how it happened/.test(PROMPT), true);
ck("a correction must change the next sentence",
   /A correction that does not change your next sentence has not been taken/.test(PROMPT), true);
ck("a correction must be written to memory at importance 5",
   /write it to memory as USER_STATED, importance 5/.test(PROMPT), true);
ck("...so they never repeat themselves",
   /They should never have to tell you the same thing twice/.test(PROMPT), true);

// ---- the classifier escalates on STATEMENTS, but only when it matters ----
// These assertions originally pinned an UNSCOPED rule: any message naming an
// organisation needed a lookup, statement or question. That was over-
// correction and it cost real latency — needs_tool:true disqualifies the
// Haiku path and bypasses the plan cap, so it forces Sonnet, measured at
// 25-27s against Haiku's 12.7s. Athletes name their club in most messages,
// so ordinary conversation went to the slow path.
//
// The rule is now scoped to statements where the reply actually turns on the
// organisation's level. CORRECTNESS DID NOT MOVE: the guarantee is the
// SYSTEM_PROMPT ban asserted above — never state a level you did not verify.
// With no search, Scout simply omits the division, which is what production
// scenario 1 did correctly ("So you just finished Tusculum", no division, no
// search). Searching was buying a richer answer, not a correct one.
ck("a question about a named organisation still escalates",
   /and asks a factual question about them almost always needs web_lookup/.test(CLASSIFIER), true);
ck("a statement escalates only when the level is load-bearing",
   /needs web_lookup ONLY when the reply genuinely turns on that organisation's level or standing/.test(CLASSIFIER), true);
ck("...a bare mention explicitly does not",
   /does NOT, because the honest reply there simply repeats the name without classifying it/.test(CLASSIFIER), true);
ck("...and the reason is stated, not just the rule",
   /Athletes name their club in most messages/.test(CLASSIFIER), true);
ck("the real failing message is still the worked example",
   CLASSIFIER.includes('"I just finished Tusculum University"'), true);
ck("both production misses are recorded — the hallucination and the over-correction",
   /REAL production miss both ways/.test(CLASSIFIER) && /pushed normal chat onto the ~25s model/.test(CLASSIFIER), true);

// ---- is_correction is part of the classifier contract -------------------
ck("is_correction is in the JSON contract", /"is_correction":true\|false/.test(CLASSIFIER), true);
ck("...and is defined for the model", /disputes, corrects, or contradicts something in the conversation so far/.test(CLASSIFIER), true);
ck("...including a fact Scout itself asserted", /including a fact Scout previously asserted/.test(CLASSIFIER), true);
ck("...and is explicitly never a FAQ match", /never a FAQ match/.test(CLASSIFIER), true);

// ---- nothing that already worked was traded away ------------------------
// The Saint-Laurent correction in the same conversation was handled perfectly.
// These are the guarantees that produced it, plus the safety block.
ck("the health and safety block is intact",
   has(PROMPT, "HEALTH AND SAFETY, EVERY REPLY", "safety heading"), true);
ck("weight-cutting is still banned outright",
   /Never give weight-cutting, dehydration, calorie-restriction, or "making weight" instructions/.test(PROMPT), true);
ck("WHEN TO SEARCH still exists", has(PROMPT, "WHEN TO SEARCH", "search heading"), true);
ck("internal terminology is still never exposed",
   /Never mention internal fields, flags, or JSON keys/.test(PROMPT), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
