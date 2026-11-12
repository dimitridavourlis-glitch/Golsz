// SCOUT'S "FROM YOUR PLAN" CARD SAYS WHAT HOME SAYS.
//
// AVA job 216 t3. A question about today's steps comes back from api/scout.js
// with today_card (Home's numbers for the day, from todayCard()), plus
// today_override when the reply named a date, step or count that is not in the
// plan, or today_unavailable when the plan could not be read. golsz-app.html
// keeps all three on the assistant message, draws ScoutTodayCard under the
// reply and, in place of an overridden reply, shows scoutTodaySentence(card, t),
// which is then what scout_history keeps. Four parts:
//   1. scoutTodayLines (the card's line rules) and scoutTodaySentence, lifted
//      out of golsz-app.html, on fixed plans and in all four languages;
//   2. on test_scout_today.cjs's generated plans (tests/_day_parity.cjs), the
//      card shows the numbers of Home's own lifted code (its TODAY and THIS
//      WEEK tiles and late line) and of the server's todayCard();
//   3. ScoutTodayCard drawn: what it says, colours only from C (no hex), and
//      every text colour readable on the card in both themes;
//   4. the real Scout component driven like a person, its requests answered by
//      the real handler of api/scout.js with the model and database mocked.
const path = require("path");
const { pathToFileURL } = require("url");
const { between, S, runHome, homeAt, plansAround, DAYS } = require("./_day_parity.cjs");
const { APP, React, makeScope, mount, settle } = require("./_app_mount.cjs");

