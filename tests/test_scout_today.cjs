// SCOUT KNOWS WHAT DAY IT IS — THE ATHLETE'S DAY, BY HOME'S RULES.
//
// ADS-BUILD-ORDER.md Phase 6 item 2. Scout was told it had no date, so "what
// should I do today", THIS WEEK 2/5 and "you are late on one" were
// uncomputable: it saw due dates with nothing to compare them to. Now the app
// sends its local day, the server checks it (resolveAthleteDay), works out
// Home's three numbers (dayBuckets) and hands Scout the results.
//
// The rule that makes this safe is PARITY: Scout must say what Home shows.
// So this suite lifts Home's real code out of golsz-app.html, runs it under a
// pinned clock, and diffs it against the server's dayBuckets() on the same
// plans. A copy of either side would only prove the copy agrees with itself.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const BUNDLE = fs.readFileSync(REPO + "/js/app.js", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => { const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); } else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); } };
const between = (src, a, b, label) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`could not slice ${label} — markers moved, update this suite`);
  return src.slice(i, j);
};

// ---- the server helpers, lifted ------------------------------------------
const S = new Function(between(SCOUT, "function dueFromOffset(n, baseKey) {", "\nfunction extractSuggestedPathway", "day helpers") +
  "\nreturn { dueFromOffset, isDayKey, shiftDayKey, resolveAthleteDay, dayBuckets };")();

console.log("-- resolveAthleteDay: the device's day, checked --");
{
  const NOON = Date.parse("2026-10-28T12:00:00Z");
  const LATE = Date.parse("2026-10-28T23:30:00Z");   // Athens is already on the 29th
  const EARLY = Date.parse("2026-10-28T02:00:00Z");  // Toronto is still on the 27th
  ck("the device's own day is used", S.resolveAthleteDay("2026-10-28", NOON), { key: "2026-10-28", source: "device" });
  ck("a day ahead of UTC is a real timezone (east)", S.resolveAthleteDay("2026-10-29", LATE), { key: "2026-10-29", source: "device" });
  ck("a day behind UTC is a real timezone (west)", S.resolveAthleteDay("2026-10-27", EARLY), { key: "2026-10-27", source: "device" });
  ck("two days off is no timezone on Earth: the server's day is used",
     S.resolveAthleteDay("2026-10-30", NOON), { key: "2026-10-28", source: "server" });
  ck("...and a year off", S.resolveAthleteDay("2025-10-28", NOON), { key: "2026-10-28", source: "server" });
  ck("an impossible date is refused, not rolled into the next month",
     S.resolveAthleteDay("2026-02-30", Date.parse("2026-03-02T12:00:00Z")), { key: "2026-03-02", source: "server" });
  ck("a time-stamped string is refused", S.resolveAthleteDay("2026-10-28T00:00:00Z", NOON).source, "server");
  ck("a missing day falls back", S.resolveAthleteDay(undefined, NOON), { key: "2026-10-28", source: "server" });
  ck("a non-string falls back", S.resolveAthleteDay(20261028, NOON).source, "server");
  ck("year boundary, east of UTC", S.resolveAthleteDay("2027-01-01", Date.parse("2026-12-31T22:30:00Z")), { key: "2027-01-01", source: "device" });
}

