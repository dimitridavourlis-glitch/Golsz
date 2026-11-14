// A STARTER PLAN FROM A SPORT AND A GOAL, CHECKED BY HOME'S OWN RULES.
//
// starterPathwaySteps() promises a brand-new athlete a plan they can act on in
// the same sitting: a step due today, more due this week, nothing late, every
// step in the shape pathway_plan.milestones stores. Each promise is checked
// against the app's real code, lifted out of golsz-app.html: normalizeMilestone,
// athleteStages, the gap engine, the I18N dictionaries, and HomeTab's TODAY /
// THIS WEEK / late block (the slice test_scout_today.cjs diffs against the
// server). A copy of any of them would only prove the copy agrees with itself.
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const APP = require("./_app_source.cjs").appSource();
const BUNDLE = fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => { const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); } else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); } };
const between = (src, a, b, label) => {
  const i = src.indexOf(a), j = src.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`could not slice ${label}: markers moved, update this suite`);
  return src.slice(i, j);
};
const fnSrc = (name) => between(APP, `function ${name}(`, "\n}\n", name) + "\n}\n";
const objSrc = (name) => between(APP, `const ${name} = {`, "\n};\n", name) + "\n};\n";
const stmtSrc = (name) => between(APP, `const ${name} = `, ";\n", name) + ";\n";

// ---- the app's code, lifted ----------------------------------------------
// The block ends on a comment line, so the function starts on a line of its own.
const STARTER_SRC = between(APP, "const STARTER_DEFAULT_DAYS = ", "\nfunction starterPathwaySteps(", "starter block") + "\n" +
  fnSrc("starterPathwaySteps");
const L = new Function(
  objSrc("SPORT_PATHWAY_STAGES") + objSrc("PATHWAY_KEY_EVIDENCE") + objSrc("EVIDENCE_SOURCES") +
  stmtSrc("CONTACTED_STATUSES") + stmtSrc("ACTION_CATEGORIES") + stmtSrc("SPORTS") + stmtSrc("PATHWAY_TYPES") +
  ["isRealDate", "normalizeStage", "athleteStages", "stageLabel", "currentStageIndex", "statedStageIndex",
   "resolveStageIndex", "gapFromRows", "evaluateGap", "normalizeMilestone", "suggestedDate"].map(fnSrc).join("") +
  STARTER_SRC +
  "\nreturn { SPORTS, PATHWAY_TYPES, ACTION_CATEGORIES, athleteStages, normalizeMilestone, suggestedDate, starterTimelineDays, starterPathwaySteps };"
)();
const I18N = new Function(between(APP, "const I18N = {", "\n};\n", "I18N") + "\n};\nreturn I18N;")();
const LANGS = ["en", "fr", "es", "el"];
// The app's own lookup (useLang): the language, then English, then the key.
const asked = new Set();
const tFor = (lang) => (k) => { asked.add(k); return k in I18N[lang] ? I18N[lang][k] : k in I18N.en ? I18N.en[k] : k; };
const tEn = tFor("en");

// HomeTab's day block, run under a clock pinned to local noon on `key`.
const HOME_BLOCK = between(APP, "  const homeTodayKey = isoDay(new Date());", "\n  const contacted", "HomeTab day block");
ck("the lifted Home block computes today, this week and late",
   ["stepsLate", "weekSteps", "todaySteps"].every((k) => HOME_BLOCK.includes(`const ${k} =`)), true);
const homeAt = (key) => {
  const [y, mo, d] = key.split("-").map(Number);
  const Real = Date;
  const fixed = new Real(y, mo - 1, d, 12, 0, 0).getTime();
  class PinnedDate extends Real { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }
  return new Function("Date", "allMilestones", "resting",
    fnSrc("isoDay") + fnSrc("weekStartFrom") + fnSrc("suggestedDate") + fnSrc("canCallLate") + HOME_BLOCK +
    "\nreturn { today: homeTodayKey, weekFrom: weekFromKey, weekTo: weekToKey, todayTotal: todaySteps.length, weekTotal: weekSteps.length, lateCount: stepsLate };"
  ).bind(null, PinnedDate);
};

