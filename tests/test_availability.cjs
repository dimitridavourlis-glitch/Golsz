// AVAILABILITY IS A FACT ABOUT PLAYING, NOT A MEDICAL RECORD.
//
// The brief asks GOLSZ to reroute like GPS when circumstances change and gives
// injury as the worked example, and asks that Scout receive availability as
// structured context. Before migration 150 the product had no concept of it at
// all: an athlete could tell Scout about an injury and Scout would propose
// sprint work in the next conversation, because nothing carried it.
//
// MOST OF WHAT THIS SUITE CHECKS IS RESTRAINT. GOLSZ stores no diagnosis, no
// body part and no prognosis, the expected-return date belongs to the athlete
// rather than to anyone qualified, and "not recorded" must never be read as
// "fit". A product that guesses about a fifteen-year-old's injury is worse
// than one that stays quiet.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const SCOUT = fs.readFileSync(path.join(REPO, "api", "scout.js"), "utf8");
const MIG = fs.readFileSync(path.join(REPO, "supabase-migration-150-availability.sql"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- three states, and nothing clinical ------------------------------------
ck("only three states are allowed",
   /check \(availability_status is null or availability_status in \('available', 'limited', 'out'\)\)/.test(MIG), true);
// Anything resembling a medical record is a line this product does not cross.
for (const word of ["diagnosis", "body_part", "injury_type", "severity", "prognosis"]) {
  ck(`  no ${word} column`, new RegExp("add column[^;]*" + word).test(MIG), false);
}
ck("the date is named for whose estimate it is", /availability_expected_return/.test(MIG), true);
ck("...and the column comment says so", /ATHLETE''S OWN estimate/.test(MIG), true);

// NULL means NOT RECORDED. Backfilling it to 'available' would put words in
// the mouth of every athlete who never answered.
ck("nothing is backfilled", /update profiles set availability/.test(MIG), false);
ck("...and the file says why", /never be backfilled to available/.test(MIG), true);
// A date with no status is a half-state nothing can read.
ck("dates cannot exist without a status",
   /check \(availability_status is not null\s*\n\s*or \(availability_since is null/.test(MIG), true);

// ---- the client control ----------------------------------------------------
{
  const at = APP.indexOf('{t("avail_section")}');
  ck("the control exists", at > 0, true);
  // Bounded by the section that follows it. The first version ended on
  // '{t("avail_unset")}', which does not exist as a literal — it is rendered
  // inside a ternary — so indexOf returned -1 and the slice collapsed to
  // nothing, failing five assertions that were actually true.
  const end = APP.indexOf('{t("privacy_section")}', at);
  ck("the block's end was found", end > at, true);
  // The guard in FULL. "{sb && uid && occupation ===" alone opens both this
  // block and the privacy block below it; a lastIndexOf that happens to pick
  // the right one is a guess, not a locator.
  const guard = '{sb && uid && occupation === "Player" && avail !== null && (';
  ck("the availability guard is unique", APP.split(guard).length - 1, 1);
  const block = APP.slice(APP.indexOf(guard), end);
  ck("...and the slice really contains the control", block.includes('t("avail_section")'), true);
  ck("it is shown to players only", /occupation === "Player"/.test(block), true);
  // avail !== null, not a truthiness test: an athlete with no status recorded
  // has an object with status null, and the control must still render for them.
  ck("...and renders once loaded, even with nothing recorded", /avail !== null/.test(block), true);
  ck("all three states are offered", /\["available", "limited", "out"\]/.test(block), true);
  // Tapping the active state again clears it. Without that, a state entered by
  // accident can never be removed.
  ck("the same button clears it", /setAvailability\(on \? \{ status: null \} :/.test(block), true);
  // The return-date field appears only once a state is set, and never for
  // someone who said they are fit.
  ck("the date is asked only when it means something",
     /avail\.status && avail\.status !== "available" && \(/.test(block), true);
  ck("...and is labelled as the athlete's own estimate", /t\("avail_expected_note"\)/.test(block), true);
  ck("not-recorded is said in the product's own voice", /t\("avail_unset"\)/.test(block), true);
}

// Styles must be in scope. inputStyle and editorLabel are declared inside
// three OTHER components; borrowing them here is a ReferenceError at render,
// and Settings would have gone down for every player. test_client_scope found
// it, and this pins the fix.
{
  // aria-label, which occurs once — the bare {t("avail_expected")} is both the
  // visible label and the aria-label, so it is two places, not one.
  const aria = 'aria-label={t("avail_expected")}';
  ck("the date input is uniquely locatable", APP.split(aria).length - 1, 1);
  const at = APP.indexOf(aria);
  const block = APP.slice(at - 900, at + 600);
  ck("...and the slice covers its label and its style", /avail_expected/.test(block), true);
  ck("the control borrows no out-of-scope style",
     /style=\{editorLabel\}|\.\.\.inputStyle/.test(block), false);
}

// ---- the write -------------------------------------------------------------
{
  const at = APP.indexOf("async function setAvailability(next) {");
  ck("the writer exists", at > 0, true);
  const fn = APP.slice(at, APP.indexOf("\n  }", at));
  ck("it checks { error } rather than assuming", /if \(error\) \{/.test(fn), true);
  ck("...and restores the previous value on failure", /setAvail\(before\);/.test(fn), true);
  ck("...and tells the athlete", /setPrivacyErr\(t\("privacy_save_failed"\)\)/.test(fn), true);
  // Clearing must null the dates too, or the CHECK rejects the row.
  ck("clearing nulls the dates with the status",
     /availability_status: null, availability_since: null,\s*\n\s*availability_expected_return: null, availability_note: null/.test(fn), true);

  // HISTORY. The brief's rule is that pathway history is never destroyed, and
  // a log that starts being written only when something reads it starts empty.
  ck("every change is appended to athlete_outcomes",
     /from\("athlete_outcomes"\)\.insert\(\{/.test(fn), true);
  ck("...with the type migration 150 added", /outcome_type: "availability_changed"/.test(fn), true);
  ck("...AFTER the status write succeeded", fn.indexOf("athlete_outcomes") > fn.indexOf('from("profiles").update'), true);
  // An athlete reporting an injury must not be blocked by a failed audit row.
  ck("...and a failed log never blocks the change", /console\.warn\("GOLSZ availability history not written/.test(fn), true);
}
ck("the outcome type is allowed by the constraint", /'availability_changed','pathway_rerouted'/.test(MIG), true);

// ---- Scout --------------------------------------------------------------
ck("Scout reads the columns", /availability_status,availability_since,availability_expected_return,availability_note/.test(SCOUT), true);
ck("...and carries it as a result on athleteState", /availability: profileRow && profileRow\.availability_status \?/.test(SCOUT), true);
ck("...absent when not recorded, rather than defaulted", /\} : null,/.test(SCOUT), true);
{
  const at = SCOUT.indexOf("THEIR OWN AVAILABILITY");
  ck("the prompt states it", at > 0, true);
  const block = SCOUT.slice(at - 200, at + 1800);
  ck("...as self-reported, with no medical claim",
     /GOLSZ has no medical information about them/.test(block), true);
  ck("...the return date is theirs, not a fact", /that is THEIR estimate, not a diagnosis or a commitment/.test(block), true);
  ck("...Scout must not prescribe through an injury", /do not tell them to push through it/.test(block), true);
  ck("...and must defer to whoever is treating them", /that is for the person treating them/.test(block), true);
  // THE HALF THAT MATTERS MOST: silence is not fitness.
  ck("not recorded is explicitly not the same as fit",
     /THEIR AVAILABILITY IS NOT RECORDED\. That is not the same as being fit\./.test(SCOUT), true);
  ck("...and Scout is told to ask rather than assume", /Do not assume either way; if it matters to the answer, ask\./.test(SCOUT), true);
}

for (const k of ["avail_section", "avail_available", "avail_limited", "avail_out",
                 "avail_expected", "avail_expected_note", "avail_note", "avail_unset"]) {
  const hits = APP.match(new RegExp("\\b" + k + ': "[^"]+"', "g")) || [];
  ck(`  ${k} in four dictionaries, four distinct strings`, [hits.length, new Set(hits).size], [4, 4]);
}

ck("it is in the compiled bundle",
   fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8").includes("setAvailability"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
