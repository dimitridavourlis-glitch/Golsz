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
console.log("\n-- today --");
ck("today is computed from the same key the late count uses",
   /const todaySteps = allMilestones\.filter\(\(m\) => m\.due === homeTodayKey\)/.test(APP), true);
ck("...and is rendered as its own tile", /k: "today", label: t\("home_week_today"\)/.test(APP), true);

// THE LIFETIME STEPS TILE WAS DELIBERATELY RETIRED on 2026-10-10, hours after
// an earlier assertion here insisted it stay. The reason changed: adding TODAY
// and THIS WEEK alongside it would have put six number tiles above the fold,
// and the brief's rule for this screen is that an athlete understands what
// matters within five seconds. Lifetime done/total is the least actionable of
// the three and already lives on Plan, which owns steps.
ck("the lifetime STEPS tile is gone",
   /k: "steps", label: t\("home_status_steps"\)/.test(APP), false);
// Nothing about overdue work may be lost in that trade.
ck("...and the late count moved onto TODAY rather than disappearing",
   /k: "today",[\s\S]{0,400}?home_door_plan_late/.test(APP), true);
// Its computation must go with it, or it is dead code that looks live.
ck("...and stepsDone is not left behind", /const stepsDone =/.test(APP), false);
// The string stays: unused i18n keys are kept in this repo, parity over tidiness.
ck("...while home_status_steps stays in all four dictionaries",
   (APP.match(/home_status_steps:/g) || []).length, 4);

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

console.log("\n-- nothing on Home is computed and thrown away --");
// THE DOORS BLOCK. "THE REST OF THE APP" was removed from Home in the
// 2026-09-18 reorganisation and its 46 lines of computation were not: four
// *Fact consts, a doors array and doorsAllEmpty were rebuilt on every single
// Home load and rendered nowhere. One branch could never fire at all —
// schoolsFact tested `status === "replied"`, and "replied" is not in
// TARGET_STATUSES, so the only proper noun from the outside world on that
// screen was unreachable twice over.
//
// This is the same class as the three things this suite exists to protect:
// a value computed and never shown. The difference is that those were worth
// showing and this was worth deleting.
for (const gone of ["const doors", "doorsAllEmpty", "planFact", "schoolsFact", "scoutFact", "passportFact", "stepsDone"]) {
  ck(`${gone} is gone from Home`, APP.includes(gone), false);
}
// The strings stay — unused i18n keys are kept in this repo, parity over
// tidiness — so their absence from the JSX is what has to be asserted.
ck("...while its strings remain in all four dictionaries",
   (APP.match(/home_door_schools_replied:/g) || []).length, 4);

