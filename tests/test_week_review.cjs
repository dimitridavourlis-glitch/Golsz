// THE WEEK THAT JUST ENDED — the brief's ADJUST step, and the first thing in
// GOLSZ that looks backwards rather than forwards.
//
// It reads athlete_actions, which is the FIRST reader that table has ever had.
// That matters for two reasons beyond the feature: the table is kept equal to
// the plan by sync_athlete_actions() on every write, so a review built on it
// cannot disagree with what the athlete sees on Plan; and completed_at there
// is a real completion moment, which the jsonb only started recording today.
//
// Most of these assertions are about what it REFUSES to say. A review is a
// surface that tells someone they fell short, so every number on it has to be
// one the product can stand behind.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const grab = (sig) => {
  const at = APP.indexOf(sig);
  if (at < 0) throw new Error("not found: " + sig);
  return APP.slice(at, APP.indexOf("\n}", at) + 2);
};
const weekReview = vm.runInNewContext(
  grab("function isoDay(d) {") + "\n" +
  grab("function weekStartFrom(date) {") + "\n" +
  grab("function weekReview(rows, now) {") + "\nweekReview");

// Wednesday 14 Oct 2026. The week before is Mon 5 Oct – Sun 11 Oct.
const NOW = new Date(2026, 9, 14, 11, 0, 0);
const LAST = { from: "2026-10-05", to: "2026-10-11" };
const ts = (d, h = 12) => new Date(2026, 9, d, h, 0, 0).toISOString();

// Null-safe on purpose. Written as r.fromKey directly, a mutation that made
// the window the CURRENT week produced an inverted range, matched nothing,
// returned null and CRASHED the suite — which exits non-zero, so it is caught,
// but a stack trace tells a reader far less than a failed expectation.
ck("the window is the week BEFORE this one",
   (() => { const r = weekReview([{ status: "completed", completed_at: ts(7) }], NOW);
            return r ? [r.fromKey, r.toKey] : "no review at all"; })(),
   [LAST.from, LAST.to]);

// ---- what it counts --------------------------------------------------------
{
  const rows = [
    { title: "Film the Brevard game", status: "completed", completed_at: ts(7) },
    { title: "Email three coaches", status: "completed", completed_at: ts(11, 22) },
    { title: "Sprint retest", status: "open", due_on: "2026-10-08" },
    { title: "Abandoned idea", status: "dropped", due_on: "2026-10-09" },
  ];
  const r = weekReview(rows, NOW);
  ck("completions are listed by name, not just counted",
     r.completed, ["Film the Brevard game", "Email three coaches"]);
  ck("a step still open whose day has passed is missed", r.missed, ["Sprint retest"]);
  ck("a dropped step is counted, not listed as missed", [r.droppedCount, r.missed.length], [1, 1]);
}

// ---- what it must NOT count ------------------------------------------------
{
  const outside = [
    { title: "This week's work", status: "completed", completed_at: ts(13) },   // after the window
    { title: "Two weeks ago", status: "completed", completed_at: ts(1) },        // before it
    { title: "Due this week", status: "open", due_on: "2026-10-15" },
    { title: "Undated and open", status: "open", due_on: null },
  ];
  ck("nothing outside the window appears at all", weekReview(outside, NOW), null);
}
{
  // A completion on the LAST day of the window, late in the evening. Compared
  // as a UTC instant rather than a local day, a Sunday-night finish lands in
  // the wrong week for anyone west of UTC.
  const r = weekReview([{ title: "Sunday night", status: "completed", completed_at: ts(11, 23) }], NOW);
  ck("a Sunday-evening completion is in the week it happened", r && r.completed, ["Sunday night"]);
}
{
  const r = weekReview([{ title: "Monday 00:30", status: "completed", completed_at: ts(5, 0) }], NOW);
  ck("...and so is one in the first hour of Monday", r && r.completed, ["Monday 00:30"]);
}

// ---- when it refuses to speak ---------------------------------------------
ck("no rows at all is no review", weekReview([], NOW), null);
ck("null rows is no review", weekReview(null, NOW), null);
// An empty scoreboard every Monday is worse than silence for an athlete who
// has no dated steps — which is most of them.
ck("a week with nothing in it produces no card",
   weekReview([{ title: "Someday", status: "open", due_on: null }], NOW), null);
