// THE INSTALLED-APP VERDICT (AVA job 235, t4-r3-2).
//
// tools/record-installed-fullscreen.cjs opens Home in headless Chrome as an
// iPhone Home Screen app and as a browser tab, and prints installedVerdict()
// for each. That verdict must be able to come out both ways, and an emulation
// Chrome did not apply must read as "unsupported", never as a pass. This suite
// runs the pure helpers on the numbers the recorded run read (good) and on
// broken variants of them.
const fs = require("fs");
const path = require("path");
const V = require("../tools/_installed-fullscreen.cjs");

let p = 0, f = 0;
const ck = (label, actual, expected) => {
  const A = JSON.stringify(actual), E = JSON.stringify(expected);
  if (A === E) { p++; console.log("PASS  " + label); }
  else { f++; console.log(`FAIL  ${label}\n   exp ${E}\n   got ${A}`); }
};

// What the recorded run read in standalone mode (390x844, insets 47/34).
const standalone = () => ({ mode: "standalone", insetTop: 47, insetBottom: 34, safeArea: "applied",
  isStandalone: true, innerWidth: 390, innerHeight: 844, docScrollWidth: 390, rootHeight: 844, shellHeight: 844,
  headerPadTop: 59, navPadBottom: 46, envTop: 47, envBottom: 34,
  content: [{ what: "a", top: 59 }, { what: "text \"GOLSZ\"", top: 63 }, { what: "button Notifications", top: 60 }] });
const tab = () => ({ mode: "tab", insetTop: 47, insetBottom: 34, safeArea: "not set (browser tab)",
  isStandalone: false, innerWidth: 390, innerHeight: 844, docScrollWidth: 390, rootHeight: 844, shellHeight: 844,
  headerPadTop: 12, navPadBottom: 12, envTop: 0, envBottom: 0, content: [{ what: "a", top: 12 }] });
const withOver = (base, over) => Object.assign(base, over);
const verdict = (s) => { const v = V.installedVerdict(s); return { pass: v.pass, reasons: v.reasons, unsupported: v.unsupported }; };

// Good screens pass, both ways.
ck("standalone Home as recorded passes", verdict(standalone()), { pass: true, reasons: [], unsupported: [] });
ck("the browser tab as recorded passes", verdict(tab()), { pass: true, reasons: [], unsupported: [] });
ck("standalone summary strings", (({ doc, root, shell }) => ({ doc, root, shell }))(V.installedVerdict(standalone())), { doc: "390/390", root: "844/844", shell: "844/844" });

// Standalone detection must agree with the mode.
ck("installed but isStandaloneDisplay() false fails", verdict(withOver(standalone(), { isStandalone: false })).reasons,
  ["isStandaloneDisplay() is false when installed (expected true)"]);
ck("a tab that claims to be installed fails", verdict(withOver(tab(), { isStandalone: true })).reasons,
  ["isStandaloneDisplay() is true in a browser tab (expected false)"]);
ck("a missing isStandaloneDisplay fails", verdict(withOver(standalone(), { isStandalone: "missing" })).pass, false);

// The app must fill the screen exactly: not shorter (a gap) and not taller (100vh under a toolbar).
ck("#root taller than the screen fails", verdict(withOver(standalone(), { rootHeight: 900 })).reasons, ["#root is 900px tall, the screen 844px"]);
ck(".app-shell shorter than the screen fails", verdict(withOver(standalone(), { shellHeight: 760 })).reasons, [".app-shell is 760px tall, the screen 844px"]);
ck("a missing .app-shell (null height) fails", verdict(withOver(standalone(), { shellHeight: null })).pass, false);
ck("sub-pixel height difference passes", verdict(withOver(standalone(), { rootHeight: 843.5 })).pass, true);
ck("sideways scroll fails in standalone", verdict(withOver(standalone(), { docScrollWidth: 2000 })).reasons, ["document scrolls sideways (2000/390)"]);
ck("sideways scroll fails in a tab too", verdict(withOver(tab(), { docScrollWidth: 412 })).pass, false);

// Safe-area padding must cover the insets CSS resolved.
ck("header not padded for the status bar fails", verdict(withOver(standalone(), { headerPadTop: 12 })).reasons,
  ["header top padding 12px is less than the 47px top inset"]);
ck("nav not padded for the home indicator fails", verdict(withOver(standalone(), { navPadBottom: 12 })).reasons,
  ["nav bottom padding 12px is less than the 34px bottom inset"]);
ck("a missing nav (null padding) fails", verdict(withOver(standalone(), { navPadBottom: null })).pass, false);

// Nothing a person reads or taps may start under the status bar.
const under = withOver(standalone(), { content: standalone().content.concat([{ what: "text \"Today\"", top: 20 }, { what: "button Back", top: 46.5 }]) });
ck("text under the top inset fails", verdict(under).reasons, ["1 visible item(s) start under the 47px top inset"]);
ck("underTopInset names the item, not the one within 1px", V.installedVerdict(under).underTopInset, [{ what: "text \"Today\"", top: 20 }]);
ck("underTopInset is empty with no inset", V.underTopInset([{ what: "a", top: 0 }], 0), []);
ck("underTopInset boundary: top == inset is fine", V.underTopInset([{ what: "a", top: 47 }, { what: "b", top: 45.9 }], 47), [{ what: "b", top: 45.9 }]);

