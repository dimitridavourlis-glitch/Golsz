// PLAN WAS A SPREADSHEET, NOT A PLAN.
//
// Measured on a live account, Plan rendered 53 visible controls. Five were the
// athlete's own steps. The rest was machinery: a status dropdown, an edit icon
// and a delete icon on every training row and every school, two always-open
// add-forms, and a three-scale calendar - all mounted at once.
//
// Two sections now close. The whole argument for letting them close is that a
// closed row still reports what is inside it, so the assertions that matter
// here are the ones about `summary`: an accordion that shows only a title is
// the thing the Schools & clubs card spent a comment refusing, and it was
// right to. rosterSummary is EXECUTED below rather than grepped, because a row
// that states the wrong count is worse than a row that states nothing.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// Returns "" rather than throwing when a signature is gone. A missing
// function should make the assertions about it FAIL by name, not abort the
// file - otherwise the first thing to regress hides every finding after it.
const grab = (sig) => {
  const at = APP.indexOf(sig);
  if (at < 0) return "";
  return APP.slice(at, APP.indexOf("\n}", at) + 2);
};

/* ---------- the mechanism ---------- */

const col = grab("function Collapsible(");
ck("Collapsible exists", col.length > 0, true);
ck("it starts closed", /useState\(false\)/.test(col), true);
// `{open && children}` and not `style={{display: open ? ... }}`: a section that
// is merely hidden has still mounted, still fetched, and still costs the
// athlete the wait. This is the line that makes a closed section free.
ck("closed means not rendered, not merely hidden", /\{open && children\}/.test(col), true);
ck("it exposes its open state to assistive tech", /aria-expanded=\{open\}/.test(col), true);
ck("it renders a summary line when given one", /\{summary \?/.test(col), true);

/* ---------- the two sections that close ---------- */

ck("the training plan is wrapped, and says what is inside it",
   /<Collapsible label=\{t\("dev_plan_title"\)\} summary=\{t\("dev_plan_collapsed_hint"\)\}><DevelopmentPlan /.test(APP), true);
ck("schools & clubs is wrapped, and reports its roster",
   /<Collapsible label=\{t\("targets_title"\)\} summary=\{rosterSummary\(t, items\)\}/.test(APP), true);
// A closed section is only acceptable because it states its contents - and
// only reachable because a deep link can force it open. Home's Schools tile
// points straight at it, and a link that lands on a collapsed row is a link
// that did nothing as far as the athlete can tell.
ck("...and a deep link can open it",
   /anchorId="gz-schools" revealSignal=\{focusSection === "gz-schools" \? focusNonce : 0\}/.test(APP), true);
ck("the wrapped card no longer repeats its own title",
   (APP.match(/<Eyebrow>\{t\("targets_title"\)\}<\/Eyebrow>/g) || []).length, 0);
ck("the goal-gap table is wrapped, and its summary is the finding itself",
   /<Collapsible label=\{t\("gap_title"\)\} summary=\{t\("gap_counts"\)/.test(APP), true);
// "1 of 4 things your goal asks for are on file" is the whole message; the
// four rows are only the detail behind it. Printing that sentence in the
// closed row AND again inside the opened card is how a wrapper turns one
// finding into two.
ck("the gap count is stated once, not in the header and the body both",
   (APP.match(/t\("gap_counts"\)/g) || []).length, 2);  // Plan's header + Home's own copy
ck("the wrapped gap card no longer repeats its own title",
   (APP.match(/<Eyebrow>\{t\("gap_title"\)\}<\/Eyebrow>/g) || []).length, 1);  // the unsupported-sport card keeps its own

ck("exactly three sections close on Plan", (APP.match(/<Collapsible /g) || []).length, 3);

// The condition on which this component is allowed to exist at all. A
// <Collapsible> with no summary is precisely the title-only accordion the
// Schools & clubs comment refused, and it would pass every other check in this
// file. This is the assertion that binds a future section, not just these three.
ck("every section that closes states what is inside it",
   APP.match(/<Collapsible (?![^>]*summary=)[^>]*>/g) || [], []);

// The comment on that card used to assert it was "no longer an accordion".
// Leaving that in place would have made the source argue against the code.
ck("the comment that refused an accordion was retracted",
   /It is no longer an accordion/.test(APP), false);
ck("and the retraction keeps the reason, not just the verdict",
   /a closed row still states how many are on/.test(APP), true);

/* ---------- rosterSummary, executed ---------- */

const sandbox = { CONTACTED_STATUSES: ["contacted", "responded", "follow_up", "opportunity"] };
vm.createContext(sandbox);
const rsSrc = grab("function rosterSummary(");
ck("rosterSummary exists", rsSrc.length > 0, true);
if (rsSrc) vm.runInContext(rsSrc, sandbox);
const T = { home_door_schools_empty: "No schools or clubs yet",
            home_door_schools_counts: "{n} on the list, {c} contacted" };
const t = (k) => T[k];
// Every behavioural assertion below reports the throw as its own failure
// instead of taking the file down with it.
const rs = (items) => {
  try { return sandbox.rosterSummary(t, items); }
  catch (e) { return "THREW: " + e.message; }
};

ck("no list reads as no list", rs([]), "No schools or clubs yet");
ck("a missing list does not crash the header", rs(null), "No schools or clubs yet");
ck("it counts the roster and the contacted separately",
   rs([{ status: "to_contact" }, { status: "contacted" }, { status: "responded" }]),
   "3 on the list, 2 contacted");
ck("researching is not contacted",
   rs([{ status: "researching" }, { status: "preparing" }]), "2 on the list, 0 contacted");
ck("an opportunity counts as contacted",
   rs([{ status: "opportunity" }]), "1 on the list, 1 contacted");
ck("a row with no status is still on the list",
   rs([{}, { status: null }]), "2 on the list, 0 contacted");
ck("a null row does not throw", rs([null, { status: "contacted" }]), "2 on the list, 1 contacted");

/* ---------- the strings are shared, not forked ---------- */

// Reusing the Home door's own two strings is what stops Plan and Home
// disagreeing about the same list, and is why this change added no new keys.
for (const k of ["home_door_schools_empty", "home_door_schools_counts", "dev_plan_collapsed_hint"]) {
  ck(`${k} is translated in all 4 languages`,
     (APP.match(new RegExp(`\\b${k}: "`, "g")) || []).length, 4);
}

ck("it is in the compiled bundle",
   fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8").includes("rosterSummary"), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
