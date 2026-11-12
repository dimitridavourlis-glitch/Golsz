// SCOUT'S "WHAT SHOULD I DO TODAY?" SAYS WHAT HOME SAYS.
//
// AVA job 216. If Scout and the Home screen give different answers, the
// athlete stops trusting both. These pure helpers beside dayBuckets() in
// api/scout.js make Scout's answer checkable:
//   isTodayQuestion(text)        a question about today's or this week's steps?
//                                Fixed patterns, not the AI classifier, so a
//                                classifier timeout cannot change the verdict.
//   pickNextMilestone(plan)      the step Home's Today tile names.
//   todayCard(days, next, rest)  Home's numbers, every open step due today and
//                                the next step, as one object.
//   datesInContext(text)         every real YYYY-MM-DD the model was given.
//   checkReplyAgainstPlan(...)   does an answer stay inside the plan?
// The server's side and Home's are both lifted out of their sources at run
// time (tests/_day_parity.cjs, shared with test_scout_today.cjs), never
// copied. Every passing reply has a twin built to break one check, and the
// twin must be flagged: a check that cannot fail proves nothing.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const { between, S, homeAt, homeTileAt, plansAround, DAYS } = require("./_day_parity.cjs");

let p = 0, f = 0;
const ck = (l, a, e) => { const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); } else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); } };
const dayKey = ([y, mo, d]) => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

console.log("-- isTodayQuestion: today's and this week's steps, in all four languages --");
const ASKS = {
  en: ["What should I do today?", "what do I need to do this week?", "What's due today?", "Anything due this week?",
       "Today, what should I focus on?", "What steps do I have this week?"],
  fr: ["Qu'est-ce que je dois faire aujourd'hui ?", "Que dois-je faire cette semaine ?", "Qu'est-ce qui est prévu aujourd'hui ?",
       "Quoi faire ce soir ?", "Aujourd'hui, que dois-je faire ?", "Qu’ai-je à faire cette semaine ?"],
  es: ["¿Qué debo hacer hoy?", "¿Qué tengo que hacer esta semana?", "¿Qué tengo pendiente hoy?", "¿Qué me toca hoy?",
       "Hoy, ¿qué hago?", "¿En qué debo trabajar hoy?"],
  el: ["Τι πρέπει να κάνω σήμερα;", "Τι να κάνω αυτή την εβδομάδα;", "Τι έχω σήμερα;", "Τι μένει για αυτή την εβδομάδα;",
       "Σήμερα τι κάνω;", "ΤΙ ΠΡΕΠΕΙ ΝΑ ΚΑΝΩ ΣΗΜΕΡΑ;"],
};
for (const [lang, qs] of Object.entries(ASKS)) for (const q of qs) ck(`${lang}: ${q}`, S.isTodayQuestion(q), true);

// DECISION: the app's own first Scout button for a player, "What's next for
// me?" (scout_big_next), counts as a today question, so its answer is held to
// the plan too. It asks for the step Home's Today tile names; a different
// answer there is the very disagreement this job removes. The texts are read
// from the app's four dictionaries, so a reworded button stays covered.
const i18nTexts = (key) => [...APP.matchAll(new RegExp(`\\b${key}: ("(?:[^"\\\\]|\\\\.)*")`, "g"))].map((m) => JSON.parse(m[1]));
const NEXT_BUTTON = i18nTexts("scout_big_next");
ck("the What's next button is found in all four languages", new Set(NEXT_BUTTON).size, 4);
for (const q of NEXT_BUTTON) ck(`the What's next button: ${q}`, S.isTodayQuestion(q), true);
// The button coaches and scouts get asks about a month, which is not today.
const MONTH_BUTTON = i18nTexts("scout_np_chip4");
ck("the month button is found in all four languages", new Set(MONTH_BUTTON).size, 4);
for (const q of MONTH_BUTTON) ck(`not about today: ${q}`, S.isTodayQuestion(q), false);
for (const q of ["which clubs fit me?", "what is a redshirt year?", "Quels clubs me correspondent ?", "¿Qué es un año redshirt?",
  "Ποιοι σύλλογοι μου ταιριάζουν;",
  "I got cut today, what should I do?",   // the time word belongs to the news, not the question
  "", "   ", null, 42, undefined, {}, ["What should I do today?"]]) {
  ck(`not about today: ${JSON.stringify(q)}`, S.isTodayQuestion(q), false);
}

