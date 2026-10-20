// THE DAILY CHECK-IN — asked once a day, and it writes almost nothing.
//
// This is health information, so the assertions that matter most are about
// RESTRAINT: what the screen declines to store. "Okay" stores nothing at all
// (a daily mood log is new health data nobody consented to), and Great/Hurt
// write only when the status actually changes, so tapping Hurt on the third
// day of an injury adds no row and does not restart availability_since.
//
// shouldAskCheckin is RUN, not grepped, because it is the whole gate.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const PRIV = fs.readFileSync(path.join(REPO, "privacy.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};
// Returns "" rather than throwing, so a missing function fails by name instead
// of aborting the file and hiding every assertion after it.
const grab = (sig) => {
  const at = APP.indexOf(sig);
  if (at < 0) return "";
  return APP.slice(at, APP.indexOf("\n}", at) + 2);
};

/* ---------- the gate, executed ---------- */

const gateSrc = grab("function shouldAskCheckin({");
ck("shouldAskCheckin exists", gateSrc.length > 0, true);
// Falls back to a sentinel rather than throwing: if the function is renamed
// or deleted, every assertion below must fail BY NAME. A stub that throws
// aborts the file and hides the other forty.
let shouldAskCheckin = () => "GATE NOT LOADED";
if (gateSrc) {
  try { shouldAskCheckin = new Function(gateSrc + " return shouldAskCheckin;")(); }
  catch (e) { shouldAskCheckin = () => "GATE DID NOT EVAL: " + e.message; }
}

const OK = {
  hasSb: true, profileLoaded: true, occupation: "Player", actingFor: null,
  mustFinishProfile: false, onboarding: false, stored: "", userId: "u1", today: "2026-10-20",
};
const ask = (over) => shouldAskCheckin({ ...OK, ...over });

ck("an athlete who has not answered today is asked", ask({}), true);
ck("...and not a second time the same day", ask({ stored: "u1:2026-10-20" }), false);
ck("...but is asked again tomorrow", ask({ stored: "u1:2026-10-19" }), true);
// A shared device. The stamp carries the user id precisely so one athlete's
// answer is never counted as another's.
ck("a different athlete on the same device is still asked", ask({ stored: "u2:2026-10-20" }), true);

ck("a parent is never asked", ask({ occupation: "Parent" }), false);
// Written the wide way round - not-Player rather than is-Parent - so that
// re-adding an occupation later cannot silently start asking a coach how
// their training went. Migration 138 made these unreachable today.
ck("...nor a coach, if one ever exists again", ask({ occupation: "Coach" }), false);
ck("an athlete with no occupation recorded IS asked", ask({ occupation: null }), true);

ck("nobody is asked while acting for someone else", ask({ actingFor: { id: "x" } }), false);
ck("...or mid-signup", ask({ onboarding: true }), false);
ck("...or while the profile lock is armed", ask({ mustFinishProfile: true }), false);
ck("...or in preview mode with no session", ask({ hasSb: false }), false);

// The flash this prevents: occupation is undefined until the profiles read
// returns, and treating "we have not looked" as "not a parent" would show the
// check-in to a parent for the length of one fetch.
ck("nobody is asked before the profile has loaded", ask({ profileLoaded: false }), false);
ck("...and `undefined` occupation does not sneak through as 'not a parent'",
   ask({ profileLoaded: false, occupation: undefined }), false);
ck("no user id means no stamp is possible, so no question", ask({ userId: null }), false);

/* ---------- the stamp ---------- */

const stampSrc = grab("function checkinStamp(userId, today)");
ck("checkinStamp exists", stampSrc.length > 0, true);
ck("the stamp names the athlete, not just the day",
   /return `\$\{userId\}:\$\{today\}`/.test(stampSrc), true);

/* ---------- what each answer writes ---------- */

const at = APP.indexOf("function DailyCheckIn({");
ck("the screen exists", at > 0, true);
const CI = APP.slice(at, APP.indexOf("\nfunction ", at + 10));

ck("Great means available, Hurt means out, Okay means nothing",
   /const want = kind === "great" \? "available" : kind === "hurt" \? "out" : null;/.test(CI), true);
