// THE ONE ARTIFACT THAT LEAVES GOLSZ.
//
// A shared Passport link is the only thing an outside coach ever sees. Until
// migration 154 it carried name, sport, position, club, country, grad year,
// foot, height, weight, bio and highlight links — and not one recorded number
// or a single line of career history, while the athlete looking at the SAME
// Passport inside the app saw both.
//
// THE ASSERTION THIS SUITE EXISTS FOR is not that the data is there. It is
// that nobody's existing link started revealing more. Share tokens are already
// out in the world; adding fields to the function would have widened a
// disclosure the athlete made before the feature existed, with no notice and
// no action by them. Both columns default FALSE and the function returns null
// — not an empty array — until the athlete opts in.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const MIG = fs.readFileSync(path.join(REPO, "supabase-migration-154-passport-performance.sql"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- NOTHING WIDENS WITHOUT THE ATHLETE ------------------------------------
ck("both flags default to false", (MIG.match(/boolean not null default false/g) || []).length, 2);
ck("neither defaults to true", /show_(benchmarks|timeline)\s+boolean not null default true/.test(MIG), false);
ck("benchmarks are gated on the flag",
   /'benchmarks', case when coalesce\(a\.show_benchmarks, false\) then/.test(MIG), true);
ck("the timeline is gated on its own flag",
   /'timeline', case when coalesce\(a\.show_timeline, false\)/.test(MIG), true);
// NULL, not an empty array: "not shared" and "none recorded" are different
// things to say about an athlete, and only one of them is about their data.
ck("a section that is not shared returns null, not an empty array",
   (MIG.match(/else null end/g) || []).length, 2);
ck("the reader is told which sections were shared at all",
   /'shows_benchmarks', coalesce\(a\.show_benchmarks, false\)/.test(MIG) &&
   /'shows_timeline', coalesce\(a\.show_timeline, false\)/.test(MIG), true);
// Nothing in the migration flips an existing row.
ck("no row is backfilled to on", /update athletes set show_/.test(MIG), false);
ck("...and the migration verifies that by query", /expect 0: no existing link's disclosure changed/.test(MIG), true);

// Still scoped to the token's owner, and still refuses a restricted minor.
ck("the function still resolves the user from the token only",
   /select user_id into v_user from passport_share_tokens where token = p_token and not revoked;/.test(MIG), true);
ck("...and still refuses a restricted minor", /is_restricted_minor\(v_user\)/.test(MIG), true);
ck("benchmarks are read for that user alone", /from athlete_benchmarks b where b\.user_id = v_user/.test(MIG), true);

// ---- A NUMBER WITHOUT ITS METHOD IS A CLAIM, NOT EVIDENCE ------------------
ck("the method travels with the value",
   /'measured_by', b\.measured_by, 'protocol', b\.protocol/.test(MIG), true);
{
  const at = APP.indexOf("{p.shows_benchmarks && Array.isArray(p.benchmarks)");
  ck("the public view renders benchmarks", at > 0, true);
  const block = APP.slice(at, APP.indexOf("\n            )}", at));
  ck("...showing the method under each", /describeProtocol\(b, t\)/.test(block), true);
  ck("...and saying so in words when none was recorded", /t\("bench_method_none"\)/.test(block), true);
  ck("...with the provenance note above the numbers", /t\("verify_bench_note"\)/.test(block), true);
  // The product scores none of this and must not look like it does.
  ck("...and no score, rank or comparison", /score|rank|percentile|better|vs\b/i.test(block), false);
}
{
  const at = APP.indexOf("{p.shows_timeline && Array.isArray(p.timeline)");
  ck("the public view renders the career history", at > 0, true);
}
// Both are gated on the FLAG, not merely on the array being non-empty — an
// array that arrives when it should not would otherwise render.
ck("rendering checks the flag, not just the data",
   (APP.match(/p\.shows_(benchmarks|timeline) && Array\.isArray/g) || []).length, 2);

// ---- THE TOGGLES, WITH THE RIGHT DEFAULTS ----------------------------------
{
  ck("the privacy read includes the new columns",
     /select\("scout_visible, show_club, show_country, show_benchmarks, show_timeline"\)/.test(APP), true);
  ck("both rows are in the toggle list",
     /\["show_benchmarks", "privacy_show_benchmarks"[\s\S]{0,180}?\["show_timeline", "privacy_show_timeline"/.test(APP), true);
  // THE BUG THIS AVOIDS: the three older columns are `default true`, so the
  // existing rule reads undefined as ON. Applied to these two it would show an
  // athlete a switch saying ON while their link shares nothing.
  // passport_public joined them 2026-10-21: it is also \`not null default
  // false\`, and it is the only row in this panel that lives on profiles
  // rather than athletes.
  ck("the new rows read undefined as OFF, not ON",
     /const defaultsOff = col === "show_benchmarks" \|\| col === "show_timeline" \|\| col === "passport_public";/.test(APP), true);
  // THE ONE ROW ON A DIFFERENT TABLE. Every other switch here is on
  // athletes; passport_public is on profiles. Writing it to athletes would
  // fail silently under RLS and the switch would spring back on reload.
  ck("passport_public is written to profiles, not athletes",
     /const PRIVACY_TABLE = \(col\) => \(col === "passport_public" \? "profiles" : "athletes"\);/.test(APP), true);
  ck("...and the toggle routes through it rather than naming a table",
     /sb\.from\(PRIVACY_TABLE\(col\)\)\.update\(\{ \[col\]: next \}\)/.test(APP), true);
  ck("...and it is read from profiles in the same panel's load",
     /select\("occupation, passport_public, availability_status/.test(APP), true);
  // A consent toggle the athlete cannot reach is the defect this closes.
  ck("the row is in the list", /\["passport_public", "privacy_passport_public", "privacy_passport_public_sub"\]/.test(APP), true);
  ck("...and its copy exists in all four languages",
     (APP.match(/privacy_passport_public: "/g) || []).length, 4);
  ck("...and the older rows keep reading undefined as ON",
     /const on = defaultsOff \? privacy\[col\] === true : privacy\[col\] !== false;/.test(APP), true);
}

for (const k of ["privacy_show_benchmarks", "privacy_show_benchmarks_sub",
                 "privacy_show_timeline", "privacy_show_timeline_sub"]) {
  const hits = APP.match(new RegExp("\\b" + k + ': "[^"]+"', "g")) || [];
  ck(`  ${k} in four dictionaries, four distinct strings`, [hits.length, new Set(hits).size], [4, 4]);
}
// The sub-labels must say it is off until turned on, or an athlete assumes it
// is already sharing.
{
  const subs = APP.match(/\bprivacy_show_benchmarks_sub: "([^"]+)"/g) || [];
  ck("every language says it is off until switched on",
     subs.every((v) => /Off until|Désactivé tant|Desactivado hasta|Ανενεργό μέχρι/.test(v)), true);
}

ck("it is in the compiled bundle",
   fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8").includes("shows_benchmarks"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