console.log("\n-- pickNextMilestone: the step Home's Today tile names --");
// The server's rule before this job, kept here only as a control: the
// earliest date of either kind, else the first undone step.
const oldNext = (plan) => {
  const undone = plan.filter((m) => m && !m.done);
  const dated = undone.filter((m) => typeof m.due === "string" && m.due);
  return dated.length ? dated.slice().sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))[0] : (undone[0] || null);
};
const SUGGESTED_SOONER = { id: "sooner", label: "Retest the 30 m sprint", due: "2026-11-13", due_src: "retest", done: false };
const MINE_LATER = { id: "mine", label: "Email Coach Rivera", due: "2026-11-16", done: false };
{
  const plan = [SUGGESTED_SOONER, MINE_LATER];
  ck("Home's Today tile names the athlete's own later date over GOLSZ's sooner suggestion",
     homeTileAt(2026, 11, 12)(plan, false).next.id, "mine");
  ck("...and so does the server", S.pickNextMilestone(plan).id, "mine");
  ck("control: the old earliest-date rule names the suggestion on this plan", oldNext(plan).id, "sooner");
  ck("a date Scout suggested yields the same way", S.pickNextMilestone([{ ...SUGGESTED_SOONER, due_src: "scout" }, MINE_LATER]).id, "mine");
  ck("among suggested dates the earliest wins",
     S.pickNextMilestone([{ ...SUGGESTED_SOONER, id: "later", due: "2026-11-20" }, SUGGESTED_SOONER]).id, "sooner");
  ck("a suggested date still comes before no date",
     S.pickNextMilestone([{ id: "undated", label: "Undated", due: null, done: false }, SUGGESTED_SOONER]).id, "sooner");
  ck("with no dates at all, the first undone step in list order",
     S.pickNextMilestone([{ id: "a", done: true }, { id: "b", due: "", done: false }, { id: "c", done: false }]).id, "b");
  ck("a late date of their own comes first", S.pickNextMilestone([MINE_LATER, { ...MINE_LATER, id: "late", due: "2026-11-02" }]).id, "late");
  ck("everything done: no next step", S.pickNextMilestone([{ ...MINE_LATER, done: true }]), null);
  ck("no plan: no next step", [S.pickNextMilestone(null), S.pickNextMilestone([]), S.pickNextMilestone("x")], [null, null, null]);
  ck("null entries are skipped, not thrown on", S.pickNextMilestone([null, MINE_LATER]).id, "mine");
  ck("getAthleteState names Scout's next step by this rule", /const nextMilestoneRow = pickNextMilestone\(milestones\);/.test(SCOUT), true);
}
{
  // Every generated plan on every day: the server picks the very step Home picks.
  let compared = 0, mismatches = 0, firstBad = null, oldDiffers = 0;
  const ranks = { 0: 0, 1: 0, 2: 0, none: 0 };   // Home's milestoneRank of its pick
  for (const day of DAYS) {
    const tile = homeTileAt(...day);
    for (const plan of plansAround(dayKey(day))) {
      const h = tile(plan, false), s = S.pickNextMilestone(plan);
      compared++;
      if (h.next !== s) { mismatches++; if (!firstBad) firstBad = { day: dayKey(day), home: plan.indexOf(h.next), server: plan.indexOf(s) }; }
      if (oldNext(plan) !== h.next) oldDiffers++;
      ranks[h.next ? h.nextRank : "none"]++;
    }
  }
  ck(`the server names Home's next step on every plan (${compared} compared)`, mismatches === 0 ? null : firstBad, null);
  ck(`the plans exercise a date they chose, a suggested date, no date and nothing left (${JSON.stringify(ranks)})`,
     [ranks[0] > 100, ranks[1] > 10, ranks[2] > 3, ranks.none > 3], [true, true, true, true]);
  ck(`control: the old rule names a different step on some of them (${oldDiffers})`, oldDiffers > 10, true);
}

