// EVERY VALUE THE UI OFFERS IS A VALUE THE DATABASE ACCEPTS.
//
// OCCUPATIONS in golsz-app.html has offered "Parent" for months while
// profiles.occupation's CHECK constraint did not contain it. Picking the one
// option that describes you had your profile UPDATE rejected by Postgres —
// and because occupation stayed null, isParentAccount stayed false, so Family
// Access never rendered and the parent could not reach the athlete they had
// signed up for. The product is sold to parents. Parents could not use it.
//
// Nothing caught it because nothing compared the two lists. A dropdown is a
// promise about what the column will accept; this is that promise, checked.
const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const SCHEMA = fs.readFileSync(path.join(REPO, "supabase-schema.sql"), "utf8");
const MIGS = fs.readdirSync(REPO).filter((f) => /^supabase-migration-.*\.sql$/.test(f)).sort()
  .map((f) => fs.readFileSync(path.join(REPO, f), "utf8")).join("\n");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// The LAST definition wins: a later migration that widens a constraint is the
// one in force, so reading only the schema file would report a stale answer.
function allowedFor(column) {
  const re = new RegExp("check\\s*\\(\\s*(?:" + column + "\\s+is\\s+null\\s+or\\s+)?" + column + "\\s+in\\s*\\(([^)]*)\\)", "gi");
  let last = null;
  for (const src of [SCHEMA, MIGS]) for (const m of src.matchAll(re)) last = m[1];
  if (!last) return null;
  return last.split(",").map((x) => x.trim().replace(/^'|'$/g, "")).filter(Boolean);
}


console.log("-- profiles.occupation --");
const uiList = (APP.match(/const OCCUPATIONS = \[([^\]]*)\]/) || [])[1];
ck("the dropdown list was found", typeof uiList, "string");
const offered = uiList.split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
const allowed = allowedFor("occupation");
ck("the column's allowed values were found", Array.isArray(allowed), true);
console.log("   UI offers: " + offered.join(", "));
console.log("   DB allows: " + (allowed || []).join(", "));
// THE ASSERTION. Anything the UI offers that the column rejects is a control
// that looks like it works and silently does not.
ck("every occupation the UI offers is one the database accepts",
   offered.filter((o) => !allowed.includes(o)), []);
// PARENT ACCOUNTS ARE OFF (2026-09-19). This assertion used to read "...and
// 'Parent' specifically, because the product is sold to parents" and required
// the UI to offer it. GOLSZ is strictly for athletes now, so the requirement
// inverts: the dropdown must NOT offer it.
//
// The database half deliberately does not invert. Migration 138 still allows
// 'Parent' in the CHECK constraint, and that is what makes re-enabling parent
// accounts a client change rather than a migration — the same asymmetry that,
// pointing the other way, caused the original bug: a value the UI offered and
// the column rejected locked every parent out of their own account.
ck("the dropdown does not offer Parent while parent accounts are off",
   offered.includes("Parent"), false);
ck("...but the column still accepts it, so turning them back on needs no migration",
   allowed.includes("Parent"), true);

console.log("\n-- a parent is not locked out by a gate about sport --");
// mustFinishProfile pins the user on the Passport screen until this reports
// true, and go() refuses every other destination while it does.
ck("the live status check exempts a parent",
   /onProfileStatus\(!!\(athlete && athlete\.sport\) \|\| !!\(profile && profile\.occupation === "Parent"\)\)/.test(APP), true);
ck("...and so does the mount-time check that arms the lock first",
   /setProfileComplete\(!!\(data && data\.sport\) \|\| !!\(prof && prof\.occupation === "Parent"\)\)/.test(APP), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
