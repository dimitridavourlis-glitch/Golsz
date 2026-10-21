// SIGNING IN MUST NOT MOUNT THE APP, THROW IT AWAY, AND MOUNT IT AGAIN.
//
// Root() holds back the app until a ban check has run, so a banned account
// never reaches GolszApp. The hold used to be a boolean, `banChecked`, and it
// recorded THAT a check finished rather than WHICH sign-in state it covered —
// which lags by exactly one render in the one case that matters:
//
//   signed out        effect runs with !authed  -> banChecked = true
//   sign in           setAuthed(true)
//   render            authed=true, banChecked still TRUE from the signed-out
//                     pass, so "authed && !banChecked" is FALSE
//                     -> GolszApp MOUNTS AND PAINTS
//   effect            -> banChecked = false  -> GolszApp UNMOUNTS, blank screen
//   check resolves    -> banChecked = true   -> GolszApp MOUNTS AGAIN
//
// The athlete sees a half-loaded app, a blank screen, then the app. And every
// fetch GolszApp issues on mount — profile, athlete, pathway, benchmarks,
// targets, actions, share tokens — runs twice, with the first set's results
// thrown away.
//
// Storing what the check covered makes the comparison answer for the CURRENT
// render instead of the previous one. These assertions execute that rule
// rather than describing it, because the defect was never a wrong rule — it
// was a right rule evaluated one render too late.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- the rule itself, lifted and run --------------------------------------
const m = APP.match(/const banChecked = (.+);/);
ck("the hold is derived, not stored", !!m, true);
const banChecked = new Function("banCheckedFor", "authed", "return " + (m ? m[1] : "false") + ";");

// THE EXACT MOMENT THE BUG HAPPENED. Signed out, the effect stamps the state
// it checked — false. Then authed flips true. If this returns true, the app
// mounts a render too early and the flash is back.
ck("the render where sign-in lands does NOT count as checked",
   banChecked(false, true), false);
// ...and once the check for THAT state completes, the app is released.
ck("...and it is released when the check covers the new state",
   banChecked(true, true), true);
// Signing out is the mirror: a stamp of `true` must not satisfy a signed-out
// render, or a banned-account sign-out could flash the app on the way past.
ck("a stale signed-in stamp does not satisfy a signed-out render",
   banChecked(true, false), false);
ck("...and a fresh signed-out stamp does", banChecked(false, false), true);
// First load, before anything has been checked at all.
ck("nothing checked yet is not checked", [banChecked(null, false), banChecked(null, true)], [false, false]);

// ---- the guard still uses it ----------------------------------------------
ck("the app is held behind that hold",
   /if \(authed && !banChecked\) return React\.createElement\("div"/.test(APP), true);

// ---- every exit stamps -----------------------------------------------------
// A path that returns without recording which state it checked leaves the
// holding screen up for ever — a blank page instead of a flash, which is
// worse. There are three ways out of the effect: no backend or signed out,
// no user, and the finally.
const at = APP.indexOf("    if (!sb || !authed) { setBanCheckedFor(authed); return; }");
ck("the effect was found", at > 0, true);
const effect = APP.slice(at, APP.indexOf("}, [authed]);", at));
ck("all three exits record what they checked",
   (effect.match(/setBanCheckedFor\(authed\)/g) || []).length, 3);
// The lagging reset is what made it a boolean problem. Nothing may set the
// stamp to a literal: it is always the state that was actually examined.
ck("nothing stamps a literal instead of the state examined",
   /setBanCheckedFor\((?:true|false|null)\)/.test(APP), false);
ck("the old lagging flag is gone", /setBanChecked\(/.test(APP), false);

console.log(`\n${p}/${p + f} passed`); process.exit(f ? 1 : 0);
