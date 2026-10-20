// THREE SMALL THINGS, AND ONE NEAR-MISS WORTH MORE THAN ALL OF THEM.
//
// 1. A sport GOLSZ has no requirements for now says so, instead of showing
//    nothing and leaving the athlete unable to tell "you are not missing
//    anything" from "this product never looked".
// 2. dismiss_next_move() has been callable by every signed-in account since
//    migration 070 with zero call sites. The grant is revoked.
// 3. Migration 151 must NEVER be applied. It was written for a design that was
//    rejected, and running it now would break sync_athlete_actions() for every
//    athlete — silently. That is what this suite mostly guards.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const M151 = fs.readFileSync(path.join(REPO, "supabase-migration-151-legacy-idx-plain.sql"), "utf8");
const M152 = fs.readFileSync(path.join(REPO, "supabase-migration-152-sync-actions.sql"), "utf8");
const M155 = fs.readFileSync(path.join(REPO, "supabase-migration-155-sync-category.sql"), "utf8");
const M157 = fs.readFileSync(path.join(REPO, "supabase-migration-157-revoke-dismiss-next-move.sql"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- 151 IS A TRAP, AND MUST STAY LABELLED AS ONE --------------------------
//
// The live sync infers its ON CONFLICT against a PARTIAL unique index. 151
// replaces that index with a plain constraint. Apply it and the predicate
// matches nothing: 42P10 on every sync, so every tick, rename and reschedule
// stops mirroring for every athlete, with no error an athlete would ever see.
ck("151 is marked do-not-apply", /\*\*\* DO NOT APPLY/.test(M151), true);
ck("...and says it would break the sync", /BREAK the sync/.test(M151), true);
ck("...and names the error it would cause", /42P10/.test(M151), true);
ck("...and is NOT marked applied", /\*\*\* APPLIED/.test(M151), false);

// The dependency it would break, asserted from the live migrations rather than
// described: both functions name the predicate, so both need the partial index.
for (const [name, sql] of [["152", M152], ["155", M155]]) {
  ck(`${name}'s ON CONFLICT names the partial predicate`,
     /on conflict \(user_id, legacy_milestone_id\) where legacy_milestone_id is not null/.test(sql), true);
}
// And 151 really does remove it — so the two facts above are in genuine
// conflict, which is why the label matters.
ck("151 really does drop that index", /drop index if exists athlete_actions_legacy_idx/.test(M151), true);

// ---- 157: THE GRANT IS GONE, THE FUNCTION IS NOT ---------------------------
ck("157 revokes execute from everyone", /revoke all on function public\.dismiss_next_move\(\) from authenticated, anon, public;/.test(M157), true);
ck("...and does not drop the function", /drop function/.test(M157), false);
ck("...and is recorded as applied", /\*\*\* APPLIED 2026-10-14/.test(M157), true);
// The reason it was safe to revoke: nothing calls it. If that changes, this
// fails and whoever added the call site has to grant it back deliberately.
ck("still zero call sites in the client", /dismiss_next_move/.test(APP), false);
{
  const apiDir = path.join(REPO, "api");
  const hits = fs.readdirSync(apiDir).filter((n) => n.endsWith(".js"))
    .filter((n) => fs.readFileSync(path.join(apiDir, n), "utf8").includes("dismiss_next_move"));
  ck("...and zero across the API", hits, []);
}
ck("the comment tells the next person to grant it WITH a call site",
   /IN THE SAME CHANGE as its call site and its test/.test(M157), true);

// ---- A SPORT WITH NO REQUIREMENTS SAYS SO ----------------------------------
{
  ck("the unsupported case renders", /gap_sport_unsupported/.test(APP), true);
  const at = APP.indexOf("{!gap && pathwayType && athlete && athlete.sport");
  ck("...only when there is genuinely no requirement data", at > 0, true);
  const blk = APP.slice(at, at + 700);
  // Gated on the mirror itself, so adding a sport's requirements removes this
  // card automatically rather than leaving a stale apology on screen.
  ck("...gated on the requirement table, not a hardcoded sport list",
     /!PATHWAY_KEY_EVIDENCE\[String\(athlete\.sport\)\.toLowerCase\(\)\]/.test(blk), true);
  ck("...and only once they have a goal to compare against", /pathwayType &&/.test(blk), true);
  // Named back to them IN THEIR OWN LANGUAGE. athlete.sport is the canonical
  // stored English value; this sentence is the one telling them GOLSZ will not
  // guess what their sport requires, and reading "Basketball" in Latin script
  // mid-Greek undercuts exactly that claim.
  ck("the athlete's own sport is named back to them", /replace\("\{sport\}", tv\(athlete\.sport\)\)/.test(blk), true);

  const strings = APP.match(/\bgap_sport_unsupported: "([^"]+)"/g) || [];
  ck("four dictionaries, four distinct strings", [strings.length, new Set(strings).size], [4, 4]);
  ck("...each interpolating the sport", strings.every((v) => v.includes("{sport}")), true);
  // It must say GOLSZ will not guess — that is the whole point of the card.
  ck("...and each saying GOLSZ will not guess",
     strings.every((v) => /not going to guess|ne va pas le deviner|no va a adivinarlo|δεν πρόκειται να μαντέψει/.test(v)), true);
  // And it must not read as "your sport is unsupported", which is false — the
  // rest of the product works.
  ck("...and each saying the rest still works",
     strings.every((v) => /all work|fonctionnent|funcionan|λειτουργούν/.test(v)), true);
}

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
