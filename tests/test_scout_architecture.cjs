// Scout as the intelligence layer — the four architectural fixes.
//
// Each section guards a failure observed in production on 2026-08-10, not a
// hypothetical:
//
//   2  The Scout -> Plan handoff. Four escalating, unambiguous instructions
//      ("build it now", "go ahead and build it", "that is genuinely my new
//      goal, build the Plan") produced four prose Pathways and zero
//      structured objects, so nothing ever reached the Plan tab.
//   3  Precedence. Scout said "your goal on file is CPL professional
//      contract" while the goal the athlete had written read "a top European
//      club" — 35 memory rows outvoting one live field.
//   5  Sequence. Nothing ordered UNDERSTAND -> DIAGNOSE -> ADVISE -> PLAN ->
//      RECOMMEND, so a plan pitch could land before the diagnosis.
//   6  Internal terminology. Verbatim, to a real athlete: "I'm holding the
//      suggested_pathway build for one more message."
//
// Functions are sliced out of api/scout.js at run time and executed. None of
// them are retyped here.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};
function slice(startMarker, endMarker, label) {
  const a = SCOUT.indexOf(startMarker);
  const b = SCOUT.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error(`could not slice ${label} — markers moved, update this suite`);
  return SCOUT.slice(a, b);
}

// =========================================================================
// 6 — internal terminology never reaches an athlete
// =========================================================================
eval(slice("const INTERNAL_TERM_REPLACEMENTS = [", "// Scout kept ending EVERY reply with a question", "sanitizer"));

// The exact sentence a real athlete was shown.
{
  const leaked = "I'm holding the suggested_pathway build for one more message so I don't lock in milestones around the wrong branch.";
  const out = stripInternalTerminology(leaked);
  ck("the production leak no longer contains the field name", /suggested_pathway/.test(out), false);
  ck("...and the sentence still reads as English", out.includes("I'm holding the Plan build for one more message"), true);
}
const LEAKS = [
  ["Your pathway_type is set to juco.", /pathway_type/],
  ["I've noted that in scout_context for next time.", /scout_context/],
  ["Your goal_text hasn't changed.", /goal_text/],
  ["ATHLETE STATE shows you're on Free.", /ATHLETE STATE/],
  ["PLAN FIT says Basic would cover it.", /PLAN FIT/],
  ["I'll send that as profile_updates.", /profile_updates/],
  ["Your athlete_benchmarks are looking better.", /athlete_benchmarks/],
  ["baseline_complete is still false.", /baseline_complete/],
  ["assessment_ready flipped to true.", /assessment_ready/],
  ["Adding it to development_plan_items now.", /development_plan_items/],
  ["I'll put them in outreach_targets.", /outreach_targets/],
  ["Your profile_quality is the weakest one.", /profile_quality/],
];
for (const [input, re] of LEAKS) {
  ck(`sanitized: ${input.slice(0, 38)}...`, re.test(stripInternalTerminology(input)), false);
}
// Ordinary English an athlete SHOULD hear must survive untouched — the
// sanitizer only rewrites the unmistakably-internal spellings.
const SAFE = [
  "Your Plan needs milestones before it does anything for you.",
  "Let's get your pathway sorted, then the target list.",
  "Your goal is a European club, and that's the right thing to aim at.",
  "Your Passport is missing a bio and a highlight reel.",
  "We should plan the next three months around the trial.",
];
for (const s of SAFE) ck(`untouched: ${s.slice(0, 34)}...`, stripInternalTerminology(s), s);
ck("non-strings pass through", stripInternalTerminology(null), null);
ck("empty string passes through", stripInternalTerminology(""), "");
// The guarantee is that this runs on the one function every response path
// derives athlete-facing text from — a prompt rule alone already failed.
ck("deriveReplyText sanitizes the normal parse path",
   /return stripInternalTerminology\(parsed\.reply\.trim\(\)\)/.test(SCOUT), true);
ck("deriveReplyText sanitizes the salvage path",
   /return stripInternalTerminology\(salvaged\.trim\(\)\)/.test(SCOUT), true);
ck("deriveReplyText sanitizes the prose-fallback path",
   /return stripInternalTerminology\(prose\)/.test(SCOUT), true);
ck("the prompt also forbids it (defence in depth)",
   /NEVER SAY THE PLUMBING OUT LOUD/.test(SCOUT), true);