const REPO = path.join(__dirname, "..");
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "svc";
process.env.ANTHROPIC_API_KEY = "sk-test";

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};
const dayKey = ([y, mo, d]) => `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const fnSource = (name) => between(APP, `function ${name}(`, "\n}\n", name) + "\n}\n";

// ---- the app's helpers and dictionaries, lifted -------------------------
const APP_SCOPE = makeScope({ React });
const I18N = APP_SCOPE.get("I18N");
const scoutTodayLines = APP_SCOPE.get("scoutTodayLines");
const scoutTodaySentence = APP_SCOPE.get("scoutTodaySentence");
const LANGS = ["en", "fr", "es", "el"];
// A missing key throws here. The app would fall back to English or the key
// itself, which is the failure this catches.
const tIn = (lang) => (k) => { const v = I18N[lang][k]; if (typeof v !== "string") throw new Error(`${lang} has no ${k}`); return v; };
const t = tIn("en");

// Cards are made by the server's own functions, so they have the real shape.
const DAY = "2026-11-12";   // a Thursday: its week runs Monday 9 to Sunday 15 November
const cardFor = (plan, resting = false, day = DAY) =>
  S.todayCard(S.dayBuckets(plan, day, resting), S.pickNextMilestone(plan), resting);
// Shaped like the plan GoalSetup builds, as job 199's recorded run saw it on
// Home: TODAY 0/1, THIS WEEK 0/3, its "Ask Scout what to focus on this week"
// step (the app's own starter_step_scout_week text) due today.
const STARTER_STEP = I18N.en.starter_step_scout_week;
const STARTER = [
  { id: "s1", label: STARTER_STEP, due: "2026-11-12", done: false },
  { id: "s2", label: "Record a benchmark with the date and how it was measured", due: "2026-11-13", done: false },
  { id: "s3", label: "Add a highlight video", due: "2026-11-15", done: false },
  { id: "s4", label: "Update your Passport bio", due: "2026-11-20", done: false },
];
const lineOf = (lines, k) => lines.find((l) => l.k === k) || null;

console.log("-- a plan of 0/1 today and 0/3 this week --");
ck("the step comes from the app's own starter plan", STARTER_STEP, "Ask Scout what to focus on this week");
{
  const card = cardFor(STARTER);
  ck("the server's card: 0 of 1 today, 0 of 3 this week, nothing late",
     [card.todayDone, card.todayTotal, card.weekDone, card.weekTotal, card.lateCount], [0, 1, 0, 3, 0]);
  const lines = scoutTodayLines(card, t);
  ck("two lines, today and this week, and no others", lines.map((l) => l.k), ["today", "week"]);
  const today = lineOf(lines, "today"), week = lineOf(lines, "week");
  ck("today: Home's label, 0/1, the open step by name, no empty text",
     [today.label, today.value, today.steps, today.more, today.empty], ["TODAY", "0/1", [STARTER_STEP], null, null]);
  ck("this week: Home's label, 0/3", [week.label, week.value, week.empty], ["THIS WEEK", "0/3", null]);
  const said = scoutTodaySentence(card, t);
  ck("the sentence", said, `Today: "${STARTER_STEP}". This week: 0 of 3 done.`);
  ck("...names the step, in quotes", said.includes(`"${STARTER_STEP}"`), true);
  ck("...and says '0 of 3'", said.includes("0 of 3"), true);
}

console.log("\n-- nothing due: the empty states --");
{
  const card = cardFor([{ label: "Email Coach Rivera", due: "2026-11-13", done: false }, { label: "Old step", due: "2026-11-02", done: true }]);
  const lines = scoutTodayLines(card, t), today = lineOf(lines, "today");
  ck("nothing due today: no number and no names, the empty-state text",
     [today.value, today.steps, today.more, today.empty], [null, [], null, "Nothing is due today."]);
  ck("...the week still counts", lineOf(lines, "week").value, "0/1");
  ck("...the sentence says so, then the week", scoutTodaySentence(card, t), "Nothing is due today. This week: 0 of 1 done.");
  const none = cardFor([]);
  ck("nothing this week either: Home's own empty-week words", lineOf(scoutTodayLines(none, t), "week").empty, I18N.en.home_week_empty);
  ck("...and the sentence", scoutTodaySentence(none, t), "Nothing is due today. Nothing in this week yet.");
}

console.log("\n-- the late line --");
{
  ck("late 0: no Late line", scoutTodayLines(cardFor(STARTER), t).some((l) => l.k === "late"), false);
  const late2 = cardFor(STARTER.concat([
    { label: "Send the reel", due: "2026-11-03", done: false }, { label: "Call the academy", due: "2026-11-10", done: false }]));
  ck("this plan has 2 late", late2.lateCount, 2);
  const late = lineOf(scoutTodayLines(late2, t), "late");
  ck("late 2: a Late line", late && late.text, "2 late");
  ck("...the very words Home puts under its TODAY tile", late && late.text, t("home_door_plan_late").replace("{n}", 2));
  ck("...and it is not part of the sentence (the card shows it)", scoutTodaySentence(late2, t).includes("late"), false);
  const suggested = cardFor(STARTER.concat([{ label: "Retest the 30 m sprint", due: "2026-11-03", due_src: "retest", done: false }]));
  ck("a date GOLSZ suggested that has passed is not late, as on Home: no Late line",
     [suggested.lateCount, scoutTodayLines(suggested, t).some((l) => l.k === "late")], [0, false]);
}

console.log("\n-- resting --");
{
  const plan = STARTER.concat([{ label: "Send the reel", due: "2026-11-03", done: false }]);
  const lines = scoutTodayLines(cardFor(plan, true), t);
  ck("resting: a note in Home's banner words", lineOf(lines, "rest") && lineOf(lines, "rest").text,
     `${I18N.en.resting_banner_strong} ${I18N.en.resting_banner}`);
  ck("...and late is paused, as on Home", lines.some((l) => l.k === "late"), false);
  ck("not resting: no note, and the late step counts", scoutTodayLines(cardFor(plan), t).map((l) => l.k), ["today", "week", "late"]);
  const recovery = cardFor(plan.concat([{ label: "Ice bath", due: "2026-11-05", category: "recovery", done: false }]), true);
  ck("resting: a late recovery step still shows, as on Home", lineOf(scoutTodayLines(recovery, t), "late").text, "1 late");
}

console.log("\n-- done, many, nameless, and names with $ in them --");
{
  const done = cardFor([{ label: "Film the session", due: DAY, done: true }, { label: "Stretch", due: DAY, done: true },
    { label: "Email Coach Rivera", due: "2026-11-13", done: false }]);
  const today = lineOf(scoutTodayLines(done, t), "today");
  ck("all of today done: 2/2 and no names", [today.value, today.steps, today.more], ["2/2", [], null]);
  ck("...the sentence counts them", scoutTodaySentence(done, t), "Today: 2 of 2 done. This week: 2 of 3 done.");

  const drills = Array.from({ length: 25 }, (_, i) => ({ label: `Drill ${i + 1}`, due: DAY, done: false }));
  const many = cardFor(drills);
  ck("25 open today: the server names 20 and counts 5", [many.todayOpen.length, many.todayOpenMore], [20, 5]);
  const manyLine = lineOf(scoutTodayLines(many, t), "today");
  ck("...the card lists those 20, then 'and 5 more'", [manyLine.steps, manyLine.more], [drills.slice(0, 20).map((m) => m.label), "and 5 more"]);
  ck("...and so does the sentence", scoutTodaySentence(many, t),
     `Today: ${drills.slice(0, 20).map((m) => `"${m.label}"`).join(", ")} and 5 more. This week: 0 of 25 done.`);

  const nameless = cardFor([{ label: "", due: DAY, done: false }, { label: "Film the session", due: DAY, done: false }]);
  ck("the server gives a step with no label an empty name", nameless.todayOpen, ["", "Film the session"]);
  const namelessLine = lineOf(scoutTodayLines(nameless, t), "today");
  ck("...the card counts it rather than listing a blank", [namelessLine.steps, namelessLine.more], [["Film the session"], "and 1 more"]);
  ck("...and so does the sentence", scoutTodaySentence(nameless, t), `Today: "Film the session" and 1 more. This week: 0 of 2 done.`);
  ck("only nameless steps open: the sentence gives done of total",
     scoutTodaySentence(cardFor([{ label: "   ", due: DAY, done: false }]), t), "Today: 0 of 1 done. This week: 0 of 1 done.");

  const dollars = cardFor([{ label: "Pay the $& fee ($$40, $1)", due: DAY, done: false }]);
  ck("a name with $&, $$ or $1 in it is printed as typed", scoutTodaySentence(dollars, t),
     `Today: "Pay the $& fee ($$40, $1)". This week: 0 of 1 done.`);
}

console.log("\n-- a card that does not add up is not used --");
{
  const good = cardFor(STARTER);
  ck("control: the good card is used", scoutTodayLines(good, t) !== null && scoutTodaySentence(good, t) !== null, true);
  const BAD = [
    ["null", null], ["a string", "card"], ["an array", []], ["an empty object", {}],
    ["a negative count", { ...good, todayDone: -1 }], ["a fraction", { ...good, weekTotal: 3.5 }],
    ["a count as a string", { ...good, lateCount: "2" }], ["more done than due today", { ...good, todayDone: 2 }],
    ["more done than due this week", { ...good, weekDone: 4 }], ["names that are not a list", { ...good, todayOpen: "Film" }],
    ["a name that is not text", { ...good, todayOpen: [42] }], ["open steps that do not add up", { ...good, todayOpen: [] }],
    ["extra steps past the twenty that are not there", { ...good, todayOpenMore: 1 }],
  ];
  for (const [what, card] of BAD) ck(`${what}: no lines, no sentence`, [scoutTodayLines(card, t), scoutTodaySentence(card, t)], [null, null]);
}

console.log("\n-- in all four languages --");
const NEW_KEYS = ["scout_today_title", "scout_today_none", "scout_today_more", "scout_today_say_steps", "scout_today_say_done",
  "scout_today_say_week", "scout_today_unavailable"];
// Home's own words, which the card reuses so both screens name things alike.
const HOME_KEYS = ["home_week_today", "home_week_title", "home_week_empty", "home_door_plan_late", "resting_banner_strong", "resting_banner"];
// Every key the card, its sentence and the message render ask for, read out of their source.
const RENDER = between(APP, "{m.todayCard ? <ScoutTodayCard", "{m.retryable && (", "the message's card render");
const SEND = between(APP, "  async function send(text, retryOf) {", "  // Brief §2B \"persistent actions\"", "send()");
const USED = new Set([...(fnSource("scoutTodayLines") + fnSource("scoutTodaySentence") + fnSource("ScoutTodayCard") + RENDER + SEND)
  .matchAll(/\bt\("([a-z0-9_]+)"\)/g)].map((m) => m[1]));
ck("every new key is used by the card, the sentence or the render", NEW_KEYS.filter((k) => !USED.has(k)), []);
ck("...and so is each of Home's words the card reuses", HOME_KEYS.filter((k) => !USED.has(k)), []);
const placeholders = (s) => [...new Set(s.match(/\{[a-z]+\}/g) || [])].sort();
for (const lang of LANGS) {
  const used = [...USED].filter((k) => k.startsWith("scout_today_") || HOME_KEYS.includes(k));
  ck(`${lang}: every key the card uses is there and not empty`,
     used.filter((k) => typeof I18N[lang][k] !== "string" || !I18N[lang][k].trim()), []);
  ck(`${lang}: each new key keeps English's placeholders`,
     NEW_KEYS.filter((k) => JSON.stringify(placeholders(I18N[lang][k] || "")) !== JSON.stringify(placeholders(I18N.en[k]))), []);
  const tl = tIn(lang), card = cardFor(STARTER), lines = scoutTodayLines(card, tl), said = scoutTodaySentence(card, tl);
  ck(`${lang}: the card's labels are Home's own in ${lang}`, [lines[0].label, lines[1].label], [I18N[lang].home_week_today, I18N[lang].home_week_title]);
  ck(`${lang}: the sentence names the step in quotes, says 0 and 3, and leaves no {placeholder}`,
     [said.includes(`"${STARTER_STEP}"`), /\b0\b/.test(said) && /\b3\b/.test(said), /[{}]/.test(said)], [true, true, false]);
  if (lang !== "en") ck(`${lang}: ...in ${lang}, not English`, said === scoutTodaySentence(card, t), false);
  ck(`${lang}: nothing due`, scoutTodaySentence(cardFor([]), tl), `${I18N[lang].scout_today_none} ${I18N[lang].home_week_empty}`);
}