console.log("\n-- due offsets count from the athlete's day --");
{
  ck("1 is tomorrow from their day", S.dueFromOffset(1, "2026-10-28"), "2026-10-29");
  ck("across a month end", S.dueFromOffset(4, "2026-10-28"), "2026-11-01");
  ck("across a year end", S.dueFromOffset(3, "2026-12-30"), "2027-01-02");
  ck("into a leap day", S.dueFromOffset(1, "2028-02-28"), "2028-02-29");
  const utcTomorrow = (() => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  ck("no day given: the server's day, exactly as before", S.dueFromOffset(1), utcTomorrow);
  ck("a malformed day is ignored, not trusted", S.dueFromOffset(1, "28/10/2026"), utcTomorrow);
  ck("the range rules are unchanged: 0 is no date", S.dueFromOffset(0, "2026-10-28"), null);
  ck("...and 731 is no date", S.dueFromOffset(731, "2026-10-28"), null);
}

console.log("\n-- the same numbers Home shows --");
// Home's code, lifted: the four helpers it calls and the block in HomeTab
// from homeTodayKey to todayDone.
const fnSrc = (name) => between(APP, `function ${name}(`, "\n}\n", name) + "\n}\n";
const HOME_BLOCK = between(APP, "  const homeTodayKey = isoDay(new Date());", "\n  const contacted", "HomeTab day block");
ck("the lifted Home block computes all three numbers",
   ["stepsLate", "weekSteps", "weekDone", "todaySteps", "todayDone"].every((k) => HOME_BLOCK.includes(`const ${k} =`)), true);
const homeAt = (y, mo, d) => {
  const Real = Date;
  const fixed = new Real(y, mo - 1, d, 12, 0, 0).getTime();   // local noon on that day
  class PinnedDate extends Real { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }
  return new Function("Date", "allMilestones", "resting",
    fnSrc("isoDay") + fnSrc("weekStartFrom") + fnSrc("suggestedDate") + fnSrc("canCallLate") + HOME_BLOCK +
    "\nreturn { today: homeTodayKey, weekFrom: weekFromKey, weekTo: weekToKey, todayTotal: todaySteps.length, todayDone, weekTotal: weekSteps.length, weekDone, lateCount: stepsLate };"
  ).bind(null, PinnedDate);
};
const serverAs = (key, ms, resting) => {
  const b = S.dayBuckets(ms, key, resting);
  return { today: b.today, weekFrom: b.weekFrom, weekTo: b.weekTo, todayTotal: b.todayTotal, todayDone: b.todayDone,
           weekTotal: b.weekTotal, weekDone: b.weekDone, lateCount: b.lateCount };
};
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
let compared = 0, mismatches = 0, firstBad = null, nonZero = { today: 0, week: 0, late: 0 }, restingDiffers = 0;
for (const [y, mo, d] of DAYS) {
  const home = homeAt(y, mo, d);
  const key = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  for (const plan of plansAround(key)) {
    for (const resting of [false, true]) {
      const h = home(plan, resting), s = serverAs(key, plan, resting);
      compared++;
      if (JSON.stringify(h) !== JSON.stringify(s)) { mismatches++; if (!firstBad) firstBad = { key, resting, h, s }; }
      if (h.todayTotal) nonZero.today++;
      if (h.weekTotal) nonZero.week++;
      if (h.lateCount) nonZero.late++;
    }
    if (serverAs(key, plan, false).lateCount !== serverAs(key, plan, true).lateCount) restingDiffers++;
  }
}
ck(`server and Home agree on every plan (${compared} compared)`, mismatches === 0 ? null : firstBad, null);
// The comparison must be able to fail, and the plans must exercise every
// bucket, or "they agree" means nothing.
ck("the plans exercise the today bucket", nonZero.today > 20, true);
ck("...the week bucket", nonZero.week > 50, true);
ck("...and the late bucket", nonZero.late > 50, true);
ck("resting changes the late count on real plans (the rule is exercised)", restingDiffers > 10, true);
ck("the instrument can see a disagreement (server run on the wrong day)",
   JSON.stringify(homeAt(2026, 10, 28)(plansAround("2026-10-28")[0], false)) === JSON.stringify(serverAs("2026-10-29", plansAround("2026-10-28")[0], false)), false);

console.log("\n-- dayBuckets details Home does not show but Scout needs --");
{
  const b = S.dayBuckets([
    { label: "Film the session", due: "2026-10-28", done: false },
    { label: "Retest 10m", due: "2026-10-28", done: true },
    { label: "Email coach", due: "2026-10-20", done: false },
  ], "2026-10-28", false);
  ck("weekday is named from the date, not the server clock", b.weekday, "Wednesday");
  ck("the week is Monday to Sunday", [b.weekFrom, b.weekTo], ["2026-10-26", "2026-11-01"]);
  ck("today's open steps are listed by label", b.todayOpen, ["Film the session"]);
  ck("a Sunday's week started six days earlier", [S.dayBuckets([], "2026-11-01", false).weekFrom, S.dayBuckets([], "2026-11-01", false).weekday], ["2026-10-26", "Sunday"]);
  ck("no plan is not an error", S.dayBuckets(null, "2026-10-28", false).weekTotal, 0);
  ck("null entries are skipped, not thrown on", S.dayBuckets([null, { due: "2026-10-28" }], "2026-10-28", false).todayTotal, 1);
}

console.log("\n-- wired end to end --");
{
  ck("the app sends its local day with every Scout request",
     /body: JSON\.stringify\(\{ messages: api,[^\n]*today: isoDay\(new Date\(\)\) \}\)/.test(APP), true);
  ck("...and the compiled bundle carries it", /today:isoDay\(new Date(\(\))?\)/.test(BUNDLE), true);
  ck("the handler checks it rather than trusting it", /const athleteDay = resolveAthleteDay\(body && body\.today\);/.test(SCOUT), true);
  ck("...and hands it to the state loader", /getAthleteState\(userId, athleteDay\)/.test(SCOUT), true);
  ck("the loader uses it for 'missed'", /const todayKey = \(day && isDayKey\(day\.key\)\) \? day\.key :/.test(SCOUT), true);
  const missed = between(SCOUT, "const missedActions = actionRows", ";", "missed");
  ck("...and 'missed' pauses while they rest, as Home's late count does",
     /\(!resting \|\| a\.category === "recovery"\)/.test(missed), true);
  ck("resting means exactly what Home means by it",
     /const resting = !!\(profileRow && profileRow\.availability_status === "out"\);/.test(SCOUT), true);
  ck("the action read carries the category that rule needs",
     /select=title,status,due_on,due_src,completed_at,category&/.test(SCOUT), true);
  ck("the loader returns Home's numbers", /dayBuckets: days,/.test(SCOUT), true);
  ck("new steps are dated from the same day", /today: athleteState\.day \? athleteState\.day\.key : null,/.test(SCOUT), true);

  const iAssign = SCOUT.indexOf("athleteBlock = `\\n\\nATHLETE STATE");
  const iToday = SCOUT.indexOf("TODAY FOR THEM: ${dd.weekday} ${dd.today}");
  ck("the TODAY FOR THEM line is built", iToday > 0, true);
  ck("...AFTER the assignment that would overwrite it", iToday > iAssign, true);
  const todayLine = between(SCOUT, "TODAY FOR THEM: ${dd.weekday}", "\n    }\n", "today line");
  ck("...it gives today's, this week's and the late count", /Due today:[\s\S]*This week:[\s\S]*Late \(dates they chose themselves/.test(todayLine), true);
  ck("...says when the day is the server's, not theirs", /the server's day; theirs may differ by one/.test(todayLine), true);
  ck("...and forbids date arithmetic of the model's own",
     /Use only dates written in this context; never work out another date or weekday yourself\./.test(SCOUT), true);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
