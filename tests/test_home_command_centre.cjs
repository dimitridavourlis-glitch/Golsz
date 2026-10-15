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

// ---- A TILE WITH NOTHING TO SAY IS NOT SHOWN ------------------------------
//
// The status row rendered five tiles whose value was an em-dash when there was
// no data — a tile asking to be ignored. A first-time athlete opened GOLSZ and
// saw five placeholders for data they could not possibly have yet, which is
// the "scoreboard architecture" this screen's own comments say was removed
// once already.
{
  const at = APP.indexOf("const statusTiles = [");
  ck("the tiles are built once, above the JSX", at > 0, true);
  const arr = APP.slice(at, APP.indexOf(".filter(Boolean).filter((tile) => !tile.empty);", at));

  // Every tile must declare it, or it can never be filtered out.
  const keys = [...arr.matchAll(/k: "(\w+)"/g)].map((x) => x[1]);
  const empties = (arr.match(/\bempty:/g) || []).length;
  ck("every tile declares whether it is empty", [keys.length, empties], [5, 5]);

  ck("empty tiles are filtered out",
     /\.filter\(Boolean\)\.filter\(\(tile\) => !tile\.empty\);/.test(APP), true);
  // The whole row goes when nothing survives, rather than leaving an empty box.
  ck("the row itself disappears when none survive",
     /\{planKnown\(plan\) && statusTiles\.length > 0 && \(/.test(APP), true);
  // One surviving tile in a two-column grid is a tile and a hole.
  ck("a single tile does not sit in a two-column grid",
     /repeat\(\$\{statusTiles\.length === 1 \? 1 : 2\}/.test(APP), true);
  // The guard, the column count and the map must read the SAME list — the
  // first version had the guard referencing a variable that did not exist.
  ck("guard, grid and map all read the hoisted list",
     (APP.match(/statusTiles/g) || []).length, 4);

  // A score of zero is not a status.
  ck("a zero Passport Strength is treated as empty", /empty: !composite,/.test(arr), true);
  // But an overdue count is worth showing even with nothing due today.
  ck("TODAY still shows when something is late", /empty: !todaySteps\.length && !stepsLate,/.test(arr), true);
}

// ---- HOME SHOWS ONE THING -------------------------------------------------
//
// Seven stacked cards is not "understand what matters within five seconds".
// Everything reflective now sits behind one tap, CLOSED by default. Nothing is
// deleted and nothing moves to another page — the tap is the athlete asking
// for it rather than the screen insisting.
{
  ck("the disclosure exists", /const \[showMore, setShowMore\] = useState\(false\);/.test(APP), true);
  // Asserted on the declaration itself. The first version matched
  // "useState(false)" anywhere in the file, which is true of several unrelated
  // hooks and would have passed with this one defaulting open.
  ck("...and starts closed",
     /const \[showMore, setShowMore\] = useState\(false\);/.test(APP), true);
  ck("the toggle says what is behind it, in words",
     /\{showMore \? t\("home_less"\) : t\("home_more"\)\}/.test(APP), true);
  // A screen reader must hear the state, not infer it from a caret.
  ck("...and announces its state", /aria-expanded=\{showMore\}/.test(APP), true);

  // What stays on the surface: identity, the next step, the goal, the toggle,
  // Ask Scout. Everything else is behind it.
  const open = APP.indexOf("{showMore && (");
  const nextStep = APP.indexOf('{t("next_move_title")}');
  const goal = APP.indexOf('{t("home_your_goal")}');
  ck("the next step stays above the fold", nextStep < open && nextStep > 0, true);
  ck("...and so does the goal", goal < open && goal > 0, true);
  // Ask Scout must NOT be buried: it is the one thing a confused athlete reaches for.
  const scout = APP.indexOf('onNavigate("scout")', open);
  const firstClose = APP.indexOf("\n        </>\n      )}", open);
  ck("Ask Scout is not inside the disclosure", scout > firstClose, true);

  // What IS behind it.
  // home_dim_focus, not home_focus_title — the latter exists in all four
  // dictionaries and is rendered nowhere, so asserting on it checked nothing.
  for (const [what, key] of [["focus areas", "home_dim_focus"], ["the bottleneck", "home_bottleneck_eyebrow"],
                             ["last week", "review_title"], ["the score breakdown", "home_readiness_why_title"]]) {
    const at = APP.indexOf('t("' + key + '")');
    ck(`  ${what} is actually rendered`, at > 0, true);
    ck(`  ...and is behind the tap`, at > open, true);
  }
  // The status tiles too — they were the worst of it for a new athlete.
  ck("  the status tiles are behind the tap", APP.indexOf("statusTiles.length > 0") > open, true);

  // Both wrapped ranges hold MORE than one sibling, so each needs a fragment.
  // Without one the JSX does not parse, which is how the first attempt failed.
  ck("every disclosure block wraps its siblings in a fragment",
     (APP.match(/\{showMore && \(\s*\n\s*<>/g) || []).length,
     (APP.match(/\{showMore && \(/g) || []).length);

  for (const k of ["home_more", "home_less"]) {
    const hits = APP.match(new RegExp("\\b" + k + ': "[^"]+"', "g")) || [];
    ck(`  ${k} in four dictionaries, four distinct strings`, [hits.length, new Set(hits).size], [4, 4]);
  }
}

// ---- THE ACTION OUTRANKS THE DESTINATION ----------------------------------
//
// The next step rendered at 18px while the goal below it rendered at 36 — so
// on a screen whose entire job is "what do I do now", the eye landed on the
// destination. Size IS the hierarchy here; these numbers are the design.
{
  const stepAt = APP.indexOf('{nextMove.labelText || t(nextMove.label)}');
  const stepStyle = APP.slice(Math.max(0, stepAt - 420), stepAt);
  const stepPx = Number((/fontSize: (\d+(?:\.\d+)?)/.exec(stepStyle) || [])[1]);

  const goalAt = APP.indexOf('{goalText || t("home_goal_none")}');
  const goalStyle = APP.slice(Math.max(0, goalAt - 420), goalAt);
  const goalPx = Number((/fontSize: (\d+(?:\.\d+)?)/.exec(goalStyle) || [])[1]);

  ck("both sizes were found", [Number.isFinite(stepPx), Number.isFinite(goalPx)], [true, true]);
  ck("THE NEXT STEP IS LARGER THAN THE GOAL", stepPx > goalPx, true);
  ck("...and is the largest type on the closed screen", stepPx >= 24, true);
  ck("the goal is still prominent, just not dominant", goalPx >= 18 && goalPx < stepPx, true);
}

// ---- ONE PRIMARY ACTION, THE REST ARE WAYS OUT ----------------------------
{
  const at = APP.indexOf("markStepDone(pathwayNext)");
  const done = APP.slice(at, at + 320);
  ck("Done is full width", /width: "100%"/.test(done), true);
  ck("...and is the only primaryBtn in the group",
     (APP.slice(at, APP.indexOf('t("home_step_drop")', at)).match(/\.\.\.primaryBtn/g) || []).length, 1);
  // Reschedule, Ask and Drop are text, not boxes — a bordered button says
  // "this is a choice of equal weight", and they are not.
  const group = APP.slice(at, APP.indexOf('t("home_step_drop")', at) + 60);
  ck("the secondary actions carry no border",
     (group.match(/border: "none"/g) || []).length >= 3, true);
  ck("...and none of them is a quietBtn box any more", /\.\.\.quietBtn/.test(group), false);
  // Destructive stays visually distinct even as text.
  ck("Drop is still marked as the harmful one",
     /color: C\.warnText[\s\S]{0,200}?t\("home_step_drop"\)/.test(APP), true);
}

// ---- THE DISCLOSURE IS A LINK, NOT A DISABLED-LOOKING BOX -----------------
{
  const at = APP.indexOf('{showMore ? t("home_less") : t("home_more")}');
  const style = APP.slice(Math.max(0, at - 520), at);
  ck("it no longer renders as a full-width bordered box",
     /width: "100%"[\s\S]{0,200}?border: `1px solid/.test(style), false);
  ck("...it reads as a link", /textDecoration: "underline"/.test(style), true);
  ck("...and is still a 44px touch target", /minHeight: 44/.test(style), true);
}

// ---- NO SECOND NAVIGATION -------------------------------------------------
// A Passport/Plan row sat directly above a nav bar whose first two items are
// Passport and Plan. Two routes to the same place, an inch apart.
{
  const homeStart = APP.indexOf("function HomeTab(");
  const homeEnd = APP.indexOf("\nfunction ", homeStart + 20);
  const home = APP.slice(homeStart, homeEnd);
  ck("Home does not render its own Passport link", /\{t\("nav_passport"\)\}<\/button>/.test(home), false);
  ck("...nor its own Plan link", /\{t\("nav_plan"\)\}<\/button>/.test(home), false);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
