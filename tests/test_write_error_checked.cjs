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
// EVERY rpc the client calls must be classified as one or the other. This is
// an allowlist keyed on a value, and the first version inherited the failure
// this repo has hit repeatedly: an unlisted entry is invisible. It was already
// true — the original list of 7 missed nine mutating RPCs and included
// merge_scout_context, which the client never calls. The assertion below makes
// an unclassified RPC fail rather than pass unchecked.
const MUTATING_RPCS = [
  "set_athlete_context_field", "ensure_message_request", "request_parent_link",
  "respond_to_message_request", "admin_review_verification", "admin_review_appeal",
  "admin_review_knowledge", "resolve_moderation_item", "resolve_error_log_item",
  "create_passport_share_token", "revoke_passport_share_token",
  "reset_scout_intelligence", "log_admin_action", "log_client_error",
  "record_activity_ping",
  // Writes athlete_actions for the calling athlete only (migration 152). It is
  // deliberately fire-and-forget — the athlete's real write has already
  // succeeded and must not be made to wait on a mirror, nor shown an error for
  // an operation that worked — so its handler logs rather than surfacing.
  "sync_athlete_actions",
];
// Six analytics RPCs left this list on 2026-08-13 when loadAnalytics() was
// deleted with the Analytics tab: admin_analytics_counts, admin_moderation_stats,
// admin_scout_model_mix, admin_scout_cost_summary, admin_scout_margin_summary,
// admin_scout_cache_stats. They still EXIST in the database and are still
// granted — nothing was revoked — the client simply no longer calls them.
//
// The "no classified rpc has stopped being called" assertion is what forced
// this edit rather than letting the list quietly describe a client that no
// longer exists. That is the anti-rot half doing its job.
const READ_RPCS = [
  "get_public_passport", "get_public_passport_by_token",
  "admin_scout_debug", "admin_list_knowledge_candidates",
];
const WRITE = new RegExp(
  "await\\s+sb\\s*\\.\\s*(?:from\\([^)]*\\)[\\s\\S]{0,400}?\\.(?:update|insert|delete|upsert)\\(" +
  "|rpc\\(\\s*[\"'](?:" + MUTATING_RPCS.join("|") + ")[\"'])");
// Both binding forms count. `({ error } = await ...)` reassigns an outer
// binding and has no declarator — missing that form flagged two already-fixed
// call sites on the first run.
const BOUND = /(?:(?:const|let|var)\s*)?\(?\s*\{[^}]*\berror\b[^}]*\}\s*=\s*await\s+sb\s*\./;

// A write does not have to be awaited. `sb.rpc(...).then(({ error }) => ...)`
// is the other shape in this file, and a detector that only inspects `await`
// lines is blind to it — a .then() write that dropped its error would pass
// this suite in silence. Found by asking why the unbound count did not move
// after eight RPCs were added to the mutating list.
const THEN_WRITE = new RegExp(
  "sb\\s*\\.\\s*(?:from\\([^)]*\\)[\\s\\S]{0,400}?\\.(?:update|insert|delete|upsert)\\(" +
  "|rpc\\(\\s*[\"'](?:" + MUTATING_RPCS.join("|") + ")[\"'])");
