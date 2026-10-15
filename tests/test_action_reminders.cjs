// A PLAN THAT NEVER SPEAKS CANNOT HELP ANYONE ACT.
//
// Nothing in GOLSZ told an athlete a step was due: the date passed and the
// first they heard of it was the word "overdue" next time they happened to
// open the app.
//
// THE ASSERTION THIS SUITE EXISTS FOR is not that reminders work. It is that
// GOLSZ never calls an athlete late on a date it chose for them. due_src marks
// a date that came from Scout, or from tapping Retest on a benchmark — one tap
// on a confirm card is consent to a plan, not consent to twelve individual
// deadlines. The client has refused to call such a date late since
// suggestedDate() was written, and a push notification is the most punitive
// surface in the product: it arrives uninvited, on a phone, when the athlete
// is not even using GOLSZ. If anything in here ever reminds on a date the
// product picked, that is a fifteen-year-old being told off by software for
// missing a deadline nobody asked them to agree to.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const CRON = fs.readFileSync(path.join(REPO, "api", "target-followup-reminders.js"), "utf8");
const MIG = fs.readFileSync(path.join(REPO, "supabase-migration-153-action-reminders.sql"), "utf8");
const VERCEL = JSON.parse(fs.readFileSync(path.join(REPO, "vercel.json"), "utf8"));

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const at = CRON.indexOf("async function remindDueSteps(");
ck("the due-step pass exists", at > 0, true);
const fn = CRON.slice(at, CRON.indexOf("\n}", at) + 2);
// Comments discuss due_src and suggested dates at length; grepping the prose
// instead of the code is a trap this repo has fallen into repeatedly.
const code = fn.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
ck("...and the stripped body is still the real function", /supaSelect\(/.test(code), true);

// ---- THE RULE ---------------------------------------------------------------
ck("ONLY dates the athlete set themselves are ever reminded",
   /due_src=is\.null/.test(code), true);
ck("...and that is in the QUERY, not a filter applied afterwards",
   /athlete_actions\?[^`]*due_src=is\.null/.test(code), true);
// The index exists so the filter stays cheap, but more importantly it encodes
// the same rule in the database.
ck("the supporting index carries the same predicate",
   /where status = 'open' and due_on is not null and due_src is null/.test(MIG), true);

// ---- ONE NUDGE, EVER --------------------------------------------------------
ck("a step that has been reminded is never reminded again",
   /last_reminded_at=is\.null/.test(code), true);
ck("...and the stamp is written after the send", 
   code.indexOf("last_reminded_at: new Date().toISOString()") > code.indexOf("sendNotification"), true);
ck("the column is never backfilled, so an already-overdue step gets its first nudge",
   /Never backfilled/.test(MIG), true);
ck("...and the migration verifies that by query", /expect 0 — nothing is backfilled/.test(MIG), true);

// An athlete with no push subscription must NOT have their one nudge burned.
ck("no subscription means no stamp, so the nudge is not spent",
   /if \(!subs\.length\) continue;/.test(code), true);
ck("...and that check precedes the stamp",
   code.indexOf("if (!subs.length) continue;") < code.indexOf("last_reminded_at: new Date"), true);

// ---- ONLY OPEN, ONLY DUE ----------------------------------------------------
ck("completed and dropped steps are never nudged", /status=eq\.open/.test(code), true);
ck("a step due in the future is not nudged", /due_on=lte\./.test(code), true);
ck("...against today, computed as a date not a timestamp",
   /toISOString\(\)\.slice\(0, 10\)/.test(code), true);
// Due today reads differently from already past: one is a prompt, the other is
// an admission the day went by.
ck("due-today and overdue say different things", /dueToday \?/.test(code), true);

// ---- IT RIDES THE EXISTING CRON --------------------------------------------
// api/ is at Vercel's 12-function limit, and a reminder does not deserve a route.
ck("there is still exactly one cron", (VERCEL.crons || []).length, 1);
ck("...and it is the existing daily job",
   [VERCEL.crons[0].path, VERCEL.crons[0].schedule], ["/api/target-followup-reminders", "0 13 * * *"]);
const apiFiles = fs.readdirSync(path.join(REPO, "api")).filter((n) => n.endsWith(".js") && !n.startsWith("_"));
ck("no new serverless route was added", apiFiles.length <= 12, true);

// ---- A FAILURE HERE MUST NOT LOSE THE RUN IT RODE IN ON ---------------------
ck("the new pass has its own try", /let steps = \{ checked: 0, reminded: 0 \};\s*\n\s*try \{/.test(CRON), true);
ck("...and its failure is logged, not swallowed",
   /Due-step reminders failed/.test(CRON), true);
ck("...and reported in the response either way", /steps, watchdog \}/.test(CRON), true);
// A silent zero must be distinguishable from "nothing was due".
ck("the response says how many were checked, not just how many were sent",
   /return \{ checked: rows\.length, reminded: sent \};/.test(fn), true);

// ---- a dead subscription is pruned, through ONE sender ----------------------
// The prune was copied for this second caller, leaving two identical DELETEs
// that test_server_write_error_checked could not tell apart — it keys a write
// by file, function and method. That collision was the suite reporting a
// duplication, so there is one sender now and both passes call it.
ck("the due-step pass sends through the shared sender",
   /await pushToAll\(supaUrl, serviceKey, webpush, subs, payload\);/.test(code), true);
{
  const sender = CRON.slice(CRON.indexOf("async function pushToAll("), CRON.indexOf("\n}", CRON.indexOf("async function pushToAll(")));
  ck("...which prunes a gone endpoint rather than retrying it forever",
     /statusCode === 404 \|\| e\.statusCode === 410/.test(sender), true);
  ck("...and there is exactly one such prune in the file",
     (CRON.match(/statusCode === 404 \|\| e\.statusCode === 410/g) || []).length, 1);
  ck("...used by both passes",
     (CRON.match(/await pushToAll\(/g) || []).length, 2);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