console.log("\n-- the card shows Home's numbers, on every generated plan --");
// Home's TODAY and THIS WEEK tiles, their own object literals out of HomeTab,
// evaluated in HomeTab's day block under Home's pinned clock (runHome) with the
// app's English dictionary. What the card shows is read off its lines.
// (Sliced out of HomeTab's statusTiles: scoutTodayLines uses the same labels.)
const STATUS_TILES = between(APP, "  const statusTiles = [", "    .filter(Boolean).filter((tile) => !tile.empty);", "HomeTab's statusTiles");
const TODAY_TILE = between(STATUS_TILES, 'k: "today", label: t("home_week_today"),', "go: canTargets", "Home's TODAY tile");
const WEEK_TILE = between(STATUS_TILES, 'k: "week", label: t("home_week_title"),', "go: canTargets", "Home's THIS WEEK tile");
const homeTilesAt = (y, mo, d) => runHome(y, mo, d, `
  const DICT = ${JSON.stringify(I18N.en)};
  const t = (k) => DICT[k];
  const C = new Proxy({}, { get: (_, k) => "C." + String(k) });
  const todayTile = ({ ${TODAY_TILE} });
  const weekTile = ({ ${WEEK_TILE} });
  return { todayTile, weekTile, todayOpen: todaySteps.filter((m) => !m.done).map((m) => m.label) };`);
