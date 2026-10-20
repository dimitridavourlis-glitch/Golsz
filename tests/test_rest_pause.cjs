// NOTHING IS LATE WHILE SOMEONE IS INJURED.
//
// "Late" is a judgement, and it is the wrong one to make of an athlete who is
// hurt. The pause changes only what is SHOWN: this file's central assertion is
// that no due date is moved, rewritten or deleted anywhere in it, so the
// moment they tap "I'm better" every date says exactly what it said before.
//
// The brief asked for "every former !suggestedDate( lateness site uses
// canCallLate(". Written that way the test is wrong: one of those sites is
// nextMilestone's filter, which answers "what should I do next", not "is this
// late", and must keep its old predicate. So this asserts BOTH directions -
// the five that changed, and the one that must not.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const CRON = fs.readFileSync(path.join(REPO, "api", "target-followup-reminders.js"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};
const grab = (sig) => {
  const at = APP.indexOf(sig);
  if (at < 0) return "";
  return APP.slice(at, APP.indexOf("\n}", at) + 2);
};

/* ---------- the predicate, executed ---------- */

const src = grab("function canCallLate(m, resting) {");
ck("canCallLate exists", src.length > 0, true);
let canCallLate = () => "NOT LOADED";
if (src) {
  try {
    canCallLate = new Function("suggestedDate", src + " return canCallLate;")(
      (m) => !!(m && (m.due_src === "scout" || m.due_src === "retest") && m.due));
  } catch (e) { canCallLate = () => "DID NOT EVAL: " + e.message; }
}

const MINE = { id: "m", due: "2020-01-01", done: false, due_src: null };
const SUG = { id: "s", due: "2020-01-01", done: false, due_src: "scout" };
const RETEST = { id: "r", due: "2020-01-01", done: false, due_src: "retest" };

ck("an athlete's own date can be called late", canCallLate(MINE, false), true);
ck("...but never while they are resting", canCallLate(MINE, true), false);
ck("a date Scout guessed is never late", canCallLate(SUG, false), false);
ck("a retest date GOLSZ picked is never late", canCallLate(RETEST, false), false);
ck("...and resting changes neither", canCallLate(SUG, true), false);

// Section 4.3: recovery work keeps its deadlines, because "see the physio on
// Tuesday" is exactly the date that still matters when you are hurt.
ck("recovery work stays normal while resting",
   canCallLate({ ...MINE, category: "recovery" }, true), true);
ck("...but not if the date was Scout's guess",
   canCallLate({ ...SUG, category: "recovery" }, true), false);
// m.category is populated only when SCOUT proposed the step (migration 155
// seeds athlete_actions on insert only), so an unknown category must fail
// SAFE: paused, never a step wrongly marked late at an injured athlete.
ck("any other category is paused while resting",
   canCallLate({ ...MINE, category: "training" }, true), false);
ck("an uncategorised step is paused, not late",
   canCallLate({ ...MINE, category: null }, true), false);
ck("a missing milestone does not throw", canCallLate(null, true), false);

/* ---------- the pause reads; it never writes ---------- */