const THEN_HANDLED = /\.then\(\s*\(?\s*\{[^}]*\berror\b/;

// ANCHORED ON THE WRITE, NOT ON PUNCTUATION.
//
// Two previous versions of this were both wrong in the same direction — they
// decided where a statement ENDS and then asked whether the binding was
// anywhere inside it:
//
//   by line       a write split across lines was invisible, because every
//                 regex needs the write and its binding in one string, and
//                 golsz-app.html formats five of its writes that way.
//   by semicolon  a write whose last line carries no `;` kept accumulating
//                 forward and merged with the NEXT statement, so a
//                 neighbour's `{ error }` satisfied the binding check for an
//                 unbound write beside it. The comment here claimed adjacent
//                 statements could not merge. They could.
//
// Both holes come from the same mistake: treating "is there a binding nearby"
// as the question. The real rule is tighter and needs no statement at all —
// a binding belongs to a write only when it is IMMEDIATELY before it:
//
//     const { error } = await sb.from(...).update(...)
//                     ^ this text, adjacent, with nothing in between
//
// A neighbour's binding is by definition not adjacent, so it cannot launder
// anything, and a write spanning any number of lines is still one match.
const BINDING_BEFORE = /\{[^{}]*\berror\b[^{}]*\}\s*=\s*$/;
const LOOKBEHIND = 120;   // enough for `const { data: x, error: e } = `
const LOOKAHEAD = 600;    // ceiling, in case a statement never closes

// THE WINDOW FORWARD IS THE STATEMENT'S OWN, not a fixed number of characters.
// A flat slice reaches past the end of a read and into the next line, so
// `await sb.auth.getUser();` with a write below it was reported as an
// unchecked write — the detector blaming a read for its neighbour, which is
// the same laundering as before pointing the other way. Depth-aware so the
// semicolons inside a chained call's arguments do not end it early.
function statementFrom(code, i) {
  let depth = 0;
  const end = Math.min(code.length, i + LOOKAHEAD);
  for (let j = i; j < end; j++) {
    const c = code[j];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth <= 0) return code.slice(i, j + 1);
  }
  return code.slice(i, end);
}

function unboundWrites(code) {
  const out = [];
  const lineAt = (i) => code.slice(0, i).split("\n").length;
  // Awaited writes. The window forward decides whether it IS a write; the
  // text immediately behind decides whether THIS write was bound.
  for (const m of code.matchAll(/await\s+sb\s*\./g)) {
    const fwd = statementFrom(code, m.index);
    if (!WRITE.test(fwd)) continue;
    const behind = code.slice(Math.max(0, m.index - LOOKBEHIND), m.index);
    if (BINDING_BEFORE.test(behind)) continue;
    out.push({ line: lineAt(m.index), text: fwd.split("\n")[0].trim() });
  }
  // Unawaited writes: `sb.rpc(...).then(({ error }) => ...)`. Here the handler
  // follows the call, so the window forward is the right place to look — and
  // a write with no .then() at all is fire-and-forget by choice, not a miss.
  for (const m of code.matchAll(/(?<!await\s{1,8})\bsb\s*\.\s*(?:from|rpc)\(/g)) {
    const fwd = statementFrom(code, m.index);
    if (!THEN_WRITE.test(fwd)) continue;
    if (!/\.then\(/.test(fwd) || THEN_HANDLED.test(fwd)) continue;
    out.push({ line: lineAt(m.index), text: fwd.split("\n")[0].trim() });
  }
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
// THE GAP THAT EXISTED, PLANTED SO IT CANNOT REOPEN. Both fixtures above are
// single-line, so they passed just as happily against the line scanner this
// replaced. These two are the shape golsz-app.html actually writes in — the
// call split over several lines — and the broken one is what the suite was
// blind to for its whole life.
const BROKEN_MULTILINE = `
  async function save(id, updates) {
    try {
      await sb.from("development_plan_items")
        .update(updates)
        .eq("id", id);
    } catch (e) { console.error("GOLSZ update error:", e); }
  }
`;
const GOOD_MULTILINE = `
  async function save(id, updates) {
    const { error } = await sb.from("development_plan_items")
      .update(updates)
      .eq("id", id);
    if (error) throw error;
  }
`;
ck("the detector flags a write split across lines", unboundWrites(BROKEN_MULTILINE).length, 1);
ck("...and stays silent when that same shape is bound", unboundWrites(GOOD_MULTILINE).length, 0);
// THE LAUNDERING CASE, PLANTED. The semicolon-grouping version of this
// detector merged a write whose last line carries no `;` with the statement
// after it, so the NEXT write's `{ error }` satisfied the binding check for
// this one and it was never reported. Both writes are real; only the first is
// unbound, and exactly one must be flagged.
const LAUNDERED = `
  async function save(a, b) {
    await sb.from("athletes").update(a).eq("id", b)
    const { error } = await sb.from("profiles").update(b).eq("id", b);
    if (error) throw error;
  }
`;
const launderedHits = unboundWrites(LAUNDERED);
ck("a neighbour's binding cannot launder an unbound write", launderedHits.length, 1);
ck("...and it is the unbound one that is named",
   /athletes/.test(launderedHits[0] ? launderedHits[0].text : ""), true);

// THE MIRROR: a read must not be blamed for a write below it. A flat forward
// window reached past `await sb.auth.getUser();` into the next statement and
// reported the READ as an unchecked write — six of them on the real file.
const READ_THEN_WRITE = `
  async function go(id) {
    const { data: { user } } = await sb.auth.getUser();
    const { error } = await sb.from("profiles").update({ x: 1 }).eq("id", id);
    if (error) throw error;
  }
`;
ck("a read is not blamed for the write after it", unboundWrites(READ_THEN_WRITE).length, 0);
// ...and the same read above a genuinely unbound write still reports once.
const READ_THEN_UNBOUND = `
  async function go(id) {
    const { data: { user } } = await sb.auth.getUser();
    await sb.from("profiles").update({ x: 1 }).eq("id", id);
  }
`;
ck("...but an unbound write under a read is still caught",
   unboundWrites(READ_THEN_UNBOUND).length, 1);

// Proof the two fixtures differ in the way claimed, not by accident.
ck("...and the two fixtures really are the same call, bound and unbound",
   [/\.update\(updates\)/.test(BROKEN_MULTILINE), /\.update\(updates\)/.test(GOOD_MULTILINE)], [true, true]);
// The real file writes this way; if it ever stops, these fixtures are still
// the contract but this line stops being the reason to keep them.
ck("the client really does format writes across lines",
   /const \{ error \} = await sb\.from\("pathway_plan"\)\n/.test(APP), true);


// The .then() shape, both ways. A write need not be awaited to lose data.
const THEN_BROKEN = `sb.rpc("log_client_error", { p_message: m }).then(() => {});`;
const THEN_OK = `sb.rpc("log_client_error", { p_message: m }).then(({ error }) => { if (error) console.error(error); });`;
ck("the detector flags an unawaited write whose .then ignores error", unboundWrites(THEN_BROKEN).length, 1);
ck("...and stays silent when the .then handles it", unboundWrites(THEN_OK).length, 0);

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

// ---- the classification itself must be exhaustive ----------------------
// Without this, adding a mutating RPC and forgetting to list it means the
// detector simply never looks at it — silent, which is the property this
// whole suite exists to remove.
const calledRpcs = [...new Set([...APP.matchAll(/sb\.rpc\(\s*["']([a-z_]+)["']/g)].map((m) => m[1]))].sort();
const unclassified = calledRpcs.filter((r) => !MUTATING_RPCS.includes(r) && !READ_RPCS.includes(r));
ck("every rpc the client calls is classified as a read or a write", unclassified, []);
const phantom = [...MUTATING_RPCS, ...READ_RPCS].filter((r) => !calledRpcs.includes(r));
ck("no classified rpc has stopped being called", phantom, []);

// An exemption list that outlives its entries rots into blanket permission.
const stale = SELF_CORRECTING.filter((t) => !found.some((w) => isAccepted(w.text) && w.text.includes(t)));
ck("no accepted entry has become stale", stale, []);

console.log("\n-- a helper must not swallow the error its caller is watching for --");
// A SECOND, QUIETER SHAPE OF THE SAME BUG. The scan above catches a write
// whose error is never BOUND. These bound it, then caught it into
// console.error and resolved successfully anyway — so the caller's own
// try/catch could never fire. addHighlight cleared its inputs and addEntry
// showed the new row, both on a write that had been rejected. The athlete
// closes the app believing their clip is on file.
ck("the highlights helper propagates instead of logging and returning",
   /const \{ error \} = await sb\.from\("athletes"\)\.update\(\{ highlights: list \}\)[\s\S]{0,120}?throw error;/.test(APP), true);
ck("the timeline helper does the same",
   /const \{ error \} = await sb\.from\("athletes"\)\.update\(\{ timeline: list \}\)[\s\S]{0,120}?throw error;/.test(APP), true);
ck("neither one still swallows into a bare console.error",
   /catch \(e\) \{ console\.error\("GOLSZ (highlights|timeline) save error:", e\); \}/.test(APP), false);

console.log("\n-- an optimistic delete is put back when the write fails --");
// Deleting on screen and never checking left the row gone from the UI and
// still on the server. It returns on the next load, which reads as the app
// undoing the athlete's own deletion.
// Matched whole, not sliced from a concatenated anchor: "  async function "
// on its own occurs 107 times in this file, and an anchor that ambiguous is
// exactly what test_anchor_integrity refuses — correctly, because it would
// silently start reading some other function after any refactor.
for (const fn of ["removeHighlight", "removeEntry"]) {
  const m = APP.match(new RegExp("async function " + fn + "\\(id\\) \\{[\\s\\S]*?\\n  \\}"));
  ck(fn + " was found", !!m, true);
  const body = m ? m[0] : "";
  ck(fn + " snapshots before it removes", /const before = items;/.test(body), true);
  ck("..." + fn + " restores that snapshot on failure", /setItems\(before\); setErr\(/.test(body), true);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