// The numbers a person reads on the card: "d/t" or nothing, and the late count.
const numbersOnCard = (lines) => {
  const frac = (v) => (v ? v.split("/").map(Number) : [0, 0]);
  const late = lineOf(lines, "late");
  return { today: frac(lineOf(lines, "today").value), week: frac(lineOf(lines, "week").value), late: late ? parseInt(late.text, 10) : 0 };
};
{
  ck("Home's tiles were found: TODAY shows done/total or a dash, late under it",
     [/value: todaySteps\.length \? `\$\{todayDone\}\/\$\{todaySteps\.length\}` : "\\u2014"/.test(TODAY_TILE),
      /sub: stepsLate > 0 \? t\("home_door_plan_late"\)\.replace\("\{n\}", stepsLate\) : null/.test(TODAY_TILE),
      /value: weekSteps\.length \? `\$\{weekDone\}\/\$\{weekSteps\.length\}` : "\\u2014"/.test(WEEK_TILE)], [true, true, true]);
  let compared = 0, unusable = 0, firstUnusable = null, mismatches = 0, firstBad = null;
  const busy = { today: 0, allDone: 0, week: 0, late: 0, nothingToday: 0, restingPauses: 0 };
  for (const day of DAYS) {
    const home = homeAt(...day), tiles = homeTilesAt(...day), key = dayKey(day);
    for (const plan of plansAround(key)) {
      for (const resting of [false, true]) {
        compared++;
        const card = cardFor(plan, resting, key), lines = scoutTodayLines(card, t), h = home(plan, resting), tl = tiles(plan, resting);
        if (!lines) { unusable++; if (!firstUnusable) firstUnusable = { key, card }; continue; }
        const today = lineOf(lines, "today"), late = lineOf(lines, "late");
        const named = tl.todayOpen.slice(0, 20).filter((l) => String(l || "").trim());
        const moreCount = today.more ? parseInt(today.more.replace(/\D+/g, ""), 10) : 0;
        const got = {
          shown: numbersOnCard(lines),
          tiles: [today.value || "\u2014", lineOf(lines, "week").value || "\u2014", late ? late.text : null],
          names: [today.steps, today.steps.length + moreCount],
          server: [card.todayDone, card.todayTotal, card.weekDone, card.weekTotal, card.lateCount],
        };
        const want = {
          shown: { today: [h.todayDone, h.todayTotal], week: [h.weekDone, h.weekTotal], late: h.lateCount },
          tiles: [tl.todayTile.value, tl.weekTile.value, tl.todayTile.sub],
          names: [named, tl.todayOpen.length],
          server: [h.todayDone, h.todayTotal, h.weekDone, h.weekTotal, h.lateCount],
        };
        if (JSON.stringify(got) !== JSON.stringify(want)) { mismatches++; if (!firstBad) firstBad = { key, resting, got, want }; }
        if (h.todayTotal) busy.today++;
        if (h.todayTotal && h.todayDone === h.todayTotal) busy.allDone++;
        if (h.weekTotal) busy.week++;
        if (h.lateCount) busy.late++;
        if (!h.todayTotal) busy.nothingToday++;
        if (resting && cardFor(plan, false, key).lateCount !== card.lateCount) busy.restingPauses++;
      }
    }
  }
  ck(`the card is drawn for every real card (${compared} made by todayCard())`, unusable === 0 ? null : firstUnusable, null);
  ck(`the card shows Home's numbers, Home's tile values and late line, and the server's numbers, on every plan (${compared} compared)`,
     mismatches === 0 ? null : firstBad, null);
  ck(`the plans exercise steps today, all done, this week, late, nothing today and resting (${JSON.stringify(busy)})`,
     [busy.today > 50, busy.allDone > 5, busy.week > 100, busy.late > 50, busy.nothingToday > 50, busy.restingPauses > 10], [true, true, true, true, true, true]);
  // The comparison must be able to fail: a card made for the wrong day.
  const plan = plansAround("2026-10-28").find((x) => x.some((m) => m.due === "2026-10-28"));
  ck("the instrument can see a disagreement (the card made for the next day)",
     JSON.stringify(numbersOnCard(scoutTodayLines(cardFor(plan, false, "2026-10-29"), t))) ===
     JSON.stringify((({ todayDone, todayTotal, weekDone, weekTotal, lateCount }) => ({ today: [todayDone, todayTotal], week: [weekDone, weekTotal], late: lateCount }))(homeAt(2026, 10, 28)(plan, false))), false);
}

