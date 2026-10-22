// ADMIN SECOND FACTOR AND ADMIN ROLES (migrations 161 and 162, the Admin Panel
// gate, api/admin-user-action.js).
//
// Until now every admin held the same full power on the strength of one boolean
// and a password. This suite holds the pieces that make that no longer true:
//
//   1. Migration 161 re-creates protect_profile_columns() from migration 126's
//      body. A copy that drifts is a silent regression in the one trigger that
//      stops athletes granting themselves plans and admin, so the new function
//      is compared with 126's TEXT: strip the fenced insertions and nothing
//      else may differ.
//   2. Migration 162 changes is_admin() by exactly one clause.
//   3. Both are recorded as NOT YET APPLIED in the ledger (they are run by
//      hand), and the probe knows how to tell.
//   4. The Admin Panel loads NOTHING until the session passed its second
//      factor, and every owner-only control sits behind isOwner while the
//      moderator controls do not. A control "hidden" by a comment is a bug.
//   5. The panel survives migration 161 not having run.
//
// The API half (aal2, owner-only delete, the missing-column fallback) is
// behaviour, so it lives in test_admin_user_action.cjs, which runs the real
// handler.

const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(REPO, f), "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (ok) p++; else { f++; console.log(`FAIL  ${l}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(e)}`); }
};

const M126 = read("supabase-migration-126-audit-fixes.sql");
const M161 = read("supabase-migration-161-admin-roles.sql");
const M162 = read("supabase-migration-162-admin-requires-mfa.sql");
const SCHEMA = read("supabase-schema.sql");
const PROBE = read("supabase-probe-migration-state.sql");
const APP = read("golsz-app.html");

const fnText = (src, name) => {
  const s = src.indexOf(`create or replace function ${name}`);
  if (s < 0) return null;
  return src.slice(s, src.indexOf("\n$$;", s) + 4);
};

/* ---------- 1. 161 == 126 + the fenced insertions ---------- */

const fn126 = fnText(M126, "protect_profile_columns()");
const fn161 = fnText(M161, "protect_profile_columns()");
ck("migration 126 still defines the function this one is copied from", !!fn126, true);
ck("migration 161 defines it", !!fn161, true);
const stripFences = (t) => t.replace(/ *-- >>> 161[^\n]*\n[\s\S]*?-- <<< 161\n?/g, "").replace(/\n{3,}/g, "\n\n");
const normalise = (t) => t.replace(/\n{2,}/g, "\n").trim();
ck("161's function, with its fenced insertions removed, is migration 126's function byte for byte",
   normalise(stripFences(fn161)), normalise(fn126));
ck("there are exactly two fenced insertions", (fn161.match(/-- >>> 161/g) || []).length, 2);
ck("...and every opening fence is closed", (fn161.match(/-- <<< 161/g) || []).length, 2);

const inserted = (fn161.match(/-- >>> 161[\s\S]*?-- <<< 161/g) || []).join("\n");
for (const col of ["is_admin", "admin_role", "plan", "full_access", "ai_unlimited", "stripe_customer_id"]) {
  ck(`a moderator's write to ${col} is reverted`, new RegExp(`new\\.${col} := old\\.${col};`).test(inserted), true);
}
ck("...only for a caller who is an admin but not an owner",
   /and is_admin\(\) and not is_admin_owner\(\)/.test(inserted), true);
ck("...and never for the service role, the SQL Editor or the privileged RPCs",
   /not \(auth\.role\(\) is null or auth\.role\(\) = 'service_role' or v_privileged\)/.test(inserted), true);
ck("a new admin is a moderator (least privilege), a non-admin has no role",
   /new\.admin_role := 'moderator'/.test(inserted) && /new\.admin_role := null/.test(inserted), true);
ck("the last owner cannot be removed", /cannot remove the last owner/.test(inserted), true);
// The owner-only pin must run AFTER the allowlist block and BEFORE return, or a
// moderator's write passes. Fence order is the whole point.
const iPin = fn161.indexOf("-- >>> 161 owner-only columns");
const iAllow = fn161.indexOf("new := jsonb_populate_record(new, v_new);");
const iDerive = fn161.indexOf("new.verified_tier := case new.plan");
const iRole = fn161.indexOf("-- >>> 161 role follows flag");
const iRet = fn161.lastIndexOf("return new;");
ck("the owner-only pin comes after the allowlist, before the plan derivation",
   iAllow > 0 && iPin > iAllow && iPin < iDerive, true);
