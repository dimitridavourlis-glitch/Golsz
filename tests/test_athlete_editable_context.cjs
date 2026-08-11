// The RPC's allowlist and Scout's allowlist must not disagree.
//
// THE BUG THIS PREVENTS
// migration 125 lets the athlete write a small set of scout_context fields
// directly (set_athlete_context_field). api/scout.js has its OWN allowlist,
// SCOUT_CONTEXT_KEYS, filtering what Scout may write.
//
// If a field is athlete-editable but missing from SCOUT_CONTEXT_KEYS, then
// Scout writing that field silently drops it — and every test of the write
// path still passes, because those tests write through the RPC, not through
// Scout. The field would work when the athlete typed it and vanish when Scout
// touched it, with nothing failing.
//
// That is the same family as the dead anchor and the missing select(): the
// test measures the right thing over a path it never exercises. Same fix as
// test_answered_by_labels, which caught exactly this between logRouting() and
// the CHECK constraint: compare the two lists as sets, in code, rather than
// relying on someone remembering.
//
// SUBSET, NOT EQUALITY. SCOUT_CONTEXT_KEYS is much larger — Scout infers
// many fields the athlete never edits directly. The invariant is one-way:
// everything the RPC can write, Scout must also be able to write.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const MIG = fs.readFileSync(REPO + "/supabase-migration-125-athlete-editable-context.sql", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- the RPC's allowlist, read out of the migration ----------------------
const rpcMatch = MIG.match(/if p_field not in \(([^)]*)\) then/);
if (!rpcMatch) throw new Error("could not find the RPC field allowlist — migration 125 changed shape");
const rpcFields = rpcMatch[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean).sort();
ck("the RPC allowlist parsed", rpcFields.length > 0, true);

// ---- Scout's allowlist, read out of api/scout.js -------------------------
const scoutStart = SCOUT.indexOf("const SCOUT_CONTEXT_KEYS = new Set([");
if (scoutStart < 0) throw new Error("SCOUT_CONTEXT_KEYS not found — markers moved, update this suite");
const scoutEnd = SCOUT.indexOf("]", scoutStart);
if (scoutEnd < 0) throw new Error("SCOUT_CONTEXT_KEYS has no closing bracket where expected");
const scoutBlock = SCOUT.slice(scoutStart, scoutEnd);
const scoutFields = (scoutBlock.match(/"[a-z_]+"/g) || []).map((s) => s.replace(/"/g, ""));
ck("Scout's allowlist parsed and is the larger list", scoutFields.length > rpcFields.length, true);

console.log("   rpc:   " + rpcFields.join(", "));

// ---- THE INVARIANT ------------------------------------------------------
const droppable = rpcFields.filter((x) => !scoutFields.includes(x));
ck("every athlete-editable field is also writable by Scout", droppable, []);

// Named individually so a failure says which one, not just that one exists.
for (const field of rpcFields) {
  ck(`SCOUT_CONTEXT_KEYS contains "${field}"`, scoutFields.includes(field), true);
}

// ---- the RPC's own guarantees, asserted against the migration text -------
// These are the reasons a client-writable path was acceptable at all.
ck("source is forced server-side, never taken from the caller",
   /'source', 'athlete_stated'/.test(MIG), true);
ck("...and the caller cannot pass a source at all",
   /p_source/.test(MIG), false);
ck("authorization is own-row or an approved parent link",
   /p_athlete <> auth\.uid\(\) and not is_parent_of\(p_athlete\)/.test(MIG), true);
ck("an unauthenticated caller is rejected", /auth\.uid\(\) is null/.test(MIG), true);
ck("empty deletes the key rather than storing an empty string",
   /- p_field/.test(MIG), true);
ck("execute is granted to authenticated", /grant\s+execute on function set_athlete_context_field\(uuid, text, text\) to authenticated/.test(MIG), true);
ck("...and revoked from anon", /revoke execute on function set_athlete_context_field\(uuid, text, text\) from anon/.test(MIG), true);

// The wide writer must stay service-role only. If this ever flips, the
// narrow RPC was pointless.
const SCHEMA = fs.readFileSync(REPO + "/supabase-schema.sql", "utf8");
const mergeGrants = SCHEMA.slice(SCHEMA.indexOf("revoke execute on function merge_scout_context"));
ck("merge_scout_context is still revoked from authenticated",
   /revoke execute on function merge_scout_context\(uuid, jsonb\) from authenticated/.test(mergeGrants.slice(0, 600)), true);
ck("...and granted only to service_role",
   /grant execute on function merge_scout_context\(uuid, jsonb\) to service_role/.test(mergeGrants.slice(0, 600)), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