console.log("\n-- ScoutTodayCard, drawn --");
const CARD_SCOPE = makeScope({ React });
const ScoutTodayCard = CARD_SCOPE.get("ScoutTodayCard");
const draw = (card, tt = t) => mount(ScoutTodayCard, { card, t: tt });
const inOrder = (text, pieces) => { let at = 0; for (const x of pieces) { const i = text.indexOf(x, at); if (i < 0) return false; at = i + x.length; } return true; };
const LATE2 = cardFor(STARTER.concat([{ label: "Send the reel", due: "2026-11-03", done: false }, { label: "Call the academy", due: "2026-11-10", done: false }]));
const RESTING = cardFor(STARTER, true);
const MANY = cardFor(Array.from({ length: 22 }, (_, i) => ({ label: `Drill ${i + 1}`, due: DAY, done: i === 0 })));
{
  const ui = draw(cardFor(STARTER));
  ck("FROM YOUR PLAN, then TODAY 0/1 and the step, then THIS WEEK 0/3",
     inOrder(ui.text(), ["FROM YOUR PLAN", "TODAY", "0/1", STARTER_STEP, "THIS WEEK", "0/3"]), true);
  ck("...and nothing else", ui.text(), `FROM YOUR PLANTODAY0/1${STARTER_STEP}THIS WEEK0/3`);
  ck("the step is an item of a list", ui.findAll((n) => n.type === "li").map((n) => ui.textOf(n)), [STARTER_STEP]);
  ck("no button: the card only reports", ui.findAll((n) => n.type === "button").length, 0);
  ck("Home's Today icon (Sun)", [ui.findAll((n) => n.type === CARD_SCOPE.get("Sun")).length, ui.findAll((n) => n.type === CARD_SCOPE.get("Pause")).length], [1, 0]);
  const empty = draw(cardFor([]));
  ck("nothing due: the two empty texts, no numbers, no list",
     [empty.text(), empty.findAll((n) => n.type === "li").length], [`FROM YOUR PLANTODAY${t("scout_today_none")}THIS WEEK${t("home_week_empty")}`, 0]);
  ck("late 0: no late line", draw(cardFor(STARTER)).text().includes("late"), false);
  ck("late 2: the late line, last", draw(LATE2).text().endsWith("2 late"), true);
  const rest = draw(RESTING);
  ck("resting: the note, and Home's resting icon (Pause)",
     [rest.text().endsWith(`${I18N.en.resting_banner_strong} ${I18N.en.resting_banner}`), rest.findAll((n) => n.type === CARD_SCOPE.get("Pause")).length,
      rest.findAll((n) => n.type === CARD_SCOPE.get("Sun")).length], [true, 1, 0]);
  const many = draw(MANY);
  ck("21 open today: 20 list items, then 'and 1 more'", [many.findAll((n) => n.type === "li").length, many.text().includes("Drill 21and 1 more")], [20, true]);
  ck("a card that does not add up draws nothing", [draw({ ...cardFor(STARTER), todayDone: 5 }).text(), draw(null).findAll(() => true).length], ["", 0]);
  const fr = draw(cardFor(STARTER), tIn("fr"));
  ck("in French: the heading and Home's French labels", inOrder(fr.text(), [I18N.fr.scout_today_title, I18N.fr.home_week_today, "0/1", I18N.fr.home_week_title, "0/3"]), true);
}

