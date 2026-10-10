// Home answers the brief's questions, and every control on it does something.
//
// The Athlete Direction System brief asks Home to answer "what should I do
// next", "what is stopping me", "how far along am I" and "what about this
// week". Three of those were already computed in this file and rendered
// nowhere — this suite exists so they cannot quietly stop being rendered
// again, which is how they were lost the first time.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

console.log("-- what is stopping me --");
// weakest / leverKey / projectedWeak were computed on every Home load for
// weeks and thrown away. Computing a thing is not showing it.
ck("the weakest dimension is still computed", /const weakest = READINESS_DIMENSIONS\.reduce/.test(APP), true);
ck("...and is rendered", /t\("home_readiness_weakest_" \+ weakest\)/.test(APP), true);
ck("the lever is rendered", /\{t\(leverKey\)\}/.test(APP), true);
ck("the bottleneck is labelled as the brief names it",
   /t\("home_bottleneck_eyebrow"\)/.test(APP), true);
ck("...in all four languages", (APP.match(/home_bottleneck_eyebrow:/g) || []).length, 4);
// Plan-gated and skeleton-gated like the rest of readiness: never a lock.
ck("the card is gated on planKnown and the readiness entitlement",
   /planKnown\(plan\) && featureUnlocked\(plan, "readiness"\) && pathwayRow/.test(APP), true);
// projectedWeak re-runs the real scoring functions; show it only when it moves.
ck("the projected composite shows only when it is higher",
   /projectedWeak !== null &&/.test(APP), true);

console.log("\n-- how far along am I --");
// PathwayStrip was a finished component with ZERO render sites.
ck("PathwayStrip is defined", /^function PathwayStrip\(/m.test(APP), true);
ck("...and is actually mounted", /<PathwayStrip /.test(APP), true);
// Without a pathway it would draw the sport's generic ladder and imply the
// athlete chose it.
ck("...only when the athlete has a pathway",
   /\{pathwayRow && \(\s*\n\s*<HomeZone span=\{2\}>\s*\n\s*<PathwayStrip /.test(APP), true);

console.log("\n-- this week --");
ck("the week is computed from a Monday-first start", /weekStartFrom\(new Date\(\)\)/.test(APP), true);
// Dated steps only: an undated step is not scheduled for any week, and
// counting it would invent a commitment the athlete never made.
ck("...over dated steps only",
   /allMilestones\.filter\(\(m\) => m\.due && m\.due >= weekFromKey && m\.due <= weekToKey\)/.test(APP), true);
{
  // An em dash, not 0/0 — a zero reads as failure rather than as an empty
  // calendar, which is the rule the rest of the status row already follows.
  const tile = /k: "week",[\s\S]{0,400}?go: "targets",/.exec(APP);
  ck("the week tile exists", !!tile, true);
  ck("...and shows a dash rather than 0/0 when nothing is dated",
     !!tile && /weekSteps\.length \? /.test(tile[0]) && /u2014/.test(tile[0]), true);
}
// STEPS is lifetime and stays — a different question from "this week".
ck("the lifetime STEPS tile is still there",
   /value: allMilestones\.length \? `\$\{stepsDone\}\/\$\{allMilestones\.length\}`/.test(APP), true);

console.log("\n-- no control on Home is a no-op --");
// Reschedule passed `pathwayNext.due || null`, and Plan opens a day only for
// a YYYY-MM-DD, so on an UNDATED step the button did nothing — and an undated
// step is exactly the one most likely to need a date.
// Scoped to the RESCHEDULE button. "Drop it" uses the same navigate shape
// with a null fallback and is NOT a bug: it renders only when stepOverdue,
// which is false unless the step has a due date, so the null branch is
// unreachable there. Asserting over the whole file would have forced a
// pointless edit to prove a property that already holds.
{
  const resched = /home_step_reschedule[\s\S]{0,40}/.exec(APP);
  ck("the Reschedule button exists", !!resched, true);
  const btn = /<button onClick=\{\(\) => onNavigate\("targets"[^}]*\}[\s\S]{0,200}?home_step_reschedule/.exec(APP);
  ck("...and does not navigate with a null day", !!btn && /\|\| null\)/.test(btn[0]), false);
}
ck("...it falls back to a real day", 
   /onNavigate\("targets", null, null, pathwayNext\.due \|\| isoDay\(new Date\(\)\)\)/.test(APP), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
