// WHAT THE GOAL REQUIRES, AND WHAT GOLSZ CAN ACTUALLY SEE.
//
// Two jobs. First, the mirror: PATHWAY_KEY_EVIDENCE is a client copy of
// api/scout.js's key_evidence, and this repo's THREE duplication bugs all
// share one cause — a parity check that compared a SUBSET. BENCHMARK_METRICS
// dropped a position gate the test never diffed; POSITIONLESS_SPORTS drifted
// so a golfer was never assessed. So this compares sport, id, goal_type AND
// the evidence list IN DECLARED ORDER, and fails on any extra or missing row
// on either side.
//
// Second, the honesty: four of the eleven evidence keys have no source in
// this product — there is no playing-level column, no coach accounts, no
// trial record, no AAU record. Those must read UNKNOWN ("GOLSZ cannot see
// this"), never MISSING ("you do not have this"). An athlete may well have
// them. Confusing the two is the product telling someone they fall short of
// something it never looked at.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const SCOUT = fs.readFileSync(path.join(REPO, "api", "scout.js"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- lift both sides, rather than retyping either --------------------------
// A parity test that RETYPES one side pins the typist, not the code.
const clientAt = APP.indexOf("const PATHWAY_KEY_EVIDENCE = {");
ck("the client mirror exists", clientAt > 0, true);
const CLIENT = vm.runInNewContext(
  APP.slice(clientAt, APP.indexOf("\n};", clientAt) + 3) + "\nPATHWAY_KEY_EVIDENCE");

