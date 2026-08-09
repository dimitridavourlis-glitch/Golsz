// P0-4 / P1-4 / P1-5 — parent-managed under-16 athletes.
//
// The dangerous shape here is "do this for athlete X" arriving from a caller
// whose token says Y. These tests exercise resolveActingAthlete() against a
// stubbed Supabase, including the cases that matter most: an unrelated
// athlete's id, an id whose parent link exists but is UNAPPROVED, a forged
// token, and a lookup that errors.
//
// The module is loaded for real (dynamic import of api/_acting-for.js) rather
// than re-typed, and global fetch is replaced with a scripted stub so every
// branch can be driven deterministically.

const path = require("path");
const REPO = path.join(__dirname, "..");
const fs = require("fs");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");
const SCOUT = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const DELETE_ACCOUNT = fs.readFileSync(REPO + "/api/delete-account.js", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const PARENT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const UNAPPROVED = "44444444-4444-4444-8444-444444444444";
const URL = "https://example.supabase.co";
const KEY = "service-key";

// Stub Supabase: /auth/v1/user resolves the bearer token to a user id;
// /rest/v1/parent_links returns a row only for the approved pair.
let fetchLog = [];
function installFetch({ tokenUser = PARENT, authOk = true, linkThrows = false, linkOk = true } = {}) {
  fetchLog = [];
  global.fetch = async (url, opts) => {
    fetchLog.push(String(url));
    if (String(url).includes("/auth/v1/user")) {
      if (!authOk) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => (tokenUser ? { id: tokenUser } : {}) };
    }
    if (String(url).includes("/rest/v1/parent_links")) {
      if (linkThrows) throw new Error("network down");
      if (!linkOk) return { ok: false, json: async () => [] };
      const u = String(url);
      // Only the approved PARENT->CHILD pair exists. Note the stub honours
      // approved_at=not.is.null: the UNAPPROVED link is filtered out here the
      // same way Postgres would filter it.
      const match = u.includes(`parent_id=eq.${PARENT}`)
        && u.includes(`athlete_id=eq.${CHILD}`)
        && u.includes("approved_at=not.is.null");
      return { ok: true, json: async () => (match ? [{ id: "link-1" }] : []) };
    }
    return { ok: false, json: async () => ({}) };
  };
}