const addDays = (key, n) => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
// 18 calendar months ahead, on a day every month has, so the bound is never generous.
const in18Months = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + 18, Math.min(d, 28))).toISOString().slice(0, 10); };
const plan = (o) => L.starterPathwaySteps({ today: "2026-11-09", t: tEn, ...o });
const keysOf = (steps) => steps.map((s) => s.id.replace(/^starter-\d{4}-\d{2}-\d{2}-/, ""));
const adopted = (steps) => steps.map((s) => ({ ...s, due_src: null }));   // as if the athlete re-dated every step

const MONDAY = "2026-11-09", SUNDAY = "2026-11-15", NEW_YEARS_EVE = "2026-12-31";
const SPORT_LIST = [...L.SPORTS, "Quidditch"];
const GOALS = [null, ...L.PATHWAY_TYPES];

console.log("-- every sport, every language, every goal: the shape pathway_plan stores --");
{
  const bad = { count: [], ids: [], normalized: [], stage: [], label: [], order: [] };
  let runs = 0;
  for (const sport of SPORT_LIST) {
    const ladder = L.athleteStages({ sport }, null).map((s) => s.id);
    for (const lang of LANGS) for (const goal of GOALS) {
      const steps = L.starterPathwaySteps({ sport, pathwayType: goal, timeline: "", today: MONDAY, t: tFor(lang) });
      const tag = `${sport}/${lang}/${goal}`;
      runs++;
      if (steps.length < 5 || steps.length > 8) bad.count.push(`${tag}: ${steps.length}`);
      if (new Set(steps.map((s) => s.id)).size !== steps.length) bad.ids.push(tag);
      for (const s of steps) {
        if (JSON.stringify(L.normalizeMilestone(s)) !== JSON.stringify(s)) bad.normalized.push(`${tag}: ${s.id}`);
        if (ladder.indexOf(s.stage) === -1) bad.stage.push(`${tag}: ${s.stage}`);
        if (!s.label.trim() || /starter_step_|pathway_stage_|\{stage\}/.test(s.label)) bad.label.push(`${tag}: ${s.label}`);
      }
      if (steps.some((s, i) => i > 0 && s.due < steps[i - 1].due)) bad.order.push(tag);
    }
  }
  ck(`${runs} plans built (${SPORT_LIST.length} sports x 4 languages x ${GOALS.length} goals)`, runs, SPORT_LIST.length * 4 * GOALS.length);
  ck("every plan has 5 to 8 steps", bad.count, []);
  ck("...with ids unique within the plan", bad.ids, []);
  ck("...every step passes normalizeMilestone unchanged", bad.normalized, []);
  ck("...is filed under a section of that sport's own ladder", bad.stage, []);
  ck("...has a translated label, with no key or placeholder showing", bad.label, []);
  ck("...and the steps come in date order", bad.order, []);
  ck("an unknown sport falls back to the __default ladder",
     [...new Set(plan({ sport: "Quidditch" }).map((s) => s.stage))], ["developing"]);
  ck("no sport at all is the __default ladder too", plan({ sport: null })[0].stage, "developing");
}