console.log("\n-- todayCard: what Home shows for today, as one object --");
const CAP = 20;   // every open step due today is named up to 20; the rest are counted
const serverCard = (key, plan, resting) => S.todayCard(S.dayBuckets(plan, key, resting), S.pickNextMilestone(plan), resting);
const cardView = (c) => ({
  today: c.today, todayTotal: c.todayTotal, todayDone: c.todayDone, weekTotal: c.weekTotal, weekDone: c.weekDone, lateCount: c.lateCount,
  todayOpen: c.todayOpen, todayOpenMore: c.todayOpenMore, toDo: c.todayOpen.length + c.todayOpenMore, next: c.next, resting: c.resting,
});
// The same facts read off Home on that day: the TODAY and THIS WEEK cells and
// the late count, then the Today tile's step and its "N to do" badge.
const homeViewAt = (day) => {
  const home = homeAt(...day), tile = homeTileAt(...day);
  return (plan, resting) => {
    const h = home(plan, resting), t = tile(plan, resting);
    return {
      today: h.today, todayTotal: h.todayTotal, todayDone: h.todayDone, weekTotal: h.weekTotal, weekDone: h.weekDone, lateCount: h.lateCount,
      todayOpen: t.todayOpen.slice(0, CAP), todayOpenMore: Math.max(0, t.todayOpen.length - CAP), toDo: t.todoLeft,
      next: t.next && t.next.label ? { label: t.next.label, due: t.next.due || null } : null, resting,
    };
  };
};
{
  let compared = 0, mismatches = 0, firstBad = null;
  const busy = { open: 0, several: 0, next: 0, week: 0, late: 0 };
  for (const day of DAYS) {
    const homeView = homeViewAt(day);
    for (const plan of plansAround(dayKey(day))) {
      for (const resting of [false, true]) {
        const c = cardView(serverCard(dayKey(day), plan, resting)), h = homeView(plan, resting);
        compared++;
        if (JSON.stringify(c) !== JSON.stringify(h)) { mismatches++; if (!firstBad) firstBad = { day: dayKey(day), resting, card: c, home: h }; }
        if (h.todayOpen.length) busy.open++;
        if (h.todayOpen.length > 1) busy.several++;
        if (h.next) busy.next++;
        if (h.weekTotal) busy.week++;
        if (h.lateCount) busy.late++;
      }
    }
  }
  ck(`the card is what Home shows, on every plan (${compared} compared)`, mismatches === 0 ? null : firstBad, null);
  // Several open steps on one day are rare in these plans; the fixed plans
  // below hold 7 and 25.
  ck(`the plans exercise open steps today, a next step, this week and late (${JSON.stringify(busy)})`,
     [busy.open > 50, busy.several > 3, busy.next > 100, busy.week > 100, busy.late > 50], [true, true, true, true, true]);
  const plan = plansAround("2026-10-28").find((x) => x.some((m) => m.due === "2026-10-28"));
  ck("the instrument can see a disagreement (card made on the wrong day)",
     JSON.stringify(cardView(serverCard("2026-10-29", plan, false))) === JSON.stringify(homeViewAt([2026, 10, 28])(plan, false)), false);
}
{
  const day = [2026, 11, 12], key = dayKey(day), homeView = homeViewAt(day);
  const drills = (n) => Array.from({ length: n }, (_, i) => ({ id: "drill" + i, label: `Drill ${i + 1}`, due: key, done: false }));
  const names = (n) => drills(n).map((m) => m.label);
  // Seven open steps today, among two done today, one tomorrow and one late.
  const seven = drills(7);
  seven.splice(2, 0, { id: "done1", label: "Ice bath", due: key, done: true });
  seven.splice(5, 0, { id: "tomorrow", label: "Gym session", due: "2026-11-13", done: false });
  seven.push({ id: "done2", label: "Stretching", due: key, done: true }, { id: "late", label: "Send the reel", due: "2026-11-03", done: false });
  const card7 = serverCard(key, seven, false);
  ck("7 open steps today: the card names all 7, in plan order", card7.todayOpen, names(7));
  ck("...counts the 2 done ones without naming them", [card7.todayDone, card7.todayTotal, card7.todayOpenMore], [2, 9, 0]);
  ck("...and is what Home shows: the numbers, the 7-to-do badge, the next step", cardView(card7), homeView(seven, false));
  ck("control: the old cap of 5 named fewer steps than Home's badge counts",
     card7.todayOpen.slice(0, 5).length < homeTileAt(...day)(seven, false).todoLeft, true);
  const twentyFive = [{ id: "done", label: "Ice bath", due: key, done: true }].concat(drills(25));
  const card25 = serverCard(key, twentyFive, false);
  ck("25 open steps today: the card names the first 20, in plan order", card25.todayOpen, names(20));
  ck("...and counts the other 5", card25.todayOpenMore, 5);
  ck("...and is what Home shows: 25 to do", cardView(card25), homeView(twentyFive, false));
}
{
  const days = S.dayBuckets([{ label: "Film the session", due: "2026-11-12", done: false }], "2026-11-12", false);
  ck("no day, no card", [S.todayCard(null, null, false), S.todayCard({ ...days, today: "2026-02-30" }, null, false)], [null, null]);
  ck("the card's fields", Object.keys(S.todayCard(days, null, false)),
     ["today", "weekday", "todayTotal", "todayDone", "todayOpen", "todayOpenMore", "weekTotal", "weekDone", "lateCount", "next", "resting"]);
  ck("no next step: next is null", S.todayCard(days, null, false).next, null);
  ck("a next step without a label is no next step", S.todayCard(days, { label: "", due: "2026-11-12" }, false).next, null);
  ck("an undated next step has no date", S.todayCard(days, { label: "Update your bio", due: "" }, false).next, { label: "Update your bio", due: null });
  ck("resting is carried, since Home pauses late while they rest", S.todayCard(days, null, true).resting, true);
  S.todayCard(days, null, false).todayOpen.push("Something else");
  ck("the card's list is its own copy", days.todayOpen, ["Film the session"]);
}

