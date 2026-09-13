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
// Plan's week is no longer hand-written at all: it comes from calendarGrid,
// the one derivation Home and Plan share across all three scales. That is the
// whole point — two screens each hand-rolling a week, a month and a year is
// six chances to disagree about what days those are.
ck("Plan derives its calendar from the shared derivation",
   /const calView = calendarGrid\(calScale, calCursor, milestones\);/.test(APP), true);
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
   /rows: byDay\.get\(key\) \|\| \[\]/.test(APP), true);
// Derived readiness/development items carry no date; putting them on a day
// would place work on a day the athlete never chose.
// They are filed as UNDATED rather than into a horizon band: a readiness task
// and a development goal carry no date until the athlete gives them one, and
// d30/d90 merge into a heading that says LATER — a horizon assertion, which is
// exactly what NEXT 30 DAYS / NEXT 90 DAYS were deleted for.
ck("only real steps land on a day", /next30\.forEach\(\(i\) => bandRows\.undated/.test(APP), true);
ck("...and development goals file the same way", /devItems\.forEach\(\(i\) => bandRows\.undated/.test(APP), true);
ck("no derived row is filed into a horizon band",
   /bandRows\.d(30|90)\.push/.test(APP), false);

console.log("\n-- a step in this week is drawn once, not twice --");
ck("in-week steps are excluded from the bands below", /if \(weekKeys\.has\(m\.due\)\) return "inweek";/.test(APP), true);
// ORDER MATTERS, and it was wrong until 2026-09-13. With the overdue test
// first, a step due Monday and still undone was drawn on Monday in the grid
// AND again under OVERDUE — survivable while the grid was read-only dots, not
// survivable once tapping a day opens that same step in an editor directly
// above the duplicate. Run the real function rather than trusting the reading.
{
  const src = APP.slice(APP.indexOf("function milestoneBand(m) {"));
  const body = src.slice(0, src.indexOf("\n  }") + 4);
  const band = new Function("todayIso", "weekKeys", "suggestedDate", body + " return milestoneBand;");
  const today = new Date("2026-09-13T00:00:00");
  const thisWeek = new Set(["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"]);
  const f = band(today, thisWeek, (m) => !!(m && m.due_src === "scout" && m.due));
  ck("an overdue step inside the drawn window is the calendar's, not the band's",
     f({ due: "2026-09-10", done: false }), "inweek");
  ck("...while one outside it is still overdue",
     f({ due: "2026-08-10", done: false }), "overdue");
  ck("a done step past its date is finished, not late", f({ due: "2026-08-10", done: true }), "d30");
  ck("an untouched Scout suggestion that passed asks for a real day",
     f({ due: "2026-08-10", done: false, due_src: "scout" }), "undated");
  ck("...but inside the drawn window the calendar owns it",
     f({ due: "2026-09-10", done: false, due_src: "scout" }), "inweek");
  ck("a step with no date at all is undated", f({ due: null, done: false }), "undated");
  ck("a future step outside the window still bands by horizon",
     f({ due: "2026-10-01", done: false }), "d30");
}
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

console.log("\n-- the calendar at three scales, RUN --");
// One derivation now serves Home and Plan at week, month and year. A regex can
// confirm it is called; only running it can confirm that a month pads to whole
// weeks, that a year rolls from the cursor instead of starting in January, and
// that paging lands where it should across a DST boundary and a leap day.
const grab2 = (sig) => {
  const start = APP.indexOf(sig);
  if (start < 0) throw new Error(sig + " not found");
  let d = 0, j = APP.indexOf("{", start);
  for (; j < APP.length; j++) { if (APP[j] === "{") d++; else if (APP[j] === "}") { d--; if (!d) break; } }
  return APP.slice(start, j + 1);
};
eval(grab2("function isoDay(d) {"));
eval(grab2("function weekStartFrom(date) {"));
eval(grab2("function calendarGrid(scale, cursor, rows) {"));
eval(grab2("function calendarStep(scale, cursor, dir) {"));
eval(grab2("function calendarReach(rows) {"));
const D2 = (iso) => new Date(iso + "T12:00:00");
const step = (due) => ({ id: due, label: due, done: false, due });

{
  const g = calendarGrid("week", D2("2026-09-09"), [step("2026-09-10"), step("2026-09-10")]);
  ck("a week is seven days", g.days.length, 7);
  ck("...Monday first", g.days[0].key, "2026-09-07");
  ck("...Sunday last", g.days[6].key, "2026-09-13");
  ck("a day collects every step that matches it", g.days[3].rows.length, 2);
  ck("a day with nothing on it is still a cell", g.days[0].rows.length, 0);
  ck("year mode is not populated at week scale", g.months, null);
}
{
  // September 2026 starts on a Tuesday and ends on a Wednesday, so a month
  // padded to whole Monday-Sunday weeks must reach back into August and
  // forward into October — otherwise the columns do not line up under one row
  // of weekday letters and the grid silently lies about which day is which.
  const g = calendarGrid("month", D2("2026-09-15"), [step("2026-09-01"), step("2026-10-04")]);
  ck("a month is padded to whole weeks", g.days.length % 7, 0);
  ck("...starting on a Monday", g.days[0].date.getDay(), 1);
  ck("...reaching back before the 1st", g.days[0].key, "2026-08-31");
  ck("...and forward past the last", g.days[g.days.length - 1].key, "2026-10-04");
  ck("padding days are marked as outside the month", g.days[0].out, true);
  ck("...and days in the month are not", g.days.find((d) => d.key === "2026-09-15").out, false);
  // A step in the padding is genuinely visible in this window, so it must
  // carry its rows — a cell drawn but left empty would hide real work.
  ck("a step in the padding still shows", g.days[g.days.length - 1].rows.length, 1);
}
{
  // An athlete in September is asking about the next twelve months. A year
  // view that stops at 31 December answers a question nobody has — their goal
  // is fourteen months out.
  const g = calendarGrid("year", D2("2026-09-15"), [step("2026-09-20"), step("2027-03-02"), step("2027-03-09")]);
  ck("a year is twelve months", g.months.length, 12);
  ck("...rolling from the cursor, not from January", g.months[0].key, "2026-09");
  ck("...and ending twelve months out", g.months[11].key, "2027-08");
  ck("a month carries its own steps", g.months.find((m) => m.key === "2027-03").rows.length, 2);
  ck("months with nothing are still listed", g.months.find((m) => m.key === "2026-12").rows.length, 0);
  ck("year mode draws no day grid", g.days, null);
}
console.log("\n-- paging moves by one unit of the scale shown --");
ck("a week steps seven days", isoDay(calendarStep("week", D2("2026-09-09"), 1)), "2026-09-16");
ck("...and backwards too", isoDay(calendarStep("week", D2("2026-09-09"), -1)), "2026-09-02");
ck("a month steps one month", isoDay(calendarStep("month", D2("2026-09-15"), 1)), "2026-10-15");
ck("a year steps one year", isoDay(calendarStep("year", D2("2026-09-15"), 1)), "2027-09-15");
// 29 Feb 2028 exists; 29 Feb 2029 does not. Date rolls it to 1 March rather
// than throwing, which is fine — what matters is that it never lands on an
// invalid day or silently skips a month.
ck("a leap day pages forward without inventing a date",
   /^\d{4}-\d{2}-\d{2}$/.test(isoDay(calendarStep("year", D2("2028-02-29"), 1))), true);

console.log("\n-- the pager stops where the work stops --");
{
  const reach = calendarReach([step("2026-11-20")]);
  ck("it reaches the END of the month after the furthest dated step", isoDay(reach.to), "2026-12-31");
  // Bounding on the FIRST of that month excluded almost all of it: one step on
  // 10 September made `to` 1 October, and paging a month from 13 September
  // lands on 13 October — past the bound — so the arrow was dead while October
  // still plainly had reach.
  ck("...so paging into that month is allowed, not refused",
     calendarStep("month", D2("2026-11-13"), 1) <= reach.to, true);
  // Hitting a disabled arrow IS the statement "there is nothing out there".
  // Infinite paging invites an athlete to scroll through empty months hunting
  // for work that was never filed.
  ck("...but paging beyond it is refused", calendarStep("month", D2("2026-12-15"), 1) <= reach.to, false);
  const empty = calendarReach([]);
  ck("with no dated steps at all the range is still valid", empty.to >= empty.from, true);
  ck("undated steps do not extend the reach", isoDay(calendarReach([{ id: "u", due: null }]).to).length, 10);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
