// Precedence under adversarial conditions, and the meta-commentary scrubber.
//
// THE FAILURE THIS GUARDS
// The athlete's written goal read "earn an NCAA Division 1 scholarship".
// Thirty-five Scout memory rows all said CPL, from weeks of earlier
// conversation. Scout kept advising toward CPL and described the NCAA goal
// as the thing that didn't match. A prompt rule ranking the live record
// above memory did not survive that volume — rank is a weak signal when the
// count is 35 to 1.
//
// The fix does not delete anything. A memory that points at a different
// pathway than the CURRENT goal is relabelled, at render time, as history —
// still readable, still referable, no longer sayable as the present aim.
//
// Everything here runs the real shipped functions, sliced out of
// api/scout.js. Nothing is retyped.

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

// The real classifier and the real renderer.
eval(slice("const GOAL_TEXT_PATTERNS", "// Applies ONLY the derived pathway_type", "classifier"));
// IDENTITY_FIELDS lives just above the renderer and is closed over by it.
eval(slice("const IDENTITY_FIELDS = [", "// Step 3 — hard anti-hallucination rules", "renderer"));

// The real production shape: a pile of CPL memories against one NCAA goal.
// Memories that DECLARE a direction. These are the ones that must stop
// speaking in the present tense once the goal changes.
const CPL_MEMORIES = [
  { type: "GOAL", subject: "dream outcome", content: "CPL professional contract", source: "athlete_stated", confidence: 0.95 },
  { type: "PATHWAY_ACTIVE", subject: "target level", content: "Canadian Premier League, top-tier professional", source: "athlete_stated", confidence: 0.9 },
  { type: "DECISION", subject: "route", content: "U Sports draft into the CPL, or a free agent trial", source: "athlete_stated", confidence: 0.9 },
];
// Memories that merely MENTION the old direction while stating a fact about
// the athlete's life. These deliberately stay current: a trial in the diary
// still happens after a goal change, and the gap in their game is still the
// gap. Superseding them would delete true information, which is exactly what
// this design is supposed to avoid.
const INCIDENTAL_MEMORIES = [
  { type: "MILESTONE", subject: "trial", content: "CPL club trial in two weeks", source: "athlete_stated", confidence: 1 },
  { type: "CONCERN", subject: "playing time", content: "needs minutes to build tape for CPL scouts", source: "ai_inferred", confidence: 0.7 },
];
const NEUTRAL_MEMORIES = [
  { type: "CONCERN", subject: "biggest gap", content: "recovery speed, deceleration and re-acceleration", source: "athlete_stated", confidence: 0.9 },
  { type: "FACT", subject: "current club", content: "Tusculum", source: "athlete_stated", confidence: 1 },
  { type: "UNKNOWN", subject: "date of birth", content: "still need DOB to check eligibility", source: "ai_inferred", confidence: 0.5 },
];
const NCAA_GOAL = "My goal is to earn an NCAA Division 1 scholarship";
const ctx = { athlete: { sport: "Soccer" }, memories: [...CPL_MEMORIES, ...INCIDENTAL_MEMORIES, ...NEUTRAL_MEMORIES], conflicts: [], age: 20 };

const out = renderAuthoritativeContext(ctx, NCAA_GOAL);

// ---- the superseded section exists and contains the right rows -----------
ck("a HISTORY section appears when memory disagrees with the current goal",
   /HISTORY — SUPERSEDED BY THEIR CURRENT GOAL/.test(out), true);
ck("the current goal is quoted verbatim inside it", out.includes(NCAA_GOAL), true);
for (const m of CPL_MEMORIES) {
  const idx = out.indexOf(m.content);
  const histIdx = out.indexOf("HISTORY — SUPERSEDED");
  ck(`"${m.content.slice(0, 34)}..." is filed as history`, idx > histIdx, true);
}
// NOTHING IS DELETED — the whole point. Every memory still reaches Scout.
for (const m of [...CPL_MEMORIES, ...INCIDENTAL_MEMORIES, ...NEUTRAL_MEMORIES]) {
  ck(`preserved, not deleted: "${m.subject}"`, out.includes(m.content), true);
}
// Memories that say nothing about a pathway are untouched by any of this.
const histStart = out.indexOf("HISTORY — SUPERSEDED");
ck("an unrelated concern stays a current fact",
   out.indexOf("recovery speed, deceleration and re-acceleration") < histStart, true);
ck("current club stays a current fact", out.indexOf("Tusculum") < histStart, true);
ck("known unknowns are not swept into history",
   out.indexOf("still need DOB to check eligibility") < histStart, true);
// Only DIRECTION-DECLARING memories are superseded. A fact that happens to
// mention the old route is still a true fact and stays current.
for (const m of INCIDENTAL_MEMORIES) {
  ck(`incidental mention stays current: "${m.subject}"`, out.indexOf(m.content) < histStart, true);
}

