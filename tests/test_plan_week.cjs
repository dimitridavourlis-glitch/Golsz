// THE WEEK ON THE PLAN SCREEN, RUN RATHER THAN READ.
//
// NEXT 30 DAYS / NEXT 90 DAYS were horizons the app asserted. A fifteen-year-
// old does not plan in ninety-day windows — they plan around Tuesday training
// and Saturday's match, so "am I on track" is a question about this week.
//
// The week boundary is the part that can be quietly wrong: Monday-first when
// getDay() is Sunday-first, and a Sunday that must stay in the week it ends
// rather than jumping into the next one. Those are off-by-one bugs that look
// fine every day except one, and they are invisible from whichever weekday
// the author happened to test on. So this runs the real expressions, lifted
// from the source, across all seven weekdays.
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// The real week-start expression, lifted so a retyped copy cannot pass while
// production differs.
// Re-anchored 2026-09-12: the week maths was hoisted to ONE module-level
// definition after test_anchor_integrity caught "const isoOf =" matching
// twice — Home and Plan had each grown their own copy, which is three chances
// for two screens to disagree about what day it is.
const startSrc = APP.slice(APP.indexOf("function weekStartFrom(date) {"), APP.indexOf("\n}", APP.indexOf("function weekStartFrom(date) {")));
ck("the shared week-start function was found", startSrc.length > 60, true);
ck("it steps back Monday-first, not Sunday-first",
   /d\.setDate\(d\.getDate\(\) - \(\(d\.getDay\(\) \+ 6\) % 7\)\)/.test(startSrc), true);
// The point of hoisting: both screens must call the SAME thing, or "this
// week" can mean two different sets of days in one app.
ck("Plan derives its week from the shared function",
   /const weekStart = weekStartFrom\(todayIso\);/.test(APP), true);
ck("Home derives its week from the same shared function",
   /const start = weekStartFrom\(new Date\(\)\);/.test(APP), true);
ck("no component keeps a private copy of the date rule",
   /const isoOf = \(d\) =>/.test(APP), false);

const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const weekStartFor = (today) => {
  const d = new Date(today);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  d.setHours(0, 0, 0, 0);
  return d;
};
const weekOf = (today) => {
  const s = weekStartFor(today);
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(s); d.setDate(d.getDate() + i); return isoOf(d); });
};

console.log("\n-- every weekday lands in the same Monday-Sunday week --");
// 2026-09-07 is a Monday; 2026-09-13 the Sunday that closes that week.
const MON = "2026-09-07T12:00:00", SUN = "2026-09-13T12:00:00";
const expected = ["2026-09-07","2026-09-08","2026-09-09","2026-09-10","2026-09-11","2026-09-12","2026-09-13"];
for (let i = 0; i < 7; i += 1) {
  const d = new Date(MON); d.setDate(d.getDate() + i);
  ck(`${d.toDateString().slice(0, 3)} sees the same week`, weekOf(d), expected);
}
// The one that breaks with a Sunday-first calculation: Sunday must belong to
// the week it ENDS, not start a new one.
ck("Sunday stays in the week it closes", weekOf(new Date(SUN))[6], "2026-09-13");
ck("...and Monday is that week's first day", weekOf(new Date(SUN))[0], "2026-09-07");
ck("the next Monday does start a new week", weekOf(new Date("2026-09-14T12:00:00"))[0], "2026-09-14");