// ---- THE WHY SLOT CARRIES A REASON, NOT A DATE ----------------------------
//
// The brief's command centre is NEXT ACTION followed by WHY. Every rung of
// Home's recommendation ladder puts a reason in that slot except the one that
// matters most — the athlete's own stated step — which put the date label
// there, so the most prominent card on Home read "Film 20 minutes of Saturday
// match / 5w overdue" with no reason at all. Verified signed in before fixing.
{
  const branchAt = APP.indexOf("? { labelText: pathwayNext.label,");
  ck("the stated-step rung exists", branchAt > 0, true);
  const branch = APP.slice(branchAt, APP.indexOf("go: \"targets\" }", branchAt));

  ck("its why is a translated reason", /whyText: goalText\.trim\(\)/.test(branch), true);
  ck("...resolved from i18n, both with and without a stated goal",
     /t\("home_next_why_step"\)/.test(branch) && /t\("home_next_why_step_nogoal"\)/.test(branch), true);
  // The defect, pinned: the date must not be what the why slot renders.
  ck("the date is NOT the why", /whyText: \[milestoneDateLabel/.test(branch), false);
  ck("...it is its own field", /metaText: \[milestoneDateLabel/.test(branch), true);

  ck("the why line renders", /\{nextMove\.whyText \|\| t\(nextMove\.why\)\}/.test(APP), true);
  ck("...and the date renders separately, only when there is one",
     /\{nextMove\.metaText && \(/.test(APP), true);
  // Gold is achievement in this palette; a date is not one.
  const metaAt = APP.indexOf("{nextMove.metaText && (");
  ck("...and not in gold", /C\.lime/.test(APP.slice(metaAt, metaAt + 400)), false);

  // Four languages, real strings, and the interpolation the goal variant needs.
  for (const key of ["home_next_why_step", "home_next_why_step_nogoal"]) {
    ck(`  ${key} is in all four dictionaries`,
       (APP.match(new RegExp("\\b" + key + ': "')) || []).length > 0 &&
       (APP.match(new RegExp("\\b" + key + ': "[^"]+"', "g")) || []).length, 4);
  }
  const goalVariants = APP.match(/\bhome_next_why_step: "([^"]+)"/g) || [];
  ck("every goal variant interpolates {goal}", goalVariants.every((v) => v.includes("{goal}")), true);
  ck("...and none of the four is the English string pasted twice",
     new Set(goalVariants).size, 4);
}

// ---- THE BOTTLENECK CARD DISCLOSES ITS OWN BASIS --------------------------
//
// The card is labelled BIGGEST BOTTLENECK and an athlete reads that as "the
// biggest thing stopping me reaching my goal". It is not that: it is the
// weakest contributor to Passport Strength, which measures profile
// completeness. Nothing in GOLSZ evaluates a requirement against a goal yet —
// BENCHMARK_BANDS is empty and there is no per-stage requirement data — so the
// card states its basis instead of letting the label overclaim.
{
  const cardAt = APP.indexOf('{t("home_bottleneck_eyebrow")}');
  ck("the bottleneck card exists", cardAt > 0, true);
  // SLICED BY ITS REAL BOUNDS, NOT A CHARACTER COUNT.
  // This was a fixed window and broke three times as the card grew — each
  // time silently, by the assertion simply stopping short of the thing it
  // claimed to check. The card is one HomeZone; end it where that ends.
  const cardEnd = APP.indexOf("</HomeZone>", cardAt);
  ck("the card's end was found", cardEnd > cardAt, true);
  const card = APP.slice(cardAt, cardEnd);
  // A window that no longer contains what the assertions below name is the
  // failure mode being guarded against, so it is checked rather than assumed.
  ck("...and the slice still contains every element asserted below",
     ["home_bottleneck_basis", "leverKey", "projectedWeak", "gap.missing"]
       .filter((x) => !card.includes(x)), []);
  ck("...and discloses what it is measured from", card.includes('t("home_bottleneck_basis")'), true);
  // The caveat is only TRUE when there is no requirement gap to show. Once
  // GOLSZ can name a missing requirement it is no longer unable to compare.
  ck("...only while there is no requirement gap to show instead",
     /\{!\(gap && gap\.missing\.length > 0\) && \(/.test(card), true);
  ck("...below the projection, not instead of it", card.indexOf('t("home_bottleneck_basis")') > card.indexOf("projectedWeak"), true);
  // The style sits BEFORE the key in the JSX, so this window looks backward.
  // Written forward first, it passed on a gold caveat — the mutation that
  // caught it is M2 in this file's history.
  const basisAt = card.indexOf('t("home_bottleneck_basis")');
  const styleBefore = card.slice(Math.max(0, basisAt - 320), basisAt);
  ck("...in slate, not gold — it is a caveat, not an achievement",
     /C\.lime/.test(styleBefore), false);
  ck("...and the window actually covers its style", /fontSize: 10\.5/.test(styleBefore), true);

  const strings = APP.match(/\bhome_bottleneck_basis: "([^"]+)"/g) || [];
  ck("four dictionaries carry it", strings.length, 4);
  ck("...as four distinct strings", new Set(strings).size, 4);
  // The disclosure is worthless if it does not actually name the limit.
  ck("...and each one says GOLSZ cannot compare against the goal yet",
     strings.every((v) => /cannot yet|ne peut pas encore|aún no puede|δεν μπορεί ακόμη/.test(v)), true);

  // The empty reference population is the REASON this disclosure exists. If
  // someone fills it, this assertion fires and the disclosure gets revisited
  // rather than quietly outliving the limitation it describes.
  const SCOUT = fs.readFileSync(path.join(REPO, "api", "scout.js"), "utf8");
  ck("the reference population is still empty, so the caveat is still true",
     /const BENCHMARK_BANDS = \[\];/.test(SCOUT), true);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