// The server's rows live inside SPORT_CORE-style sport blocks; pull each
// sport's pathways list out of the source itself.
const serverRows = [];
for (const m of SCOUT.matchAll(/\n  (\w+): \{[\s\S]{0,8000}?pathways: \[([\s\S]*?)\n    \],/g)) {
  const sport = m[1];
  for (const r of m[2].matchAll(/\{ id: "([a-z_]+)", goal_type: "([a-z_]+)", label: "[^"]+", levels: \[[^\]]*\],\s*key_evidence: \[([^\]]*)\] \}/g)) {
    serverRows.push({ sport, id: r[1], goal_type: r[2], key_evidence: [...r[3].matchAll(/"([a-z_]+)"/g)].map((q) => q[1]) });
  }
}
ck("the server's rows were actually found (not an empty parity pass)", serverRows.length > 0, true);
ck("...all fourteen of them", serverRows.length, 14);

const clientRows = Object.keys(CLIENT).flatMap((sport) =>
  CLIENT[sport].map((r) => ({ sport, id: r.id, goal_type: r.goal_type, key_evidence: r.key_evidence })));

// Order matters: a reordered evidence list changes which requirement an
// athlete reads first, and a set comparison would not notice.
ck("EVERY ROW MATCHES, IN DECLARED ORDER, FIELD FOR FIELD", clientRows, serverRows);
ck("...and neither side has a row the other lacks", clientRows.length, serverRows.length);

// ---- every key the server can declare has a source decision ----------------
const serverKeys = [...new Set(serverRows.flatMap((r) => r.key_evidence))].sort();
const srcAt = APP.indexOf("const EVIDENCE_SOURCES = {");
ck("EVIDENCE_SOURCES exists", srcAt > 0, true);
const SOURCES = vm.runInNewContext(APP.slice(srcAt, APP.indexOf("\n};", srcAt) + 3) + "\nEVIDENCE_SOURCES");
ck("every evidence key has an explicit source decision",
   serverKeys.filter((k) => !(k in SOURCES)), []);
ck("...and no source is declared for a key nothing requires",
   Object.keys(SOURCES).filter((k) => !serverKeys.includes(k)), []);

// The four with no source are a STATEMENT about this product, not an oversight.
ck("the unknowable four are declared null",
   Object.keys(SOURCES).filter((k) => SOURCES[k] === null).sort(),
   ["aau_exposure", "coach_evaluation", "level", "trial_history"]);
// If a `level` column ever appears on athletes, this fires and the decision
// gets revisited instead of silently staying wrong.
ck("...and `level` is still absent from everything the client reads",
   /athlete\.level\b/.test(APP), false);

// ---- behaviour -------------------------------------------------------------
const gapAt = APP.indexOf("function evaluateGap(sport, pathwayType, athlete, benchmarks, outreach) {");
ck("evaluateGap exists", gapAt > 0, true);
const evaluateGap = vm.runInNewContext(
  APP.slice(clientAt, APP.indexOf("\n};", clientAt) + 3) + "\n" +
  APP.slice(srcAt, APP.indexOf("\n};", srcAt) + 3) + "\n" +
  APP.slice(gapAt, APP.indexOf("\n}", gapAt) + 2) + "\nevaluateGap");

const FULL = { grad_year: 2026, gpa: "3.4", citizenship: "CA", highlights: ["a"] };
{
  const r = evaluateGap("soccer", "ncaa", FULL, [{ metric_key: "match_minutes" }], [{ status: "contacted" }]);
  ck("NCAA soccer evaluates its five requirements", r.items.length, 5);
  ck("...all present when every row exists", r.missing, []);
  ck("...with nothing unknown, because NCAA needs none of the unknowable four", r.unknown, []);
}
{
  const r = evaluateGap("soccer", "ncaa", { grad_year: 2026 }, [], []);
  ck("a bare profile reports what is missing", r.missing.sort(), ["exposure", "film", "gpa", "match_minutes"]);
  ck("...and what is present", r.present, ["grad_year"]);
}
// THE ASSERTION THIS SUITE EXISTS FOR.
{
  const r = evaluateGap("soccer", "professional", FULL, [{ metric_key: "match_minutes" }], []);
  ck("an unseeable requirement is UNKNOWN, not MISSING", r.unknown.sort(), ["level", "trial_history"]);
  ck("...and is never reported as missing", r.missing.includes("level"), false);
  ck("...so a full profile is not told it falls short of what was never checked",
     r.items.filter((x) => x.state === "missing"), []);
}
{
  const r = evaluateGap("basketball", "development", FULL, [], []);
  ck("basketball's own ladder is used", r.pathway, "development");
  ck("...with its unknowables flagged", r.unknown.sort(), ["coach_evaluation", "level"]);
  ck("...and ppg missing, because no such benchmark is recorded", r.missing, ["ppg"]);
}

// Being on a list is not being seen by anyone.
{
  const onList = evaluateGap("soccer", "ncaa", FULL, [{ metric_key: "match_minutes" }], [{ status: "to_contact" }]);
  ck("an uncontacted target does not count as exposure", onList.missing, ["exposure"]);
  const contacted = evaluateGap("soccer", "ncaa", FULL, [{ metric_key: "match_minutes" }], [{ status: "replied" }]);
  ck("...a contacted one does", contacted.missing, []);
}

// Degenerate inputs return null rather than an empty verdict that reads as
// "nothing is required of you".
ck("an unknown sport yields no verdict", evaluateGap("curling", "ncaa", FULL, [], []), null);
ck("no goal yields no verdict", evaluateGap("soccer", null, FULL, [], []), null);
ck("an unknown pathway yields no verdict", evaluateGap("soccer", "nonsense", FULL, [], []), null);
ck("a missing athlete does not throw",
   evaluateGap("soccer", "juco", null, null, null).missing.sort(), ["film", "grad_year"]);
ck("sport matching is case-insensitive", evaluateGap("Soccer", "juco", FULL, [], []).pathway, "juco");
// pathway_plan stores a goal_type, and soccer maps TWO rows to "professional".
// Id-first matching measures such an athlete against the STRICTER row; the
// semi-pro row would quietly tell them they need less than they do.
ck("an ambiguous goal resolves to the stricter row",
   evaluateGap("soccer", "professional", FULL, [], []).pathway, "professional");
ck("...and a goal_type with no id of its own still resolves",
   evaluateGap("basketball", "development", FULL, [], []).pathway, "development");

// An empty string is not a value. gpa: "" must read as missing, not present.
ck("an empty profile field is missing, not present",
   evaluateGap("soccer", "naia", { grad_year: 2026, gpa: "  ", highlights: ["a"] }, [], []).missing, ["gpa"]);

// ---- nothing here produces a number ---------------------------------------
{
  // Comments are stripped first: this function's own prose discusses targets
  // and standards, and grepping the prose instead of the code is a trap this
  // repo has fallen into before.
  const body = APP.slice(gapAt, APP.indexOf("\n}", gapAt))
    .split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  ck("the engine scores nothing", /score|percent|rating/i.test(body), false);
  ck("...and compares against no standard", /BENCHMARK_BANDS|threshold|minimum|requiredValue/i.test(body), false);
  ck("...and the stripped body is still the real function", /key_evidence\.map/.test(body), true);
  ck("the reference population is still empty, so that remains the only option",
     /const BENCHMARK_BANDS = \[\];/.test(SCOUT), true);
}

// ---- WIRED INTO BOTH SCREENS, OFF ROWS THEY ACTUALLY FETCH ----------------
{
  ck("Home computes the gap in its loader", /setGap\(evaluateGap\(ath && ath\.sport, pathwayRow && pathwayRow\.pathway_type/.test(APP), true);
  ck("Plan computes it too", /setGap\(evaluateGap\(ath && ath\.sport, data && data\.pathway_type/.test(APP), true);
  ck("...both from one declaration, not two implementations",
     (APP.match(/function evaluateGap\(/g) || []).length, 1);

  // A requirement cannot be evaluated from a column that is not selected.
  // gpa and citizenship were absent from Home's athletes read entirely, and
  // metric_key — the only field that ties a reading to a requirement — was
  // absent from every benchmark read.
  const homeAth = /from\("athletes"\)\.select\("sport, position, club_name, grad_year, ([^"]*)"\)/.exec(APP);
  ck("Home reads gpa and citizenship", !!homeAth && /gpa/.test(homeAth[1]) && /citizenship/.test(homeAth[1]), true);
  // Only the reads that FEED the engine need it. Of the others, one is a
  // deliberate pre-migration fallback that retries without metric_key when the
  // column is absent, and one is a bare existence count — requiring the column
  // in either would be wrong, so this names the two that matter rather than
  // sweeping the file.
  const benchReads = APP.match(/from\("athlete_benchmarks"\)\.select\("[^"]*"\)/g) || [];
  ck("Home's benchmark read carries metric_key",
     benchReads.some((q) => /"metric, metric_key, value, unit, recorded_date"/.test(q)), true);
  ck("Plan's carries it too", benchReads.some((q) => /select\("metric_key"\)/.test(q)), true);
  ck("...and the only read without it is the documented fallback or a count",
     benchReads.filter((q) => !/metric_key/.test(q))
       .filter((q) => !/"id, metric, value, unit, recorded_date"/.test(q) && !/select\("id"\)/.test(q)), []);
  const planAth = /from\("athletes"\)\.select\("sport, club_name, recruiting_status, scout_context([^"]*)"\)/.exec(APP);
  ck("Plan reads what its requirement list needs",
     !!planAth && ["grad_year", "gpa", "citizenship", "highlights"].every((c) => planAth[1].includes(c)), true);
  // Four reads in one round trip, not four sequential awaits.
  ck("...in the same round trip", /await Promise\.all\(\[[\s\S]{0,700}?outreach_targets"\)\.select\("status"\)/.test(APP), true);

  // THE CARD MUST NOT TURN "CANNOT SEE" INTO A SHORTFALL.
  ck("Plan lists every requirement with its own state",
     /gap\.items\.map\(\(it\) =>[\s\S]{0,700}?t\("gap_state_" \+ it\.state\)/.test(APP), true);
  ck("...present in gold, missing in amber, unseeable in slate",
     /it\.state === "present" \? C\.lime : it\.state === "missing" \? C\.amber : C\.slate/.test(APP), true);
  ck("Home names the first missing requirement, never an unknown one",
     /t\("gap_first_missing"\)[\s\S]{0,120}?gap\.missing\[0\]/.test(APP), true);
  ck("...and says separately what it cannot see",
     /gap\.unknown\.length > 0 &&[\s\S]{0,300}?t\("gap_cannot_see"\)/.test(APP), true);

  // Every evidence key the server can declare needs a human label, or a
  // scout-facing screen renders a snake_case identifier.
  const serverKeys2 = [...new Set(serverRows.flatMap((r) => r.key_evidence))];
  for (const lang of ["en", "fr", "es", "el"]) {
    const at = APP.indexOf("\n  " + lang + ": {");
    const dict = APP.slice(at, APP.indexOf("\n  },", at));
    ck(`  ${lang} labels every evidence key`,
       serverKeys2.filter((k) => !new RegExp("\\bgap_ev_" + k + ': "[^"]+"').test(dict)), []);
    for (const k of ["gap_title", "gap_note", "gap_state_unknown", "gap_first_missing", "gap_cannot_see", "gap_counts"]) {
      ck(`  ${lang}.${k}`, new RegExp("\\b" + k + ': "[^"]+"').test(dict), true);
    }
  }
  // The disclaimer must actually say the thing, in every language.
  const notes = APP.match(/\bgap_note: "([^"]+)"/g) || [];
  ck("four distinct notes", [notes.length, new Set(notes).size], [4, 4]);
  ck("...each stating nothing is scored",
     notes.every((n) => /scored|noté|puntúa|βαθμολογείται/.test(n)), true);
}

const JS = fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8");
ck("the engine is in the compiled bundle", JS.includes("evaluateGap"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
