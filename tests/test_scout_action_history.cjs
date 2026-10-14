// AN ADVISOR WHO NEVER REMEMBERS WHAT YOU DID IS A STRANGER EVERY TIME.
//
// Scout knew what was OPEN on an athlete's plan and nothing about what
// happened to it. It could not say "you have done four of these already", and
// it could not notice a step that quietly went past. The brief asks for recent
// actions, completed actions and missed actions as structured context; none of
// the three existed.
//
// THE RULE THIS SUITE PROTECTS: a date Scout itself proposed, which the
// athlete never acted on, is NOT a deadline they missed — nobody agreed to it.
// The reminder cron refuses to push such a date, and Scout must refuse to
// raise it in conversation for exactly the same reason. One tap on a confirm
// card is consent to a plan, not to twelve individual deadlines.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const SCOUT = fs.readFileSync(path.join(REPO, "api", "scout.js"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- it reads the table that has real completion times --------------------
ck("Scout reads athlete_actions",
   /rest\/v1\/athlete_actions\?user_id=eq\./.test(SCOUT), true);
ck("...selecting what it needs to tell done from missed",
   /select=title,status,due_on,due_src,completed_at/.test(SCOUT), true);
// due_src is the field the rule below depends on; selecting without it would
// make the rule unenforceable at the point of use.
ck("...including due_src, without which the rule cannot be applied",
   /select=[a-z_,]*due_src/.test(SCOUT), true);
ck("a failed load does not take the turn down", /GOLSZ action history load failed/.test(SCOUT), true);

// ---- THE RULE --------------------------------------------------------------
{
  const at = SCOUT.indexOf("const missedActions = actionRows");
  ck("missed is derived", at > 0, true);
  const d = SCOUT.slice(at, SCOUT.indexOf(";", at));
  ck("ONLY dates the athlete chose can be called missed", /!a\.due_src/.test(d), true);
  ck("...and only if the day has actually passed", /a\.due_on < todayKey/.test(d), true);
  ck("...and only while still open", /a\.status === "open"/.test(d), true);
}
{
  const at = SCOUT.indexOf("const recentlyDone = actionRows");
  const d = SCOUT.slice(at, SCOUT.indexOf("droppedCount =", at));
  ck("completed requires a real completion time", /a\.status === "completed" && a\.completed_at/.test(d), true);
  ck("...and is ordered newest first", /localeCompare/.test(d), true);
}

// ---- the prompt ------------------------------------------------------------
{
  const at = SCOUT.indexOf("WHAT THEY HAVE ACTUALLY COMPLETED");
  ck("the prompt states completions", at > 0, true);
  const block = SCOUT.slice(at - 1200, at + 2200);
  ck("...with the date each was done", /on \$\{a\.on\}/.test(block), true);
  // Silence must not read as success.
  ck("no completions is said plainly, not glossed over",
     /THEY HAVE NOT COMPLETED ANY STEP YET/.test(block), true);
  ck("...and Scout is told not to congratulate work that is not there",
     /do not congratulate them for work that is not there/.test(block), true);
  // The missed line must say whose dates these are.
  ck("missed steps are named as the athlete's OWN dates",
     /these are dates THEY chose, so it is fair to raise them/.test(block), true);
  ck("...and Scout asks what got in the way before adding more",
     /Ask what got in the way before suggesting anything new/.test(block), true);
  // Dropping is a decision, not a failure.
  ck("dropping is not treated as failure",
     /Dropping is a legitimate decision, not a failure/.test(block), true);
  // The list is the whole truth in both directions.
  ck("Scout may not invent a completion", /Never credit them with work that is not in this list/.test(block), true);
  ck("...nor invent a miss", /never accuse them of missing something that is not in it either/.test(block), true);
  // Nothing is shown at all when the table has not loaded: an empty list would
  // read as "you have done nothing".
  ck("the whole block is gated on actually having the data",
     /if \(athleteState\.actionsKnown\) \{/.test(SCOUT), true);
}

// ---- exposed as a result, like readiness and the gap ----------------------
ck("recentlyDone is on athleteState", /recentlyDone: recentlyDone\.map/.test(SCOUT), true);
ck("missedActions is too", /missedActions: missedActions\.map/.test(SCOUT), true);
ck("...and a flag distinguishes 'none' from 'not loaded'",
   /actionsKnown: actionRows\.length > 0/.test(SCOUT), true);

// The same rule, enforced in two places, must stay in step: the cron pushes
// only due_src-null steps, and Scout raises only due_src-null steps.
{
  const CRON = fs.readFileSync(path.join(REPO, "api", "target-followup-reminders.js"), "utf8");
  ck("the reminder cron applies the identical rule", /due_src=is\.null/.test(CRON), true);
  ck("...and Scout applies it too", /!a\.due_src/.test(SCOUT), true);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
