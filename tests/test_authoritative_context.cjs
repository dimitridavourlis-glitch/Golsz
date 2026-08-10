// STEP 9 ACCEPTANCE TEST — the Montreal/Cyprus athlete from the directive.
//
// The functions under test are extracted from api/scout.js AT RUN TIME, so
// this cannot drift from what actually ships. It used to read a generated
// _scout_extracted.js side file, which was a build artifact that lived
// outside the repo and made the suite unrunnable anywhere else.
const fs = require("fs");
const REPO = require("path").join(__dirname, "..");
const SRC = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));
// One contiguous slice: renderAuthoritativeContext sits AFTER
// buildAuthoritativeContext in the file, so stopping at the latter silently
// dropped it. Ends at LANG_NAMES, the next unrelated declaration.
// renderAuthoritativeContext() now closes over classifyGoalText: a memory
// that points at a different pathway than the athlete's CURRENT goal is
// relabelled as history rather than presented as a peer fact. Supply the
// real classifier, not a stub.
eval(slice("const GOAL_TEXT_PATTERNS", "// Applies ONLY the derived pathway_type"));
eval(slice("const IDENTITY_FIELDS", "// Matches golsz-app.html's LANGS"));
// complexityScore lives elsewhere in the file (model routing, not context
// building) but this suite asserts the two-locations signal raises it.
eval(SRC.slice(SRC.indexOf("function complexityScore"),
               SRC.indexOf("\n}\n", SRC.indexOf("function complexityScore")) + 3));

// The athlete the directive specifies.
const ATHLETE = {
  home_city: "Montreal", home_country: "Canada",
  current_city: "Limassol", country: "Cyprus",
  citizenship: "Canada",
  sport: "Soccer", position: "Right Winger", secondary_position: null, foot: "Right",
  club_name: "Omonia 29 (reserve pathway / training)",
  previous_clubs: [{ name: "Lakeshore FC", from: null, to: null, level: null }],
  recruiting_status: "Open to offers", grad_year: null, education_level: null,
  height_cm: null, weight_kg: null, gpa: null,
  dob: null, age_reported: 16, age_reported_at: new Date().toISOString().slice(0, 10),
};
const MEMORIES = [
  { type: "USER_STATED", subject: "family relocation", content: "Parents moved to Cyprus with the athlete", source: "athlete_stated", confidence: 0.95, importance: 4, active: true },
  { type: "GOAL", subject: "career goal", content: "Play professional football", source: "athlete_stated", confidence: 0.9, importance: 5, active: true },
  { type: "CONCERN", subject: "considering return", content: "Considering returning to Montreal", source: "athlete_stated", confidence: 0.9, importance: 4, active: true },
  { type: "USER_STATED", subject: "ankle", content: "Ankle issue mentioned; no prognosis established", source: "athlete_stated", confidence: 0.8, importance: 4, active: true },
  { type: "SCOUT_INFERENCE", subject: "level read", content: "May be evaluating options through an overly MLS-centric lens", source: "ai_inferred", confidence: 0.4, importance: 2, active: true },
  { type: "NEXT_DATA_NEEDED", subject: "senior minutes", content: "Senior appearances and starts this season", source: "ai_inferred", confidence: 0.5, importance: 5, active: true },
];
const ctx = { athlete: ATHLETE, memories: MEMORIES, conflicts: detectConflicts(ATHLETE, MEMORIES), age: resolveAge(ATHLETE) };
const block = renderAuthoritativeContext(ctx);

let p = 0, f = 0;
const ck = (l, cond) => { if (cond) { p++; console.log("PASS  " + l); } else { f++; console.log("FAIL  " + l); } };
const has = (t) => block.includes(t);

console.log("=== identity is unambiguous in the rendered block ===");
ck("home city Montreal present and labelled FROM", /home city \(where they are FROM\): Montreal/.test(block));
ck("current city labelled NOW", /current city \(where they are NOW\): Limassol/.test(block));
ck("current country Cyprus labelled NOW", /current country \(where they are NOW\): Cyprus/.test(block));
ck("citizenship kept separate from both", /citizenship \/ passport: Canada/.test(block));
ck("home and current are NOT the same value", ATHLETE.home_city !== ATHLETE.current_city);
ck("age resolved from athlete-stated value", ctx.age && ctx.age.age === 16);
ck("previous club Lakeshore FC preserved", has("Lakeshore FC"));
ck("current club is Omonia, not a previous club", has("Omonia 29") && !/previous clubs:.*Omonia/.test(block));

console.log("\n=== the 'back' problem (directive Step 2 worked example) ===");
ck("block explicitly resolves back/home/return", has('RESOLVING "back"/"home"/"return"'));
ck("resolves 'back' to Montreal, not Cyprus", /Read "back"\/"home"\/"return" as Montreal, Canada/.test(block));
ck("still instructs ONE question if truly ambiguous", /ask ONE short question/.test(block));

console.log("\n=== facts vs inferences must never be merged ===");
ck("stated facts in their own confirmed section", /THINGS THE ATHLETE HAS STATED[\s\S]*Parents moved to Cyprus/.test(block));
ck("inference is in the NOT-facts section", /YOUR EARLIER INFERENCES[\s\S]*MLS-centric/.test(block));
ck("inference is NOT in the stated section",
   block.indexOf("MLS-centric") > block.indexOf("YOUR EARLIER INFERENCES"));