ck("...including saying it is withholding one",
   /not even to explain what you are doing or to say you are holding one back/.test(SCOUT), true);

// =========================================================================
// 2 — the Scout -> Plan handoff is guaranteed by the app
// =========================================================================
const PATHWAY_TYPE_SET = new Set([
  "ncaa", "naia", "juco", "canadian_university", "academy", "european_club",
  "professional", "development", "agent_representation", "trainer_performance", "other",
]);
const { hasFeature } = require("../api/_entitlements.js");
// resolveSuggestedPathway closes over classifyGoalText in production; supply
// the real one rather than a stub so the goal-contradiction guard is tested
// against the same classifier that ships.
eval(slice("const GOAL_TEXT_PATTERNS", "// Applies ONLY the derived pathway_type", "goal classifier"));
eval(slice("const PATHWAY_APPROVAL_PATTERNS = [", "// Same extraction shape again, pulling drafted_email", "handoff"));

// Approval is read from the ATHLETE's words. These are the real messages
// sent during the 2026-08-10 production test.
const APPROVALS = [
  "Yes. Rebuild my Plan now around the European club goal, with real milestones. Go ahead and build it.",
  "Yes, confirmed: I am switching my goal to a top European club and dropping CPL. That is genuinely my new goal. Build the Plan around Europe now with real milestones.",
  "Canadian passport only, no EU citizenship. That's the full answer. Now build the Plan with real dated milestones.",
  "go ahead",
  "build it",
  "yes please build that",
  "ok, set it up",
  "lock it in",
];
for (const m of APPROVALS) ck(`approval read: "${m.slice(0, 40)}..."`, athleteApprovedPathwayBuild(m), true);

// Questions, refusals and "later" must never read as approval — building a
// Plan the athlete did not ask for is its own kind of overwrite.
const NON_APPROVALS = [
  "Should you build it now or wait?",
  "Can you build me a plan?",
  "Would you build it if I had an EU passport?",
  "don't build it yet",
  "not yet",
  "hold off on the plan for now",
  "no, leave it",
  "nope",
  "maybe later, let's talk about the trial first",
  "What's my current goal, and is my Plan set up correctly for it?",
  "",
  null,
];
for (const m of NON_APPROVALS) ck(`not approval: "${String(m).slice(0, 40)}"`, athleteApprovedPathwayBuild(m), false);

