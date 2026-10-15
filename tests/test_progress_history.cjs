// "AM I IMPROVING?" HAD NO ANSWER AT ALL.
//
// GOLSZ computed a Passport Strength on every Home load and kept none of them,
// so the most prominent number in the product was unanswerable for the
// question people actually have about it. assessment_snapshots (migration 156)
// is the first history of anything in this codebase.
//
// WHAT IT MUST NOT BECOME. Passport Strength measures how complete and
// well-evidenced a profile is. It is not speed, not technique, not ability.
// Nothing here may license "you are improving as a player" — the only honest
// reading is "your Passport is more complete than it was", and the copy says
// Passport for exactly that reason. BENCHMARK_BANDS is still empty.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const MIG = fs.readFileSync(path.join(REPO, "supabase-migration-156-assessment-snapshots.sql"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- A HISTORY THAT CANNOT BE REWRITTEN ------------------------------------
ck("one row per athlete per day", /primary key \(athlete_id, taken_on\)/.test(MIG), true);
ck("self-only read", /using \(athlete_id = auth\.uid\(\)\)/.test(MIG), true);
ck("self-only insert", /with check \(athlete_id = auth\.uid\(\)\)/.test(MIG), true);
// The absence IS the rule: RLS denies by default, so no update policy means a
// snapshot can never be edited and today can never rewrite last month.
ck("NO update policy — a record of a day is not editable", /for update/.test(MIG), false);
ck("NO delete policy either", /for delete/.test(MIG), false);
ck("...and the file says the absence is deliberate",
   /Deliberately no update or delete policy/.test(MIG), true);
ck("RLS is on", /enable row level security/.test(MIG), true);
ck("a score out of range is refused", /check \(composite >= 0 and composite <= 100\)/.test(MIG), true);
ck("nothing is backfilled", /insert into assessment_snapshots/i.test(MIG), false);

// ---- IT IS NOT AN ASSESSMENT OF THE ATHLETE --------------------------------
ck("the table comment says what it measures", /completeness and evidence|profile completeness/i.test(MIG), true);
ck("...and says what it does NOT", /NOT athletic ability|not speed, not technique/i.test(MIG), true);

// ---- WRITTEN WITHOUT A HOOK ------------------------------------------------
// The first version used a useEffect placed where the composite is computed —
// BELOW a state-gated early return, which is the React #310 shape that took
// production down for every signed-in athlete. test_hook_order caught it.
{
  ck("no snapshot hook exists", /snapWrittenRef/.test(APP), false);
  // The write, by its own call rather than by the verb — which changed from
  // insert to upsert once the daily 409 was removed, and silently took this
  // window with it.
  const at = APP.indexOf('sb.from("assessment_snapshots")\n            .upsert(');
  ck("the write is in the loader", at > 0, true);
  const loaderStart = APP.indexOf("const [{ data: prof }, { data: ath }, { data: reqs }");
  const loaderEnd = APP.indexOf("const composite = Math.round(", loaderStart);
  ck("...which is ABOVE where the composite is computed, so no hook is involved",
     at > loaderStart && at < loaderEnd, true);
  const blk = APP.slice(at - 1400, at + 1100);
  ck("...and the window really covers the write", /assessment_snapshots/.test(blk), true);
  // A snapshot of zeros taken before the fetch resolves would be a lie that
  // lives forever in a table nothing is allowed to correct.
  ck("every sub-score comes from the real scoring functions",
     /computeProfileQuality\(ath, prof\)[\s\S]{0,400}?computePerformanceScore\(benchmarks\)[\s\S]{0,200}?computeDevelopmentScore\(devItems\)[\s\S]{0,200}?computePathwayScore\(pathwayRow/.test(blk), true);
  ck("the composite is the same mean the screen shows",
     /READINESS_DIMENSIONS\.reduce\(\(sum, d\) => sum \+ \(snapScores\[d\] \|\| 0\), 0\) \/ READINESS_DIMENSIONS\.length/.test(blk), true);
  // A plain insert returns 409 for every load after the first each day. The
  // code handled it, but the browser logs the 409 at the network layer anyway,
  // so every athlete's console filled with a red line daily for a write that
  // worked. ON CONFLICT DO NOTHING makes it a genuine no-op.
  ck("a second load today is a no-op, not a swallowed 409",
     /ignoreDuplicates: true/.test(blk), true);
  ck("...naming the real key", /onConflict: "athlete_id,taken_on"/.test(blk), true);
  // DO NOTHING needs no UPDATE policy — and there is none, by design.
  ck("...and it does not rely on an update policy that does not exist",
     /\.update\(/.test(blk), false);
  ck("...and any other failure is logged, never shown",
     /console\.warn\("GOLSZ snapshot not written/.test(blk) &&
     !/setErr|setSaveError|alert\(/.test(blk), true);
}

// ---- THE LINE ONLY APPEARS WITH A REAL EARLIER POINT ------------------------
{
  ck("the read excludes today", /\.lt\("taken_on", isoDay\(new Date\(\)\)\)/.test(APP), true);
  ck("...takes the most recent before it", /\.order\("taken_on", \{ ascending: false \}\)\.limit\(1\)/.test(APP), true);
  ck("no history means no line", /\{prevScore && \(/.test(APP), true);
  const at = APP.indexOf("{prevScore && (");
  const blk = APP.slice(at, at + 900);
  // PRESENCE IS NOT REACHABILITY. Written as "the string appears", this
  // passed when the condition guarding it was replaced with `false` — the
  // message was still in the file and could never render. Assert the branch.
  ck("unchanged is its own message, not a zero delta",
     /composite === prevScore\.composite\s*\n?\s*\? t\("progress_same"\)/.test(blk), true);
  ck("...and a zero delta can never reach the up/down copy",
     /\{composite === prevScore\.composite/.test(blk), true);
  ck("...and up and down are distinguished", /progress_up" : "progress_down"/.test(blk), true);
  ck("a rise is gold, everything else is not", /composite > prevScore\.composite \? C\.lime : C\.slate/.test(blk), true);
  ck("the comparison date is always shown", (blk.match(/replace\("\{date\}", prevScore\.on\)/g) || []).length, 2);
}

// ---- THE COPY SAYS PASSPORT, NOT THE ATHLETE -------------------------------
for (const k of ["progress_up", "progress_down", "progress_same"]) {
  const hits = APP.match(new RegExp("\\b" + k + ': "[^"]+"', "g")) || [];
  ck(`  ${k} in four dictionaries, four distinct strings`, [hits.length, new Set(hits).size], [4, 4]);
}
{
  const ups = APP.match(/\bprogress_up: "([^"]+)"/g) || [];
  // Διαβατήρι[οό]: Greek adds a second accent before an enclitic, so
  // "Διαβατήριό σου" does not match a pattern written for "Διαβατήριο". The
  // string was right and the test was wrong.
  ck("every language says PASSPORT, not the player",
     ups.every((v) => /Passport|Passeport|Pasaporte|Διαβατήρι[οό]/.test(v)), true);
  ck("...and none of them claims the athlete improved",
     ups.some((v) => /you are better|you improved|mejor jugador|meilleur joueur/i.test(v)), false);
}

// A table the app keeps about you must be in your export.
ck("the history is exported",
   /\["assessment_snapshots", "assessment_snapshots", "athlete_id"\]/.test(APP), true);

ck("it is in the compiled bundle",
   fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8").includes("assessment_snapshots"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
