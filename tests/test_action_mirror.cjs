// KEEPING athlete_actions IN STEP WITH THE jsonb.
//
// pathway_plan.milestones is still the source of truth. Nothing reads
// athlete_actions yet; the mirror exists so the table is already correct when
// readers cut over — including for athletes who never touch their plan again.
//
// THE DESIGN THIS REPLACED IS WHY THE SUITE IS SHAPED THIS WAY. A full
// client-side dual-write was specified and rejected by two independent
// adversarial reviews that converged on the same defect: a browser cannot
// reconcile atomically, so it needs a fingerprint cache, and a half-applied
// pass leaves that cache naming a state the table no longer holds — after
// which the next write returning to that state is skipped forever. Tick/untick
// and delete/undo return to a previous state constantly.
//
// So the assertions here are mostly about what must NOT exist in the client:
// no cache, no queue, no diffing, and no await that makes the athlete wait on
// a mirror for a write that already succeeded.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const MIG = fs.readFileSync(path.join(REPO, "supabase-migration-152-sync-actions.sql"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- the client half is one function and four calls -----------------------
const at = APP.indexOf("function syncActions(sb) {");
ck("syncActions exists", at > 0, true);
const body = APP.slice(at, APP.indexOf("\n}", at) + 2);

ck("it calls the function and nothing else", /sb\.rpc\("sync_athlete_actions"\)/.test(body), true);
ck("...passing no arguments, so there is no user_id to get wrong",
   /sb\.rpc\("sync_athlete_actions"\)\s*\./.test(body), true);
ck("...and checks { error } rather than assuming", /\{ error \}/.test(body), true);