// The guarantee itself.
const READINESS_GAPS = {
  quality: { missing: ["Bio", "Highlights"] },
  performance: { metricsTracked: 0, metricsRetested: 0 },
  pathway: { targetsCount: 0 },
  development: { total: 0 },
  verification: { status: "none" },
};
{
  const modelPathway = { pathway_type: "european_club", target_timeline: "2027", milestones: [{ label: "m", done: false }] };
  const base = { plan: "starter", goalDefined: true, pathwayType: "european_club", readiness: READINESS_GAPS, goalText: "My goal is to play for a top European club" };

  const r1 = resolveSuggestedPathway({ ...base, modelPathway, approved: true });
  ck("the model's own Pathway is preferred when it emits one", r1.source, "model");
  ck("...and is passed through unchanged", r1.pathway, modelPathway);

  // THE FIX: the model emitted nothing, the athlete said yes anyway.
  const r2 = resolveSuggestedPathway({ ...base, modelPathway: null, approved: true });
  ck("an approved Plan is built by the app when the model emits none", r2.source, "app");
  ck("...with the corrected pathway category", r2.pathway.pathway_type, "european_club");
  ck("...and real milestones drawn from actual gaps", r2.pathway.milestones.length > 0, true);
  ck("...every milestone has a label", r2.pathway.milestones.every((m) => typeof m.label === "string" && m.label.length > 0), true);
  ck("...and none are pre-ticked", r2.pathway.milestones.every((m) => m.done === false), true);
  ck("...naming the athlete's real missing Passport fields",
     r2.pathway.milestones.some((m) => /Bio/.test(m.label) && /Highlights/.test(m.label)), true);
  ck("...capped so the Plan stays readable", r2.pathway.milestones.length <= 6, true);

  // Nothing is built without the athlete actually asking.
  ck("no approval, no Plan", resolveSuggestedPathway({ ...base, modelPathway: null, approved: false }).source, "not_requested");
  // Never invent a route toward a goal that does not exist — that is the
  // silent-overwrite this whole design forbids.
  ck("no goal on record, no Plan", resolveSuggestedPathway({ ...base, modelPathway: null, approved: true, goalDefined: false }).source, "no_goal");
  ck("...and nothing is returned", resolveSuggestedPathway({ ...base, modelPathway: null, approved: true, goalDefined: false }).pathway, null);
  // Plan gating is checked before anything else.
  ck("Free is gated even with approval and a model Pathway",
     resolveSuggestedPathway({ ...base, plan: "free", modelPathway, approved: true }).source, "gated");
  ck("...returning nothing at all", resolveSuggestedPathway({ ...base, plan: "free", modelPathway, approved: true }).pathway, null);
  // A healthy account has no gaps to turn into milestones.
  const noGaps = { quality: { missing: [] }, performance: { metricsTracked: 3, metricsRetested: 2 }, pathway: { targetsCount: 5 }, development: { total: 3 }, verification: { status: "verified" } };
  ck("nothing to build from is reported honestly, not faked",
     resolveSuggestedPathway({ ...base, modelPathway: null, approved: true, readiness: noGaps }).source, "insufficient_state");
  // An invalid category can never reach the client's insert.
  ck("an unknown pathway category is refused",
     resolveSuggestedPathway({ ...base, modelPathway: null, approved: true, pathwayType: "made_up" }).source, "insufficient_state");
  // The app-built Plan carries no goal fields whatsoever.

  // PRODUCTION, 2026-08-11: the athlete's written goal read "earn an NCAA
  // Division 1 scholarship" and the emitted Pathway came back as a CPL
  // professional route assembled from older conversation memory. Accepting
  // it would have persisted a Plan pointing somewhere they never asked to
  // go. A model Pathway that contradicts the written goal is refused, and
  // the app builds one from that goal instead.
  const contradicting = { pathway_type: "professional", target_timeline: "CPL contract", milestones: [{ label: "CPL trial", done: false }] };
  const ncaa = { ...base, pathwayType: "ncaa", goalText: "My goal is to earn an NCAA Division 1 scholarship" };
  const r3 = resolveSuggestedPathway({ ...ncaa, modelPathway: contradicting, approved: true });
  ck("a Plan contradicting the written goal is refused", r3.source, "app");
  ck("...and the app builds one pointing at the written goal instead", r3.pathway.pathway_type, "ncaa");
  ck("...never persisting the contradicting category", r3.pathway.pathway_type === "professional", false);
  const agreeing = { pathway_type: "ncaa", target_timeline: "2027", milestones: [{ label: "m", done: false }] };
  ck("a Plan that agrees with the written goal is still accepted",
     resolveSuggestedPathway({ ...ncaa, modelPathway: agreeing, approved: true }).source, "model");
  // A goal the classifier cannot read must impose nothing at all.
  ck("an unclassifiable goal imposes no constraint",
     resolveSuggestedPathway({ ...base, goalText: "MLS contract", modelPathway: contradicting, approved: true }).source, "model");

  ck("an app-built Plan never carries goal wording",
     Object.keys(r2.pathway).sort(), ["milestones", "pathway_type", "target_timeline"]);
}
ck("all four response paths share the one guarantee",
   (SCOUT.match(/finalizeSuggestedPathway\(data, pathwayBuildCtx, incomingText, userPlan\)/g) || []).length, 4);
ck("the context is captured after the goal/pathway reconciliation",
   SCOUT.indexOf("pathwayBuildCtx = {") > SCOUT.indexOf("if (recon.safeAutoFix && recon.derived) {"), true);

// =========================================================================
// 3 — athlete-state precedence
// =========================================================================
ck("the order of authority is stated explicitly",
   /WHEN SOURCES DISAGREE, THIS IS THE ORDER OF AUTHORITY/.test(SCOUT), true);
ck("what the athlete wrote themselves ranks first",
   /1\. What the athlete has written themselves/.test(SCOUT), true);
ck("the live record ranks above this conversation",
   SCOUT.indexOf("2. Their live record in the blocks above") < SCOUT.indexOf("3. Something they told you earlier in THIS conversation"), true);
ck("memory from past conversations ranks last",
   /4\. SCOUT MEMORY from previous conversations\. Lowest authority\./.test(SCOUT), true);
