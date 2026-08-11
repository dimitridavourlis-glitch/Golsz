// Every consequential write must be able to observe its own failure.
//
// THE BUG THIS ENFORCES AGAINST
// supabase-js RESOLVES with { error } rather than throwing. So
//
//   try { await sb.from("x").update(y).eq("id", id); }
//   catch (e) { console.error(e); }
//
// catches a network throw and NOTHING ELSE. An RLS rejection, a constraint
// violation or an expired session all look exactly like success: the UI keeps
// the optimistic value, the row never changed, and the athlete believes their
// note, highlight or target was saved.
//
// On 2026-08-11 a scan found 36 such writes. The error was not ignored — it
// was unobservable, because the result was never bound at all. 23 were fixed;
// the rest are self-correcting and listed below as deliberate.
//
// WHY THIS SUITE EXISTS AND NOT JUST THE COMMENT IN golsz-app.html
// The comment tells the next person what the rule is. This tells them when
// they have broken it, and this is the class where nothing surfaces until an
// athlete loses something.
//
// HOW THE DETECTOR IS VALIDATED
// The FIRST version of this scan searched for the string "error" near the
// call. `catch (e) { console.error(...) }` contains it, so the broken pattern
// counted as evidence of the fix: it reported 4 when the answer was 36, and
// would have closed the question with "the codebase is basically clean".
//
// A detector is only worth its green if its signal is ABSENT from the failure
// case. So this file tests itself against both — a known-broken snippet it
// must flag, and a known-good one it must not — before its result on the real
// file means anything.

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

// A write whose result is never bound cannot observe its own error. That is
// the test — not whether the word "error" appears nearby.
// A table write is unambiguous. An rpc is NOT — sb.rpc() is used for reads
// too (get_public_passport), so treating every rpc as a write produced false
// positives on the first run. Mutating RPCs are listed explicitly; adding one
// means adding it here, which is the point.
const MUTATING_RPCS = ["set_athlete_context_field", "ensure_message_request", "merge_scout_context",
  "admin_review_verification", "admin_review_appeal", "resolve_moderation_item", "request_parent_link"];
const WRITE = new RegExp(
  "await\\s+sb\\s*\\.\\s*(?:from\\([^)]*\\)[\\s\\S]{0,400}?\\.(?:update|insert|delete|upsert)\\(" +
  "|rpc\\(\\s*[\"'](?:" + MUTATING_RPCS.join("|") + ")[\"'])");
// Both binding forms count. `({ error } = await ...)` reassigns an outer
// binding and has no declarator — missing that form flagged two already-fixed
// call sites on the first run.
const BOUND = /(?:(?:const|let|var)\s*)?\(?\s*\{[^}]*\berror\b[^}]*\}\s*=\s*await\s+sb\s*\./;

function unboundWrites(code) {
  const out = [];
  code.split("\n").forEach((line, i) => {
    if (!WRITE.test(line)) return;
    if (BOUND.test(line)) return;
    out.push({ line: i + 1, text: line.trim() });
  });
  return out;
}

// ---- validate the detector BEFORE trusting it on the real file ----------
const BROKEN = `
  async function save(id, updates) {
    try { await sb.from("development_plan_items").update(updates).eq("id", id); }
    catch (e) { console.error("GOLSZ update error:", e); }
  }
`;
const GOOD = `
  async function save(id, updates) {
    try {
      const { error } = await sb.from("development_plan_items").update(updates).eq("id", id);
      if (error) throw error;
    } catch (e) { console.error("GOLSZ update error:", e); setItems(before); }
  }
`;
ck("the detector flags a write whose result is discarded", unboundWrites(BROKEN).length, 1);
// THE ASSERTION THAT THE FIRST SCAN FAILED. The broken fixture contains
// `console.error` — if the detector keys on the string "error" anywhere near
// the call, it goes silent here and reports the codebase clean.
ck("...and is NOT fooled by console.error in the catch",
   unboundWrites(BROKEN)[0] && /console\.error/.test(BROKEN), true);
ck("the detector stays silent when the result is bound and checked", unboundWrites(GOOD).length, 0);

// ---- deliberately unchecked, by table/rpc rather than line number -------
// Line numbers drift; the decision is about the write, not its position. The
// rule is SELF-CORRECTION, not importance: a like that failed to save springs
// back on the next feed load and the athlete sees the truth unaided. A deleted
// highlight that failed to delete looks gone until they return and find it.
// Silence is acceptable only where the next render corrects it.
const SELF_CORRECTING = [
  "post_likes",            // toggle; re-reads on next feed load
  "follows",               // toggle; re-reads on next profile/feed load
  "messages",              // read_at receipts; recomputed from the thread
  "ensure_message_request", // idempotent rpc, retried on the next send
  "push_subscriptions",    // cleanup; re-subscribes on next permission check
];
const isAccepted = (text) => SELF_CORRECTING.some((t) => text.includes(`"${t}"`) || text.includes(`("${t}"`));

const found = unboundWrites(APP);
const unexpected = found.filter((w) => !isAccepted(w.text));
console.log(`   ${found.length} unbound writes, ${found.length - unexpected.length} accepted as self-correcting`);

ck("no consequential write discards its own result",
   unexpected.map((w) => `${w.line}: ${w.text.slice(0, 90)}`), []);

// An exemption list that outlives its entries rots into blanket permission.
const stale = SELF_CORRECTING.filter((t) => !found.some((w) => isAccepted(w.text) && w.text.includes(t)));
ck("no accepted entry has become stale", stale, []);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
