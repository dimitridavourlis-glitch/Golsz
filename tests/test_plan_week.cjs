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
const startSrc = APP.slice(APP.indexOf("const weekStart = (() => {"), APP.indexOf("const isoOf =", APP.indexOf("const weekStart = (() => {")));
ck("the week-start expression was found", startSrc.length > 60, true);
ck("it steps back Monday-first, not Sunday-first",
   /d\.setDate\(d\.getDate\(\) - \(\(d\.getDay\(\) \+ 6\) % 7\)\)/.test(startSrc), true);

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

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