// ---- the instruction that does the work ----------------------------------
ck("volume is explicitly denied authority", /volume is not authority/.test(out), true);
ck("history may still be referred to", /You may refer to it as history/.test(out), true);
ck("every part of the reply must serve the current goal",
   /Every diagnosis, every piece of advice, every next step and every plan recommendation in this reply must serve the goal quoted above/.test(out), true);
ck("the athlete is not asked to re-confirm the change",
   /Do not ask them to re-confirm the change/.test(out), true);
ck("the current goal must not be framed as the mismatch",
   /do not describe their current goal as a "mismatch"/.test(out), true);
ck("only an explicit new statement changes direction",
   /Only an explicit new statement from them changes direction again/.test(out), true);

// ---- it must NOT fire when it shouldn't ----------------------------------
{
  // Same memories, goal still CPL-shaped: nothing is superseded.
  const proOnly = { ...ctx, memories: [CPL_MEMORIES[0], CPL_MEMORIES[1], ...INCIDENTAL_MEMORIES, ...NEUTRAL_MEMORIES] };
  const agreeing = renderAuthoritativeContext(proOnly, "My goal is to sign a professional contract");
  ck("a goal that agrees with memory produces no history section",
     /HISTORY — SUPERSEDED/.test(agreeing), false);
  // A goal the classifier cannot read must impose nothing.
  const unreadable = renderAuthoritativeContext(ctx, "MLS contract");
  ck("an unclassifiable goal supersedes nothing", /HISTORY — SUPERSEDED/.test(unreadable), false);
  const noGoal = renderAuthoritativeContext(ctx, null);
  ck("no goal at all supersedes nothing", /HISTORY — SUPERSEDED/.test(noGoal), false);
  ck("...and every memory still reaches Scout", noGoal.includes("CPL professional contract"), true);
  // No memories at all must not produce an empty section.
  const empty = renderAuthoritativeContext({ ...ctx, memories: [] }, NCAA_GOAL);
  ck("no memories, no history section", /HISTORY — SUPERSEDED/.test(empty), false);
}

// ---- multi-turn: the goal stays authoritative across consecutive calls ----
// The renderer is stateless and runs per message, so "turn 4 drifts back to
// CPL" can only happen if the block stops being emitted. Assert it is
// identical every turn, including as new CPL-flavoured memories accumulate.
{
  let memories = [...CPL_MEMORIES, ...INCIDENTAL_MEMORIES, ...NEUTRAL_MEMORIES];
  for (let turn = 1; turn <= 6; turn++) {
    // Each turn the model writes another CPL-ish memory, the exact drift
    // pressure that broke the prompt-only version.
    memories = memories.concat([{ type: "PATHWAY_CONSIDERED", subject: `route note ${turn}`, content: `CPL professional contract remains the target (note ${turn})`, source: "ai_inferred", confidence: 0.6 }]);
    const turnOut = renderAuthoritativeContext({ ...ctx, memories }, NCAA_GOAL);
    ck(`turn ${turn}: history section still present`, /HISTORY — SUPERSEDED/.test(turnOut), true);
    ck(`turn ${turn}: current NCAA goal still quoted`, turnOut.includes(NCAA_GOAL), true);
    ck(`turn ${turn}: the newest CPL memory is filed as history too`,
       turnOut.indexOf(`route note ${turn}`) > turnOut.indexOf("HISTORY — SUPERSEDED"), true);
  }
}


// =========================================================================
// scout_context — the field that ACTUALLY broke in production
// =========================================================================
// The first version of this fix only covered scout_memory, and production
// still answered "Your goal is a CPL professional contract, that's what's on
// your Passport" against an NCAA goal. dream_outcome does not live in
// scout_memory — it lives in athletes.scout_context, and it was rendering
// under "THINGS THE ATHLETE HAS STATED (confirmed — treat as fact)", the
// highest-trust section in the whole block.
{
  const scAthlete = {
    sport: "Soccer",
    scout_context: {
      dream_outcome: { value: "CPL professional contract", source: "athlete_stated", confidence: 0.95 },
      target_level: { value: "Canadian Premier League (top-tier professional)", source: "athlete_stated", confidence: 0.9 },
      target_country: { value: "Canada (Quebec)", source: "athlete_stated", confidence: 0.9 },
      main_gap: { value: "Playing time; current tape thin", source: "athlete_stated", confidence: 0.9 },
      ai_meta: { updated_at: "2026-08-11T00:00:00Z" },
    },
  };
  const scOut = renderAuthoritativeContext({ athlete: scAthlete, memories: [], conflicts: [], age: 20 }, NCAA_GOAL);
  const hi = scOut.indexOf("HISTORY — SUPERSEDED");
  ck("a stored dream outcome that contradicts the goal is filed as history", hi >= 0, true);
  ck("...specifically dream_outcome", scOut.indexOf("CPL professional contract") > hi, true);
  ck("...and target level with it", scOut.indexOf("Canadian Premier League") > hi, true);
  ck("...so it is NOT under things the athlete has stated as fact",
     scOut.indexOf("CPL professional contract") > scOut.indexOf("THINGS THE ATHLETE HAS STATED"), true);
  // Fields that say nothing about a direction are untouched.
  ck("an unrelated stored field stays a current fact",
     scOut.indexOf("Playing time; current tape thin") < hi, true);
  ck("target country is not a pathway claim and stays current",
     scOut.indexOf("Canada (Quebec)") < hi, true);
  // And it must not fire when the goal agrees.
  const proOut = renderAuthoritativeContext({ athlete: scAthlete, memories: [], conflicts: [], age: 20 }, "My goal is to sign a professional contract");
  ck("a matching goal leaves stored context alone", /HISTORY — SUPERSEDED/.test(proOut), false);
}