ck("family-moved-with-athlete is recorded (so Scout can't say 'alone abroad')", has("Parents moved to Cyprus"));
ck("ankle recorded WITHOUT any prognosis", has("no prognosis established") && !/weeks|recovery time|back in \d/.test(block));
ck("open unknown surfaced for senior minutes", /KNOWN UNKNOWNS[\s\S]*Senior appearances/.test(block));

console.log("\n=== no invented content ===");
ck("no agent invented", !/agent/i.test(block));
ck("no offers invented", !/offer received|previous offers/i.test(block));
ck("no trial invented", !/trial/i.test(block));

console.log("\n=== Step 7: conflict detection ===");
ck("clean state produces no conflicts", ctx.conflicts.length === 0);
const CONFLICTED = [{ type: "USER_STATED", subject: "current club", content: "Now training with Apollon", source: "athlete_stated", confidence: 0.9, importance: 4, active: true }];
const conf = detectConflicts(ATHLETE, CONFLICTED);
ck("club contradiction is detected", conf.length === 1 && /club_name/.test(conf[0]));
const blockC = renderAuthoritativeContext({ athlete: ATHLETE, memories: CONFLICTED, conflicts: conf, age: null });
ck("conflict tells Scout to ask, not guess", /Do NOT guess[\s\S]*Ask ONE short clarifying question/.test(blockC));
const AGREE = [{ type: "USER_STATED", subject: "current club", content: "Omonia 29", source: "athlete_stated", confidence: 0.9, importance: 3, active: true }];
ck("agreeing memory is NOT flagged as a conflict", detectConflicts(ATHLETE, AGREE).length === 0);
const INFER = [{ type: "SCOUT_INFERENCE", subject: "current club", content: "Probably Apollon", source: "ai_inferred", confidence: 0.3, importance: 2, active: true }];
ck("an INFERENCE can never raise a conflict against a verified column (precedence 5 < 1)",
   detectConflicts(ATHLETE, INFER).length === 0);

console.log("\n=== Step 5: routing sends the pivot question to the strong model ===");
const twoLoc = { twoLocationsKnown: true, hasConflicts: false };
const pivot = "The ankle doesn't help. What are my options if I pivot back?";
ck("pivot question scores into strong-model territory (>25)",
   complexityScore({ text: pivot, classification: null, context: twoLoc }) > 25);
ck("same question scores LOWER without known locations",
   complexityScore({ text: pivot, classification: null, context: { twoLocationsKnown: false } })
   < complexityScore({ text: pivot, classification: null, context: twoLoc }));
ck("a trivial definition stays cheap",
   complexityScore({ text: "What does GPA mean?", classification: null, context: twoLoc }) <= 25);
ck("eligibility interpretation scores high",
   complexityScore({ text: "How does NCAA eligibility work for me?", classification: null, context: twoLoc }) > 25);
ck("an unresolved conflict pushes to the strong model",
   complexityScore({ text: "ok", classification: null, context: { twoLocationsKnown: false, hasConflicts: true } })
   > complexityScore({ text: "ok", classification: null, context: { twoLocationsKnown: false, hasConflicts: false } }));

console.log("\n=== age handling ===");
ck("dob beats a stale reported age",
   resolveAge({ dob: "2009-03-01", age_reported: 12, age_reported_at: "2021-01-01" }).basis === "date of birth");
ck("a 3-year-old stated age is aged forward, not believed verbatim",
   resolveAge({ dob: null, age_reported: 13, age_reported_at: "2023-01-01" }).age >= 15);
ck("no age data yields null rather than a guess", resolveAge({}) === null);

console.log("\n=== empty athlete must not fabricate ===");
const empty = renderAuthoritativeContext({ athlete: null, memories: [], conflicts: [], age: null });
ck("says nothing on file rather than inventing", /nothing on file yet/.test(empty));
ck("no 'back' resolution when locations unknown", !/RESOLVING/.test(empty));

console.log("\n=== the Passport bio reaches Scout ===");
// Real gap found 2026-08-09: athletes.bio (up to 600 chars, shown on the
// Passport) was never selected by buildAuthoritativeContext and never
// rendered — Scout genuinely could not see it. Fixed by adding it to the
// select list and giving it its own labelled paragraph.
const withBio = renderAuthoritativeContext({ ...ctx, athlete: { ...ATHLETE, bio: "Box-to-box winger, grew up playing futsal in Montreal before the move." } });
ck("the bio text itself is present", withBio.includes("Box-to-box winger, grew up playing futsal in Montreal"), true);
ck("labelled as the athlete's own words, not a bullet fact", /THEIR OWN PASSPORT BIO/.test(withBio), true);
const noBio = renderAuthoritativeContext({ ...ctx, athlete: { ...ATHLETE, bio: null } });
ck("no bio on file -> no section at all, never a placeholder", !/PASSPORT BIO/.test(noBio), true);
const blankBio = renderAuthoritativeContext({ ...ctx, athlete: { ...ATHLETE, bio: "   " } });
ck("whitespace-only bio is treated as absent", !/PASSPORT BIO/.test(blankBio), true);
const longBio = renderAuthoritativeContext({ ...ctx, athlete: { ...ATHLETE, bio: "x".repeat(900) } });
ck("an oversized bio is capped at 600 chars even if it reached the server that way",
   (longBio.match(/x+/) || [""])[0].length <= 600, true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