(async () => {
  const mod = await import(REPO + "/api/_acting-for.js");
  const { resolveActingAthlete, hasApprovedLink, resolveCaller } = mod;

  console.log("-- identity comes from the token, never the body --");
  installFetch();
  ck("a valid token resolves the caller", await resolveCaller("Bearer x", URL, KEY), PARENT);
  installFetch({ authOk: false });
  ck("a rejected token resolves to null", await resolveCaller("Bearer forged", URL, KEY), null);
  ck("a missing header resolves to null", await resolveCaller(null, URL, KEY), null);

  console.log("\n-- the ordinary self path --");
  installFetch();
  let r = await resolveActingAthlete("Bearer x", null, URL, KEY);
  ck("no athleteId means act as yourself", [r.ok, r.athleteId, r.reason], [true, PARENT, "self"]);
  ck("...and no parent_links lookup is made at all",
     fetchLog.some((u) => u.includes("parent_links")), false);
  installFetch();
  r = await resolveActingAthlete("Bearer x", PARENT, URL, KEY);
  ck("asking for your own id is the self path", [r.ok, r.athleteId, r.reason], [true, PARENT, "self"]);

  console.log("\n-- an approved parent may act for their child --");
  installFetch();
  r = await resolveActingAthlete("Bearer x", CHILD, URL, KEY);
  ck("approved link is honoured", [r.ok, r.athleteId, r.reason], [true, CHILD, "parent_managed"]);
  ck("...and the caller is still reported as the parent", r.callerId, PARENT);
  ck("...the link query filtered on approved_at",
     fetchLog.some((u) => u.includes("approved_at=not.is.null")), true);
  ck("...and on BOTH ids, not just the athlete",
     fetchLog.some((u) => u.includes(`parent_id=eq.${PARENT}`) && u.includes(`athlete_id=eq.${CHILD}`)), true);

  console.log("\n-- attacks --");
  installFetch();
  r = await resolveActingAthlete("Bearer x", STRANGER, URL, KEY);
  ck("an UNRELATED athlete's id is refused", r.ok, false);
  ck("...with no athlete id returned at all", r.athleteId, null);
  ck("...and a nameable reason", r.reason, "not_linked_or_unapproved");

  installFetch();
  r = await resolveActingAthlete("Bearer x", UNAPPROVED, URL, KEY);
  ck("an UNAPPROVED link is refused", [r.ok, r.reason], [false, "not_linked_or_unapproved"]);

  installFetch({ authOk: false });
  r = await resolveActingAthlete("Bearer forged", CHILD, URL, KEY);
  ck("a forged token cannot act for anyone", [r.ok, r.reason], [false, "unauthenticated"]);
  ck("...and never even reaches the link lookup",
     fetchLog.some((u) => u.includes("parent_links")), false);

  installFetch();
  r = await resolveActingAthlete("Bearer x", "'; drop table profiles;--", URL, KEY);
  ck("a non-uuid athlete id is rejected before any query", [r.ok, r.reason], [false, "malformed_athlete_id"]);
  ck("...and never reaches the database", fetchLog.some((u) => u.includes("parent_links")), false);

  console.log("\n-- failures must not become permission --");
  installFetch({ linkThrows: true });
  r = await resolveActingAthlete("Bearer x", CHILD, URL, KEY);
  ck("a thrown lookup fails CLOSED", r.ok, false);
  installFetch({ linkOk: false });
  r = await resolveActingAthlete("Bearer x", CHILD, URL, KEY);
  ck("a non-2xx lookup fails CLOSED", r.ok, false);
  ck("hasApprovedLink refuses with a missing parent id", await hasApprovedLink(null, CHILD, URL, KEY), false);
  ck("hasApprovedLink refuses with a missing athlete id", await hasApprovedLink(PARENT, null, URL, KEY), false);

  console.log("\n-- api/scout.js actually uses it --");
  ck("scout imports the shared module", /import \{ resolveActingAthlete \} from "\.\/_acting-for\.js"/.test(SCOUT), true);
  ck("the athleteId comes from the body but is passed through the check",
     /resolveActingAthlete\(\s*req\.headers\.authorization,\s*body && typeof body\.athleteId === "string" \? body\.athleteId : null/.test(SCOUT), true);
  ck("a rejected request is a 403, not a silent fallback to self",
     /return res\.status\(403\)\.json\(\{ error: "You don't have access to that athlete\." \}\)/.test(SCOUT), true);
  ck("unauthenticated is still a 401", /acting\.reason === "unauthenticated"[\s\S]{0,120}401/.test(SCOUT), true);
  ck("userId is taken from the RESOLVED athlete, not the body", /userId = acting\.athleteId;/.test(SCOUT), true);
  // If anything downstream read body.athleteId directly it would bypass the
  // whole check, so there must be exactly one reference to it in real code.
  // (Comments mentioning it are fine and are excluded here.)
  const scoutCodeLines = SCOUT.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l));
  ck("body.athleteId is read exactly once, inside the check",
     scoutCodeLines.filter((l) => l.includes("body.athleteId")).length, 1);

  console.log("\n-- the client can reach every part of the child's account --");
  ck("GolszApp tracks who is being managed", /const \[actingFor, setActingFor\] = useState\(null\)/.test(APP), true);
  ck("MY ATHLETES has a real Manage action", /onManage=\{manageAthlete\}/.test(APP), true);
  ck("a Managing banner exists", /function ManagingBanner\(/.test(APP), true);
  ck("...naming the athlete", /t\("managing_banner"\)\.replace\("\{name\}", name/.test(APP), true);
  ck("...with a way back out", /onExit=\{exitManaging\}/.test(APP), true);
  // Both layouts (desktop sidebar + mobile) render the app; a prop threaded
  // through only one of them is a bug that only shows on one screen size.
  ck("Home receives actingFor in both layouts",
     (APP.match(/<HomeTab onNavigate=\{go\} plan=\{userPlan\} onUpgrade=\{openUpgrade\} actingFor=/g) || []).length, 2);
  ck("Scout receives actingFor in both layouts",
     (APP.match(/<Scout onGoToProfile[\s\S]{0,140}?actingFor=\{actingFor\}/g) || []).length, 2);
  ck("Plan receives actingFor in both layouts",
     (APP.match(/<Targets plan=\{userPlan\} onUpgrade=\{openUpgrade\} actingFor=/g) || []).length, 2);
  ck("Passport enters manage mode in both layouts",
     (APP.match(/manageMode=\{!!actingFor\}/g) || []).length, 2);

  console.log("\n-- manage mode is EDIT access, not view access --");
  ck("Passport distinguishes manage mode from viewing a stranger",
     /const viewingOther = !!\(viewUserId && uid && viewUserId !== uid && !manageMode\)/.test(APP), true);
  ck("...and writes target the child's row", /const editId = manageMode && viewUserId \? viewUserId : uid;/.test(APP), true);
  ck("the profile editor writes the managed athlete", /const writeId = targetId \|\| user\.id;/.test(APP), true);
  ck("...for profiles", /\.from\("profiles"\)\.update\(\{ full_name: name, occupation: form\.occupation \|\| null \}\)\.eq\("id", writeId\)/.test(APP), true);
  ck("...and for athletes", /bio: \(form\.bio \|\| ""\)\.trim\(\)\.slice\(0, 600\) \|\| null,\s*\}\)\.eq\("id", writeId\);/.test(APP), true);
  ck("highlights become editable in manage mode", /viewUserId === uid \|\| manageMode\)\);\n  const targetId = viewUserId \|\| uid;/.test(APP), true);
  ck("Scout talks about the child, not the parent", /const who = actingFor \? actingFor\.id : user\.id;/.test(APP), true);
  ck("...and sends the id for the server to verify", /athleteId: actingFor \? actingFor\.id : null/.test(APP), true);
  ck("switching athlete reloads the conversation", /\}, \[actingFor && actingFor\.id\]\);/.test(APP), true);
  ck("...and clears the previous transcript first", /setMsgs\(null\);\n    setLoaded\(false\);/.test(APP), true);
  // Share is withheld deliberately, and the reason is recorded next to it.
  ck("Share is hidden in manage mode (the RPC targets auth.uid())",
     /\{!manageMode && <button onClick=\{sharePassport\}/.test(APP), true);

  console.log("\n-- P1-4: a Parent account is no longer a dead end --");
  ck("the app knows whether this is a parent account", /setIsParentAccount\(!!\(me && me\.occupation === "Parent"\)\)/.test(APP), true);
  // Excludes the stale comment in Passport that still says it is "not
  // rendered here" — that remains true of Passport; Home renders it now.
  const appCodeLines = APP.split("\n").filter((l) => !/^\s*(\/\/|\*|<!--)/.test(l));
  ck("FamilyAccess is finally rendered, in both layouts",
     appCodeLines.filter((l) => l.includes("<FamilyAccess />")).length, 2);
  ck("...only when a parent has no linked athlete yet",
     /isParentAccount && linkedChildren && linkedChildren\.length === 0/.test(APP), true);

  console.log("\n-- P1-5: no silently orphaned child --");
  ck("deletion looks for managed children first", /parent_links\?parent_id=eq\.\$\{userId\}&approved_at=not\.is\.null/.test(DELETE_ACCOUNT), true);
  ck("...restricted to accounts nobody can sign in to", /parent_managed=is\.true/.test(DELETE_ACCOUNT), true);
  ck("it REFUSES rather than orphaning", /code: "managed_children_present"/.test(DELETE_ACCOUNT), true);
  ck("...with a 409, not a silent success", /return res\.status\(409\)/.test(DELETE_ACCOUNT), true);
  ck("...naming the athletes so the choice is informed", /children: managedChildren\.map/.test(DELETE_ACCOUNT), true);
  ck("a second explicit flag is required to proceed", /body\.confirm_delete_children !== true/.test(DELETE_ACCOUNT), true);
  ck("children are deleted BEFORE the parent", DELETE_ACCOUNT.indexOf("for (const child of managedChildren)") < DELETE_ACCOUNT.indexOf('await deleteStoragePrefix(supaUrl, serviceKey, "avatars", userId);'), true);
  ck("a failed child delete aborts the whole thing", /Couldn't delete a linked athlete's account, so nothing was deleted/.test(DELETE_ACCOUNT), true);
  ck("a failed lookup fails CLOSED, not open", /return res\.status\(503\)/.test(DELETE_ACCOUNT), true);
  ck("the client surfaces the names before the second confirm", /blockingChildren\.map\(\(c\) => \(/.test(APP), true);
  ck("...and only then sends the flag", /deleteAccount\(true\)/.test(APP), true);
  ck("the ordinary delete never sets it", /onClick=\{\(\) => deleteAccount\(false\)\}/.test(APP), true);

  console.log("\n-- localization --");
  for (const lang of ["en", "fr", "es", "el"]) {
    const i = APP.indexOf("\n  " + lang + ": {");
    const block = APP.slice(i, i + 60000);
    const keys = ["managing_banner", "managing_exit", "managing_manage", "managing_hint",
      "delete_children_title", "delete_children_body", "delete_children_confirm",
      "parent_no_athletes_title"];
    ck(`${lang} defines every parent-management key`, keys.filter((k) => !block.includes(k + ":")), []);
  }

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})();