// The whole safety property. If this function ever learns the word "due" it
// has started deciding dates rather than describing them.
ck("the pause never touches a due date", /\bdue\b/.test(src), false);
ck("...and mutates nothing", /(\.due\s*=|\.push\(|\.splice\(|save|set[A-Z])/.test(src), false);

/* ---------- the five sites that changed ---------- */

const SITES = [
  ["Home's next-step overdue flag", /const stepOverdue = !!\(pathwayNext && pathwayNext\.due && canCallLate\(pathwayNext, resting\)/],
  ["Home's plan-door late count", /const stepsLate = allMilestones\.filter\(\(m\) => !m\.done && m\.due && canCallLate\(m, resting\)/],
  ["Plan's overdue count", /const overdueCount = milestones\.filter\(\(m\) => !m\.done && m\.due && canCallLate\(m, resting\)/],
  ["the date label's overdue tone", /if \(n < 0 && !canCallLate\(m, resting\)\) return \{ text: short, tone: "flat" \};/],
  ["the OVERDUE band", /if \(days < 0 && !canCallLate\(m, resting\)\) return "undated";/],
];
for (const [name, re] of SITES) ck(`${name} asks canCallLate`, re.test(APP), true);

// THE SITE THAT MUST NOT CHANGE. nextMilestone picks what to show next; it
// prefers a date the athlete chose over one Scout guessed. That is a
// preference, not a lateness judgement, and an injured athlete still has a
// next step.
// nextMilestone now sorts through the shared comparator, so the preference
// lives in milestoneRank. The claim is unchanged: choosing what to do NEXT
// must weigh whose date it is, and must never weigh whether the athlete is
// injured. An injured athlete still has a next step; it is simply not late.
ck("the next-step preference still asks whose date it is",
   /return suggestedDate\(m\) \? 1 : 0;/.test(APP), true);
const rankSrc = grab("function milestoneRank(m) {");
ck("...and milestoneRank exists to hold it", rankSrc.length > 0, true);
ck("...and it never consults resting", /resting/.test(rankSrc), false);
const cmpSrc = grab("function compareUndone(a, b) {");
ck("...nor does the comparator", /resting|canCallLate/.test(cmpSrc), false);
const nextSrc = grab("function nextMilestone(milestones) {");
ck("nextMilestone never consults resting", /resting|canCallLate/.test(nextSrc), false);

// Exactly three CALLS to suggestedDate survive: its own definition, the call
// inside canCallLate, and nextMilestone's filter. A fourth means a lateness
// site was missed. Comment lines are stripped first - the file explains the
// predicate in prose in several places, and counting those would make this
// assertion drift every time someone writes a sentence about it.
const CODE = APP.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
ck("no lateness site still asks suggestedDate directly",
   (CODE.match(/suggestedDate\(/g) || []).length, 3);

/* ---------- resting reaches those sites ---------- */

ck("both label helpers take resting", /function milestoneDateLabel\(m, lang, t, resting\)/.test(APP), true);
ck("GolszApp derives resting from the status, not from a guess",
   /const resting = availabilityStatus === "out";/.test(APP), true);
// Home and Plan each render twice (sidebar + mobile), and PathwayPlan once.
ck("resting is handed to every screen that judges lateness",
   (APP.match(/resting=\{resting\}/g) || []).length, 5);

/* ---------- the cron, which reaches them with the app closed ---------- */

ck("the nudge looks up who is resting", /profiles\?availability_status=eq\.out&select=id/.test(CRON), true);
// NOT `not.eq.out`: in PostgREST that excludes NULL rows, and NULL is the
// status of every athlete who has never answered - which is most of them. The
// inequality would have silently stopped nudging almost everybody.
ck("...by selecting who IS out, never by excluding who is not",
   /availability_status=not\.eq\.out/.test(CRON), false);
ck("...and skips them", /if \(resting\.has\(row\.user_id\) && row\.category !== "recovery"\)/.test(CRON), true);
ck("...without stamping the nudge it never sent",
   CRON.indexOf("resting.has(row.user_id)") < CRON.indexOf("last_reminded_at: new Date()"), true);
ck("...once, not once per row", (CRON.match(/availability_status=eq\.out/g) || []).length, 1);
ck("...and reports the pause, so it is not mistaken for a broken cron",
   /reminded: sent, paused \}/.test(CRON), true);

/* ---------- translations ---------- */

for (const k of ["rest_title", "rest_sub", "rest_paused", "rest_nothing_late", "rest_back_q",
                 "rest_back_hint", "rest_tell_scout", "rest_scout_seed", "rest_continue",
                 "rest_doctor", "resting_banner_strong", "resting_banner", "resting_better"]) {
  ck(`${k} is translated in all 4 languages`, (APP.match(new RegExp(`\\b${k}: "`, "g")) || []).length, 4);
}

ck("it is in the compiled bundle",
   fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8").includes("canCallLate"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
