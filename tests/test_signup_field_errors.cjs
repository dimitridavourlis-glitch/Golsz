// SIGN-UP EXPLAINS EVERY INVALID FIELD IN WORDS.
// signupFieldErrors and signupErrorKey are lifted from the real source and run.
// `ok` in Auth must be derived from signupFieldErrors, so the button, the
// messages and submit()'s refusal cannot disagree.

const fs = require("fs");
const path = require("path");
const APP = fs.readFileSync(path.join(__dirname, "..", "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) p++; else { f++; console.log(`FAIL  ${l}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(e)}`); }
};
const fnText = (name) => {
  const s = APP.indexOf(`function ${name}(`);
  if (s < 0) return null;
  return APP.slice(s, APP.indexOf("\n}\n", s) + 3);
};

const parts = ["isRealDate", "isNetworkError", "signupErrorKey", "signupFieldErrors"].map(fnText);
ck("found every function in the source", parts.every(Boolean), true);
const PASSWORD_MIN = /const PASSWORD_MIN = (\d+);/.exec(APP)[1];
const { signupFieldErrors, signupErrorKey } = new Function(
  `const PASSWORD_MIN = ${PASSWORD_MIN};\n${parts.join("\n")}\nreturn { signupFieldErrors, signupErrorKey };`)();

const today = new Date(2026, 10, 3); // 3 November 2026, local
const valid = {
  mode: "signup", email: "a@b.co", email2: "", pw: "12345678", name: "Ada Lovelace",
  dobDay: "3", dobMonth: "11", dobYear: "2000", confirmEmailNeeded: false, turnstileOk: true, today,
};
const run = (o) => signupFieldErrors({ ...valid, ...o });

ck("all-valid input gives {}", run({}), {});
ck("17 years 364 days is under 18", run({ dobDay: "4", dobYear: "2008" }).dob, "auth_under18_notice");
ck("exactly 18 today gives no dob error", run({ dobDay: "3", dobMonth: "11", dobYear: "2008" }).dob, undefined);
ck("31/02/2000 is not a real date", run({ dobDay: "31", dobMonth: "2", dobYear: "2000" }).dob, "auth_err_dob_invalid");
ck("a future date is invalid", run({ dobDay: "4", dobMonth: "11", dobYear: "2026" }).dob, "auth_err_dob_invalid");
ck("a year before 1900 is invalid", run({ dobYear: "1899" }).dob, "auth_err_dob_invalid");
ck("a missing day is incomplete", run({ dobDay: "" }).dob, "auth_err_dob_incomplete");
ck("a three-digit year is incomplete", run({ dobYear: "200" }).dob, "auth_err_dob_incomplete");
ck("7-char password gives the password key", run({ pw: "1234567" }).pw, "auth_err_weak_password");
ck("8-char password is fine", run({ pw: "12345678" }).pw, undefined);
ck("a@b is a malformed email", run({ email: "a@b" }).email, "auth_err_email_invalid");
ck("empty email is missing", run({ email: "  " }).email, "auth_err_email_required");
ck("empty name is missing", run({ name: " " }).name, "auth_err_name_required");
ck("confirm email mismatch", run({ confirmEmailNeeded: true, email2: "x@y.co" }).email2, "auth_err_email_mismatch");
ck("confirm email match ignores case and spaces", run({ confirmEmailNeeded: true, email2: " A@B.CO " }).email2, undefined);
ck("verification not done", run({ turnstileOk: false }).verify, "auth_err_verification");
ck("sign-in needs only email and password", signupFieldErrors({ ...valid, mode: "login", name: "", dobDay: "", dobMonth: "", dobYear: "", pw: "x" }), {});
ck("sign-in with no password", signupFieldErrors({ ...valid, mode: "login", pw: "" }).pw, "auth_err_password_required");

/* ---------- the server's refusal ---------- */
ck("handle_new_user() refusal maps to the signup-refused key",
  signupErrorKey({ code: "unexpected_failure", message: "Database error saving new user" }), "auth_err_signup_refused");
ck("...by wording alone too", signupErrorKey({ message: "Database error saving new user" }), "auth_err_signup_refused");
ck("an unrelated error is still generic", signupErrorKey({ code: "boom", message: "x" }), "err_generic");

/* ---------- wiring ---------- */
ck("`ok` is derived from signupFieldErrors (no second rule)",
  /const ok = isParentSignup\s*\?[^;]*:\s*Object\.keys\(fieldErrors\)\.length === 0;/.test(APP) && /const fieldErrors = isParentSignup \? \{\} : signupFieldErrors\(/.test(APP), true);
ck("submit() refuses when errors exist, shows them and focuses the first field",
  /if \(!ok\) \{\s*setShowErrors\(true\);[\s\S]*?\.focus\(\);\s*return;/.test(APP), true);
ck("the submit button is not disabled by validation errors", /<button type="submit" disabled=\{busy \|\| confirmPolling \|\| \(isParentSignup && !ok\)\}/.test(APP), true);
ck("fields carry aria-invalid and aria-describedby", /"aria-invalid": true, "aria-describedby": "signup-err-" \+ f/.test(APP), true);

/* ---------- strings ---------- */
const starts = ["en", "fr", "es", "el"].map((l) => APP.indexOf(`\n  ${l}: {`));
ck("found the four dictionaries", starts.every((s) => s > 0), true);
const dicts = starts.map((s) => APP.slice(s, APP.indexOf("\n  },\n", s)));
const grab = (d, k) => (new RegExp(`\\b${k}: "((?:[^"\\\\]|\\\\.)*)"`).exec(d) || [])[1];
for (const k of ["auth_err_name_required", "auth_err_email_required", "auth_err_password_required", "auth_err_dob_incomplete", "auth_err_dob_invalid", "auth_err_signup_refused"]) {
  ck(`${k} exists in en, fr, es and el`, dicts.map((d) => !!grab(d, k)), [true, true, true, true]);
}
ck("the refusal message says 18 in every language", dicts.map((d) => /18/.test(grab(d, "auth_err_signup_refused"))), [true, true, true, true]);
ck("every key signupFieldErrors can return exists in all four languages",
  [...new Set(parts[3].match(/"(auth_[a-z0-9_]+)"/g))].map((k) => k.slice(1, -1)).every((k) => dicts.every((d) => !!grab(d, k))), true);

console.log(f ? `${p}/${p + f} passed, ${f} FAILED` : `${p}/${p} passed`);
process.exit(f ? 1 : 0);