// An emulation Chrome lacks is reported, never passed silently.
const refused = verdict(withOver(standalone(), { safeArea: "unsupported", envTop: 0, envBottom: 0, headerPadTop: 12, navPadBottom: 12 }));
ck("refused safe-area override: listed as unsupported", refused.unsupported.length === 1 && refused.unsupported[0].indexOf("safe-area emulation unsupported") === 0, true);
ck("refused safe-area override: padding is not claimed as checked", refused.reasons, []);
const ignored = V.installedVerdict(withOver(standalone(), { envTop: 0, envBottom: 0, headerPadTop: 12, navPadBottom: 12 }));
ck("accepted but not applied (env reads 0) is unsupported too", ignored.unsupported[0], "safe-area emulation unsupported (env top/bottom read 0/0, asked 47/34)");
ck("safeAreaApplied needs both insets resolved", [V.safeAreaApplied(standalone()), V.safeAreaApplied(withOver(standalone(), { envBottom: 0 }))], [true, false]);
ck("a tab never asks for safe-area emulation", verdict(tab()).unsupported, []);

// The page side: the injected expression compiles, and the global it calls is a
// top-level function in the bundle the page runs (a wrapper or a rename would
// make window.isStandaloneDisplay undefined and every run read "missing").
let compiles = true;
try { new Function("return " + V.snapshotExpression()); } catch (e) { compiles = false; }
ck("the injected snapshot expression compiles", compiles, true);
ck("snapshot calls window.isStandaloneDisplay", /window\.isStandaloneDisplay\(\)/.test(V.snapshotExpression()), true);
const bundle = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
ck("js/app.js declares isStandaloneDisplay at top level", /(^|[;}\n])function isStandaloneDisplay\(\)/.test(bundle), true);
ck("js/app.js is not wrapped in an IIFE", /^\s*(\/\/[^\n]*\n\s*)*\(function/.test(bundle), false);

// The notification bell (t4): installed it goes on to permission, /sw.js and
// subscribe; in a tab the same iPhone gets the install-first message, no call.
const SRC = fs.readFileSync(path.join(__dirname, "..", "golsz-app.jsx"), "utf8");
const INSTALL = V.enString(SRC, "notif_ios_homescreen");
ck("enString reads the English install-first message", INSTALL.indexOf("On iPhone/iPad, notifications only work after you add GOLSZ to your Home Screen") === 0 && INSTALL.indexOf("\"Add to Home Screen\"") > 0, true);
ck("enString reads the bell's English labels", [V.enString(SRC, "notif_title_off"), V.enString(SRC, "notif_title_on")],
  ["Turn on notifications for messages & new followers", "Notifications on — tap to turn off"]);
let missingKey = "";
try { V.enString(SRC, "notif_no_such_key"); } catch (e) { missingKey = e.message; }
ck("enString refuses a key that is not there", missingKey, "no English notif_no_such_key in golsz-app.jsx");
const installedTap = () => ({ found: true, alert: "", label: "on",
  calls: ["requestPermission", "register /sw.js", "subscribe userVisibleOnly=true keyBytes=65"] });
const tabTap = () => ({ found: true, alert: INSTALL, label: "off", calls: [] });
ck("installed tap as recorded passes", V.notifyVerdict("standalone", installedTap(), INSTALL), { pass: true, reasons: [] });
ck("tab tap as recorded passes", V.notifyVerdict("tab", tabTap(), INSTALL), { pass: true, reasons: [] });
ck("installed but the guard stopped it (install message, no calls) fails",
  V.notifyVerdict("standalone", { found: true, alert: INSTALL, label: "off", calls: [] }, INSTALL).reasons.length, 3);
ck("installed without subscribe fails", V.notifyVerdict("standalone", withOver(installedTap(), { calls: ["requestPermission", "register /sw.js"] }), INSTALL).reasons,
  ["the bell called [requestPermission, register /sw.js], expected requestPermission, register /sw.js, subscribe"]);
ck("installed, out of order fails", V.notifyVerdict("standalone", withOver(installedTap(), { calls: ["register /sw.js", "requestPermission", "subscribe x"] }), INSTALL).pass, false);
ck("installed but the bell stayed off fails", V.notifyVerdict("standalone", withOver(installedTap(), { label: "off" }), INSTALL).reasons, ["the bell did not turn on (off)"]);
ck("a tab showing the generic error fails", V.notifyVerdict("tab", withOver(tabTap(), { alert: "Something went wrong turning on notifications. Try again." }), INSTALL).pass, false);
ck("a tab that asked for permission fails", V.notifyVerdict("tab", withOver(tabTap(), { calls: ["requestPermission"] }), INSTALL).reasons,
  ["the bell called requestPermission in a browser tab (expected none)"]);
ck("no bell on the page fails", V.notifyVerdict("tab", { found: false, calls: [] }, INSTALL).reasons, ["the notification bell was not found"]);
ck("no tap result at all fails", V.notifyVerdict("standalone", null, INSTALL).pass, false);
let bellCompiles = true;
try { new Function("return " + V.bellExpression({ labelOff: "a", labelOn: "b", timeoutMs: 1 })); } catch (e) { bellCompiles = false; }
ck("the injected bell expression compiles", bellCompiles, true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