console.log("\n-- its colours: only C, never a hex, and readable in both themes --");
{
  const SRC = fnSource("ScoutTodayCard");
  ck("no hex colour in ScoutTodayCard's source", SRC.match(/#[0-9a-fA-F]{3,8}\b/g), null);
  ck("...no rgb() either", /rgba?\(/.test(SRC), false);
  ck("...and no C.ink (it is only for text on gold, and the card has no gold fill)", /\bC\.ink\b/.test(SRC), false);
  // Every style value that carries a colour, in every kind of card the
  // component draws, and every icon's colour prop.
  const nodes = [cardFor(STARTER), cardFor([]), LATE2, RESTING, MANY].flatMap((c) => draw(c).findAll(() => true));
  const COLOUR_KEYS = ["color", "background", "backgroundColor", "border", "borderTop", "borderBottom", "borderColor", "boxShadow", "outline"];
  const values = [];
  for (const n of nodes) {
    const st = (n.props && n.props.style) || {};
    for (const k of COLOUR_KEYS) if (st[k] != null) values.push(`${k}: ${st[k]}`);
    if (n.props && typeof n.props.color === "string") values.push(`icon: ${n.props.color}`);
  }
  ck(`every colour drawn is a theme variable (${values.length} found)`,
     values.filter((v) => !/var\(--[\w-]+\)/.test(v) || /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(v)), []);
  const textVars = [...new Set(nodes.map((n) => n.props && n.props.style && n.props.style.color).filter(Boolean))].sort();
  ck("its text is in three colours: chalk, chalk-soft and gold as text", textVars, ["var(--chalk)", "var(--chalk-soft)", "var(--lime-text)"]);
  const headingColour = draw(cardFor(STARTER)).find((n) => n.type === "span" && n.children.join("") === "FROM YOUR PLAN").props.style.color;
  const lateColour = draw(LATE2).find((n) => n.type === "div" && n.children.join("") === "2 late").props.style.color;
  ck("gold text (the heading, the late line) is C.limeText, never C.lime", [headingColour, lateColour], ["var(--lime-text)", "var(--lime-text)"]);
  // The unavailable line under a reply sits on the bubble, which is C.card too.
  ck("the unavailable line under a reply is C.chalkSoft", /fontSize: 14, lineHeight: 1\.45, color: C\.chalkSoft \}\}>\{t\("scout_today_unavailable"\)\}/.test(RENDER), true);

  // WCAG contrast of each text colour on the card's ground, from the real
  // :root and html[data-theme="light"] blocks of the CSS template string.
  const block = (sel) => { const s = APP.indexOf(sel + " {"); return APP.slice(s, APP.indexOf("\n  }", s)).replace(/\/\*[\s\S]*?\*\//g, ""); };
  const vars = (sel) => Object.fromEntries([...block(sel).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const rgb = (v) => { const m = /^#([0-9a-f]{6})$/i.exec(v); if (!m) throw new Error("not a solid hex colour: " + v); return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)); };
  const lum = (c) => { const [r, g, b] = c.map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  for (const [theme, vs] of [["dark", vars(":root")], ["light", vars('html[data-theme="light"]')]]) {
    for (const v of new Set(textVars.concat(["var(--chalk-soft)"]))) {   // + the unavailable line
      const m = /var\((--[\w-]+)\)/.exec(v);
      if (!m) continue;   // not a theme variable: already failed above
      const name = m[1];
      const r = ratio(rgb(vs[name]), rgb(vs["--card"]));
      ck(`${theme}: ${name} ${vs[name]} on --card ${vs["--card"]} is at least 4.5:1 (${r.toFixed(2)})`, r >= 4.5, true);
    }
  }
}

console.log("\n-- wired into send() and the message --");
{
  ck("the message keeps the card and both flags",
     /todayCard, todayOverride: !!data\.today_override, todayUnavailable: !!data\.today_unavailable \}\]\);/.test(SEND), true);
  const iUnavailable = SEND.indexOf("if (data.reply_unavailable) {"), iOverride = SEND.indexOf("} else if (data.today_override) {"),
    iRefusal = SEND.indexOf('} else if (data.stop_reason === "refusal") {');
  ck("an overridden reply is replaced after a missing reply is handled and before anything else",
     iUnavailable > 0 && iUnavailable < iOverride && iOverride < iRefusal, true);
  ck("...by the sentence, or the unavailable line when there is no card",
     /reply = scoutTodaySentence\(todayCard, t\) \|\| t\("scout_today_unavailable"\);/.test(SEND), true);
  ck("the card is drawn under the reply text", APP.indexOf("{m.text && <div style={{ whiteSpace: \"pre-wrap\" }}>{m.text}</div>}") < APP.indexOf("{m.todayCard ? <ScoutTodayCard"), true);
}

/* ======================================================================
   THE APP, THROUGH THE REAL HANDLER
   ====================================================================== */
// The clock is pinned (it keeps ticking) at local noon on DAY, so the app's
// isoDay(new Date()) is DAY in every timezone, and the server's UTC day is
// within the one day of it that resolveAthleteDay accepts as the device's.
const RealDate = Date;
const SHIFT = new RealDate(Number(DAY.slice(0, 4)), Number(DAY.slice(5, 7)) - 1, Number(DAY.slice(8, 10)), 12).getTime() - RealDate.now();
class PinnedDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + SHIFT); }
  static now() { return RealDate.now() + SHIFT; }
}

// The athlete's plan: 1 step due today, 3 this week, nothing late.
const STEP = "Film two full matches";
const PLAN = [
  { id: "m1", label: STEP, due: "2026-11-12", done: false },
  { id: "m2", label: "Email Coach Rivera", due: "2026-11-13", done: false },
  { id: "m3", label: "Upload the Saturday match clip", due: "2026-11-14", done: false },
  { id: "m4", label: "Retest the 30 m sprint", due: "2026-11-03", done: true },
  { id: "m5", label: "Book a physio check", due: "2026-11-24", done: false },
  { id: "m6", label: "Update your Passport bio", due: null, done: false },
];
const ROW = { pathway_type: "ncaa", target_timeline: null, baseline_complete: true, stages: null, current_stage_id: null, milestones: PLAN };
const EXPECTED = cardFor(PLAN);
const SENTENCE = `Today: "${STEP}". This week: 0 of 3 done.`;
// What the model answers (tests/test_scout_today_handler.cjs shows the server
// passes the first and flags the next two).
const HONEST = `Today, do "${STEP}". This week you have done 0 of 3, and next comes "Email Coach Rivera" on Friday 13 November.`;
const INVENTED_DATE = `Today, do "${STEP}" and have it done by 2026-11-16. This week you have done 0 of 3.`;
const INVENTED_STEP = `Today, do "Film three full matches". This week you have done 0 of 3.`;
const UNREAD_REPLY = "I couldn't load your plan just now. Ask me again in a moment.";
const SCHOOLS = [{ name: "Northfield College", reasoning: "Plays the way you play." }];

// ---- the services behind the handler, mocked ----------------------------
let world = null;
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const modelMessage = (model, obj) => ({ id: "msg", type: "message", role: "assistant", model, stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  content: [{ type: "text", text: JSON.stringify(obj) }] });
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String(opts.method || "GET").toUpperCase();
  const raw = opts.body ? String(opts.body) : "";
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  if (u.includes("api.anthropic.com")) {
    const model = (body && body.model) || "";
    // The classifier's contract is the only prompt that asks for summary_so_far.
    if (raw.includes("summary_so_far")) {
      return reply(200, modelMessage(model, { intent: "career_advice", confidence: 0.9, needs_tool: false, is_correction: false, faq_id: null,
        summary_so_far: "s", missing_information: [], recommended_specialist: null, conversation_stage: "pathway", next_best_action: null }));
    }
    return reply(200, modelMessage(model, { reply: world.reply, profile_updates: null, suggested_targets: world.schools || null }));
  }
  const rpc = u.includes("/rest/v1/rpc/") ? u.slice(u.indexOf("/rest/v1/rpc/") + 13).split("?")[0] : null;
  const table = !rpc && u.includes("/rest/v1/") ? u.slice(u.indexOf("/rest/v1/") + 9).split("?")[0] : null;
  if (u.includes("/auth/v1/user")) return reply(200, { id: world.uid });
  if (rpc === "reserve_scout_question") return reply(200, { allowed: true, used: 1 });
  if (rpc) return reply(200, {});
  if (table === "profiles") return reply(200, [{ plan: "pro", is_admin: false, ai_unlimited: false, full_access: false,
    goal_defined: true, goal_text: "Play NCAA D1 soccer", goal_source: "athlete_edited", full_name: "Test Athlete", occupation: "Player" }]);
  if (table === "athletes") return reply(200, [{ sport: "Soccer", position: "Winger", country: "USA", club_name: "Northfield FC" }]);
  if (table === "pathway_plan" && method === "GET") return world.pathway === "fail" ? reply(500, { message: "upstream timeout" }) : reply(200, [ROW]);
  return reply(200, []);
};
function mkRes() {
  const r = { statusCode: null, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; return r; };
  r.end = () => r;
  return r;
}

