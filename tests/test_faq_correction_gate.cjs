// The FAQ short-circuit must never answer a CORRECTION.
//
// THE FAILURE THIS GUARDS (2026-08-11, production)
//   athlete: "I just finished Tusculum University"
//   Scout:   "So you just graduated from Tusculum University (NCAA Division III)."
//   athlete: "Tusculum university is a D2"
//   Scout:   [migration 042's generic D1/D2/D3/NAIA explainer, verbatim]
//
// Tusculum is NCAA Division II (South Atlantic Conference). Scout invented a
// division for a real university, the athlete corrected it, and the correction
// was classified simple_knowledge with a faq_id at high confidence — so no
// model ever ran and a canned encyclopedia entry came back. The athlete then
// had to correct the same fact a second time.
//
// The intent gate could not catch this. The message really IS about a generic
// topic. What disqualifies it is its POSITION: it is a reply, not a question.
//
// This is the second time the FAQ path has been caught serving canned text
// where a real answer was owed (see the FAQ_ELIGIBLE_INTENTS comment in
// api/scout.js for the first). Both fixes are code-level, because the file's
// own precedent is that "a soft instruction isn't a guarantee".
//
// Everything here runs the real shipped functions, sliced out of api/scout.js.
// Nothing is retyped.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};
function slice(a, b, label) {
  const i = SCOUT.indexOf(a), j = SCOUT.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error(`could not slice ${label} — markers moved`);
  return SCOUT.slice(i, j);
}

// latestUserText first: shouldUseFaqMatch calls it. A function declaration in
// a direct eval leaks to this scope, so the second eval can resolve it.
eval(slice("function latestUserText(conversation) {", "\n// ", "latestUserText"));
// The consts (FAQ_ELIGIBLE_INTENTS, FAQ_CONFIDENCE_THRESHOLD,
// CORRECTION_OPENERS) do NOT leak out of a direct eval, but the function
// declarations in the same slice close over them — which is why the gate and
// its constants must be extracted together, in one eval.
eval(slice("const FAQ_ELIGIBLE_INTENTS = ", "// The real $0-AI-cost path", "faq gate"));

if (typeof shouldUseFaqMatch !== "function") throw new Error("shouldUseFaqMatch did not extract");
if (typeof isShortReactive !== "function") throw new Error("isShortReactive did not extract");
if (typeof isReplyToScout !== "function") throw new Error("isReplyToScout did not extract");

const GOOD = { intent: "simple_knowledge", confidence: 0.99, faq_id: 7 };

// EVERY fixture below starts with GREETING, because production always does.
// golsz-app.html seeds each new conversation with the greeting as an
// assistant turn and posts the array verbatim, so a conversation that begins
// with a user message is a shape the server NEVER receives. An earlier
// version of this suite used [{role:"user"}] as its cold-open fixture; it
// passed while the shipped code disqualified every real cold-open question,
// because the fixture was not the thing production sends.
const GREETING = { role: "assistant", content: "Hey Dimitri — I'm your GOLSZ Scout. What's the plan?" };

const COLD_OPEN = [GREETING, { role: "user", content: "What is the difference between NCAA D1, D2, D3, and NAIA?" }];
// The real shape: Scout has spoken, the athlete is pushing back.
const THE_CORRECTION = [
  GREETING,
  { role: "user", content: "I just finished Tusculum University" },
  { role: "assistant", content: "So you just graduated from Tusculum University (NCAA Division III)." },
  { role: "user", content: "Tusculum university is a D2" },
];

// ---- 1. the classifier flag path -----------------------------------------
ck("a correction is never a FAQ match, even at 0.99 with a valid faq_id",
   shouldUseFaqMatch({ ...GOOD, is_correction: true }, COLD_OPEN), false);
ck("...and confidence cannot buy its way past the gate",
   shouldUseFaqMatch({ intent: "simple_knowledge", confidence: 1, faq_id: 7, is_correction: true }, COLD_OPEN), false);

// ---- 2. the deterministic second lock (classifier-failure path) ----------
// is_correction comes from a model. If the classifier misses it entirely, a
// short reactive message arriving after Scout has spoken must still not reach
// the canned answer.
ck("the real production message does not reach the FAQ path, is_correction absent",
   shouldUseFaqMatch(GOOD, THE_CORRECTION), false);
ck("...nor when the classifier explicitly says false",
   shouldUseFaqMatch({ ...GOOD, is_correction: false }, THE_CORRECTION), false);
