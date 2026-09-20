// supabase-schema.sql says "current live state". It has to be.
//
// THE FAILURE THIS CLOSES
// 2026-09-20: the file opened with "GOLSZ — Supabase schema reference (current
// live state) / This file documents what is ACTUALLY deployed" while its
// numbered sections stopped at 135. Migrations 136 through 143 were applied to
// production — including a new table (development_plan_ticks), a new column
// (athlete_benchmarks.measured_by) and a revoke that switched athlete
// discovery off — and none of them were in it.
//
// This matters more than a stale doc usually does. An external audit reads
// this file as the answer to "what is deployed", and a reference that is
// behind is worse than none: the reader cannot tell which half to trust, so
// they stop trusting the repo. It is also the file most likely to be read by
// someone who cannot check it against the live database.
//
// WHAT THIS DOES NOT ASSERT. 83 of the 132 migrations on disk are not
// referenced by number anywhere in the schema file, and that is fine — the
// early history is organised by OBJECT (one section per table with its final
// shape), and only later additive migrations got numbered sections. Demanding
// a number for every migration would fail on day one and be deleted by the
// next person, which is how a guard becomes noise.
//
// So it asserts the one thing that is always true of a current reference: it
// knows about the newest migration on disk.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const SCHEMA = fs.readFileSync(path.join(REPO, "supabase-schema.sql"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const nums = fs.readdirSync(REPO)
  .map((n) => /^supabase-migration-(\d+)-/.exec(n))
  .filter(Boolean)
  .map((m) => Number(m[1]))
  .sort((a, b) => a - b);

ck("migrations are on disk", nums.length > 100, true);
const newest = nums[nums.length - 1];
console.log(`   newest migration on disk: ${newest}`);

// Referenced either as a numbered section header ("-- 143)") or by filename.
const referenced = (n) =>
  new RegExp(`^--\\s*${n}[)\\s]`, "m").test(SCHEMA) ||
  SCHEMA.includes(`supabase-migration-${n}-`);

ck(`the schema reference knows about migration ${newest}`, referenced(newest), true);

// The three most recent, so a gap of one cannot slip through between runs.
const recent = nums.slice(-3);
ck("...and about the three most recent", recent.filter((n) => !referenced(n)), []);

// The claim that creates the obligation. If someone softens the header, this
// guard should stop applying rather than silently keep passing.
const claimsCurrent = /current live state/i.test(SCHEMA) || /ACTUALLY deployed/i.test(SCHEMA);
ck("the file still claims to be current (which is why the above is required)", claimsCurrent, true);

// Objects from the newest migrations must actually appear, not just their
// numbers — a section header with nothing under it would pass the checks above.
for (const [obj, why] of [
  ["development_plan_ticks", "141 created this table"],
  ["measured_by", "142 added this column"],
  ["athletes_read", "139 rewrote this policy"],
]) {
  ck(`${obj} is in the reference (${why})`, SCHEMA.includes(obj), true);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
