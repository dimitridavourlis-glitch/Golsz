// SCOUT CAN SAY WHAT KIND OF WORK A STEP IS — AND THE ATHLETE OUTRANKS IT.
//
// The brief asks Scout to create typed actions: a training action, a testing
// action, an outreach action, a film action. It could only ever propose a
// label. Now it proposes a category too, validated at three gates before it
// can reach storage: the model's word is checked server-side in api/scout.js,
// again by normalizeMilestone on the client, and once more inside
// sync_athlete_actions() before the CHECK constraint sees it.
//
// THE PROPERTY THIS SUITE EXISTS FOR is in migration 155: category appears in
// the sync's INSERT column list and NOT in its DO UPDATE SET. A new step is
// created with the kind Scout proposed; an athlete who then corrects it in the
// step editor is never overruled, however many times the sync runs afterwards.
// Putting it in the update clause instead would mean every tick of a step
// quietly reverted their correction — the kind of bug nobody reports because
// it looks like they misremembered.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const SCOUT = fs.readFileSync(path.join(REPO, "api", "scout.js"), "utf8");
const MIG155 = fs.readFileSync(path.join(REPO, "supabase-migration-155-sync-category.sql"), "utf8");
const MIG144 = fs.readFileSync(path.join(REPO, "supabase-migration-144-athlete-actions.sql"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- THE PROPERTY -----------------------------------------------------------
{
  const ins = MIG155.slice(MIG155.indexOf("insert into athlete_actions"), MIG155.indexOf("on conflict"));
  // Comments stripped: the line explaining that category is deliberately
  // absent from this clause contains the word "category", and matched. This
  // repo has tripped its own greps on its own prose repeatedly.
  const upd = MIG155.slice(MIG155.indexOf("do update set"), MIG155.indexOf("returning 1", MIG155.indexOf("do update set")))
    .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  ck("the insert carries the category", /legacy_milestone_id, category\)/.test(ins), true);
  ck("...from the step", /s\.sid, s\.category/.test(ins), true);
  ck("THE UPDATE CLAUSE DOES NOT TOUCH IT", /category/.test(upd), false);
  // The rest of the sync must be unchanged — this migration replaces the whole
  // function, so a column silently dropped from the update is a real risk.
  ck("...while still updating everything it used to",
     ["title", "due_on", "due_src", "stage_id", "status", "completed_at", "updated_at"]
       .filter((c) => !new RegExp("\\b" + c + "\\s*=").test(upd)), []);
  ck("...and the first completion moment is still kept",
     /coalesce\(athlete_actions\.completed_at, excluded\.completed_at\)/.test(upd), true);
  // Dropping `returning 1` would silently make the synced count always zero.
  ck("the upserted CTE still returns rows", /updated_at   = now\(\)[\s\S]{0,120}?returning 1/.test(MIG155), true);
}

// ---- THREE GATES, ALL AGREEING WITH THE CONSTRAINT -------------------------
const check = MIG144.slice(MIG144.indexOf("athlete_actions_category_check\n"), MIG144.indexOf("athlete_actions_due_src_check"));
const DB = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
ck("the constraint's list was found", DB.length, 11);

const client = vm.runInNewContext(
  APP.slice(APP.indexOf("const ACTION_CATEGORIES = ["), APP.indexOf("];", APP.indexOf("const ACTION_CATEGORIES = [")) + 2) + "\nACTION_CATEGORIES");
ck("the client's list matches the constraint, in order", client, DB);

const scoutList = vm.runInNewContext(
  SCOUT.slice(SCOUT.indexOf("const ACTION_CATEGORIES = ["), SCOUT.indexOf("];", SCOUT.indexOf("const ACTION_CATEGORIES = [")) + 2) + "\nACTION_CATEGORIES");
ck("the server's list matches too", scoutList, DB);

// Sliced from AFTER the column reference, or the word "category" in
// m->>'category' is collected as if it were one of the allowed values.
const listAt = MIG155.indexOf("case when m->>'category' in (") + "case when m->>'category' in ".length;
const inSql = [...MIG155.slice(listAt, MIG155.indexOf("then m->>'category'")).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
ck("and the sync's own list matches", inSql, DB);

// ---- an unrecognised value degrades, it does not reach the database --------
{
  const at = SCOUT.indexOf("const catOf = (v) =>");
  const catOf = vm.runInNewContext(
    SCOUT.slice(SCOUT.indexOf("const ACTION_CATEGORIES = ["), SCOUT.indexOf(";", at) + 1) + "\ncatOf");
  ck("a real category passes", catOf("film"), "film");
  ck("...case-insensitively", catOf("  Film "), "film");
  ck("an invented one becomes other", catOf("sprinting"), "other");
  ck("a non-string becomes other", catOf(42), "other");
  ck("absent becomes other", catOf(undefined), "other");
  // "other" is a real category, not a guess about the athlete's work.
  ck("every output is one the database accepts",
     ["film", "sprinting", 42, undefined, null, "", "TRAINING"].map(catOf).filter((c) => !DB.includes(c)), []);
}

// The client normaliser is the second gate, and must not invent one either.
{
  const at = APP.indexOf("function normalizeMilestone(m) {");
  const nm = APP.slice(at, APP.indexOf("\n}", at));
  ck("the client validates against the same list",
     /ACTION_CATEGORIES\.indexOf\(m\.category\) !== -1/.test(nm), true);
  ck("...and stores null rather than a guess when absent", /: null,/.test(nm), true);
  // The constant must be declared ABOVE its reader: a const is not hoisted,
  // and relying on "nothing calls this during module evaluation" is a property
  // of today's call sites, not of the code.
  ck("ACTION_CATEGORIES is declared before normalizeMilestone",
     APP.indexOf("const ACTION_CATEGORIES = [") < at, true);
}

// ---- the contract tells the model what the field is -------------------------
ck("the output contract names the field", /"category": "training\|recovery/.test(SCOUT), true);
ck("...and the guidance says not to stretch one to seem precise",
   /do not stretch a category to seem precise/.test(SCOUT), true);
ck("...and tells it guessing gains nothing", /guessing gains you\s*\n?nothing/.test(SCOUT), true);
ck("Scout attaches it to every proposed step", /category: catOf\(m\.category\)/.test(SCOUT), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