console.log("\n-- Home's own TODAY, THIS WEEK and late count --");
{
  const scenarios = {
    "Soccer, NCAA, nothing on file": { sport: "Soccer", pathwayType: "ncaa" },
    "Swimming, no goal": { sport: "Swimming" },
    "unknown sport": { sport: "Quidditch", pathwayType: "professional" },
    "everything already on file": { sport: "Basketball", pathwayType: "ncaa",
      athlete: { grad_year: 2026, gpa: 3.2, highlights: [{ url: "https://example.com/v" }] },
      benchmarks: [{ metric_key: "ppg" }], targets: [{ status: "contacted" }, { status: "researching" }, { status: "preparing" }] },
  };
  // The three days the brief names, and every other weekday besides.
  const DAYS = [MONDAY, SUNDAY, NEW_YEARS_EVE, "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2028-02-29"];
  const bad = [];
  for (const day of DAYS) {
    const home = homeAt(day);
    for (const [name, input] of Object.entries(scenarios)) {
      const steps = L.starterPathwaySteps({ ...input, today: day, t: tEn }).map(L.normalizeMilestone);
      for (const resting of [false, true]) {
        const h = home(steps, resting);
        if (h.today !== day) bad.push(`${day} ${name}: Home's day is ${h.today}`);
        if (h.todayTotal < 1) bad.push(`${day} ${name}: ${h.todayTotal} due today`);
        if (h.weekTotal < 3) bad.push(`${day} ${name}: ${h.weekTotal} this week`);
        if (h.lateCount !== 0) bad.push(`${day} ${name}: ${h.lateCount} late (resting ${resting})`);
        // Not late on the merits either: still 0 once the athlete owns every date.
        if (home(adopted(steps), resting).lateCount !== 0) bad.push(`${day} ${name}: late once adopted`);
      }
    }
  }
  ck(`Home finds >= 1 due today, >= 3 this week and 0 late (${DAYS.length} days x 4 plans x resting or not)`, bad, []);

  const monday = homeAt(MONDAY)(plan({ sport: "Soccer", pathwayType: "ncaa" }), false);
  ck("Monday: 3 this week, 1 of them today", [monday.todayTotal, monday.weekTotal], [1, 3]);
  const sunday = homeAt(SUNDAY)(L.starterPathwaySteps({ sport: "Soccer", today: SUNDAY, t: tEn }), false);
  ck("Sunday: the week ends today, so all three are due today", [sunday.todayTotal, sunday.weekTotal], [3, 3]);
  const nye = L.starterPathwaySteps({ sport: "Soccer", today: NEW_YEARS_EVE, t: tEn });
  ck("Dec 31: this week runs into the new year, and Home agrees",
     [homeAt(NEW_YEARS_EVE)(nye, false).weekFrom, homeAt(NEW_YEARS_EVE)(nye, false).weekTo, nye.slice(0, 3).map((s) => s.due)],
     ["2026-12-28", "2027-01-03", ["2026-12-31", "2027-01-02", "2027-01-03"]]);
  ck("every date is GOLSZ's suggestion, so none can call the athlete late yet",
     plan({ sport: "Soccer" }).every((s) => s.due_src === "scout" && L.suggestedDate(s)), true);
  // The instrument can fail: a week later, the adopted plan IS late on Home.
  ck("...and Home's late count does see these steps once they are owned and past",
     homeAt(addDays(MONDAY, 7))(adopted(plan({ sport: "Soccer" })), false).lateCount >= 3, true);
}

console.log("\n-- the timeline sets the horizon, and nothing lands outside it --");
{
  const TIMELINES = ["Fall 2027", "", "   ", null, undefined, "someday", "next year", "automne 2027", "otoño 2027",
    "Φθινόπωρο 2027", "2027-09", "2027-09-01", "09/2027", "Fall 2026", "Fall 2031", "2027-2028 season", "2027-02-30", "13/2027"];
  const bad = [];
  for (const day of [MONDAY, SUNDAY, NEW_YEARS_EVE]) {
    for (const timeline of TIMELINES) {
      const steps = L.starterPathwaySteps({ sport: "Soccer", pathwayType: "ncaa", timeline, today: day, t: tEn });
      const tag = `${day} ${JSON.stringify(timeline)}`;
      if (steps.length < 5) bad.push(`${tag}: ${steps.length} steps`);
      if (steps.some((s) => s.due < day)) bad.push(`${tag}: a date before today`);
      if (steps.some((s, i) => i > 0 && s.due < steps[i - 1].due)) bad.push(`${tag}: out of order`);
      if (steps.some((s) => s.due > in18Months(day))) bad.push(`${tag}: past 18 months`);
    }
  }
  ck(`on or after today, sorted, within 18 months (${TIMELINES.length} timelines x 3 days)`, bad, []);
  const lastDue = (timeline, today = MONDAY) => { const s = plan({ sport: "Soccer", timeline, today }); return s[s.length - 1].due; };
  ck("'Fall 2027': the check-in lands when fall starts", lastDue("Fall 2027"), "2027-09-01");
  ck("...the same in French, Spanish and Greek", ["automne 2027", "otoño 2027", "Φθινόπωρο 2027"].map((x) => lastDue(x)),
     ["2027-09-01", "2027-09-01", "2027-09-01"]);
  ck("...and written as numbers", ["2027-09", "2027-09-01", "09/2027", "Sept. 2027"].map((x) => lastDue(x)),
     ["2027-09-01", "2027-09-01", "2027-09-01", "2027-09-01"]);
  ck("empty, blank, missing or unreadable: twelve weeks", ["", "  ", null, "someday", "2027-02-30", "13/2027"].map((x) => lastDue(x)),
     Array(6).fill(addDays(MONDAY, 84)));
  ck("a date already past reads as no date", lastDue("Fall 2026"), addDays(MONDAY, 84));
  ck("a goal years away is held to the cap", lastDue("Fall 2031"), addDays(MONDAY, 540));
  ck("a year alone means its first day", lastDue("2027"), "2027-01-01");
  ck("a season range reads its first year", lastDue("2027-2028 season"), "2027-01-01");
  ck("winter means the start of that year", lastDue("Winter 2027"), "2027-01-01");
  ck("a timeline days away still leaves a week after the last working step",
     (() => { const s = plan({ sport: "Soccer", timeline: "2026-11-12" }); return s[s.length - 1].due >= addDays(s[s.length - 2].due, 7); })(), true);
}