// ---- the app, driven like a person --------------------------------------
const tApp = (k) => (typeof I18N.en[k] === "string" ? I18N.en[k] : k);   // useLang's t, in English
let seq = 0;
async function openScout(handler, scenario) {
  const log = { history: [], served: [], errors: [] };
  // Scout's own reads at mount (profile, athlete, plan, past chats) and its
  // scout_history writes.
  const ROWS = { profiles: { full_name: "Test Athlete", dob: null, occupation: "Player" },
    athletes: { sport: "Soccer", position: "Winger", country: "USA", club_name: "Northfield FC" }, pathway_plan: ROW };
  const sb = {
    from: (table) => {
      let single = false;
      const q = {
        select: () => q, eq: () => q, order: () => q, limit: () => q,
        single: () => { single = true; return q; }, maybeSingle: () => { single = true; return q; },
        insert: (row) => { if (table === "scout_history") log.history.push(row.messages[0]); return Promise.resolve({ data: null, error: null }); },
        then: (res, rej) => Promise.resolve({ data: single ? (ROWS[table] || null) : [], error: null }).then(res, rej),
      };
      return q;
    },
    auth: { getUser: async () => ({ data: { user: { id: "athlete-1" } } }),
            getSession: async () => ({ data: { session: { access_token: "athlete-token" } } }) },
  };
  // The app's requests: moderation allows; /api/scout goes to the real handler.
  const fetchFromApp = async (url, opts = {}) => {
    const u = String(url);
    if (u === "/api/moderate") return { ok: true, status: 200, json: async () => ({ decision: "allow" }) };
    if (u !== "/api/scout") throw new Error("unexpected request from the app: " + u);
    world = { uid: `00000000-0000-4000-a000-${String(++seq).padStart(12, "0")}`, ...scenario };
    const headers = {};
    for (const [k, v] of Object.entries(opts.headers || {})) headers[k.toLowerCase()] = v;
    const res = mkRes();
    const keep = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};   // the handler's own logging, not this suite's output
    try { await handler({ method: opts.method, headers, body: JSON.parse(opts.body) }, res); } finally { Object.assign(console, keep); }
    log.served.push({ status: res.statusCode, body: res.body, sent: JSON.parse(opts.body) });
    const wire = JSON.stringify(res.body);
    return { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(wire) };
  };
  const scope = makeScope({
    React, useState: React.useState, useRef: React.useRef, useEffect: React.useEffect,
    sb, fetch: fetchFromApp, AbortSignal: undefined, useLang: () => ({ t: tApp, lang: "en" }),
    console: { log() {}, warn() {}, info() {}, error: (...a) => log.errors.push(a.map(String).join(" ")) },
  });
  const ui = mount(scope.get("Scout"), { plan: "pro", onUpgrade() {}, onGoToProfile() {}, onNavigate() {},
    actingFor: null, seedPrompt: null, onSeedSent() {} });
  await settle();   // the mount-time restore: greeting, profile, plan
  const isComp = (name) => (n) => typeof n.type === "function" && n.type.name === name;
  const bubble = () => ui.findAll((n) => n.props && n.props.className === "msg").slice(-1)[0] || null;
  return {
    ui, log, scope,
    async ask(question) {
      ui.find((n) => n.type === "textarea").props.onChange({ target: { value: question } });
      await ui.find((n) => n.type === "button" && n.props.title === tApp("scout_send")).props.onClick();
      await settle();
    },
    // The newest message: its text, its From your plan cards (as elements, and
    // drawn), the unavailable lines under it, and any offer cards.
    last() {
      const b = bubble();
      const textDiv = ui.find((n) => n.type === "div" && n.props.style && n.props.style.whiteSpace === "pre-wrap", b);
      const cards = ui.findAll(isComp("ScoutTodayCard"), b);
      return {
        text: textDiv ? ui.textOf(textDiv).trim() : null,
        cards: cards.map((el) => el.props.card),
        drawn: cards.map((el) => mount(el.type, el.props).text()),
        unavailableLines: ui.findAll((n) => n.type === "div" && !(n.props.style && n.props.style.whiteSpace)
          && ui.textOf(n).trim() === tApp("scout_today_unavailable"), b).length,
        offers: ui.findAll(isComp("ScoutActionCard"), b).map((el) => el.props.title),
      };
    },
  };
}

