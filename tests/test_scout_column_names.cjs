// A wrong column name is invisible at runtime, in two directions.
//
// THE CLASS THIS CLOSES — three instances in one day
//   1. WRONG KEY ON THE RESULT. `athleteRow.career_timeline` is `undefined`
//      forever. Array.isArray(undefined) is false, the list stays empty, the
//      prompt line never renders, and Scout simply never mentions the athlete's
//      timeline. A feature that never appears looks exactly like one nobody
//      uses. The real column is `timeline` (migration 065).
//   2. WRONG NAME IN A SELECT. PostgREST rejects the ENTIRE request on an
//      unknown column, so the whole fetch fails, the caller's catch swallows
//      it, and every field that query provided silently becomes absent — not
//      just the mistyped one.
//
// Neither produces an error, a log line, or a failing test. The other two
// instances the same day were the highlight->posts insert that had produced
// ZERO rows since it shipped, and `answered_by` meaning both faq and cache.
// See golsz-guard/measurement-integrity.
//
// ---------------------------------------------------------------------------
// WHAT THIS CANNOT DO, STATED UP FRONT
// ---------------------------------------------------------------------------
// It cannot verify a column EXISTS on athletes, because supabase-schema.sql
// does not contain a `create table ... athletes` at all — only `alter table
// athletes add column` statements. The base columns (sport, position, gpa,
// grad_year, height_cm, weight_kg ...) are defined somewhere this repo does
// not hold. An earlier attempt at this file assumed the create-table was
// present, sliced on it, got indexOf() === -1, and read the last character of
// the file as its column set — then reported real columns as bogus. It was
// parked rather than shipped, because a detector that cries wolf gets muted
// and a muted detector is worse than none.
//
// So this asserts two things it CAN prove from the repo alone:
//   A. internal consistency — every key read off a row was actually selected;
//   B. plausibility — every selected name appears somewhere in the schema.
// (B) is weaker than "exists on athletes", but it catches invented names:
// `career_timeline` appears nowhere in the schema, while every real column
// appears somewhere — in a migration, a policy, an index or a function.
//
// Verifying existence properly needs information_schema, which means database
// access this suite does not have. That is a real gap, not an oversight.

const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const SCOUT = fs.readFileSync(path.join(REPO, "api/scout.js"), "utf8");
const SCHEMA = fs.readFileSync(path.join(REPO, "supabase-schema.sql"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- every PostgREST select in scout.js, attributed to its table ----------
// Scanning per-request instead of with one regex: the URLs are built by string
// concatenation, so a permissive `[\s\S]{0,200}` window between `athletes?` and
// `select=` runs straight past the end of one request and into the next. An
// earlier version did exactly that and attributed scout_memory's columns
// (type, subject, content) to athletes.
function selectsByTable(src) {
  const out = {};
  const parts = src.split("/rest/v1/");
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const table = (chunk.match(/^([a-z_]+)/) || [])[1];
    if (!table) continue;
    const sel = chunk.match(/[?&]select=([a-zA-Z_,()]+)/);   // this request only
    if (!sel) continue;
    (out[table] = out[table] || []).push(sel[1]);
  }
  return out;
}
const byTable = selectsByTable(SCOUT);
ck("selects were found and attributed to tables", Object.keys(byTable).length > 3, true);
// The bug that motivated the split: scout_memory's columns must not land on athletes.
const athleteSel = (byTable.athletes || []).join(",").split(",").filter(Boolean);
ck("athletes selects were found", athleteSel.length > 5, true);
ck("...and did not absorb another table's columns",
   ["type", "subject", "content", "importance"].filter((c) => athleteSel.includes(c)), []);

// The `cols` string that buildAuthoritativeContext concatenates into its URL
// is not inside a /rest/v1/ literal, so it is collected separately.
const colsDecl = /const cols = "([a-z_,]+)"/.exec(SCOUT);
ck("the cols declaration was found", !!colsDecl, true);
const selected = new Set([...athleteSel, ...colsDecl[1].split(",").map((x) => x.trim())].filter(Boolean));

// ---- A. every key read off athleteRow was actually selected ---------------
// This is the half that catches the silent one. A typo here is `undefined`,
// never an error, and the feature just never appears.
const reads = [...new Set([...SCOUT.matchAll(/athleteRow\.([a-z_]+)/g)].map((m) => m[1]))];
ck("athleteRow reads were found", reads.length > 0, true);
ck("every key read off athleteRow was selected", reads.filter((r) => !selected.has(r)), []);

// ---- B. every selected name is plausible ---------------------------------
// Weak by design — see the header. A real column appears somewhere in the
// schema; an invented one does not.
const unknown = [...selected].filter((c) => !new RegExp("\\b" + c + "\\b").test(SCHEMA));
ck("every selected column appears somewhere in the schema", unknown, []);

// ---- the detector must fire on the real bug ------------------------------
// Both fixtures reproduce the exact 2026-08-13 mistake.
const BROKEN_READ = 'const cols = "sport,timeline";\nathletes?id=eq.x&select=sport,timeline\nathleteRow.career_timeline';
{
  const bt = selectsByTable(BROKEN_READ);
  const sel = new Set((bt.athletes || []).join(",").split(","));
  ["sport", "timeline"].forEach((c) => sel.add(c));
  const rd = [...new Set([...BROKEN_READ.matchAll(/athleteRow\.([a-z_]+)/g)].map((m) => m[1]))];
  ck("the detector flags a key that was never selected", rd.filter((r) => !sel.has(r)), ["career_timeline"]);
}
ck("...and an invented column name is not in the schema",
   /\bcareer_timeline\b/.test(SCHEMA), false);
// ...and stays silent on the correct spelling, so it detects the mismatch
// rather than merely the presence of the word.
ck("the real column IS in the schema", /\btimeline\b/.test(SCHEMA), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
