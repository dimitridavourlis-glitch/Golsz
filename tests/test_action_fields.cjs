// THE BRIEF'S ACTION FIELDS, WITHOUT THE CUTOVER.
//
// An action is meant to carry a category, a priority and a reason. The jsonb
// array has none of them, and the usual answer — migrate every reader to
// athlete_actions first — is weeks of work on a column two screens race on.
//
// It was not necessary. sync_athlete_actions() overwrites only title, due_on,
// due_src, stage_id, status, completed_at and updated_at, so every other
// column on that table survives every sync, tick and rename untouched. That
// makes athlete_actions already a correct home for fields the jsonb cannot
// hold, and this suite's job is to keep that true: the moment the client
// writes a column the sync also writes, the two have something to disagree
// about and this stops being safe.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const MIG144 = fs.readFileSync(path.join(REPO, "supabase-migration-144-athlete-actions.sql"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- the categories are the CONSTRAINT's, not a parallel list -------------
const at = APP.indexOf("const ACTION_CATEGORIES = [");
ck("the client declares the categories", at > 0, true);
const CLIENT = vm.runInNewContext(APP.slice(at, APP.indexOf("];", at) + 2) + "\nACTION_CATEGORIES");

const check = MIG144.slice(MIG144.indexOf("athlete_actions_category_check\n"), MIG144.indexOf("athlete_actions_due_src_check"));
const DB = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
ck("the database's list was found", DB.length, 11);
ck("CLIENT AND CONSTRAINT MATCH, IN ORDER", CLIENT, DB);
// A value outside the CHECK is a 400 from Postgres at runtime, not a UI bug.
ck("...so no option can be rejected by the database", CLIENT.filter((c) => !DB.includes(c)), []);
ck("...and every allowed value is offered", DB.filter((c) => !CLIENT.includes(c)), []);

// Every category needs a label or the select renders snake_case to an athlete.
for (const lang of ["en", "fr", "es", "el"]) {
  const dictAt = APP.indexOf("\n  " + lang + ": {");
  const dict = APP.slice(dictAt, APP.indexOf("\n  },", dictAt));
  ck(`  ${lang} labels every category`,
     DB.filter((c) => !new RegExp("\\baction_cat_" + c + ': "[^"]+"').test(dict)), []);
}

// ---- reads and writes are scoped to the athlete and the step --------------
{
  const rd = APP.slice(APP.indexOf("async function loadActionFields("), APP.indexOf("\n}", APP.indexOf("async function loadActionFields(")));
  ck("the read is scoped to the athlete AND the step",
     /\.eq\("user_id", uid\)\.eq\("legacy_milestone_id", String\(stepId\)\)/.test(rd), true);
  ck("...and checks { error } rather than assuming", /if \(error\)/.test(rd), true);
  ck("...returning null rather than a shape it invented", /return data \|\| null;/.test(rd), true);

  const wr = APP.slice(APP.indexOf("async function saveActionFields("), APP.indexOf("\n}", APP.indexOf("async function saveActionFields(")));
  ck("the write is scoped the same way",
     /\.eq\("user_id", uid\)\.eq\("legacy_milestone_id", String\(stepId\)\)/.test(wr), true);
  // An insert here could race the sync into a duplicate the partial unique
  // index would reject anyway. Rows come from the plan, never from this panel.
  ck("it updates and never inserts", /\.update\(/.test(wr) && !/\.insert\(|\.upsert\(/.test(wr), true);
}

// ---- every write rolls back on failure ------------------------------------
// A category that shows as saved when the server never heard is worse than one
// that visibly failed — the rule every optimistic write in this repo follows.
{
  const panel = APP.slice(APP.indexOf('<label style={editorLabel}>{t("action_category")}</label>'),
                          APP.indexOf('{t("action_fields_note")}'));
  ck("the editor panel was located", panel.length > 500, true);
  ck("all three writes restore the previous value on error",
     (panel.match(/if \(error\) \{ setFields\(before\); setSaveError/g) || []).length, 3);
  ck("...and each snapshots BEFORE changing the screen",
     (panel.match(/const before = fields;\s*\n\s*setFields\(/g) || []).length, 3);
  ck("...and tells the athlete it failed",
     (panel.match(/setSaveError\(t\("pathway_save_failed"\)\)/g) || []).length, 3);

  // Until the row is loaded the controls are disabled rather than showing a
  // default the athlete never chose.
  ck("controls are disabled while the row is unknown",
     (panel.match(/disabled=\{!fields/g) || []).length >= 3, true);
  // Free text commits on blur, not per keystroke.
  ck("the reason commits on blur", /onBlur=\{\(e\) => \{/.test(panel), true);
  ck("...and not when it has not changed", /v === \(\(fields\.reason \|\| ""\)\.trim\(\)\)/.test(panel), true);
  // Nothing here is scored, and the note says so.
  ck("the panel says nothing here is scored", /action_fields_note/.test(APP), true);
}

{
  const notes = APP.match(/\baction_fields_note: "([^"]+)"/g) || [];
  ck("four distinct notes", [notes.length, new Set(notes).size], [4, 4]);
  // Per language, because the English phrasing is "Nothing here IS scored" —
  // a pattern written for "not scored" matched none of the four and reported
  // a problem with the strings rather than with itself.
  const says = { en: /Nothing here is scored/, fr: /n'est noté/, es: /se puntúa/, el: /βαθμολογείται/ };
  ck("...each saying nothing here is scored",
     Object.keys(says).filter((k) => !notes.some((n) => says[k].test(n))), []);
}

// ---- the fields are loaded when the editor opens --------------------------
ck("opening a step loads its fields", /loadActionFields\(sb, uid, m\.id\)\.then\(setFields\);/.test(APP), true);
ck("...after clearing the previous step's, so one step never shows another's",
   /setFields\(null\);\s*\n\s*loadActionFields/.test(APP), true);

// ---- "SAVE GOAL" ON FIVE THINGS THAT ARE NOT A GOAL -----------------------
//
// goal_card_save is correct in GoalCard and was reused in five other editors:
// the backup plan, a target, two development-plan surfaces and the step
// editor. English and Spanish athletes read "Save goal" while saving a step;
// French and Greek never saw it because their translations were already
// generic. A shared key is not a shared meaning, and a parity test counts
// keys, not senses — which is why this went unnoticed.
{
  const GOAL_SAVE = 't("goal_' + 'card_save")';   // split so this file's own
                                                   // prose cannot be counted
  const goalSaves = APP.split(GOAL_SAVE).length - 1;
  ck("only one surface still says Save goal", goalSaves, 1);
  // Bounded by the next TOP-LEVEL function, not the next "function " — GoalCard
  // contains nested ones, and the first version ended the slice inside it.
  {
    const start = APP.indexOf("\nfunction GoalCard(");
    const end = APP.indexOf("\nfunction ", start + 10);
    ck("GoalCard's body was located", start > 0 && end > start, true);
    ck("...and the remaining one is inside it",
       APP.slice(start, end).includes(GOAL_SAVE), true);
  }
  ck("the other five use a neutral label", (APP.match(/t\("form_save"\)/g) || []).length, 5);
  const hits = APP.match(/\bform_save: "[^"]+"/g) || [];
  ck("four dictionaries, four distinct strings", [hits.length, new Set(hits).size], [4, 4]);
  ck("...and none of them says goal",
     hits.some((h) => /goal|objetivo|objectif|στόχ/i.test(h)), false);
}

ck("it is in the compiled bundle",
   fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8").includes("saveActionFields"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