// =========================================================================
// META-COMMENTARY — the reply must never contain the working out
// =========================================================================
eval(slice("const INTERNAL_TERM_REPLACEMENTS = [", "// Scout kept ending EVERY reply with a question", "sanitizers"));

// Verbatim from production, 2026-08-11.
{
  const real = "The search results for CPL preseason are about cricket and general MLS/Premier League info, not Canadian Premier League soccer. The draft is open to underclassmen, so you do not have to wait until you graduate.";
  const cleaned = sanitizeReplyText(real);
  ck("the production search-narration sentence is removed", /search results/i.test(cleaned), false);
  ck("...and the real advice after it survives", cleaned.includes("open to underclassmen"), true);
}
// GRANULARITY IS THE SENTENCE, AND THAT IS A DELIBERATE TRADE.
// The real production line buried "the draft is open to underclassmen"
// inside the same sentence as "I have what I need from the research". There
// is no safe way to split a sentence in half, so the whole sentence goes.
// Losing one clause of advice is a smaller harm than shipping the model's
// working-out, and the athlete can always ask again.
ck("a sentence mixing machinery and advice is dropped whole, not half-cleaned",
   sanitizeReplyText("But I have what I need from the draft research, and the window opens in May."), null);
{
  const real = "Confirmed: Tusculum is NCAA Division II, so his currently written goal would actually mean transferring. Now let me write the reply.";
  ck("third-person commentary about the athlete is removed", sanitizeReplyText(real), null);
}
const META = [
  "Let me look that up for you.",
  "Now I'll write the answer.",
  "This confirms it.",
  "I have plenty to work with.",
  "The search came back empty.",
  "I ran a search and found nothing useful.",
  "Now to answer directly using the record I already have.",
  "The athlete's goal is clear enough.",
  "Her Plan is a shell.",
  "Good, this settles it.",
];
for (const m of META) ck(`meta removed: "${m.slice(0, 40)}"`, sanitizeReplyText(m + " "), null);

// Real advice must survive completely untouched, including sentences that
// merely mention searching or plans in an ordinary way.
const REAL = [
  "Your 10 metre is 2.0 seconds, which is solidly in D1 range for a right back.",
  "Work change of direction two to three times a week: 5-10-5 shuttles and mirror drills.",
  "I'd go after the U Sports route first, then reassess in the spring.",
  "Your Passport is missing a bio and a highlight reel, and both are quick wins.",
  "You should search for programmes that actually take non-EU players.",
  "His touch under pressure is the thing you were worried about at the trial.",
];
for (const r of REAL) ck(`kept intact: "${r.slice(0, 40)}..."`, sanitizeReplyText(r), r);

// Mixed: strip the machinery, keep the answer, preserve paragraphing.
{
  const mixed = "Let me check that for you.\n\nYour 10 metre is 2.0 seconds, which is D1 range.\n\nNow I'll write the plan. You should retest in six weeks.";
  const cleaned = sanitizeReplyText(mixed);
  ck("mixed reply keeps the advice", cleaned.includes("Your 10 metre is 2.0 seconds"), true);
  ck("...keeps advice that shared a paragraph with meta", cleaned.includes("You should retest in six weeks"), true);
  ck("...drops the machinery", /Let me check that|Now I'll write the plan/.test(cleaned), false);
  ck("...and keeps paragraph structure", cleaned.includes("\n\n"), true);
}
ck("a reply that is entirely scratchpad becomes null, not an empty bubble",
   sanitizeReplyText("Let me look that up. Now I'll write the answer. This confirms it."), null);
ck("null in, null out", sanitizeReplyText(null), null);
ck("empty in, null out", sanitizeReplyText("   "), null);

// The two sanitizers compose: internal terminology is rewritten BEFORE
// sentences are judged, so a rewritten sentence is kept on its final wording.
ck("internal terminology still rewritten through the combined path",
   /suggested_pathway/.test(sanitizeReplyText("I'm holding the suggested_pathway build for one more message, and your speed is fine.") || ""), false);

// The prompt carries the same rule, as defence in depth.
ck("the prompt forbids narrating the machinery", /WRITE THE ANSWER, NOT YOUR WORKING OUT/.test(SCOUT), true);
ck("the prompt forbids the third person", /Never write about them in the third person/.test(SCOUT), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