ck("the role normalisation comes after the derivation, before return", iRole > iDerive && iRole < iRet, true);

ck("the backfill runs BEFORE the trigger function is replaced (as the SQL Editor, exempt)",
   M161.indexOf("update profiles set admin_role = 'owner'") > 0 &&
   M161.indexOf("update profiles set admin_role = 'owner'") < M161.indexOf("create or replace function protect_profile_columns()"), true);
ck("...and only touches admins", /update profiles set admin_role = 'owner' where is_admin = true and admin_role is null;/.test(M161), true);
ck("the column is constrained to the two roles", /check \(admin_role in \('owner', 'moderator'\)\)/.test(M161), true);
ck("the whole file is one transaction", /^begin;$/m.test(M161) && /^commit;$/m.test(M161), true);
ck("is_admin_owner is not executable by anon or public",
   /revoke execute on function is_admin_owner\(\) from public, anon;/.test(M161), true);
ck("...and the trigger binding is re-asserted",
   /create trigger protect_profile_columns_trigger\s+before update on profiles/.test(M161), true);

/* ---------- 2. 162 changes is_admin() by one clause ---------- */

const is126 = fnText(M126, "is_admin()");
const is162 = fnText(M162, "is_admin()");
ck("126's is_admin() is what 162 replaces", !!is126 && !!is162, true);
ck("162 keeps 126's lookup exactly",
   is162.includes("select coalesce((select is_admin from profiles where id = auth.uid()), false)"), true);
ck("...and adds exactly the aal2 condition",
   is162.includes("and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'"), true);
ck("...with the volatility and search_path 126 gave it",
   /returns boolean language sql stable security definer set search_path to 'public'/.test(is162), true);
ck("162 warns, in the file, not to run it before enrolling",
   /DO NOT RUN THIS BEFORE YOU HAVE ENROLLED/.test(M162), true);
ck("...and says how to recover a lost authenticator", /delete from auth\.mfa_factors/.test(M162), true);

/* ---------- 3. ledger and probe ---------- */

for (const [n, file, src] of [[161, "161", M161], [162, "162", M162]]) {
  ck(`${file} opts out of the ledger guard with the exact marker`, src.includes("*** NOT YET APPLIED ***"), true);
  ck(`${file} is recorded as pending in supabase-schema.sql`,
     new RegExp(`-- ${n} — NOT YET APPLIED`).test(SCHEMA), true);
}
ck("the probe checks the 161 column, function and trigger, and the 162 clause",
   ["profiles.admin_role exists", "is_admin_owner() exists", "cannot remove the last owner", "aal2"].every((x) => PROBE.includes(x)), true);

/* ---------- 4. the panel: nothing loads before the second factor ---------- */

const apStart = APP.indexOf("function AdminPanel({ onBack }) {");
const apEnd = APP.indexOf("\nfunction ", apStart + 40);
const AP = APP.slice(apStart, apEnd);
ck("found the Admin Panel source", AP.length > 20000, true);