ck("stale memory loses to the live record",
   /the live record is right and the memory is stale/.test(SCOUT), true);
ck("a changed goal is the goal — the old one is not still advised toward",
   /the new wording is the goal; do not keep advising toward the old one/.test(SCOUT), true);
ck("the correction is silent, not narrated at the athlete",
   /do not argue with yourself out loud or announce that your notes were out of date/.test(SCOUT), true);

// =========================================================================
// 1 — Scout receives the app's own diagnosis
// =========================================================================
ck("scout.js imports the shared readiness engine", /from "\.\/_readiness\.js"/.test(SCOUT), true);
ck("readiness is computed in getAthleteState, not in the prompt", /readiness = computeReadiness\(\{/.test(SCOUT), true);
ck("the scores are handed over as the athlete's own screen figures",
   /THEIR PASSPORT STRENGTH \(the exact figures on their Home screen right now/.test(SCOUT), true);
ck("the weakest dimension is named", /Weakest area: \$\{DIMENSION_LABEL\[rd\.weakest\]\}/.test(SCOUT), true);
ck("missing Passport information is named, not summarised as a number",
   /Still missing from their Passport: \$\{rd\.quality\.missing\.join/.test(SCOUT), true);
ck("supporting measurements travel with the scores",
   /Supporting counts: \$\{rd\.performance\.metricsTracked\}/.test(SCOUT), true);
ck("Scout is forbidden from inventing a different score",
   /Never state a score that is not in this block/.test(SCOUT), true);
ck("...or a sixth category", /never invent a sixth category/.test(SCOUT), true);
ck("the weakest area is described in plain language, never by its key",
   /use the plain-language name above/.test(SCOUT), true);
// The score must be computed over EVERY row, not a truncated prompt page —
// a development score over the first 8 items is simply a different number.
ck("readiness reads the full development list", /allDevItems = dRows; devItems = dRows\.slice\(0, 8\)/.test(SCOUT), true);
ck("readiness reads the full benchmark history", /allBenchmarks = bRows/.test(SCOUT), true);
ck("readiness counts every target", /targetsCount = tRows\.length; targets = tRows\.slice\(0, 10\)/.test(SCOUT), true);

// =========================================================================
// 5 — the reasoning sequence
// =========================================================================
ck("the sequence is spelled out in order", /1\. UNDERSTAND[\s\S]*2\. DIAGNOSE[\s\S]*3\. ADVISE[\s\S]*4\. PLAN[\s\S]*5\. RECOMMEND/.test(SCOUT), true);
ck("skipping to the pitch is forbidden", /You may never jump to step 5/.test(SCOUT), true);
ck("a pitch in place of an answer is called a failed reply", /is a failed reply/.test(SCOUT), true);
ck("ending after advice is explicitly a good reply", /most replies should end there/.test(SCOUT), true);
ck("the diagnosis step is pointed at the computed scores, not a second opinion",
   /use them instead of forming a competing one/.test(SCOUT), true);
ck("selling is labelled as step 5 of the sequence", /this is step 5 of the sequence above, never a shortcut past it/.test(SCOUT), true);
ck("no aggressive prompting — one mention, at most, ever",
   /Raise it at most once/.test(SCOUT), true);
ck("...and never twice in a reply", /never mention plans twice in one reply/.test(SCOUT), true);

// =========================================================================
// Nothing above may move a quota, price, entitlement or auth rule
// =========================================================================
ck("free daily limit unmoved", /FREE_DAILY_LIMIT[^\n]*3/.test(SCOUT) || /parseInt\(process\.env\.FREE_DAILY_LIMIT/.test(SCOUT), true);
ck("the Free lifetime AI budget is still enforced", /releaseFreeAiQuestion/.test(SCOUT), true);
ck("the atomic reserve is still used", /reserve_scout_question/.test(SCOUT), true);
ck("cost logging is intact", /logRouting/.test(SCOUT), true);
ck("the goal auto-fix still writes only the category",
   /body: JSON\.stringify\(\{ pathway_type: derivedType \}\)/.test(SCOUT), true);
ck("...and still refuses an out-of-enum value", /if \(!PATHWAY_TYPE_SET\.has\(derivedType\)\) return false/.test(SCOUT), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
