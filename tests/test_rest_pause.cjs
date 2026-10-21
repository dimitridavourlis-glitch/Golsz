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

// Every CALL to suggestedDate is named, so a new one has to be justified here
// rather than appearing silently at a fifth site. Comment lines are stripped
// first: the file explains the predicate in prose in several places, and
// counting those would make this drift every time someone writes a sentence.
//
//   1. its own definition
//   2. canCallLate, which is the lateness rule
//   3. milestoneRank, which decides what comes NEXT (not what is late)
//   4. the stop screen, which DISCLOSES that a date was Scout's guess
//
// Only 2 is a lateness judgement. 4 is the opposite of one - it tells the
// athlete whose date it is so they can decide whether to keep it.
const CODE = APP.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
ck("suggestedDate has exactly four callers", (CODE.match(/suggestedDate\(/g) || []).length, 4);
ck("...one of which is the lateness rule", /if \(suggestedDate\(m\)\) return false;/.test(CODE), true);
ck("...one the next-step preference", /return suggestedDate\(m\) \? 1 : 0;/.test(CODE), true);
ck("...and one a disclosure, not a judgement", /\{suggestedDate\(step\) \? \(/.test(CODE), true);

/* ---------- resting reaches those sites ---------- */

ck("both label helpers take resting", /function milestoneDateLabel\(m, lang, t, resting\)/.test(APP), true);
ck("GolszApp derives resting from the status, not from a guess",
   /const resting = availabilityStatus === "out";/.test(APP), true);
// Home and Plan each render twice (sidebar + mobile), PathwayPlan once, and
// the road and the stop screen one each. Seven. The number matters less than
// that it is pinned: a screen that shows dates and never receives `resting`
// will call an injured athlete late.
ck("resting reaches every screen that shows a date",
   (APP.match(/resting=\{resting\}/g) || []).length, 7);

/* ---------- the cron, which reaches them with the app closed ---------- */

// COMMENT LINES STRIPPED BEFORE ANY OF THIS. The route explains its own
// history in prose, including the old query verbatim - "This used to be
// `profiles?availability_status=eq.out&select=id` with no limit" - and the
// assertion below used to be satisfied by that sentence. It passed while
// matching a comment, which means the live lookup could have been deleted
// outright and this suite would still have been green, on the one guard
// standing between an injured athlete and a push telling them they are late.
const CRON_CODE = CRON.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
ck("the nudge looks up who is resting, in code and not in a comment",
   /profiles\?id=in\.[^&]*&availability_status=eq\.out&select=id/.test(CRON_CODE), true);
ck("...and the old uncapped shape is not what is running",
   /profiles\?availability_status=eq\.out&select=id/.test(CRON_CODE), false);
// NOT `not.eq.out`: in PostgREST that excludes NULL rows, and NULL is the
// status of every athlete who has never answered - which is most of them. The
// inequality would have silently stopped nudging almost everybody.
ck("...by selecting who IS out, never by excluding who is not",
   /availability_status=not\.eq\.out/.test(CRON), false);
ck("...and skips them", /if \(resting\.has\(row\.user_id\) && row\.category !== "recovery"\)/.test(CRON), true);
// IT FAILS CLOSED. This lookup decides who is NOT told they are late, so an
// empty answer means "push to everyone". supaSelect returns [] on a failed
// request, which is indistinguishable from "nobody is injured" - one bad
// response would have pushed "the day you set has passed" to every hurt
// athlete on the platform, on the one surface that reaches them with the app
// shut. A missed nudge is recoverable next run; that push is not.
ck("a reader that can report failure exists",
   /async function supaSelectOrNull\(/.test(CRON_CODE), true);
ck("...and the availability lookup uses it, not the one that returns []",
   /const got = await supaSelectOrNull\(supaUrl, serviceKey,/.test(CRON_CODE), true);
ck("...and a failed read abandons the loop instead of pushing",
   /if \(got === null\) \{[\s\S]{0,420}return \{ checked: rows\.length, reminded: 0, paused: 0,/.test(CRON_CODE), true);
ck("...and says so in the response rather than reporting a quiet zero",
   /skipped: "availability unreadable"/.test(CRON_CODE), true);

// The stale-target scan had the same uncapped shape this file fixed for the
// due-step query, 70 lines above it in the same route.
ck("the outreach scan is capped",
   /&order=updated_at\.asc&limit=500/.test(CRON_CODE), true);
ck("...and a failed scan is raised, not read as an empty night",
   /if \(targets === null\) throw new Error\("outreach target scan failed"\);/.test(CRON_CODE), true);
// Sequential loops doing three round trips a row need longer than the default.
ck("the route is allowed to finish", /export const config = \{ maxDuration: 60 \};/.test(CRON_CODE), true);

ck("...without stamping the nudge it never sent",
   CRON.indexOf("resting.has(row.user_id)") < CRON.indexOf("last_reminded_at: new Date()"), true);
ck("...once, not once per row", (CRON_CODE.match(/availability_status=eq\.out/g) || []).length, 1);
// AND IT CANNOT BE TRUNCATED. An uncapped PostgREST select stops at max-rows
// (1000 on Supabase) and still returns 200, so once more than that many
// athletes were marked out the ones past the cut-off would silently fall out
// of the Set and be pushed "the day you set has passed" while injured.
// Scoping the lookup to the ids already in hand makes that impossible.
ck("...scoped to the candidates, not to the whole user base",
   /profiles\?id=in\.\(\$\{chunk\.join\(","\)\}\)&availability_status=eq\.out/.test(CRON_CODE), true);
ck("...and chunked, so no single request can exceed what it asks for",
   /for \(let i = 0; i < candidateIds\.length; i \+= 100\)/.test(CRON_CODE), true);
ck("...with no unbounded profiles select left anywhere in the route",
   /profiles\?availability_status=eq\.out&select=id`\)/.test(CRON_CODE), false);
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
