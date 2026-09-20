// Two capabilities are deliberately OFF, and each was switched off in two
// places. This suite exists because "off" that lives in one place comes back
// on by accident.
//
// DISCOVERY (migration 143). GOLSZ is a growth app right now; athlete search
// belongs to the product it becomes later. Turning it off meant BOTH removing
// the tool from Scout AND revoking execute on search_players() from
// authenticated and anon — the grant was the load-bearing half, because it let
// any signed-in account call the RPC directly with the public anon key,
// bypassing Scout, the plan gate and the 402.
//
// PARENT ACCOUNTS (2026-09-19). Strictly athletes for now. The plumbing stays
// — actingFor / manageMode / manageId thread correctly through every screen,
// and rebuilding that contract is not something anyone should do twice — so
// this is a flag plus gated render sites, not a deletion. Production had 0
// parent accounts and 0 parent links when it was flipped.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(REPO, "golsz-app.html"), "utf8");
const SCOUT = fs.readFileSync(path.join(REPO, "api", "scout.js"), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

console.log("-- discovery is off --");
const toolsLine = /const SCOUT_SEARCH_TOOLS = \[[^\]]*\];/.exec(SCOUT);
ck("the Scout toolset is findable", !!toolsLine, true);
ck("...and does not hand the model the player search",
   !!toolsLine && toolsLine[0].includes("SEARCH_PLAYERS_TOOL"), false);
// Kept, not deleted: switching discovery back on should be adding one name to
// that array, not rebuilding the feature from memory.
ck("...while the tool definition is kept for when it returns",
   /const SEARCH_PLAYERS_TOOL = \{/.test(SCOUT), true);
ck("...and so is its executor", /async function searchPlayers\(input\)/.test(SCOUT), true);

// The database half. A revoke living only in a migration file is a revoke
// nobody re-checks, so the migration must exist and say what it did.
const m143 = path.join(REPO, "supabase-migration-143-discovery-off.sql");
ck("migration 143 is in the repo", fs.existsSync(m143), true);
const SQL143 = fs.existsSync(m143) ? fs.readFileSync(m143, "utf8") : "";
ck("...and revokes execute from authenticated", /revoke all on function %s from authenticated/.test(SQL143), true);
ck("...and from anon", /revoke all on function %s from anon/.test(SQL143), true);
// scout_visible gates only search_players(), so with that unreachable the
// toggle controls nothing. A privacy control over a capability that cannot
// happen is worse than none: the column defaults to true, so it would tell
// every athlete they are findable when nobody can find them.
ck("the Findable-by-scouts toggle is not rendered",
   /\["scout_visible", "privacy_scout_visible"/.test(APP), false);
// The two that DO still work — both are read by get_public_passport for a
// shared Passport, which is unaffected by discovery being off.
ck("...but the two toggles that still do something remain",
   /\["show_club", "privacy_show_club"/.test(APP) && /\["show_country", "privacy_show_country"/.test(APP), true);
// The client never called the RPC, but assert it stays that way: the revoke
// protects the anon key, and this protects the service-role path.
// The call shape, not the bare name: the name appears in comments explaining
// why discovery is off, and an assertion that cannot tell a call from a
// comment is one that will be silenced by rewording rather than by a fix.
ck("the client still never calls search_players directly",
   /sb\.rpc\(\s*["']search_players["']/.test(APP), false);

console.log("\n-- parent accounts are off --");
ck("the flag exists and is false", /const PARENT_ACCOUNTS_ENABLED = false;/.test(APP), true);
ck("the occupation dropdown offers athletes only", /const OCCUPATIONS = \["Player"\];/.test(APP), true);
// Every surface that could put a parent into manage mode. Two layouts, so two
// of each — a gate applied to one layout only is the shape of bug this
// codebase has produced before.
ck("MyAthletes is gated in both layouts",
   (APP.match(/PARENT_ACCOUNTS_ENABLED && page === "home" && !actingFor && linkedChildren/g) || []).length, 2);
ck("the add-athlete / FamilyAccess block is gated in both layouts",
   (APP.match(/PARENT_ACCOUNTS_ENABLED && page === "home" && !actingFor && isParentAccount/g) || []).length, 2);
ck("the 'signing up for a minor' entry point is gated",
   /PARENT_ACCOUNTS_ENABLED && !requiresParentAccount && \(/.test(APP), true);
// The route out of the under-18 block was "have a parent make the account".
// That flow cannot finish now, so offering it would send a fifteen-year-old to
// a page that dead-ends.
ck("under-18 is no longer offered a parent-signup route",
   /setMode\("parent-signup"\); setErr\(""\); setChildName\(name\)/.test(APP), false);
ck("...and the notice states the age limit in all four languages",
   (APP.match(/auth_under18_notice: "/g) || []).length, 4);
ck("...naming no parent path in any of them",
   [...APP.matchAll(/auth_under18_notice: "([^"]*)"/g)]
     .map((x) => x[1])
     .filter((v) => /parent|guardian|tuteur|padre|tutor|γονέα|κηδεμόνα/i.test(v)), []);
// The plumbing is kept on purpose. If these go, re-enabling parents is a
// rewrite rather than a flag flip.
// THE LANDING PAGE IS PART OF THE SHUTDOWN, and it was missed the first
// time. index.html told every visitor "A parent or guardian holds the account
// for athletes under 18" in the hero and again under the pricing table, so a
// sixteen-year-old read that, tapped Start free, and met "GOLSZ is for
// athletes aged 18 and over". A promise on the first page a visitor sees is
// the worst place to leave one.
const LANDING = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
ck("the landing page promises no parent path", /parent/i.test(LANDING), false);
ck("...and states the age limit instead",
   (LANDING.match(/aged 18 and over/g) || []).length >= 2, true);

// THE SERVER HALF. api/create-child-account.js exists to create an UNDER-18
// record — it rejects age >= 18 with code "not_under_18" — and it runs on the
// SERVICE ROLE key, which bypasses RLS entirely. Turning parent accounts off
// in the client left it deployed and callable with any valid session token,
// which is not "off"; it is off in the interface only.
const CHILD_API = fs.readFileSync(path.join(REPO, "api", "create-child-account.js"), "utf8");
ck("the child-account endpoint has its own flag", /const PARENT_ACCOUNTS_ENABLED = false;/.test(CHILD_API), true);
ck("...checked before anything else the handler does",
   /if \(!PARENT_ACCOUNTS_ENABLED\) \{[\s\S]{0,260}parent_accounts_disabled/.test(CHILD_API), true);
// Ordering matters: a refusal placed after the Supabase lookups would still do
// the work and still leak whether a session is valid.
{
  const handlerAt = CHILD_API.indexOf("export default async function handler");
  const refusalAt = CHILD_API.indexOf("parent_accounts_disabled");
  const firstFetchAt = CHILD_API.indexOf("fetch(", handlerAt);
  ck("...and before the first outbound call", refusalAt > handlerAt && refusalAt < firstFetchAt, true);
}

ck("the parent-view plumbing is kept", /manageMode=\{!!actingFor\}/.test(APP), true);
ck("...including the server-side verifier", fs.existsSync(path.join(REPO, "api", "_acting-for.js")), true);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