// THE RESTRAINT. Tapping Hurt on day three of an injury must not write a
// second row or restart availability_since.
ck("nothing is written when the status is already what you tapped",
   /if \(!want \|\| current === want\) \{/.test(CI), true);
ck("Okay writes nothing at all", /kind === "okay"/.test(CI) && !/saveAvailability\(sb, uid, \{ status: "limited"/.test(CI), true);
ck("it writes through the shared writer, not its own update",
   /await saveAvailability\(sb, uid,/.test(CI), true);
ck("...and never touches profiles directly", /from\("profiles"\)/.test(CI), false);
ck("Hurt stamps the day it started", /\{ status: "out", since: isoDay\(new Date\(\)\) \}/.test(CI), true);
ck("I'm better clears the dates with the status",
   /saveAvailability\(sb, uid, \{ status: "available", expected: null, note: null \}\)/.test(CI), true);

// A failed write must not be recorded as an answer, or an athlete is filed as
// something the database never stored and is never asked again that day.
ck("a failed write tells the athlete", /setErr\(t\("privacy_save_failed"\)\)/.test(CI), true);
ck("...and does not finish the check-in",
   CI.indexOf('setErr(t("privacy_save_failed"));\n      return;') > 0, true);

/* ---------- the answer reaches the SESSION, not only the database ---------- */

// THE BUG THIS PINS. finishCheckin used to read `if (chip === "great")` and
// infer the availability status from a DISPLAY value. Hurt sets no chip, so
// tapping Hurt wrote 'out' to the database and left the running app believing
// the athlete was fine: no rest banner, and every late counter on Home, Plan,
// the Road and the Stop screen kept running until the app was reloaded. The
// headline promise of this whole phase - nothing is late while you rest - was
// true in the database and false on the screen.
ck("the status is passed explicitly, not inferred from the chip",
   /function finishCheckin\(chip, stamp, status\) \{/.test(APP), true);
ck("...and the chip no longer decides it",
   /if \(chip === "great"\) setAvailabilityStatus/.test(APP), false);
ck("...it is applied whenever one was established",
   /if \(status !== undefined\) setAvailabilityStatus\(status\);/.test(APP), true);

// Every exit from the screen reports what is now on file. The rest screen is
// reachable only through Hurt, so leaving it means 'out'.
ck("leaving the rest screen reports that the athlete is out",
   (CI.match(/onFinish\(null, true, "out"\)/g) || []).length, 2);
ck("Great reports available", (CI.match(/onFinish\("great", true, "available"\)/g) || []).length, 2);
ck("Okay and Skip report the status that was already there",
   /onFinish\(kind === "okay" \? "okay" : kind === "great" \? "great" : null, true, want \|\| current\)/.test(CI), true);
ck("no exit forgets to report one",
   (CI.match(/onFinish\([^)]*\)/g) || []).filter((c) => !/, true, /.test(c) && !/onFinish\(null, true\)/.test(c)).length, 0);

// A return date is not a new injury. availabilityPatch defaults a missing
// `since` to TODAY, so passing one unconditionally restarted the clock on an
// athlete who had already been out for weeks.
ck("picking a return date does not restart availability_since",
   /since: currentSince \|\| isoDay\(new Date\(\)\)/.test(CI), true);
ck("...and the component is given the real one to preserve",
   /currentSince=\{availabilitySince\}/.test(APP), true);
ck("...which comes from the same profiles read, not a new one",
   /select\("occupation, availability_status, availability_since, full_name"\)/.test(APP), true);

/* ---------- Settings and the check-in speak one dialect ---------- */

// `avail` is { status, since, expected, note }; availabilityPatch returns
// database column names. Spreading one into the other left avail.status
// untouched, so the three buttons never moved when tapped.
ck("Settings maps the patch onto its own key names",
   /status: patch\.availability_status,/.test(APP), true);
ck("...rather than spreading database columns into short-key state",
   /setAvail\(\{ \.\.\.\(avail \|\| \{\}\), \.\.\.patch \}\)/.test(APP), false);

/* ---------- where it renders ---------- */

// GolszApp returns two different trees. An overlay added to only one of them
// is missing on half the devices, which is how the existing overlays are
// mounted and why this is counted rather than merely found.
ck("it is mounted in BOTH of GolszApp's render branches",
   (APP.match(/<DailyCheckIn /g) || []).length, 2);
ck("...behind its phase flag", /const askCheckin = REDESIGN_CHECKIN && shouldAskCheckin\(\{/.test(APP), true);
ck("the flag exists", /const REDESIGN_CHECKIN = (true|false);/.test(APP), true);

// It renders inside GolszApp, so it must NOT carry its own <style>{CSS}</style>
ck("it does not re-inject the stylesheet", /<style>\{CSS\}<\/style>/.test(CI), false);

/* ---------- it costs no extra fetch ---------- */

ck("occupation, availability and name come from one existing read",
   /select\("occupation, availability_status, availability_since, full_name"\)/.test(APP), true);

/* ---------- privacy ---------- */

ck("the screen tells the truth about who sees it",
   /checkin_private: "Coaches and schools never see this\."/.test(APP), true);
ck("the privacy policy names the check-in as a way availability is recorded",
   /daily check-in/.test(PRIV), true);

/* ---------- translations ---------- */

const KEYS = ["checkin_title_named", "checkin_title", "checkin_sub", "checkin_great", "checkin_great_sub",
  "checkin_okay", "checkin_okay_sub", "checkin_hurt", "checkin_hurt_sub", "checkin_private", "checkin_skip",
  "checkin_chip_great", "checkin_chip_okay"];
for (const k of KEYS) {
  ck(`${k} is translated in all 4 languages`, (APP.match(new RegExp(`\\b${k}: "`, "g")) || []).length, 4);
}
ck("the named heading interpolates a name",
   (APP.match(/checkin_title_named: "[^"]*\{name\}[^"]*"/g) || []).length, 4);

ck("it is in the compiled bundle",
   fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8").includes("shouldAskCheckin"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