for (const m of ["no", "not there anymore", "actually it's D2", "that's wrong", "wrong", "it's a D2", "nope"]) {
  ck(`reactive reply blocked: "${m}"`,
     shouldUseFaqMatch(GOOD, [GREETING, { role: "user", content: "..." }, { role: "assistant", content: "..." }, { role: "user", content: m }]), false);
}

// ---- 3. the FAQ economics must survive the fix ---------------------------
// This is the assertion that stops the fix from quietly turning the $0 path
// off. A genuine cold-open generic question is still answered from the FAQ.
ck("a cold-open generic question still matches the FAQ", shouldUseFaqMatch(GOOD, COLD_OPEN), true);
// THE REGRESSION THIS PINS. A SHORT cold-open question is the FAQ's core
// case — "what does offside mean?" — and it arrives after the seeded
// greeting. If isReplyToScout() counts that greeting as Scout having spoken,
// this goes false and the $0 path collapses to near zero in production while
// every other assertion here still passes.
ck("a SHORT cold-open question still matches, greeting notwithstanding",
   shouldUseFaqMatch(GOOD, [GREETING, { role: "user", content: "What does offside mean in soccer?" }]), true);
ck("...and the greeting alone is not Scout having spoken",
   isReplyToScout([GREETING, { role: "user", content: "What does offside mean in soccer?" }]), false);
ck("...a long first-message question still matches", shouldUseFaqMatch(GOOD, [GREETING, { role: "user",
   content: "Could you explain what the actual difference is between NCAA Division 1, Division 2, Division 3 and NAIA programmes, and whether the division a school sits in genuinely matters for scholarships?" }]), true);
// A long, non-reactive follow-up after Scout has spoken is a real question,
// not a correction — it must still be eligible.
ck("a long non-reactive follow-up mid-conversation is still eligible",
   shouldUseFaqMatch(GOOD, [GREETING, { role: "user", content: "hi" }, { role: "assistant", content: "..." }, { role: "user",
     content: "Could you explain how athletic scholarships actually differ between the various NCAA divisions and the NAIA, in terms of the money available to a single athlete?" }]), true);

// ---- 4. the pre-existing gates still hold --------------------------------
ck("no faq_id, no match", shouldUseFaqMatch({ ...GOOD, faq_id: null }, COLD_OPEN), false);
ck("personalized intent still never matches", shouldUseFaqMatch({ ...GOOD, intent: "career_advice" }, COLD_OPEN), false);
ck("below the confidence threshold still never matches", shouldUseFaqMatch({ ...GOOD, confidence: 0.5 }, COLD_OPEN), false);
ck("a classifier error still never matches", shouldUseFaqMatch({ ...GOOD, error: true }, COLD_OPEN), false);

// ---- 5. the primitives, directly ----------------------------------------
ck("isReplyToScout is false before Scout has spoken", isReplyToScout(COLD_OPEN), false);
ck("isReplyToScout is true once Scout has spoken", isReplyToScout(THE_CORRECTION), true);
ck("isReplyToScout tolerates a non-array", isReplyToScout(null), false);
// The distinction the whole gate rests on: a greeting PRECEDES the first
// user message; a real reply FOLLOWS one.
ck("a bare seeded greeting is not an exchange", isReplyToScout([GREETING]), false);
ck("greeting + one user message is still not an exchange",
   isReplyToScout([GREETING, { role: "user", content: "hi" }]), false);
ck("greeting + user + assistant IS an exchange",
   isReplyToScout([GREETING, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }]), true);
ck("...and it stays true on the turn after that",
   isReplyToScout([GREETING, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "no" }]), true);
ck("isShortReactive catches the real message", isShortReactive("Tusculum university is a D2"), true);
ck("isShortReactive catches a bare negation", isShortReactive("no"), true);
ck("isShortReactive ignores a long considered question", isShortReactive(
   "Could you explain how athletic scholarships actually differ between the various NCAA divisions and the NAIA today?"), false);
ck("isShortReactive tolerates a non-string", isShortReactive(undefined), false);
ck("isShortReactive tolerates whitespace only", isShortReactive("   "), false);

// ---- 6. the same gate guards the response cache -------------------------
// Same bug class, different door — assert the cache condition carries the
// identical is_correction and reactive-reply checks.
const cacheGate = slice("if (classification && CACHE_ELIGIBLE_INTENTS.has(classification.intent)", "cacheKey = cacheKeyFor", "cache gate");
ck("the response cache also refuses a flagged correction", /classification\.is_correction !== true/.test(cacheGate), true);
ck("...and also carries the deterministic second lock",
   /isReplyToScout\(conversation\) && isShortReactive\(latestText\)/.test(cacheGate), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
