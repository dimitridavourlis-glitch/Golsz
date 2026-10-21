// THE GUARDS IN FRONT OF THE FORM ARE NOT GUARDS ON THE DOOR.
//
// GOLSZ has two signup protections and both sit in front of the CLIENT's call
// to Supabase rather than in front of Supabase:
//
//   /api/signup-guard      — per-IP cap, called by Auth's submit()
//   /api/verify-turnstile  — bot check, called by Auth's submit()
//
// A script that POSTs straight to <project>.supabase.co/auth/v1/signup never
// touches either one. So neither is a gate on account creation; they only slow
// down a bot that chooses to use the form. On a platform that serves minors,
// and whose moderation queue, message-request system and profile search all
// assume accounts are scarce, that is the wrong shape of protection.
//
// GoTrue verifies options.captchaToken ITSELF, and that check is in front of
// every caller however it arrives. This suite asserts the code half is in
// place and ready. The other half is a Supabase dashboard setting — Auth >
// Attack Protection > CAPTCHA, Turnstile, the same secret already in
// TURNSTILE_SECRET_KEY — and no test here can see or assert it, which is said
// out loud rather than left to look covered.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// Both paths: the athlete's own signup and the parent-managed one. A token
// passed on one and not the other leaves half the door open once the
// dashboard setting is on, and the parent path is the one a minor arrives by.
const signUps = [...APP.matchAll(/sb\.auth\.signUp\(\{[\s\S]{0,120}?options: \{ ([^,]*),/g)].map((m) => m[1]);
ck("both signup paths were found", signUps.length, 2);
ck("...and each hands Supabase the captcha token",
   signUps.filter((s) => !/captchaToken: turnstileToken/.test(s)), []);

// `undefined`, not "": with Turnstile unconfigured the field must be absent
// rather than an empty string, which GoTrue would reject outright once CAPTCHA
// is enabled — turning a dormant setting into a total signup outage.
ck("...as undefined when Turnstile is not configured",
   (APP.match(/captchaToken: turnstileToken \|\| undefined/g) || []).length, 2);

// The two client-side guards stay. They are not useless — they stop the
// ordinary case — and removing them would leave nothing at all until the
// dashboard setting is switched on.
ck("the per-IP guard is still called before signUp",
   /fetch\("\/api\/signup-guard"/.test(APP), true);
ck("...and so is the Turnstile verification",
   /fetch\("\/api\/verify-turnstile"/.test(APP), true);
// PER PATH, not on first occurrences. Both of these strings appear twice —
// one pair per signup path — so comparing indexOf to indexOf only ever tested
// the athlete path and said nothing about the parent one, which is the path a
// minor's account arrives by. test_anchor_integrity flags exactly this shape,
// and did.
const GUARD_CALL = 'fetch("/api/signup-guard"';
const guardedBefore = [...APP.matchAll(/sb\.auth\.signUp\(/g)]
  .map((m) => APP.lastIndexOf(GUARD_CALL, m.index))
  .filter((i) => i >= 0);
ck("every signup path has the IP guard before it", guardedBefore.length, 2);
ck("...and they are two distinct calls, not one counted twice",
   new Set(guardedBefore).size, 2);

// WHAT THIS SUITE CANNOT SEE, stated so its green is not read as more than it
// is: whether CAPTCHA is actually enabled in the Supabase dashboard. Until it
// is, captchaToken is accepted and ignored by GoTrue, and direct POSTs to
// /auth/v1/signup remain unrated and unchallenged.
ck("this file says what it cannot check", /dashboard setting/.test(fs.readFileSync(__filename, "utf8")), true);

console.log(`\n${p}/${p + f} passed`); process.exit(f ? 1 : 0);