console.log("\n-- datesInContext: every day the model was given --");
// The context Scout is given, built by the real code: getAthleteState's step
// list and the prompt's lines from THEIR PLAN to TODAY FOR THEM, both lifted.
const stepsFor = new Function("milestones", "pickNextMilestone", "stageNameOf",
  between(SCOUT, "  const undone = milestones.filter((m) => m && !m.done);", "\n\n  // ---- FILM:", "getAthleteState's steps") +
  "\nreturn { openMilestones, openMilestonesTruncated, nextMilestone };");
const PLAN_LINES = between(SCOUT, "    athleteBlock += `\\n\\nTHEIR PLAN (the Plan tab, live)", "\n\n    // SECTIONS: theirs, or the sport's.", "the plan and today lines");
const planLines = new Function("athleteState", `let athleteBlock = "";\n${PLAN_LINES}\nreturn athleteBlock;`);
const contextFor = (plan, key, pick = S.pickNextMilestone) => planLines({
  pathwayType: "ncaa", pathwayTimeline: null, pathwayComplete: true, pathwayCreated: true,
  milestonesDone: plan.filter((m) => m.done).length, milestoneCount: plan.length,
  ...stepsFor(plan, pick, () => null),
  day: { key, source: "device" }, dayBuckets: S.dayBuckets(plan, key, false), availability: null,
});
const TODAY = "2026-11-12";   // a Thursday; its week runs Monday 9 to Sunday 15 November
const PLAN = [
  { id: "a", label: "Film two full matches", due: "2026-11-12", done: false },
  { id: "b", label: "Retest the 30 m sprint", due: "2026-11-12", done: true },
  { id: "c", label: "Email Coach Rivera at Northfield", due: "2026-11-10", done: true },
  { id: "d", label: "Ask Scout what to focus on this week", due: "2026-11-13", done: false, due_src: "scout" },
  { id: "e", label: "Upload the Saturday match clip", due: "2026-11-15", done: false },
  { id: "f", label: "Book a physio check", due: "2026-11-24", done: false },
  { id: "g", label: "Update your Passport bio", due: null, done: false },
];
const CONTEXT = contextFor(PLAN, TODAY);
const ALLOWED = S.datesInContext(CONTEXT);
const CARD = serverCard(TODAY, PLAN, false);
ck("the context names today and its weekday", CONTEXT.includes("TODAY FOR THEM: Thursday 2026-11-12"), true);
ck("allowed: the week's Monday and Sunday, today, and every open step's date, once each, in order",
   ALLOWED, ["2026-11-09", "2026-11-12", "2026-11-13", "2026-11-15", "2026-11-24"]);
