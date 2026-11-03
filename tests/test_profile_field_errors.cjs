// THE PASSPORT EDITOR EXPLAINS EACH INVALID FIELD NEXT TO THE FIELD.
// profileFieldErrors is lifted from the real source and run; save() must
// return on any error before moderation or the database.

const fs = require("fs");
const path = require("path");
const APP = fs.readFileSync(path.join(__dirname, "..", "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) p++; else { f++; console.log(`FAIL  ${l}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(e)}`); }
};

const s = APP.indexOf("function profileFieldErrors(");
ck("found profileFieldErrors in the source", s > 0, true);
const profileFieldErrors = new Function(`${APP.slice(s, APP.indexOf("\n}\n", s) + 3)}\nreturn profileFieldErrors;`)();

const now = new Date(2026, 10, 3);
const player = { full_name: "Ada", occupation: "Player", sport: "Soccer", height_cm: "180", weight_kg: "75", gpa: "3.8", grad_year: "2027" };
const coach = { full_name: "Bo", occupation: "Coach", sport: "Soccer", club_name: "FC Nord" };
const run = (o, isPlayer = true, base = player) => profileFieldErrors({ ...base, ...o }, isPlayer, now);

ck("a complete valid player gives {}", run({}), {});
ck("a complete valid coach gives {}", run({}, false, coach), {});
ck("an empty optional number is fine", run({ height_cm: "", gpa: "", grad_year: "", weight_kg: "" }), {});
ck("empty name", run({ full_name: "  " }).full_name, "editor_name_required");
ck("missing occupation", run({ occupation: "" }).occupation, "auth_occupation_required");
ck("player with no sport", run({ sport: "" }).sport, "editor_sport_required");
ck("non-player with no team", run({ club_name: " " }, false, coach).club_name, "editor_team_required");
ck("a player needs no team", run({ club_name: "" }).club_name, undefined);
ck("a parent needs no sport", run({ occupation: "Parent", sport: "" }, false, coach).sport, undefined);
ck("height 1.8 (metres in cm)", run({ height_cm: "1.8" }).height_cm, "editor_height_range");
ck("height 100 and 250 are allowed", [run({ height_cm: "100" }).height_cm, run({ height_cm: "250" }).height_cm], [undefined, undefined]);
ck("height 251", run({ height_cm: "251" }).height_cm, "editor_height_range");
ck("weight 29 and 251", [run({ weight_kg: "29" }).weight_kg, run({ weight_kg: "251" }).weight_kg], ["editor_weight_range", "editor_weight_range"]);
ck("GPA 7", run({ gpa: "7" }).gpa, "editor_gpa_range");
ck("GPA 0 and 5 are allowed", [run({ gpa: "0" }).gpa, run({ gpa: "5" }).gpa], [undefined, undefined]);
ck("negative GPA", run({ gpa: "-1" }).gpa, "editor_gpa_range");
ck("grad_year 2099", run({ grad_year: "2099" }).grad_year, "editor_grad_year_range");
ck("grad_year 1949", run({ grad_year: "1949" }).grad_year, "editor_grad_year_range");
ck("grad_year this year + 8 is allowed, +9 is not", [run({ grad_year: "2034" }).grad_year, run({ grad_year: "2035" }).grad_year], [undefined, "editor_grad_year_range"]);
ck("not a number", run({ height_cm: "abc" }).height_cm, "editor_height_range");
ck("a coach's stale numbers are not checked", run({ height_cm: "1.8" }, false, coach).height_cm, undefined);

/* ---------- wiring ---------- */
const editor = APP.slice(APP.indexOf("function ProfileEditor("));
const saveAt = editor.indexOf("const name = (form.full_name");
const body = editor.slice(saveAt, editor.indexOf("\n  }\n", saveAt));
const iErr = body.indexOf("profileFieldErrors(");
ck("save() computes profileFieldErrors", iErr > 0, true);
ck("save() returns on errors before moderateContent",
  /if \(Object\.keys\(errs\)\.length\) \{[\s\S]*?return;\s*\}/.test(body) && body.indexOf("return;") < body.indexOf("moderateContent("), true);
ck("save() focuses the first invalid field", /document\.getElementById\("editor-" \+ first\)[\s\S]*?\.focus\(\)/.test(body), true);
ck("the form-level err is kept for save failures", /setErr\(userErrorText\(e, t, "editor_save_err"\)\)/.test(body), true);
ck("fields carry aria-invalid and aria-describedby", /"aria-invalid": true, "aria-describedby": "editor-err-" \+ k/.test(APP), true);
for (const k of ["full_name", "occupation", "sport", "grad_year", "height_cm", "weight_kg", "gpa", "club_name"]) {
  ck(`${k} input has errProps and a message`, APP.includes(`errProps("${k}")`) && APP.includes(`fieldError("${k}")`), true);
}

/* ---------- strings ---------- */
const starts = ["en", "fr", "es", "el"].map((l) => APP.indexOf(`\n  ${l}: {`));
const dicts = starts.map((x) => APP.slice(x, APP.indexOf("\n  },\n", x)));
const grab = (d, k) => (new RegExp(`\\b${k}: "((?:[^"\\\\]|\\\\.)*)"`).exec(d) || [])[1];
const fnSrc = APP.slice(s, APP.indexOf("\n}\n", s) + 3);
const keys = [...new Set(fnSrc.match(/"((?:editor|auth)_[a-z0-9_]+)"/g))].map((k) => k.slice(1, -1));
ck("the function returns at least the 8 keys", keys.length >= 8, true);
for (const k of keys) ck(`${k} exists in en, fr, es and el`, dicts.map((d) => !!grab(d, k)), [true, true, true, true]);

console.log(f ? `${p}/${p + f} passed, ${f} FAILED` : `${p}/${p} passed`);
process.exit(f ? 1 : 0);
