// A free account may verify a fact. It still may not run deep research.
//
// WHY THIS SPLIT EXISTS
// Fixing the Tusculum hallucination means Scout must SEARCH when an athlete
// names a real organisation — including when they name it in a statement.
// But the free-plan gate returned 402 free_tool_blocked for any free account
// whose message needed a tool. Shipping the fix without splitting that gate
// would have handed a free athlete asking about their own university a
// paywall instead of an answer: strictly worse than the bug.
//
// Brief §12 blocks deep RESEARCH — multi-turn loops, large school searches —
// not fact verification. The costs are not comparable: one search turn is
// cents, a four-turn research loop is not. So db_lookup (the player/club
// database, genuinely the expensive one) stays Starter+, and web_lookup falls
// through capped at one turn.
//
// The gate lives inline in the handler, so this suite extracts the REAL
// SOURCE TEXT of the branch and runs it, rather than restating its logic.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};
function slice(a, b, label) {
  const i = SCOUT.indexOf(a), j = SCOUT.indexOf(b, i);
  if (i < 0 || j < 0) throw new Error(`could not slice ${label} — markers moved`);
  return SCOUT.slice(i, j);
}

const GATE_SRC = slice("const FREE_VERIFY_TURNS = 1;", "// ---- Multi-Model tier selection", "free-plan gate");
if (!/maxToolTurns = FREE_VERIFY_TURNS/.test(GATE_SRC)) throw new Error("gate extraction lost its body");

// Run the real branch with the handler's locals supplied as parameters and
// res/release* stubbed. Returns what the handler would have done.
const runGate = new Function("userPlan", "classification", "userIsAdmin", "userAiUnlimited", `
  let released = false;
  const reservedQuestion = true, reservedFreeAi = true, userId = "u", questionsRemaining = 2, dailyLimit = 3;
  const releaseScoutQuestion = async () => { released = true; };
  const releaseFreeAiQuestion = async () => { released = true; };
  let status = null, body = null;
  const res = { status(s) { status = s; return { json(b) { body = b; return { __sent: true }; } }; } };
  const run = async () => {
    ${GATE_SRC.replace(/\breturn res\.status/g, "return __sent(res.status")
              .replace(/scout_usage: \{ remaining: questionsRemaining, limit: dailyLimit \},\n\s*\}\);/,
                       "scout_usage: { remaining: questionsRemaining, limit: dailyLimit },\n        }));")}
    return { blocked: false, maxToolTurns, status, body, released };
  };
  const __sent = (v) => ({ __blocked: true, v });
  return run().then((r) => (r && r.__blocked ? { blocked: true, status, body, released } : r));
`);

const web = { intent: "web_lookup", needs_tool: true };
const db = { intent: "db_lookup", needs_tool: true };
const none = { intent: "career_advice", needs_tool: false };

(async () => {
  // ---- 1. free + web_lookup: allowed, capped at one turn ----------------
  {
    const r = await runGate("free", web, false, false);
    ck("a free athlete verifying a fact is NOT paywalled", r.blocked, false);
    ck("...and gets exactly one search turn", r.maxToolTurns, 1);
    ck("...and their question is not refunded, because it ran", r.released, false);
  }

  // ---- 2. free + db_lookup: still Starter+ ------------------------------
  {
    const r = await runGate("free", db, false, false);
    ck("player-database search is still blocked on free", r.blocked, true);
    ck("...with 402", r.status, 402);
    ck("...and the documented code", r.body.code, "free_tool_blocked");
    ck("...and the reserved question is released", r.released, true);
    ck("...and the message no longer claims web search is blocked too",
       /Web and player-database/.test(r.body.error), false);
    ck("...and names the database specifically", /Player-database search/.test(r.body.error), true);
  }

  // ---- 3. paid accounts keep the validated four turns -------------------
  for (const plan of ["starter", "pro", "elite"]) {
    const r = await runGate(plan, web, false, false);
    ck(`${plan} is never blocked for web_lookup`, r.blocked, false);
    ck(`...and keeps all four tool turns`, r.maxToolTurns, 4);
    const d = await runGate(plan, db, false, false);
    ck(`${plan} keeps database search`, d.blocked, false);
  }

  // ---- 4. the existing exemptions still hold ----------------------------
  {
    const admin = await runGate("free", db, true, false);
    ck("an admin on free is exempt from the database block", admin.blocked, false);
    ck("...and is not capped to one turn", admin.maxToolTurns, 4);
    const unlimited = await runGate("free", db, false, true);
    ck("an ai-unlimited free account is exempt too", unlimited.blocked, false);
  }

  // ---- 5. no tool needed: the gate is inert -----------------------------
  {
    const r = await runGate("free", none, false, false);
    ck("a free question needing no tool is untouched", r.blocked, false);
    ck("...and keeps the default turn budget", r.maxToolTurns, 4);
    const nul = await runGate("free", null, false, false);
    ck("a null classification does not blow up the gate", nul.blocked, false);
  }

  // ---- 6. the cap actually reaches the tool loop ------------------------
  // A cap that is computed and then not threaded through is not a cap.
  const LOOP = slice("async function runDeepReply(", "for (let turn = 0", "tool loop");
  ck("runDeepReply accepts a maxToolTurns argument", /maxToolTurns\)/.test(LOOP), true);
  ck("...and defaults to 4 when it is not supplied",
     /typeof maxToolTurns === "number" && maxToolTurns > 0 \? maxToolTurns : 4/.test(LOOP), true);
  // `await` anchors this to real invocations — without it the declaration
  // itself matches and the count silently reads 3.
  const calls = SCOUT.match(/await runDeepReply\(key, deepTierConfig[^)]*\)/g) || [];
  ck("both runDeepReply call sites exist", calls.length, 2);
  ck("...and both pass maxToolTurns through", calls.every((c) => /maxToolTurns/.test(c)), true);

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})();
