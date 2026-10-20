// THE FREE-PLAN TOOL GATE — lifted from api/scout.js, never retyped.
//
// This is the control that stops a $0 account running paid database searches.
// Until now this suite defined its OWN copy of the condition:
//
//   userPlan === "free" && classification && classification.needs_tool
//     && !userIsAdmin && !userAiUnlimited
//
// and asserted eight cases against it. The copy had already drifted from the
// real gate in two ways, so eight green assertions were describing a product
// that does not exist:
//
//   1. the real gate also requires `classificationUsable` — a classification
//      that errored or came back raw is NOT gated
//   2. the real gate only blocks intent === "db_lookup", not every needs_tool
//
// A hand-written mirror of a security control is worse than no test: it
// reports that the control works while watching a different control. So the
// predicate is now EXTRACTED from api/scout.js and executed. If the gate
// changes, this follows it; if the gate's shape changes enough that the
// extraction fails, the assertions fail by name instead of silently passing.

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

/* ---------- lift the real condition ---------- */

const usable = (SCOUT.match(/const classificationUsable = ([^;]+);/) || [])[1];
const gated = (SCOUT.match(/const freeAccountGated = ([^;]+);/) || [])[1];
const outer = (SCOUT.match(/if \(freeAccountGated && classificationUsable && ([^)]+)\) \{/) || [])[1];
const inner = (SCOUT.match(/if \(classification\.intent === "([a-z_]+)"\) \{\n\s*if \(reservedQuestion\)/) || [])[1];

ck("the usable-classification test was found", typeof usable === "string", true);
ck("the free-account test was found", typeof gated === "string", true);
ck("the needs-tool test was found", typeof outer === "string", true);
ck("the gated intent was found", typeof inner === "string", true);

let isBlocked = () => "NOT LIFTED";
if (usable && gated && outer && inner) {
  isBlocked = new Function("classification", "userPlan", "userIsAdmin", "userAiUnlimited",
    "const classificationUsable = " + usable + ";\n" +
    "const freeAccountGated = " + gated + ";\n" +
    "return !!(freeAccountGated && classificationUsable && " + outer + ")\n" +
    "  && classification.intent === " + JSON.stringify(inner) + ";");
}

// The intent the gate actually blocks, read from the source rather than assumed.
ck("it blocks database lookups specifically", inner, "db_lookup");

const C = (over) => ({ needs_tool: true, intent: "db_lookup", ...over });

/* ---------- who is gated ---------- */

ck("free + a database lookup is blocked", isBlocked(C(), "free", false, false), true);
ck("Basic is not", isBlocked(C(), "starter", false, false), false);
ck("Pro is not", isBlocked(C(), "pro", false, false), false);
ck("Elite is not", isBlocked(C(), "elite", false, false), false);
ck("an admin on free is not", isBlocked(C(), "free", true, false), false);
ck("an unlimited free account is not", isBlocked(C(), "free", false, true), false);
// A deployment with no metering configured must not start blocking people.
ck("an unmetered deployment (plan null) is not", isBlocked(C(), null, false, false), false);

/* ---------- the two cases the hand-written copy got WRONG ---------- */

// These are the regression tests. The old mirror said "blocked" for both, so
// the suite was green while describing a stricter product than the one that
// ships — and a reader would have concluded free accounts are gated on every
// tool use, which they are not.
ck("a needs_tool question that is NOT a database lookup is allowed",
   isBlocked(C({ intent: "advice" }), "free", false, false), false);
ck("...and so is one the classifier could not classify",
   isBlocked(C({ error: true }), "free", false, false), false);
ck("...or returned raw", isBlocked(C({ raw: "{" }), "free", false, false), false);
ck("a question needing no tool at all is allowed",
   isBlocked(C({ needs_tool: false }), "free", false, false), false);

/* ---------- the refusal the athlete actually sees ---------- */

ck("the block is a 402 with a code the client can read",
   /code: "free_tool_blocked"/.test(SCOUT), true);
ck("...and it offers the upgrade", /code: "free_tool_blocked",\s*\n\s*can_upgrade: true/.test(SCOUT), true);
// The reservation is released so a refused question is not also charged.
const at = SCOUT.indexOf('code: "free_tool_blocked"');
const before = SCOUT.slice(Math.max(0, at - 1400), at);
ck("...and the question it refused is refunded, not spent",
   /releaseScoutQuestion\(userId\)/.test(before) && /releaseFreeAiQuestion\(userId\)/.test(before), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