async function appHalf(handler) {
  ck("the app's day, by its own isoDay(), is the plan's day", APP_SCOPE.get("isoDay")(new Date()), DAY);
  const TODAY_Q = "What should I do today?";

  console.log("\n-- an answer that keeps to the plan: shown as it is, with the card under it --");
  {
    const s = await openScout(handler, { reply: HONEST, schools: SCHOOLS });
    await s.ask(TODAY_Q);
    const served = s.log.served[0] || {};
    ck("the real handler answered 200 with today_card, and no override", [served.status, !!(served.body && served.body.today_card), served.body && served.body.today_override], [200, true, undefined]);
    const last = s.last();
    ck("the bubble shows the model's answer", last.text, HONEST);
    ck("one From your plan card under it, holding the server's card", last.cards, [EXPECTED]);
    ck("...which is todayCard() for this plan and day: 0 of 1 today, 0 of 3 this week", [EXPECTED.todayDone, EXPECTED.todayTotal, EXPECTED.weekDone, EXPECTED.weekTotal], [0, 1, 0, 3]);
    ck("...drawn: the step, 0/1 and 0/3", last.drawn, [`FROM YOUR PLANTODAY0/1${STEP}THIS WEEK0/3`]);
    ck("no unavailable line", last.unavailableLines, 0);
    ck("the offer that came with it is there (control for the replaced answer below)", last.offers, [t("scout_card_schools").replace("{n}", 1)]);
    ck("scout_history keeps the question and that answer", s.log.history, [{ role: "user", content: TODAY_Q }, { role: "assistant", content: HONEST }]);
    ck("no error logged", s.log.errors, []);
  }

  for (const [what, modelSaid, piece] of [["a date that is not in the plan", INVENTED_DATE, "2026-11-16"], ["a step that is not in the plan", INVENTED_STEP, "Film three full matches"]]) {
    console.log(`\n-- an answer with ${what}: replaced by the plan's own sentence --`);
    const s = await openScout(handler, { reply: modelSaid, schools: SCHOOLS });
    await s.ask(TODAY_Q);
    const served = s.log.served[0] || {};
    ck("the real handler flagged it: today_override, with the card", [served.body && served.body.today_override, served.body && served.body.today_card], [true, EXPECTED]);
    const last = s.last();
    ck("the bubble shows the sentence built from the card", last.text, SENTENCE);
    ck(`...and nothing of the model's answer (${piece})`, last.text.includes(piece), false);
    ck("the card is under it", last.cards, [EXPECTED]);
    ck("the offer that came with the replaced answer is not shown", last.offers, []);
    ck("scout_history keeps the sentence, never the replaced answer", s.log.history, [{ role: "user", content: TODAY_Q }, { role: "assistant", content: SENTENCE }]);
  }

  console.log("\n-- the plan could not be read --");
  {
    const s = await openScout(handler, { pathway: "fail", reply: UNREAD_REPLY });
    await s.ask(TODAY_Q);
    const served = s.log.served[0] || {};
    ck("the handler sent today_unavailable and no card", [served.body && served.body.today_unavailable, served.body && served.body.today_card], [true, null]);
    const last = s.last();
    ck("the bubble shows the model saying so", last.text, UNREAD_REPLY);
    ck("no card, and one line under it: the plan couldn't be read, Home has today's steps", [last.cards, last.unavailableLines], [[], 1]);
    ck("...that line, in English", tApp("scout_today_unavailable"), "Your plan couldn't be read just now. Home shows today's steps.");
  }
  {
    const s = await openScout(handler, { pathway: "fail", reply: INVENTED_STEP });
    await s.ask(TODAY_Q);
    const served = s.log.served[0] || {};
    ck("a step named anyway: flagged, and there is no card to build from", [served.body && served.body.today_override, served.body && served.body.today_card], [true, null]);
    const last = s.last();
    ck("the bubble says the plan couldn't be read, and guesses nothing", last.text, tApp("scout_today_unavailable"));
    ck("...once: no card, and the line is not repeated under it", [last.cards, last.unavailableLines], [[], 0]);
    ck("scout_history keeps that line", s.log.history.map((m) => m.content), [TODAY_Q, tApp("scout_today_unavailable")]);
  }

  console.log("\n-- the What's next button, and a question that is not about today --");
  {
    const s = await openScout(handler, { reply: HONEST });
    const start = s.ui.find((n) => typeof n.type === "function" && n.type.name === "ScoutStart");
    ck("the start buttons are on screen", !!start, true);
    await start.props.onPick(tApp("scout_big_next"));
    await settle();
    ck("What's next for me? is answered with the card", [s.last().text, s.last().cards], [HONEST, [EXPECTED]]);
  }
  {
    const s = await openScout(handler, { reply: "Northfield College and Lakeside FC both fit your level.", schools: SCHOOLS });
    await s.ask("Which clubs fit me?");
    const last = s.last();
    ck("another question: no card, no line, and its offer is kept", [last.cards, last.unavailableLines, last.offers.length], [[], 0, 1]);
  }
}

(async () => {
  let handler = null;
  global.Date = PinnedDate;
  try {
    handler = (await import(pathToFileURL(path.join(REPO, "api", "scout.js")).href)).default;
    await appHalf(handler);
  } catch (e) { f++; console.log("FAIL  the app half threw: " + (e && e.stack || e)); }
  finally { global.Date = RealDate; }
  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})();