ck("the card for this plan: 1 of 2 today, 2 of 5 this week", [CARD.todayDone, CARD.todayTotal, CARD.weekDone, CARD.weekTotal], [1, 2, 2, 5]);
ck("...the numbers the context gives the model", /Due today: 1 of 2 done[\s\S]*This week: 2 of 5 dated steps done/.test(CONTEXT), true);
ck("...and the ones Home shows", cardView(CARD), homeViewAt([2026, 11, 12])(PLAN, false));
ck("a day that cannot be is not a day", S.datesInContext("due 2026-02-30 or 2026-11-31"), []);
ck("digits running on either side are not a date", S.datesInContext("ref 12026-11-12 and 2026-11-123"), []);
ck("no context, no dates", [S.datesInContext(null), S.datesInContext(42)], [[], []]);
{
  // The live fix, end to end: the prompt's NEXT line is Home's Today tile.
  const plan = [SUGGESTED_SOONER, MINE_LATER];
  const nextLine = (ctx) => (/NEXT BY THE APP'S OWN RULE \([^)]*\): "([^"]*)"/.exec(ctx) || [])[1];
  ck("the prompt's NEXT line names the step Home's Today tile names",
     nextLine(contextFor(plan, TODAY)), homeTileAt(2026, 11, 12)(plan, false).next.label);
  ck("control: with the old rule in its place, the NEXT line names the other step", nextLine(contextFor(plan, TODAY, oldNext)), SUGGESTED_SOONER.label);
}

console.log("\n-- checkReplyAgainstPlan: an answer stays inside the plan --");
const OPTS = { allowedDates: ALLOWED, labels: PLAN.map((m) => m.label), card: CARD, lang: "en" };
const check = (reply, over) => S.checkReplyAgainstPlan(reply, { ...OPTS, ...over });
// The good reply passes; its twin, built to break one check, is flagged with
// exactly `reasons`.
const pair = (what, good, bad, reasons, over) => {
  ck(`passes: ${what}`, check(good, over), { ok: true, reasons: [] });
  ck(`  ...its broken twin is flagged: ${bad}`, check(bad, over), { ok: false, reasons });
};

// A date that is not in the context, in each way of writing one.
pair("today's own date, ISO", "Film both matches today, 2026-11-12, after training.",
     "Film both matches by 2026-11-14, after training.", [{ kind: "date", text: "2026-11-14" }]);
pair("a step's own date, ISO", "Book the physio check for 2026-11-24, as planned.",
     "Book the physio check for 2026-11-25, as planned.", [{ kind: "date", text: "2026-11-25" }]);
pair("a date in the context, day and month", "Upload the clip by 15 November, then rest.",
     "Upload the clip by 14 November, then rest.", [{ kind: "date", text: "14 November" }]);
pair("...month and day", "Upload the clip by Nov 15, then rest.", "Upload the clip by Nov 14, then rest.", [{ kind: "date", text: "Nov 14" }]);
pair("...with an ordinal", "Upload the clip by November 15th, then rest.",
     "Upload the clip by November 14th, then rest.", [{ kind: "date", text: "November 14th" }]);
pair("...in French", "Mets le clip en ligne avant le 15 novembre, puis repose-toi.",
     "Mets le clip en ligne avant le 14 novembre, puis repose-toi.", [{ kind: "date", text: "14 novembre" }], { lang: "fr" });
pair("...in Spanish", "Sube el clip antes del 15 de noviembre, luego descansa.",
     "Sube el clip antes del 14 de noviembre, luego descansa.", [{ kind: "date", text: "14 de noviembre" }], { lang: "es" });
pair("...in Greek", "Ανέβασε το κλιπ ως τις 15 Νοεμβρίου, μετά ξεκουράσου.",
     "Ανέβασε το κλιπ ως τις 14 Νοεμβρίου, μετά ξεκουράσου.", [{ kind: "date", text: "14 Νοεμβρίου" }], { lang: "el" });

// Weekdays: in front of a date, and alone.
pair("a weekday and date that are both in the context", "Your next check-in is Friday 13 November, as planned.",
     "Your next check-in is Friday 14 November, as planned.", [{ kind: "date", text: "Friday 14 November" }]);
pair("...the right weekday for a date in the context", "Your next check-in is Friday 13 November, as planned.",
     "Your next check-in is Saturday 13 November, as planned.", [{ kind: "weekday", text: "Saturday 13 November" }]);
pair("today's own date and weekday", "Today is Thursday 12 November, so start now.",
     "Today is Wednesday 12 November, so start now.", [{ kind: "weekday", text: "Wednesday 12 November" }]);
pair("today's weekday before its ISO date", "Thursday, 2026-11-12: film both matches.",
     "Thursday, 2026-11-19: film both matches.", [{ kind: "date", text: "Thursday, 2026-11-19" }]);
pair("a weekday alone that a context date falls on", "Do the Scout check-in on Friday, as planned.",
     "Do the Scout check-in on Saturday, as planned.", [{ kind: "weekday", text: "Saturday" }]);
pair("...in French", "Fais-le vendredi, comme prévu.", "Fais-le samedi, comme prévu.", [{ kind: "weekday", text: "samedi" }], { lang: "fr" });
pair("a habit is not a date", "Train every Saturday, as you do.", "Train on Saturday, as you do.", [{ kind: "weekday", text: "Saturday" }]);
pair("a label's own weekday is the athlete's word", "Next: Upload the Saturday match clip.",
     "Next: upload the clip on Saturday.", [{ kind: "weekday", text: "Saturday" }]);

// Step names in quotes.
pair("a quoted step that is in the plan", 'Start with "Film two full matches".',
     'Start with "Film three full matches".', [{ kind: "step", text: "Film three full matches" }]);
pair("...in curly quotes, in any case and spacing", "Start with “film  two FULL matches”.",
     "Start with “Film two half matches”.", [{ kind: "step", text: "Film two half matches" }]);
pair("...in guillemets, a done step", "Tu as fini «Retest the 30 m sprint».",
     "Tu as fini «Retest the 40 m sprint».", [{ kind: "step", text: "Retest the 40 m sprint" }], { lang: "fr" });

// Counts: Home's today and this-week pairs.
{
  const PLAN_03 = [{ label: "Gym session", due: "2026-11-13", done: false }, { label: "Recovery swim", due: "2026-11-14", done: false },
    { label: "Film the derby", due: "2026-11-15", done: false }];
  const CARD_03 = serverCard(TODAY, PLAN_03, false);
  ck("a plan whose week is 0 of 3", [CARD_03.weekDone, CARD_03.weekTotal], [0, 3]);
  pair("this week's real count", "You have done 0 of 3 this week.", "You have done 2 of 5 this week.", [{ kind: "count", text: "2 of 5" }],
       { card: CARD_03, labels: PLAN_03.map((m) => m.label), allowedDates: S.datesInContext(contextFor(PLAN_03, TODAY)) });
}
// Both of Home's numbers in one sentence. Each "today" and "week" belongs to
// the count nearest to it; the checker used to give the second count the
// first one's "today", and refused these true answers.
const SWAPPED = (a, b) => [{ kind: "count", text: a }, { kind: "count", text: b }];
pair("both counts in one sentence", "You've done 1 of 2 today and 2 of 5 this week.",
     "You've done 2 of 5 today and 1 of 2 this week.", SWAPPED("2 of 5", "1 of 2"));
pair("...in French", "1 sur 2 aujourd'hui et 2 sur 5 cette semaine", "2 sur 5 aujourd'hui et 1 sur 2 cette semaine",
     SWAPPED("2 sur 5", "1 sur 2"), { lang: "fr" });
pair("...in Spanish", "1 de 2 hoy y 2 de 5 esta semana", "2 de 5 hoy y 1 de 2 esta semana", SWAPPED("2 de 5", "1 de 2"), { lang: "es" });
pair("...in Greek", "1 από 2 σήμερα και 2 από 5 αυτή την εβδομάδα", "2 από 5 σήμερα και 1 από 2 αυτή την εβδομάδα",
     SWAPPED("2 από 5", "1 από 2"), { lang: "el" });
pair("...the week first", "This week you've done 2 of 5, and today 1 of 2.", "This week you've done 1 of 2, and today 2 of 5.",
     SWAPPED("1 of 2", "2 of 5"));
pair("...with slashes", "Today: 1/2. This week: 2/5.", "Today: 2/5. This week: 1/2.", SWAPPED("2/5", "1/2"));
// The answer the brief asks for: real labels in quotes and the real counts.
const FULL = 'Today you have done 1 of 2: "Film two full matches" is still open. This week you have done 2 of 5. ' +
  'Then "Ask Scout what to focus on this week", which is due Friday 13 November.';
pair("real labels and the real counts", FULL, FULL.replace("2 of 5", "3 of 5"), [{ kind: "count", text: "3 of 5" }]);
ck("  ...its twin with a step that is not in the plan is flagged", check(FULL.replace("Film two full matches", "Film three full matches")),
   { ok: false, reasons: [{ kind: "step", text: "Film three full matches" }] });
pair("no dates at all", "Film both matches, then rest well tonight.",
     "Film both matches by 2026-11-14, then rest well tonight.", [{ kind: "date", text: "2026-11-14" }]);
pair("the whole plan's count, when the model was given it", "2 of 7 steps done overall.", "3 of 7 steps done overall.",
     [{ kind: "count", text: "3 of 7" }], { allowedCounts: [[2, 7]] });
ck("  ...and flagged when it was not given", check("2 of 7 steps done overall.").ok, false);
pair("a count that is not about the plan", "You hit 8 of 10 shots in training.", "You finished 8 of 10 steps in training.",
     [{ kind: "count", text: "8 of 10" }]);

ck("one reply can break all four checks",
   check('Do "Film three full matches" by 2026-11-14, then rest on Saturday: 3 of 5 this week.').reasons.map((r) => r.kind),
   ["step", "date", "weekday", "count"]);
ck("an empty reply contradicts nothing", [check(""), check(null)], [{ ok: true, reasons: [] }, { ok: true, reasons: [] }]);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
