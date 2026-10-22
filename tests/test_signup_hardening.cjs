// SIGNUP: WHAT A NEW CUSTOMER IS TOLD, AND WHAT THEY ARE ASKED TO TYPE TWICE.
//
// From the 2026-10-22 commercial-readiness audit:
//   * a paid signup opens checkout BEFORE the email is confirmed, so a mistyped
//     address charges someone for an account they can never open
//   * the password floor was 6, copied into three places
//   * signup showed Supabase's raw English ("User already registered") and
//     matched our own thrown sentences by their wording
//   * four notices and a button label were hard-coded English in a
//     four-language app
//
// signupErrorKey is extracted from the real source and run, not retyped.

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

/* ---------- the error mapper, run for real ---------- */
const net = fnText("isNetworkError");
const map = fnText("signupErrorKey");
ck("found isNetworkError and signupErrorKey in the source", !!net && !!map, true);
const signupErrorKey = new Function(net + "\n" + map + "\nreturn signupErrorKey;")();
const E = (props) => Object.assign(new Error(props.message || "x"), props);

ck("our own rate-limit code", signupErrorKey(E({ code: "golsz_rate_limited" })), "auth_err_rate_limited");
ck("our own verification code", signupErrorKey(E({ code: "golsz_verification_failed" })), "auth_err_verification");
ck("Supabase weak_password by code", signupErrorKey(E({ code: "weak_password", message: "anything" })), "auth_err_weak_password");
ck("...and by its older wording, when no code is present", signupErrorKey(E({ message: "Password should be at least 6 characters" })), "auth_err_weak_password");
ck("invalid email by code", signupErrorKey(E({ code: "email_address_invalid" })), "auth_err_email_invalid");
ck("validation_failed is treated as a bad email, not shown raw", signupErrorKey(E({ code: "validation_failed" })), "auth_err_email_invalid");
ck("Supabase's rate limits by code", [signupErrorKey(E({ code: "over_request_rate_limit" })), signupErrorKey(E({ code: "over_email_send_rate_limit" }))], ["auth_err_rate_limited", "auth_err_rate_limited"]);
ck("...and an HTTP 429", signupErrorKey(E({ status: 429, message: "slow down" })), "auth_err_rate_limited");
ck("a CAPTCHA failure reads as a verification problem", [signupErrorKey(E({ code: "captcha_failed" })), signupErrorKey(E({ message: "captcha verification process failed" }))], ["auth_err_verification", "auth_err_verification"]);
ck("an existing account", [signupErrorKey(E({ code: "user_already_exists" })), signupErrorKey(E({ code: "email_exists" })), signupErrorKey(E({ message: "User already registered" }))],
   ["auth_email_already_registered", "auth_email_already_registered", "auth_email_already_registered"]);
ck("a network failure", signupErrorKey(new TypeError("Failed to fetch")), "err_network");
ck("anything unrecognised is the generic message, never the raw text", signupErrorKey(E({ message: "Database error saving new user" })), "err_generic");
ck("...and so is nothing at all", [signupErrorKey(null), signupErrorKey(undefined), signupErrorKey({})], ["err_generic", "err_generic", "err_generic"]);
ck("the mapper never returns the error's own text", /return\s+e\.message|return\s+m\b/.test(map), false);

/* ---------- the catch no longer shows raw provider text ---------- */
ck("the signup catch maps through signupErrorKey", /msg = t\(signupErrorKey\(e\)\);/.test(APP), true);
ck("...and the old `msg = e.message` is gone", /msg = e\.message;/.test(APP), false);
ck("our thrown sentences are codes, not matched by wording",
   !/startsWith\("Too many signup attempts"\)/.test(APP) && (APP.match(/code: "golsz_rate_limited"/g) || []).length === 2, true);
ck("verification refusals are a code and the server text goes to the console",
   (APP.match(/code: "golsz_verification_failed"/g) || []).length === 2 && (APP.match(/GOLSZ signup verification refused:/g) || []).length === 2, true);