const effects = [...AP.matchAll(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\);/g)].map((m) => m[0]);
ck("the panel has exactly two effects: the auth check and the gated load", effects.length, 2);
const [authEffect, loadEffect] = effects;
ck("the auth-check effect fetches no admin data",
   !/loadStats\(|loadUsers\(|loadAuditLog\(|loadModerationQueue\(|loadAppeals\(|loadErrorLog\(/.test(authEffect || ""), true);
ck("...it sets the role and the second-factor state instead",
   /setAdminRole\(/.test(authEffect) && /setMfa\(await adminMfaState\(\)\)/.test(authEffect), true);
ck("the load effect returns early unless authorized AND mfa is ok",
   /if \(!authorized \|\| mfa !== "ok"\) return;/.test(loadEffect || ""), true);
ck("...and re-runs when either changes", /\[authorized, mfa\]\);$/.test(loadEffect || ""), true);
ck("every first-load call is inside that one gated effect",
   ["loadStats", "loadUsers", "loadAuditLog", "loadModerationQueue", "loadVerificationRequests", "loadAppeals", "loadKnowledge", "loadErrorLog", "loadFaqMisses"]
     .every((fn) => (loadEffect || "").includes(fn + "();")), true);

// Rules of hooks: no hook below an early return.
const iEarly = AP.indexOf('if (mfa === "checking") return');
const iGate = AP.indexOf('if (mfa !== "ok") return <AdminMfa');
ck("the gate renders AdminMfa for every state but ok", iGate > iEarly && iEarly > 0, true);
ck("no hook is called below the gate (rules of hooks)",
   /\buse(State|Effect|Memo|Ref|Callback)\(/.test(AP.slice(iGate)), false);
ck("a failed state read lands on the unavailable screen, not on an open panel",
   /return "error"/.test(APP.slice(APP.indexOf("async function adminMfaState"), apStart)) &&
   !/return "ok"[^;]*catch/.test(APP.slice(APP.indexOf("async function adminMfaState"), apStart)), true);

const MFA = APP.slice(APP.indexOf("function AdminMfa("), apStart);
ck("the enrolment screen enrols a TOTP factor", /mfa\.enroll\(\{ factorType: "totp"/.test(MFA), true);
ck("...verifies with challengeAndVerify (which upgrades THIS session to aal2)", /mfa\.challengeAndVerify\(\{ factorId, code/.test(MFA), true);
ck("...clears an abandoned unverified enrolment first (else the next enroll fails)",
   /status === "unverified"[\s\S]{0,120}mfa\.unenroll\(/.test(MFA), true);
ck("...asks for a 6-digit numeric code a password manager can fill",
   /inputMode="numeric"/.test(MFA) && /autoComplete="one-time-code"/.test(MFA) && /maxLength=\{6\}/.test(MFA), true);
ck("...reaches the database for nothing else (no from/rpc in the gate)", /sb\.from\(|sb\.rpc\(/.test(MFA), false);
ck("...and carries the shared stylesheet like every top-level screen", /<style>\{CSS\}<\/style>/.test(MFA), true);
ck("a wrong code says so and clears the field", /setMsg\("bad"\); setCode\(""\)/.test(MFA), true);

/* ---------- 4b. the gate's decision, run for real ---------- */

{
  const s0 = APP.indexOf("async function adminMfaState() {");
  const e0 = APP.indexOf("\n}\n", s0) + 3;
  const src = APP.slice(s0, e0);
  ck("extracted the real adminMfaState from the source", src.length > 100 && src.startsWith("async function adminMfaState"), true);
  const mk = (auth) => new Function("sb", "console", src + "\nreturn adminMfaState;")(auth, { error() {} });
  const aal = (data, error) => ({ auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data, error: error || null }) } } });
  const run = async (sb) => mk(sb)();
  (async () => {
    ck("aal2 now: the panel opens", await run(aal({ currentLevel: "aal2", nextLevel: "aal2" })), "ok");
    ck("aal1 with an enrolled factor: ask for the code", await run(aal({ currentLevel: "aal1", nextLevel: "aal2" })), "challenge");
    ck("aal1 and nothing enrolled: enrol", await run(aal({ currentLevel: "aal1", nextLevel: "aal1" })), "enrol");
    ck("an error from Auth is NOT an open panel", await run(aal(null, { message: "boom" })), "error");
    ck("an empty answer is NOT an open panel", await run(aal(null)), "error");
    ck("a client with no mfa API is NOT an open panel", await run({ auth: {} }), "error");
    ck("no client at all is NOT an open panel", await run(null), "error");
    ck("a thrown error is NOT an open panel",
       await run({ auth: { mfa: { getAuthenticatorAssuranceLevel: async () => { throw new Error("network"); } } } }), "error");
    ck("only the aal2 answer ever yields ok",
       (await Promise.all([
         run(aal({ currentLevel: "aal1", nextLevel: "aal2" })), run(aal({ currentLevel: "aal1", nextLevel: "aal1" })),
         run(aal({ currentLevel: null, nextLevel: null })), run(aal({})),
       ])).includes("ok"), false);
    finish();
  })();
}

/* ---------- 5. roles in the UI ---------- */

ck("isOwner comes from the role the database returned", /const isOwner = adminRole === "owner";/.test(AP), true);
// Structural, not a text window: the three owner controls and the role toggle
// share one `{isOwner && ( <> ... </> )}` block, so each call site must sit
// BETWEEN that block's opener and its closing fragment. The plan select and the
// delete button each carry their own isOwner guard on the element itself.
const ownerOpen = AP.indexOf("{isOwner && (\n                      <>");
const ownerClose = AP.indexOf("</>\n                    )}", ownerOpen);
ck("found the shared owner block", ownerOpen > 0 && ownerClose > ownerOpen, true);
const sitesOf = (name) => [...AP.matchAll(new RegExp(`\\b${name}\\(u\\.id`, "g"))].map((m) => m.index);
for (const name of ["setUserAdmin", "setUserAiUnlimited", "setUserFullAccess", "setUserRole"]) {
  const at = sitesOf(name);
  ck(`${name} is only reachable inside the owner block (${at.length} call site(s))`,
     at.length > 0 && at.every((i) => i > ownerOpen && i < ownerClose), true);
}
{
  const at = sitesOf("setUserPlan");
  ck("setUserPlan sits in the owner branch of its ternary (1 call site)",
     at.length === 1 && AP.slice(Math.max(0, at[0] - 400), at[0]).includes("{isOwner ? ("), true);
  const del = sitesOf("deleteUser");
  ck("deleteUser is behind its own isOwner guard (1 call site)",
     del.length === 1 && AP.slice(Math.max(0, del[0] - 160), del[0]).includes("{isOwner && u.id !== myUid && ("), true);
}
// The positive control for the window: moderator controls must NOT be behind
// isOwner, or the roles are decoration and a moderator cannot moderate.
const bansAt = AP.indexOf("setUserBanned(u.id");
const delAt = AP.indexOf("{isOwner && u.id !== myUid && (");
ck("ban and unban stay available to a moderator (not inside an owner guard)",
   bansAt > 0 && AP.slice(bansAt - 120, bansAt).indexOf("isOwner") === -1, true);
ck("...so does the verified-badge control",
   AP.slice(AP.indexOf("setUserVerifiedTier(u.id") - 120, AP.indexOf("setUserVerifiedTier(u.id")).indexOf("isOwner") === -1, true);
ck("delete is owner-only AND still never offered on your own account", delAt > 0, true);
ck("the plan is shown, not editable, to a moderator", /title=\{t\("admin_owner_only"\)\}/.test(AP), true);
ck("a failed role or admin write is no longer silent",
   (AP.match(/alert\(t\("admin_action_failed"\)\)/g) || []).length >= 2, true);

/* ---------- 6. the panel does not outrun migration 161 ---------- */

ck("the profile read falls back without admin_role when the column is missing",
   /select\("is_admin, admin_role"\)[\s\S]{0,300}if \(profErr\) \{[\s\S]{0,200}select\("is_admin"\)/.test(authEffect), true);
ck("...and treats that admin as an owner (today's behaviour)", /rolesLive \? .* : "owner"/.test(authEffect), true);
ck("the main users select never names admin_role",
   !/select\("id, full_name, plan[^"]*admin_role/.test(AP), true);
ck("the role read is its own failure-tolerant query",
   /select\("id, admin_role"\)\.eq\("is_admin", true\)[\s\S]{0,200}if \(!roles\.error\)/.test(AP), true);

/* ---------- 7. strings in all four languages ---------- */

const KEYS = ["admin_mfa_title", "admin_mfa_enrol_intro", "admin_mfa_enrol_button", "admin_mfa_secret", "admin_mfa_code_label",
  "admin_mfa_verify", "admin_mfa_challenge_intro", "admin_mfa_bad_code", "admin_mfa_unavailable", "admin_role_owner",
  "admin_role_moderator", "admin_make_owner", "admin_make_moderator", "admin_owner_only", "admin_action_failed"];
const dictStarts = ["  en: {", "  fr: {", "  es: {", "  el: {"].map((h) => APP.indexOf("\n" + h + "\n"));
ck("found the four dictionaries", dictStarts.every((i) => i > 0) && dictStarts.every((v, i, a) => i === 0 || v > a[i - 1]), true);
const dictEnds = dictStarts.map((s) => APP.indexOf("\n  },\n", s));
const dicts = dictStarts.map((s, i) => APP.slice(s, dictEnds[i]));
for (const k of KEYS) {
  const present = dicts.map((d) => new RegExp(`\\b${k}: "`).test(d));
  ck(`${k} exists in en, fr, es and el`, present, [true, true, true, true]);
}
// An English sentence pasted into another language's block is exactly what a
// parity check cannot see (ADS-BUILD-ORDER, Phase 2). Compare the intro text.
const grab = (d, k) => (new RegExp(`\\b${k}: "((?:[^"\\\\]|\\\\.)*)"`).exec(d) || [])[1];
for (const k of ["admin_mfa_title", "admin_mfa_enrol_intro", "admin_mfa_challenge_intro", "admin_mfa_bad_code", "admin_owner_only", "admin_action_failed"]) {
  const en = grab(dicts[0], k);
  ck(`${k}: fr, es and el are translated, not copies of the English`, [1, 2, 3].map((i) => grab(dicts[i], k) !== en), [true, true, true]);
}

function finish() {
  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
}