console.log("\n-- the same inputs give the same plan --");
{
  const input = { sport: "Tennis", pathwayType: "professional", timeline: "Summer 2027", today: "2027-03-17", t: tFor("fr") };
  const first = JSON.stringify(L.starterPathwaySteps(input));
  ck("called twice, identical", JSON.stringify(L.starterPathwaySteps(input)), first);
  const realNow = Date.now, realRandom = Math.random;
  Date.now = () => { throw new Error("Date.now called"); };
  Math.random = () => { throw new Error("Math.random called"); };
  let sabotaged;
  try { sabotaged = JSON.stringify(L.starterPathwaySteps(input)); } catch (e) { sabotaged = e.message; }
  finally { Date.now = realNow; Math.random = realRandom; }
  ck("...and identical with Date.now and Math.random made to throw", sabotaged, first);
  ck("the source reads no clock, no randomness and no network",
     /Date\.now|Math\.random|new Date\(\)|crypto|fetch\(|\bsb\./.test(STARTER_SRC), false);
  const a = plan({ sport: "Soccer", today: MONDAY }).map((s) => s.id);
  const b = plan({ sport: "Soccer", today: addDays(MONDAY, 1) }).map((s) => s.id);
  ck("ids carry the day, so two plans made on different days never share one", a.filter((id) => b.indexOf(id) !== -1), []);
  ck("not a real day: no plan rather than invented dates",
     ["", "2026-02-30", "09/11/2026", null].map((today) => L.starterPathwaySteps({ sport: "Soccer", today, t: tEn }).length), [0, 0, 0, 0]);
}

console.log("\n-- tied to the goal's evidence, and nothing duplicated --");
{
  ck("Soccer NCAA, nothing on file: eight steps, academics included",
     keysOf(plan({ sport: "Soccer", pathwayType: "ncaa" })),
     ["scout_week", "benchmark", "highlight", "targets", "academics", "outreach", "retest", "review"]);
  ck("Swimming NCAA: no academics step, GOLSZ has no Swimming requirements to go on",
     keysOf(plan({ sport: "Swimming", pathwayType: "ncaa" })).indexOf("academics"), -1);
  ck("Soccer academy: that goal does not ask for academics", keysOf(plan({ sport: "Soccer", pathwayType: "academy" })).indexOf("academics"), -1);
  ck("graduation year and GPA on file: no academics step",
     keysOf(plan({ sport: "Soccer", pathwayType: "ncaa", athlete: { grad_year: 2026, gpa: "3.5" } })).indexOf("academics"), -1);
  ck("...only one of them on file: still asked for",
     keysOf(plan({ sport: "Soccer", pathwayType: "ncaa", athlete: { grad_year: 2026 } })).indexOf("academics") > -1, true);
  ck("a highlight on file: no highlight step",
     keysOf(plan({ sport: "Soccer", athlete: { highlights: [{ url: "https://example.com/v" }] } })).indexOf("highlight"), -1);
  ck("a benchmark on file: no benchmark step, the retest stays",
     ["benchmark", "retest"].map((k) => keysOf(plan({ sport: "Soccer", benchmarks: [{ metric_key: "sprint_30m" }] })).indexOf(k) > -1), [false, true]);
  const three = [{ status: "researching" }, { status: "preparing" }, { status: "researching" }];
  ck("three targets, none contacted: no 'add 3' step, the first email stays",
     ["targets", "outreach"].map((k) => keysOf(plan({ sport: "Soccer", targets: three })).indexOf(k) > -1), [false, true]);
  ck("two targets: still asked to reach three", keysOf(plan({ sport: "Soccer", targets: three.slice(0, 2) })).indexOf("targets") > -1, true);
  ck("a target already contacted: no first-email step",
     keysOf(plan({ sport: "Soccer", targets: [{ status: "responded" }] })).indexOf("outreach"), -1);
  const full = plan({ sport: "Soccer", pathwayType: "ncaa", athlete: { grad_year: 2026, gpa: 3.4, highlights: [{ url: "https://example.com/v" }] },
    benchmarks: [{ metric_key: "match_minutes" }], targets: [{ status: "contacted" }, ...three] });
  ck("everything on file: still five steps, none of them a duplicate", keysOf(full), ["scout_week", "watch", "share", "retest", "review"]);
  const fresh = plan({ sport: "Soccer" });
  const due = (steps, k) => steps[keysOf(steps).indexOf(k)].due;
  ck("the retest comes a full fortnight after the benchmark", due(fresh, "retest") >= addDays(due(fresh, "benchmark"), 14), true);
  ck("the first step, due today, is asking Scout", [keysOf(fresh)[0], fresh[0].due], ["scout_week", MONDAY]);
  ck("every category is one the database accepts", fresh.every((s) => L.ACTION_CATEGORIES.indexOf(s.category) > -1), true);
}

console.log("\n-- tied to the sport's ladder --");
{
  const review = (steps) => steps[steps.length - 1];
  ck("no club yet: filed at the first rung, the check-in names the next one",
     [plan({ sport: "Soccer" })[0].stage, review(plan({ sport: "Soccer" })).label],
     ["academy", "Review your progress toward U19/U21 with Scout"]);
  ck("a club on file: one rung up, as the map places them",
     [plan({ sport: "Soccer", athlete: { club_name: "FC Example" } })[0].stage, review(plan({ sport: "Soccer", athlete: { club_name: "FC Example" } })).label],
     ["u19_u21", "Review your progress toward Senior with Scout"]);
  ck("signed: the top rung, and the check-in does not invent one above it",
     review(plan({ sport: "Soccer", athlete: { recruiting_status: "Signed" } })).label, "Review your progress toward Professional with Scout");
  const own = { stages: [{ id: "s1", label: "Local club" }, { id: "s2", label: "County squad $&" }], current_stage_id: "s1" };
  ck("sections the athlete renamed: their ids and their own words, verbatim",
     [plan({ sport: "Soccer", pathwayRow: own })[0].stage, review(plan({ sport: "Soccer", pathwayRow: own })).label],
     ["s1", "Review your progress toward County squad $& with Scout"]);
  ck("the stage name is translated with the rest of the label",
     review(L.starterPathwaySteps({ sport: "Soccer", today: MONDAY, t: tFor("es") })).label, "Revisa con Scout tu progreso hacia U19/U21");
}

console.log("\n-- every label key exists in all four languages --");
{
  const STEP_KEYS = Object.keys(I18N.en).filter((k) => k.startsWith("starter_step_")).sort();
  ck("the English dictionary defines the ten step labels", STEP_KEYS.length, 10);
  ck("every step label defined is one the plans above actually used",
     STEP_KEYS.filter((k) => !asked.has(k)), []);
  const missing = [];
  for (const k of asked) for (const lang of LANGS) {
    if (typeof I18N[lang][k] !== "string" || !I18N[lang][k].trim()) missing.push(`${lang}.${k}`);
  }
  ck(`all ${asked.size} keys the plans asked for are in en, fr, es and el`, missing, []);
  ck("the {stage} placeholder is in the same two labels in every language",
     LANGS.map((lang) => STEP_KEYS.filter((k) => I18N[lang][k].includes("{stage}")).join(",")),
     Array(4).fill("starter_step_review,starter_step_watch"));
}

ck("the compiled bundle carries starterPathwaySteps", /function starterPathwaySteps\(/.test(BUNDLE), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