/* ---------- the password floor: one number, eight ---------- */
ck("one constant, and it is 8", /const PASSWORD_MIN = 8;/.test(APP), true);
ck("the settings change-password check uses it", /if \(!pw \|\| pw\.length < PASSWORD_MIN\) \{ setPwErr/.test(APP), true);
ck("the reset-password check uses it", /if \(!pw \|\| pw\.length < PASSWORD_MIN\) \{ setErr/.test(APP), true);
ck("the signup gate uses it", /isSignupLike \? pw\.length >= PASSWORD_MIN : pw\.trim\(\)/.test(APP), true);
ck("the input's minLength uses it", /minLength=\{isSignupLike \? PASSWORD_MIN : undefined\}/.test(APP), true);
ck("no literal 6 is left as a password length",
   !/pw\.length < 6|pw\.length >= 6|minLength=\{isSignupLike \? 6/.test(APP), true);
const starts = ["  en: {", "  fr: {", "  es: {", "  el: {"].map((h) => APP.indexOf("\n" + h + "\n"));
const dicts = starts.map((s) => APP.slice(s, APP.indexOf("\n  },\n", s)));
const grab = (d, k) => (new RegExp(`\\b${k}: "((?:[^"\\\\]|\\\\.)*)"`).exec(d) || [])[1];
ck("the visible rule says 8 in every language", dicts.map((d) => /\b8\b/.test(grab(d, "reset_pw_min_len")) && !/\b6\b/.test(grab(d, "reset_pw_min_len"))), [true, true, true, true]);
ck("the weak-password message also says 8", dicts.map((d) => /\b8\b/.test(grab(d, "auth_err_weak_password"))), [true, true, true, true]);

/* ---------- confirm email, only when money is about to move ---------- */
ck("it is needed only for a signup on a paid plan", /const confirmEmailNeeded = isSignup && \(PLANS\.find\(\(p\) => p\.id === plan\) \|\| PLANS\[0\]\)\.price > 0;/.test(APP), true);
ck("the two addresses are compared case-insensitively and trimmed",
   /email2\.trim\(\)\.toLowerCase\(\) === email\.trim\(\)\.toLowerCase\(\)/.test(APP), true);
ck("the form cannot submit while they differ (it is part of `ok`)", /turnstileOk && emailsMatch &&/.test(APP), true);
ck("the field renders only when needed, with a mismatch alert",
   /\{confirmEmailNeeded && \(/.test(APP) && /\{email2\.trim\(\) && !emailsMatch && \(/.test(APP) && /role="alert"[^>]*>\{t\("auth_err_email_mismatch"\)\}/.test(APP), true);
ck("the state hook lives inside Auth, not another component", (() => {
  const a = APP.indexOf("function Auth(");
  const i = APP.indexOf('const [email2, setEmail2] = useState("");');
  const nextFn = APP.indexOf("\nfunction ", a + 20);
  return i > a && i < nextFn;
})(), true);
ck("it is an `email` input with a label, so keyboards and password managers behave",
   /aria-label=\{t\("auth_confirm_email"\)\}[^>]*type="email"/.test(APP), true);

/* ---------- strings ---------- */
const KEYS = ["auth_notice_pay_confirm", "auth_notice_check_email", "auth_cta_waiting_confirm", "auth_err_rate_limited",
  "auth_err_verification", "auth_err_weak_password", "auth_err_email_invalid", "auth_confirm_email", "auth_err_email_mismatch"];
for (const k of KEYS) {
  ck(`${k} exists in en, fr, es and el`, dicts.map((d) => !!grab(d, k)), [true, true, true, true]);
  ck(`${k}: fr, es and el are translated, not copies of the English`, [1, 2, 3].map((i) => grab(dicts[i], k) !== grab(dicts[0], k)), [true, true, true]);
}
ck("the check-your-email notice keeps its {email} placeholder in every language", dicts.map((d) => /\{email\}/.test(grab(d, "auth_notice_check_email"))), [true, true, true, true]);
ck("the athlete signup notices and the waiting label are no longer hard-coded English",
   /setNotice\(t\("auth_notice_pay_confirm"\)\)/.test(APP) && /setNotice\(t\("auth_notice_check_email"\)\.replace\("\{email\}", signupEmail\)\)/.test(APP) && /confirmPolling \? t\("auth_cta_waiting_confirm"\)/.test(APP), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
