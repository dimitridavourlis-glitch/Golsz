// THE SERVER'S DAY AND HOME'S DAY, EACH LIFTED OUT OF ITS OWN SOURCE.
//
// Shared by tests/test_scout_today.cjs (dayBuckets against Home's numbers),
// tests/test_scout_today_answer.cjs (todayCard and pickNextMilestone against
// Home's Today tile) and tests/test_scout_today_card.cjs (the app's "From your
// plan" card against Home's tiles). Not a suite: run-all.cjs only runs test_*.cjs.
// Both sides are read out of api/scout.js and golsz-app.html at run time; a
// copy of either would only prove the copy agrees with itself.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");

const between = (src, a, b, label) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`could not slice ${label} — markers moved, update this suite`);
  return src.slice(i, j);
};

// ---- the server helpers, lifted ------------------------------------------
const S = new Function(between(SCOUT, "function dueFromOffset(n, baseKey) {", "\nfunction extractSuggestedPathway", "day helpers") +
  "\nreturn { dueFromOffset, isDayKey, shiftDayKey, resolveAthleteDay, dayBuckets, pickNextMilestone, todayCard, isTodayQuestion, typedQuestion, datesInContext, checkReplyAgainstPlan };")();

// ---- Home's code, lifted -------------------------------------------------
// The helpers HomeTab calls and its block from homeTodayKey to todayDone, run
// under a clock pinned to local noon on the given day, then `tail`.
const fnSrc = (name) => between(APP, `function ${name}(`, "\n}\n", name) + "\n}\n";
const HOME_BLOCK = between(APP, "  const homeTodayKey = isoDay(new Date());", "\n  const contacted", "HomeTab day block");
const runHome = (y, mo, d, tail) => {
  const Real = Date;
  const fixed = new Real(y, mo - 1, d, 12, 0, 0).getTime();   // local noon on that day
  class PinnedDate extends Real { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }
  return new Function("Date", "allMilestones", "resting",
    fnSrc("isoDay") + fnSrc("weekStartFrom") + fnSrc("suggestedDate") + fnSrc("canCallLate") + HOME_BLOCK + tail
  ).bind(null, PinnedDate);
};
// Home's three numbers: TODAY, THIS WEEK and late.
const homeAt = (y, mo, d) => runHome(y, mo, d,
  "\nreturn { today: homeTodayKey, weekFrom: weekFromKey, weekTo: weekToKey, todayTotal: todaySteps.length, todayDone, weekTotal: weekSteps.length, weekDone, lateCount: stepsLate };");
// Home's Today tile: the step it names (nextMilestone, and that step's
// milestoneRank), its "N to do" badge (todoLeft), and the open steps due today
// that the badge counts, in plan order.
const TODO_LEFT = between(APP, "    const todoLeft = ", ";\n", "the Today tile's badge") + ";\n";
const homeTileAt = (y, mo, d) => runHome(y, mo, d,
  fnSrc("milestoneRank") + fnSrc("compareUndone") + fnSrc("nextMilestone") + TODO_LEFT +
  "const next = nextMilestone(allMilestones);" +
  "\nreturn { next, nextRank: next ? milestoneRank(next) : null, todoLeft, todayOpen: todaySteps.filter((m) => !m.done).map((m) => m.label) };");

// ---- the plans both sides are run on -------------------------------------
// Deterministic plans around the day: past, today, this week, next week,
// undated, Scout- and retest-suggested dates, recovery steps, done and not.
let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const plansAround = (key) => Array.from({ length: 40 }, () => Array.from({ length: 1 + rnd(14) }, (_, i) => ({
  id: "m" + i, label: "Step " + i,
  due: rnd(6) === 0 ? null : rnd(15) === 0 ? "" : S.shiftDayKey(key, rnd(25) - 12),
  done: rnd(3) === 0,
  due_src: [undefined, null, "scout", "retest", null][rnd(5)],
  category: [undefined, "recovery", "training", null][rnd(4)],
})));
// Mondays, Sundays, mid-week, a month end, a year end, a leap day.
const DAYS = [[2026, 10, 26], [2026, 10, 28], [2026, 11, 1], [2026, 10, 31], [2026, 12, 31], [2027, 1, 3], [2028, 2, 29], [2027, 3, 29]];

// runHome is exported for tests/test_scout_today_card.cjs, which reads Home's
// TODAY and THIS WEEK tiles with their own expressions in that same scope.
module.exports = { between, S, HOME_BLOCK, runHome, homeAt, homeTileAt, plansAround, DAYS };