// Fire and forget: the athlete's write already succeeded.
ck("the athlete never waits on the mirror", /await sb\.rpc/.test(body), false);
ck("...and is never shown an error for a write that worked",
   /setSaveError|setStepErr|setRetestMsg|actionError|alert\(/.test(body), false);
ck("...but it is not silent either", /console\.warn/.test(body), true);
// A rejected promise with no handler is an unhandled rejection, and rpc() can
// reject rather than resolve on a transport failure.
ck("a rejection is handled, not just an { error }", /,\s*\(e\) =>/.test(body), true);
ck("...and a synchronous throw cannot escape", /try \{/.test(body) && /catch \(e\)/.test(body), true);

// THE MACHINERY THAT MUST NOT COME BACK.
ck("there is no fingerprint cache", /actionMirrorSynced|mirrorPrint|syncedPrint/.test(APP), false);
ck("there is no mirror queue", /actionMirrorQueue|mirrorQueue/.test(APP), false);
// READS are fine and expected — Home's weekly review is the first one, and
// the data export now carries the table too. What must never come back is the
// client WRITING or diffing rows itself: that is the rejected design, and all
// reconciliation goes through sync_athlete_actions().
// THE RULE, STATED PRECISELY RATHER THAN CONVENIENTLY.
//
// This began as "the client never writes this table". That was right about the
// danger and wrong about the boundary. The rejected dual-write design was
// dangerous because it wrote the MIRRORED columns and tried to keep them in
// step with the plan — which a browser cannot do atomically. The athlete's own
// category, priority and reason are different: sync_athlete_actions() never
// touches them, so there is nothing for a client write to diverge FROM.
//
// So the rule is: the client may UPDATE only columns the sync leaves alone,
// and may never insert or delete. Both halves are derived here rather than
// retyped — the sync's set from the migration, the client's from the code —
// and asserted disjoint. If anyone ever adds a mirrored column to either side,
// this fails.
const actionVerbs = [...APP.matchAll(/from\("athlete_actions"\)\s*\n?\s*\.\s*(\w+)/g)].map((m) => m[1]);
ck("the client only selects and updates", [...new Set(actionVerbs)].sort(), ["select", "update"]);
ck("...never inserts, so a row can only come from the sync",
   actionVerbs.includes("insert") || actionVerbs.includes("upsert"), false);
ck("...and never deletes", actionVerbs.includes("delete"), false);
{
  // What the sync overwrites, read out of migration 152.
  const SYNC = fs.readFileSync(path.join(REPO, "supabase-migration-152-sync-actions.sql"), "utf8");
  const doUpdate = SYNC.slice(SYNC.indexOf("do update set"), SYNC.indexOf("returning 1", SYNC.indexOf("do update set")));
  const mirrored = [...doUpdate.matchAll(/^\s{4,}([a-z_]+)\s*=/gm)].map((m) => m[1]);
  ck("the sync's overwritten set was found", mirrored.length >= 6, true);

  // What the client writes, read out of saveActionFields' callers.
  const at = APP.indexOf("async function saveActionFields(");
  const writer = APP.slice(at, APP.indexOf("\n}", at));
  // EVERY KEY OF EVERY CALL, not the first of each. This captured
  // `\{ (\w+):` — one key per call site — so a call writing
  // `{ category: v, due_on: d }` contributed only "category" and the
  // disjointness check below could not see the mirrored column beside it.
  // The guard that exists to prove the client never writes a column the sync
  // overwrites was reading a third of what the client writes.
  ck("there are three call sites, one writer", (APP.match(/saveActionFields\(sb, uid, m\.id, \{/g) || []).length, 3);
  const written = [...APP.matchAll(/saveActionFields\(sb, uid, m\.id, \{([^}]*)\}/g)]
    .flatMap((m) => [...m[1].matchAll(/(\w+)\s*:/g)].map((k) => k[1]));
  ck("...and more keys than there are call sites, or this is still reading one each",
     written.length >= 3, true);
  ck("...writing only category, priority and reason", [...new Set(written)].sort(), ["category", "priority", "reason"]);
  ck("THE TWO SETS ARE DISJOINT — nothing the client writes can be overwritten",
     written.filter((c) => mirrored.includes(c)), []);
  // updated_at IS mirrored, and the writer sets it. That is deliberate and
  // harmless — the sync will set it again — but it must be the ONLY overlap,
  // so it is named here rather than left to look like an oversight.
  ck("...apart from updated_at, which both may touch",
     /updated_at: new Date\(\)\.toISOString\(\)/.test(writer) && mirrored.includes("updated_at"), true);
}
ck("...so reconciliation has exactly one implementation",
   (APP.match(/sb\.rpc\("sync_athlete_actions"\)/g) || []).length, 1);

// ---- every write of the jsonb syncs, and only on success -----------------
{
  const calls = (APP.match(/syncActions\(sb\);/g) || []).length;
  ck("four write paths sync", calls, 4);

  // Each one must sit on the SUCCESS branch. A sync after a failed write
  // would mirror a state the server rejected.
  // Plan's save is the one site where the call sits OUTSIDE the try — a throw
  // inside it would otherwise be caught by the save's own catch and reported
  // as a failed save for a write that succeeded — and inside a try of its own,
  // because an escaping throw rejects savesRef's chain and every later
  // .then(fn) on a rejected promise is skipped, silently ending all writes for
  // the session. test_plan_writes proves both by running it with a mirror stub
  // that throws on purpose.
  ck("Plan's save records success before mirroring",
     /if \(error\) throw error;\s*\n\s*setExists\(true\);\s*\n\s*setSaveError\(""\);\s*\n\s*saved = true;/.test(APP), true);
  ck("...and mirrors only on success, outside the try",
     /\} finally \{ setBusy\(false\); \}[\s\S]{0,900}?if \(saved\) \{ try \{ syncActions\(sb\); \} catch/.test(APP), true);
  ck("...so a throwing mirror cannot poison the write queue",
     /if \(saved\) \{ try \{ syncActions\(sb\); \} catch \(e\) \{ console\.warn/.test(APP), true);
  ck("Home's tick syncs only in the else branch",
     /setStepErr\(t\("home_step_failed"\)\);\s*\n\s*\} else \{\s*\n\s*syncActions\(sb\);/.test(APP), true);
  ck("the retest writer syncs before telling the athlete it worked",
     /syncActions\(sb\);\s*\n\s*setRetestMsg\(t\("bench_retest_done"\)/.test(APP), true);
  ck("Scout's accept syncs after its upsert threw nothing",
     /syncActions\(sb\);\s*\n\s*setMsgs\(\(m\) => m\.map\(\(msg, i\) => \(i === msgIndex \? \{ \.\.\.msg, suggestedPathway: null/.test(APP), true);
}

// ---- the function itself ---------------------------------------------------
ck("it takes no arguments", /create or replace function public\.sync_athlete_actions\(\)/.test(MIG), true);
ck("...reads the caller's identity rather than trusting a parameter",
   /uid uuid := auth\.uid\(\);/.test(MIG), true);
ck("...and refuses an anonymous caller", /if uid is null then\s*\n\s*raise exception/.test(MIG), true);
ck("security definer, with a pinned search_path",
   /security definer\s*\nset search_path = public, pg_temp/.test(MIG), true);
ck("anon cannot execute it", /revoke all on function public\.sync_athlete_actions\(\) from public, anon;/.test(MIG), true);
ck("...only signed-in athletes can", /grant execute on function public\.sync_athlete_actions\(\) to authenticated;/.test(MIG), true);

// Every statement must be scoped to the caller. A missing uid predicate here
// would let one athlete's save rewrite another's rows.
{
  // Named in full. "revoke all on function" alone appears nine times across
  // the migrations, so it is a weak anchor even when the slice is scoped to
  // one file — and a weak anchor is how a slice silently ends up covering the
  // wrong thing.
  // Bounded by the function's own terminator, which occurs once. The previous
  // bound reused the revoke line that an assertion below also matches, and
  // test_anchor_integrity flagged the duplicate — a literal doing two jobs is
  // one rename away from the slice silently covering something else.
  const fn = MIG.slice(MIG.indexOf("create or replace function public.sync_athlete_actions()"),
                       MIG.indexOf("\n$$;"));
  ck("the function body was actually sliced", /return query select n_synced, n_dropped;/.test(fn), true);
  ck("the read is scoped to the caller", /where p\.user_id = uid/.test(fn), true);
  ck("the insert writes the caller's id", /select uid, s\.title/.test(fn), true);
  ck("the drop pass is scoped to the caller", /where a\.user_id = uid/.test(fn), true);
}

// THE PARTIAL INDEX. Postgres will not infer it without the predicate — the
// error the backfill hit. This is raw SQL so it CAN name it, which is why the
// function does not depend on migration 151.
ck("ON CONFLICT repeats the partial index's predicate",
   /on conflict \(user_id, legacy_milestone_id\) where legacy_milestone_id is not null/.test(MIG), true);

// completed_at history. The client design could not do this; the CHECK forces
// a drop to null the column, so only a server-side coalesce carries it back.
ck("the FIRST completion moment is kept, not the latest write's",
   /coalesce\(athlete_actions\.completed_at, excluded\.completed_at\)/.test(MIG), true);
ck("...and a non-completed status clears it, as the CHECK requires",
   /else null end,\s*\n\s*updated_at   = now\(\)/.test(MIG), true);

// A step with no id must not cause a drop — the defect that killed the
// client design's drop phase.
ck("id-less steps are excluded from the step set",
   /and nullif\(m->>'id', ''\) is not null/.test(MIG), true);
ck("...and the drop pass only touches rows that came from a step",
   /and a\.legacy_milestone_id is not null/.test(MIG), true);
ck("a vanished step is marked, never deleted", /set status = 'dropped'/.test(MIG), true);
ck("...and nothing in the function deletes a row", /\bdelete from athlete_actions\b/i.test(MIG), false);

// The status values must match the CHECK, or it is a 400 at runtime.
ck("only the three real statuses are written",
   [...new Set((MIG.match(/'(open|completed|dropped|in_progress|todo)'/g) || []))].sort(),
   ["'completed'", "'dropped'", "'open'"]);

ck("the mirror is in the compiled bundle",
   fs.readFileSync(path.join(REPO, "js", "app.js"), "utf8").includes("sync_athlete_actions"), true);

// APPLIED 2026-10-14. This assertion was written the other way round and
// fired the moment it landed, which is what it was for: the file must never
// disagree with the database about whether it has run.
ck("the migration records that it is applied", /\*\*\* APPLIED 2026-10-14/.test(MIG), true);
ck("...and no longer claims otherwise", /NOT YET APPLIED/.test(MIG), false);
// The facts that were checked against the live database, kept with the file so
// a later reader can re-run them rather than trust this note.
ck("...with anon execute explicitly recorded as denied", /anon EXECUTE = FALSE/.test(MIG), true);
ck("...and the pinned search_path recorded", /search_path=public, pg_temp/.test(MIG), true);

// The schema reference must know about it too — the guard that catches an
// applied-but-unrecorded migration is test_schema_reference_current.
{
  const SCHEMA = fs.readFileSync(path.join(REPO, "supabase-schema.sql"), "utf8");
  ck("the schema reference carries 152", /152 — sync_athlete_actions/.test(SCHEMA), true);
  // Deliberately a pointer, not a copy. A second definition of the body would
  // drift from the one the database actually runs.
  ck("...as a pointer, not a second copy of the body",
     /create or replace function public\.sync_athlete_actions/.test(SCHEMA), false);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