ck("a malformed completion date does not count as a completion",
   weekReview([{ title: "Broken", status: "completed", completed_at: "whenever" }], NOW), null);
ck("...nor does a missing one", weekReview([{ title: "No date", status: "completed", completed_at: null }], NOW), null);

// ---- what it does not claim ------------------------------------------------
{
  const src = grab("function weekReview(rows, now) {")
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  // The brief asks for a rescheduled count. Nothing records a date change —
  // the old date is overwritten — so it cannot be known, only inferred.
  ck("it does not report a rescheduled count", /resched/i.test(src), false);
  // "What changed as a result" needs a score history, and there is none.
  ck("it does not score, rank or compare weeks", /score|percent|streak|better|worse/i.test(src), false);
  ck("...and the stripped body is still the real function", /weekStartFrom\(now\)/.test(src), true);
}

// ---- wired in, and reading the right table --------------------------------
ck("Home computes it from the action rows", /setReview\(weekReview\(actionRows, new Date\(\)\)\);/.test(APP), true);
ck("...which come from athlete_actions",
   /sb\.from\("athlete_actions"\)\.select\("title, status, completed_at, due_on"\)\.eq\("user_id", who\)/.test(APP), true);
// BY THE ARRAY'S REAL BOUNDS, not a character count. Written as a 2200-char
// window first, it failed at 2756 — the same silent-window trap that has now
// bitten three assertions in this repo. A window that stops short does not
// report a problem; it reports absence.
{
  // Anchored on Home's own destructuring, which is unique, rather than on
  // "await Promise.all([" — that appears 22 times, and a fromIndex that picks
  // "the first one after HomeTab" is a guess dressed as a locator.
  const open = APP.indexOf("const [{ data: prof }, { data: ath }, { data: reqs }");
  const close = APP.indexOf("\n        ]);", open);
  ck("Home's parallel load was located", open > 0 && close > open, true);
  const block = APP.slice(open, close);
  ck("...in the same round trip, not a ninth await",
     /from\("athlete_actions"\)/.test(block), true);
  // The thing the bound is protecting: nothing may await between them.
  // Comments stripped first — the comment explaining this very rule uses the
  // word, and matched. Describing a banned construct is not writing one, but
  // a grep cannot tell the difference.
  const code = block.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  ck("...and nothing inside the array awaits separately",
     /\bawait\b/.test(code.replace("await Promise.all([", "")), false);
  ck("...and the stripped block still holds every read",
     (code.match(/sb\.from\("/g) || []).length >= 10, true);
}
ck("the card renders only when there is a review", /\{review && \(/.test(APP), true);
ck("...completions in gold, misses in amber",
   /t\("review_done"\)[\s\S]{0,40}|C\.lime/.test(APP) && /color: C\.amber[\s\S]{0,80}?t\("review_missed"\)/.test(APP), true);

// A table the app reads about you must be in your export, or its absence
// reads as "there was nothing there".
// Matched up to the owner column, not to the end of the row: the sort key
// after it is test_data_export's invariant, not this suite's.
ck("the table is in the data export",
   /\["athlete_actions", "athlete_actions", "user_id"[,\]]/.test(APP), true);
// ...and in the privacy policy, which enumerates categories specifically
// enough that an omission is a claim.
{
  const PRIV = fs.readFileSync(path.join(REPO, "privacy.html"), "utf8");
  ck("the policy discloses plan and training data", /Plan and training data\./.test(PRIV), true);
  ck("...including when a step was completed or dropped", /completed or dropped/.test(PRIV), true);
  ck("...and says GOLSZ does not score it", /does not measure, score or verify/.test(PRIV), true);
}

for (const k of ["review_title", "review_done", "review_more", "review_none_done", "review_missed", "review_missed_note"]) {
  const hits = APP.match(new RegExp("\\b" + k + ': "[^"]+"', "g")) || [];
  ck(`  ${k} in four dictionaries, four distinct strings`, [hits.length, new Set(hits).size], [4, 4]);
}
for (const k of ["review_done", "review_more", "review_missed"]) {
  const hits = APP.match(new RegExp("\\b" + k + ': "([^"]+)"', "g")) || [];
  ck(`  ${k} interpolates {n} in every language`, hits.every((h) => h.includes("{n}")), true);
}

ck("it is in the compiled bundle",
   fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8").includes("weekReview"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