console.log("\n-- the calendar is built from days, not from rows --");
// A week drawn only from the rows cannot show the days with nothing on them,
// which is half of what makes a week worth looking at.
ck("seven cells are generated regardless of content",
   /Array\.from\(\{ length: 7 \}/.test(APP), true);
ck("a day's rows come from an exact date match on the athlete's own steps",
   /rows: milestones\.filter\(\(m\) => m\.due === key\)/.test(APP), true);
// Derived readiness/development items carry no date; putting them on a day
// would place work on a day the athlete never chose.
ck("only real steps land on a day", /next30\.forEach\(\(i\) => bandRows\.d30/.test(APP), true);

console.log("\n-- a step in this week is drawn once, not twice --");
ck("in-week steps are excluded from the bands below", /if \(weekKeys\.has\(m\.due\)\) return "inweek";/.test(APP), true);
ck("...and 'inweek' has no band of its own to render it again",
   /\{ key: "inweek", label:/.test(APP), false);

console.log("\n-- the horizons the app asserted are gone --");
ck("NEXT 30 DAYS is no longer a band label on Plan",
   /\{ key: "d30", label: t\("plan_next_30_title"\) \}/.test(APP), false);
ck("plan_week_title exists in all four dictionaries",
   (APP.match(/plan_week_title:/g) || []).length, 4);
ck("plan_week_empty exists in all four dictionaries",
   (APP.match(/plan_week_empty:/g) || []).length, 4);

console.log("\n-- Home's calendar says what is in it --");
// Seven boxes that never name their contents are a picture of a week. The
// footer line is what makes the grid worth looking at, and the day it picks
// is the part that can be quietly wrong, so run the real expression.
const upSrc = (APP.match(/const upcoming = days\.find\([^;]*;/) || [""])[0];
ck("the upcoming-day expression was found", upSrc.length > 40, true);
const pickUpcoming = new Function("days", "todayK", upSrc + " return upcoming;");
const wk = (spec) => Object.keys(spec).map((k) => ({ key: k, rows: spec[k].map((done) => ({ done })) }));
const D = ["2026-09-07","2026-09-08","2026-09-09","2026-09-10","2026-09-11","2026-09-12","2026-09-13"];
const blank = () => { const o = {}; D.forEach((d) => { o[d] = []; }); return o; };
const on = (day, rows) => { const o = blank(); o[day] = rows; return o; };

ck("today is picked when today still has open work",
   (pickUpcoming(wk(on("2026-09-10", [false])), "2026-09-10") || {}).key, "2026-09-10");
ck("a today with nothing left open hands off to the next day that has work",
   (pickUpcoming(wk({ ...blank(), "2026-09-10": [true, true], "2026-09-12": [false] }), "2026-09-10") || {}).key, "2026-09-12");
// Late is its own state and belongs at the front of the week as a count, not
// as "your next day" — pointing an athlete at Tuesday when Tuesday has gone
// is worse than saying nothing.
ck("a past day's open step is never offered as the next day",
   pickUpcoming(wk(on("2026-09-08", [false])), "2026-09-10"), null);
ck("a fully done week offers no day", pickUpcoming(wk(on("2026-09-11", [true, true])), "2026-09-10"), null);
ck("the EARLIEST qualifying day wins, not the last",
   (pickUpcoming(wk({ ...blank(), "2026-09-11": [false], "2026-09-13": [false] }), "2026-09-10") || {}).key, "2026-09-11");
ck("an empty week offers no day", pickUpcoming(wk(blank()), "2026-09-10"), null);
ck("the footer prints the step's own label, not a count",
   /homeWeek\.upcoming\.rows\.find\(\(m\) => !m\.done\)\.label/.test(APP), true);
ck("a week with work all done says so rather than falling silent",
   /homeWeek\.count === 0 \? t\("home_week_empty"\) : t\("home_week_clear"\)/.test(APP), true);

console.log("\n-- the week states its own dates --");
// "THIS WEEK" over bare numerals 7 to 13 does not say which seven days those
// are. A week that straddles two months has to print both.
const rangeStart = APP.indexOf("const weekRangeLabel = (() => {");
const rangeSrc = APP.slice(rangeStart, APP.indexOf("})();", rangeStart) + 5);
ck("the range expression was found", rangeSrc.length > 120, true);
const rangeOf = new Function("homeWeek", "lang", rangeSrc + " return weekRangeLabel;");
const daysFrom = (iso) => ({ days: Array.from({ length: 7 }, (_, i) => {
  const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + i); return { date: d };
}) });
ck("one month prints one month name", rangeOf(daysFrom("2026-09-07"), "en"), "Sep 7 — 13");
ck("a week across two months prints both", rangeOf(daysFrom("2026-09-28"), "en"), "Sep 28 — Oct 4");
ck("no week, no label", rangeOf(null, "en"), "");

console.log("\n-- today is a mark, not a form field --");
// An outline is how a text input says "focused". A calendar marks today by
// filling it, and an athlete should be able to find today without reading.
ck("today's cell is filled", /background: d\.isToday \? C\.lime/.test(APP), true);
ck("...and its numerals invert onto the fill", /const ink = d\.isToday \? C\.pitch/.test(APP), true);
ck("the day numeral of a day already gone recedes",
   /opacity: past && !d\.rows\.length \? 0\.5 : 1/.test(APP), true);
// Fading the whole cell erased its border — C.line is 8% alpha, and
// 8% of 42% is nothing — so the row stopped reading as seven days.
ck("...but the cell itself is never faded", /opacity: past && !d\.rows\.length \? 0\.42/.test(APP), false);
ck("every day keeps a visible frame",
   /border: `1px solid \$\{d\.isToday \? C\.lime : all \? "transparent" : d\.rows\.length \? C\.line2 : C\.line\}`\}\}>/.test(APP), true);
// Capping the dots and saying nothing loses exactly the days worth seeing.
ck("a day with more than three steps shows the count instead of three dots",
   /d\.rows\.length > 3 \? \(/.test(APP), true);
ck("the old full-width empty-state button is gone", /home_week_open/.test(APP), false);
ck("home_week_today exists in all four dictionaries",
   (APP.match(/home_week_today:/g) || []).length, 4);
ck("home_week_clear exists in all four dictionaries",
   (APP.match(/home_week_clear:/g) || []).length, 4);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
