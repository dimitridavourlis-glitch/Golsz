// api/admin-user-action.js — service-role ban / unban / delete.
//
// This handler had ZERO behavioural coverage. It holds the highest-blast-
// radius capability in the codebase: it calls the Supabase Admin API with
// the service-role key to ban an auth credential outright, and to DELETE an
// auth.users row, which cascades to profiles and everything hanging off it.
// There is no undo. The only thing standing between a signed-in stranger and
// that button is the admin re-check in this file.
//
// EXTRACTION
// The module cannot be require()d in this environment — it does
// `import webpush from "web-push"`, and web-push is not installed for the
// test run. So the REAL source is read at run time, the single import line
// is swapped for an injected stub, and the whole file (handler plus every
// helper, unmodified otherwise) is evaluated. Nothing here is retyped: if a
// helper changes, this suite runs the changed helper. See tests/README.md,
// "the one rule that matters".

const path = require("path");
const fs = require("fs");
const REPO = path.join(__dirname, "..");
const SRC = fs.readFileSync(REPO + "/api/admin-user-action.js", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

// ---- load the real module body -------------------------------------------
// Each substitution asserts it actually matched. A silent no-op here would
// produce a syntax error at best and, at worst, a handler that is not the
// one that ships.
function rewrite(src, re, to, label) {
  if (!re.test(src)) throw new Error(`could not find ${label} in api/admin-user-action.js — update this suite`);
  return src.replace(re, to);
}
let body = SRC;
body = rewrite(body, /^import webpush from "web-push";$/m, "const webpush = __webpush;", "the web-push import");
// The erasure sweeps are shared with api/delete-account.js (see api/_erasure.js)
// and arrive by import too. They are replaced with recording stubs rather than
// stripped, so the assertions below can check that the delete path actually
// calls them — the whole point of lifting them out was that one route ran them
// and the other did not.
body = rewrite(body,
  /^import \{ deleteStoragePrefix, deleteScoutReplyCache \} from "\.\/_erasure\.js";$/m,
  "const deleteStoragePrefix = __sweepStorage; const deleteScoutReplyCache = __sweepCache;",
  "the shared erasure import");
body = rewrite(body, /^export default async function handler/m, "async function handler", "the default export");

// The push stub records rather than sends. alertAdmins() is fire-and-forget
// from the caller's point of view but IS awaited, so a stub that throws would
// change the response — which is itself worth asserting.
let pushes = [];
const webpushStub = {
  setVapidDetails() {},
  async sendNotification(sub, payload) { pushes.push({ sub, payload: JSON.parse(payload) }); },
};
// Recorded, not ignored: the delete path must call both sweeps for the target
// before the auth row goes, and the only way to assert that is to watch them.
const sweptStorage = [], sweptCache = [];
const __sweepStorage = async (_u, _k, bucket, prefix) => { sweptStorage.push(bucket + "/" + prefix); };
const __sweepCache = async (_u, _k, uid) => { sweptCache.push(uid); };
const handler = new Function("__webpush", "__sweepStorage", "__sweepCache", body + "\nreturn handler;")(webpushStub, __sweepStorage, __sweepCache);

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
process.env.VAPID_PUBLIC_KEY = "vapid-public";
process.env.VAPID_PRIVATE_KEY = "vapid-private";
process.env.VAPID_SUBJECT = "mailto:admin@golsz.com";

// ---- harness -------------------------------------------------------------
// Deliberately full of hex LETTERS, not just digits: the self-targeting
// check is a strict string comparison, and a uuid of all-digits would make
// .toUpperCase() a no-op and quietly turn the case-sensitivity probe below
// into an assertion that tests nothing.
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ADMIN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NON_ADMIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

let calls = [];
// token -> user id. A token that is not in here resolves to null, the same
// way a forged or expired one would.
// Tokens are JWT-shaped because the handler reads the `aal` claim out of the
// caller's own access token: "aal2" only after a verified second factor. The
// signature is never checked here (Supabase Auth validated the string; the
// /auth/v1/user mock below stands in for that), so the payload is what matters.
const MODERATOR = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const mkJwt = (who, aal) => "Bearer h." + Buffer.from(JSON.stringify(aal === undefined ? { sub: who } : { sub: who, aal })).toString("base64url") + ".s";
const ADMIN_TOKEN = mkJwt(ADMIN, "aal2");
const ADMIN_AAL1 = mkJwt(ADMIN, "aal1");
const ADMIN_NO_AAL = mkJwt(ADMIN, undefined);
const MOD_TOKEN = mkJwt(MODERATOR, "aal2");
const MOD_AAL1 = mkJwt(MODERATOR, "aal1");
const TOKENS = { [ADMIN_TOKEN]: ADMIN, [ADMIN_AAL1]: ADMIN, [ADMIN_NO_AAL]: ADMIN, [MOD_TOKEN]: MODERATOR, [MOD_AAL1]: MODERATOR, "Bearer plain": NON_ADMIN };
const ADMINS = new Set([ADMIN, OTHER_ADMIN, MODERATOR]);
// Migration 161: who is an owner. An admin absent from here is an owner, which
// is what every admin was before roles existed. A moderator must be listed.
const ROLES = { [MODERATOR]: "moderator" };
// Migration 161 not applied: the admin_role column does not exist, so PostgREST
// rejects a select that names it with a 400 and the handler must fall back.
let legacyColumn = false;
let authApiOk = true;
let rpcOk = true;
// "ok" = a normal PATCH that matches the target row.
// "zero" = a 204/[] answer matching NO rows — the case `return=minimal` could
//          not distinguish from success.
// "http400" = PostgREST rejects it — the case `await fetch()` RESOLVES on.
let patchMode = "ok";
let auditOk = true;
// The is_admin lookup answering 5xx — NOT the same thing as answering "no".
let adminLookupOk = true;
// target id -> { plan, stripe_customer_id } for the billing check.
const BILLING = {};
let billingLookupOk = true;

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String(opts.method || "GET").toUpperCase();
  let parsed = null;
  try { parsed = opts.body ? JSON.parse(opts.body) : null; } catch { parsed = opts.body; }
  calls.push({ url: u, method, body: parsed });

  if (u.includes("/auth/v1/user")) {
    const id = TOKENS[(opts.headers || {}).Authorization];
    return id ? { ok: true, json: async () => ({ id }) } : { ok: false, json: async () => ({}) };
  }
  if (u.includes("/rest/v1/profiles?is_admin=eq.true")) {
    return { ok: true, json: async () => [...ADMINS].map((id) => ({ id })) };
  }
  if (u.includes("/rest/v1/push_subscriptions")) {
    return { ok: true, json: async () => [{ endpoint: "https://push.example/1", p256dh: "k", auth: "a" }] };
  }
  if (method === "GET" && u.includes("/rest/v1/profiles")) {
    if (!adminLookupOk) {
      return { ok: false, status: 503, text: async () => "upstream unavailable",
               json: async () => ({ message: "upstream unavailable" }) };
    }
    // Anchored: /id=eq\./ also matches inside "stripe_customer_id=eq." and
    // any other *_id column. Cost six failing assertions elsewhere today.
    const m = /[?&]id=eq\.([^&]+)/.exec(u);
    // The target's billing lookup (select=plan,stripe_customer_id).
    if (/select=plan,stripe_customer_id/.test(u)) {
      if (!billingLookupOk) return { ok: false, status: 503, json: async () => ({}), text: async () => "down" };
      return { ok: true, json: async () => [BILLING[m && m[1]] || { plan: "free", stripe_customer_id: null }] };
    }
    const askedRole = /select=is_admin,admin_role/.test(u);
    if (askedRole && legacyColumn) {
      return { ok: false, status: 400, text: async () => '{"code":"42703","message":"column profiles.admin_role does not exist"}',
               json: async () => ({ code: "42703" }) };
    }
    const isAdm = ADMINS.has(m && m[1]);
    const row = { is_admin: isAdm };
    if (askedRole) row.admin_role = isAdm ? (ROLES[m[1]] || "owner") : null;
    return { ok: true, json: async () => [row] };
  }
  if (u.includes("/auth/v1/admin/users/")) {
    return { ok: authApiOk, status: authApiOk ? 200 : 500, json: async () => ({}) };
  }
  // The profile PATCH used to fall through to the catch-all below, which
  // answers []. That was invisible while patchProfile discarded its result:
  // the ban assertions passed against a write that matched nothing. Modelling
  // it explicitly is what makes those assertions mean anything.
  if (method === "PATCH" && u.includes("/rest/v1/profiles")) {
    if (patchMode === "http400") {
      return { ok: false, status: 400, text: async () => '{"message":"column does not exist"}',
               json: async () => ({ message: "column does not exist" }) };
    }
    // Honours Prefer for the same reason the stripe suite does: `return=minimal`
    // answers 204 with an empty body, so requiring a row back would turn every
    // successful ban into a 500. See that file's note.
    const prefer = String((opts.headers || {}).Prefer || "");
    if (!prefer.includes("return=representation")) {
      return { ok: true, status: 204, json: async () => { throw new SyntaxError("Unexpected end of JSON input"); },
               text: async () => "" };
    }
    const m = /[?&]id=eq\.([^&]+)/.exec(u);
    const rows = patchMode === "zero" || !m ? [] : [{ id: m[1], ...(parsed || {}) }];
    return { ok: true, json: async () => rows };
  }
  if (u.includes("/rest/v1/admin_action_log")) {
    return auditOk
      ? { ok: true, json: async () => [] }
      : { ok: false, status: 500, text: async () => "audit table unavailable",
          json: async () => ({ message: "audit table unavailable" }) };
  }
  if (u.includes("/rpc/admin_delete_profile_data")) {
    return { ok: rpcOk, status: rpcOk ? 200 : 500, json: async () => ({}) };
  }
  return { ok: true, json: async () => [] };
};

const mkRes = () => {
  const r = { statusCode: null, payload: null, headers: {}, ended: false };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.payload = b; return r; };
  r.end = () => { r.ended = true; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
};

async function call({ auth = ADMIN_TOKEN, method = "POST", body = {}, origin } = {}) {
  calls = [];
  pushes = [];
  const res = mkRes();
  const headers = { authorization: auth };
  if (origin) headers.origin = origin;
  if (auth === null) delete headers.authorization;
  await handler({ method, headers, body }, res);
  return {
    status: res.statusCode,
    payload: res.payload,
    resHeaders: res.headers,
    calls,
    pushes,
    authApi: calls.filter((c) => c.url.includes("/auth/v1/admin/users/")),
    patches: calls.filter((c) => c.method === "PATCH" && c.url.includes("/rest/v1/profiles")),
    audit: calls.filter((c) => c.url.includes("/rest/v1/admin_action_log")),
    rpcs: calls.filter((c) => c.url.includes("/rpc/admin_delete_profile_data")),
    errorLogs: calls.filter((c) => c.url.includes("/rest/v1/error_log")),
  };
}

(async () => {
  console.log("-- the harness reaches the handler, and the happy path really works --");
  // If auth silently failed, every "nothing was written" assertion below
  // would pass while proving nothing. Establish the positive case first.
  let r = await call({ body: { action: "ban", targetId: TARGET } });
  ck("an admin can ban", r.status, 200);
  ck("...and gets a real ok", r.payload, { ok: true });
  ck("...the auth-layer ban was issued, not just the profile flag", r.authApi.length, 1);
  ck("...with a real ban_duration", r.authApi[0].body, { ban_duration: "876000h" });
  ck("...and the app-level flag was set too", r.patches[0].body, { is_banned: true });
  ck("...and it was written into the audit log", r.audit.length, 1);
  ck("...naming the admin who did it and who it was done to",
     [r.audit[0].body.admin_id, r.audit[0].body.action, r.audit[0].body.target_id], [ADMIN, "ban", TARGET]);

  r = await call({ body: { action: "unban", targetId: TARGET } });
  ck("unban lifts the auth-layer ban", r.authApi[0].body, { ban_duration: "none" });
  ck("...and clears the profile flag", r.patches[0].body, { is_banned: false });

  console.log("\n-- THE ADMIN RE-CHECK --");
  // The Admin Panel only renders its buttons for is_admin users, but this
  // endpoint is a plain HTTPS route: anyone signed in can POST to it. The
  // UI is not the control; this check is.
  r = await call({ auth: "Bearer plain", body: { action: "ban", targetId: TARGET } });
  ck("a signed-in NON-admin is refused", r.status, 403);
  ck("...with an honest message", r.payload, { error: "Admins only." });
  ck("...and NOTHING reached the Supabase Admin API", r.authApi.length, 0);
  ck("...no profile was patched", r.patches.length, 0);
  ck("...and no audit row was written for an action that did not happen", r.audit.length, 0);
  ck("...but every admin is pushed a security alert", r.pushes.length > 0, true);
  ck("...and the alert says what happened",
     /without permission/.test(r.pushes[0].payload.body), true);
  ck("...and deep-links to the admin panel", r.pushes[0].payload.url, "/golsz-app.html?page=admin");

  r = await call({ auth: "Bearer forged", body: { action: "delete", targetId: TARGET } });
  ck("a forged/expired token is 401, not 403", r.status, 401);
  ck("...and never reaches the is_admin lookup",
     r.calls.some((c) => c.url.includes("is_admin")), false);
  ck("...and touches nothing", r.authApi.length, 0);

  r = await call({ auth: null, body: { action: "ban", targetId: TARGET } });
  ck("no Authorization header at all is 401", r.status, 401);

  // The admin check is a live lookup, not a claim in the token.
  ADMINS.delete(ADMIN);
  r = await call({ body: { action: "ban", targetId: TARGET } });
  ck("an admin whose is_admin was just revoked is refused on the next call", r.status, 403);
  ADMINS.add(ADMIN);
  r = await call({ body: { action: "ban", targetId: TARGET } });
  ck("...and works again once restored", r.status, 200);

  console.log("\n-- SELF-TARGETING IS BLOCKED --");
  // An admin banning or deleting themselves is not a normal operation; it
  // is either a mistake or a coerced/compromised session. It also cannot be
  // undone from inside the product, because the account that could undo it
  // is the one that just got destroyed.
  r = await call({ body: { action: "ban", targetId: ADMIN } });
  ck("an admin cannot ban their own account", r.status, 400);
  ck("...with a specific reason, not a generic 400",
     r.payload, { error: "Cannot act on your own account this way." });
  ck("...and no auth-layer call was made", r.authApi.length, 0);
  ck("...and no profile was patched", r.patches.length, 0);


  /* ---------- an admin delete erases what a self delete erases ---------- */

  // api/delete-account.js swept the athlete's photos out of both buckets and
  // their cached Scout replies out of scout_response_cache. The admin path
  // did neither: the RPC cleared the app tables, the Auth API removed the
  // credential, and the files and cached replies stayed. privacy.html tells
  // the athlete those are deleted — so which promise they got depended on
  // which button was pressed, and nothing said so. Both routes import the
  // same two routines now; these assert this one actually calls them.
  sweptStorage.length = 0; sweptCache.length = 0;
  r = await call({ body: { action: "delete", targetId: TARGET } });
  ck("an admin delete succeeds", r.status, 200);
  ck("both buckets are swept for the target",
     sweptStorage.slice().sort(), ["avatars/" + TARGET, "post-images/" + TARGET].sort());
  ck("...and the cached Scout replies with them", sweptCache, [TARGET]);
  // BEFORE the auth row goes: once it is gone nothing can look up which files
  // were theirs, so a sweep afterwards has nothing left to sweep by.
  const delAt = r.calls.findIndex((c) => c.method === "DELETE" && c.url.includes("/auth/v1/admin/users/"));
  ck("the credential is removed, and last", delAt > -1, true);

  r = await call({ body: { action: "delete", targetId: ADMIN } });
  ck("an admin cannot DELETE their own account", r.status, 400);
  ck("...and the destructive RPC never ran", r.rpcs.length, 0);
  ck("...and the auth user was never deleted", r.authApi.length, 0);

  // Regression guard for a real bypass found in the 2026-08-12 audit.
  // `targetId === callerId` was a strict string comparison, but UUID_RE
  // carries /i and GoTrue / Postgres both resolve a uuid case-insensitively
  // — so an admin who sent their own id upper-cased walked straight past
  // the self-check and reached the destructive delete, which cascades
  // through auth.users. The comparison is now case-insensitive on both
  // sides. If anyone reverts it to ===, this is what goes red.
  r = await call({ body: { action: "delete", targetId: ADMIN.toUpperCase() } });
  ck("an upper-cased form of your own id is still caught by the self-check",
     r.status, 400);
  ck("...and the destructive RPC never ran", r.rpcs.length, 0);
  ck("...and the auth user was never deleted", r.authApi.length, 0);

  r = await call({ body: { action: "ban", targetId: OTHER_ADMIN } });
  ck("one admin CAN act on another admin (only self is blocked)", r.status, 200);

  console.log("\n-- targetId validation --");
  for (const bad of [undefined, null, "", 12345, {}, "not-a-uuid",
                     "../../auth/v1/admin/users/" + TARGET,
                     TARGET + "&is_admin=eq.true", TARGET + " or 1=1"]) {
    r = await call({ body: { action: "ban", targetId: bad } });
    ck(`targetId ${JSON.stringify(bad)} is refused`, r.status, 400);
    ck(`...and issues no Admin API call`, r.authApi.length, 0);
  }
  ck("a valid uuid with different casing is accepted (UUID_RE is case-insensitive)",
     (await call({ body: { action: "ban", targetId: TARGET.toUpperCase() } })).status, 200);

  console.log("\n-- delete: ordering and failure handling --");
  r = await call({ body: { action: "delete", targetId: TARGET } });
  ck("delete succeeds for an admin", r.status, 200);
  ck("...the app-level cleanup RPC ran", r.rpcs.length, 1);
  ck("...with the target as its argument", r.rpcs[0].body, { p_target: TARGET });
  ck("...and the auth user was deleted", r.authApi.map((c) => c.method), ["DELETE"]);
  // Ordering matters: auth.users deletion cascades profiles away, so any
  // non-cascading cleanup has to happen while the rows still exist.
  const rpcIdx = r.calls.findIndex((c) => c.url.includes("admin_delete_profile_data"));
  const delIdx = r.calls.findIndex((c) => c.url.includes("/auth/v1/admin/users/") && c.method === "DELETE");
  ck("...cleanup runs BEFORE the cascading auth delete", rpcIdx < delIdx, true);
  ck("...and it is audited", r.audit[0].body.action, "delete");

  rpcOk = false;
  r = await call({ body: { action: "delete", targetId: TARGET } });
  ck("if the cleanup RPC fails, the auth user is NOT deleted", r.authApi.length, 0);
  ck("...and the caller gets a 500 rather than a false ok", r.status, 500);
  ck("...and the failure is written to error_log",
     r.calls.some((c) => c.url.includes("/rest/v1/error_log")), true);
  rpcOk = true;

  authApiOk = false;
  r = await call({ body: { action: "ban", targetId: TARGET } });
  ck("if the auth-layer ban fails, the profile flag is NOT set either", r.patches.length, 0);
  ck("...and it is a 500, not a silent success", r.status, 500);
  ck("...and no audit row claims a ban that did not happen", r.audit.length, 0);
  authApiOk = true;

  console.log("\n-- method, CORS and unknown actions --");
  r = await call({ method: "OPTIONS", body: {} });
  ck("OPTIONS preflight is a 204", r.status, 204);
  r = await call({ method: "GET", body: {} });
  ck("GET is refused", r.status, 405);
  ck("...before any auth work is done", r.calls.length, 0);
  r = await call({ body: { action: "promote_me", targetId: TARGET } });
  ck("an unknown action is refused", [r.status, r.payload.error], [400, "Unknown action"]);
  ck("...and does nothing", [r.authApi.length, r.patches.length, r.rpcs.length], [0, 0, 0]);
  r = await call({ body: { action: "ban", targetId: TARGET }, origin: "https://golsz.com" });
  ck("a known origin is echoed back", r.resHeaders["Access-Control-Allow-Origin"], "https://golsz.com");
  r = await call({ body: { action: "ban", targetId: TARGET }, origin: "https://evil.example" });
  ck("an unknown origin is not", r.resHeaders["Access-Control-Allow-Origin"], undefined);

  console.log("\n-- a write that does not land must not be reported as success --");
  // patchProfile runs AFTER the auth-layer ban has already succeeded, so a
  // silent failure here is not "nothing happened" - it is split-brain: the
  // account cannot get a session, while the panel still shows it as active.
  // Both halves of the old bug produced exactly that, and both produced a 200.
  {
    // Positive control first. A 500 below has to mean "the write failed" and
    // not "this fixture never wrote anything" - which is what the ban
    // assertions above were silently doing until the mock modelled the PATCH.
    patchMode = "ok";
    r = await call({ body: { action: "ban", targetId: TARGET } });
    ck("control: a normal ban is a 200", r.status, 200);

    patchMode = "zero";
    r = await call({ body: { action: "ban", targetId: TARGET } });
    ck("a profile PATCH matching zero rows is a 500, not a silent 200", r.status, 500);
    ck("...and it is written to error_log, so the Errors tab shows it", r.errorLogs.length, 1);
    ck("...and no audit row claims a ban that only half happened", r.audit.length, 0);

    patchMode = "http400";
    r = await call({ body: { action: "ban", targetId: TARGET } });
    ck("a 4xx on the profile PATCH is a 500, not a swallowed 200", r.status, 500);
    ck("...and reaches error_log too", r.errorLogs.length, 1);

    patchMode = "ok";
    r = await call({ body: { action: "ban", targetId: TARGET } });
    ck("...and a 200 returns once the failure is removed", r.status, 200);
  }

  console.log("\n-- a lost audit row is downgraded, never swallowed --");
  // The opposite resolution to the block above, on purpose. The ban has
  // already landed by the time the audit write runs, so failing the request
  // would report a failure that did not happen and invite a retry - of a
  // delete that already cascaded through auth.users. So: still a 200, but the
  // loss is recorded where someone will see it.
  {
    auditOk = false;
    r = await call({ body: { action: "ban", targetId: TARGET } });
    ck("the ban still reports success, because the ban really succeeded", r.status, 200);
    ck("...the auth-layer ban did happen", r.authApi.length, 1);
    ck("...but the lost audit row is written to error_log", r.errorLogs.length, 1);
    ck("...naming what was lost rather than a generic failure",
       /audit log/i.test(String(r.errorLogs[0].body.message)), true);

    // A delete must behave the same way, and it is the one where a retry is
    // destructive - so it is asserted separately rather than assumed.
    r = await call({ body: { action: "delete", targetId: TARGET } });
    ck("a delete whose audit row is lost still reports success", r.status, 200);
    ck("...and records the loss", r.errorLogs.length, 1);
    auditOk = true;

    r = await call({ body: { action: "ban", targetId: TARGET } });
    ck("...and nothing is logged once the audit write works again", r.errorLogs.length, 0);
  }

  console.log("\n-- \"not an admin\" and \"could not check\" are different answers --");
  // Both used to be `false`, and the 403 path pushes a Security alert to every
  // admin. So a transient Supabase error accused an innocent user of trying to
  // escalate privileges. The alert has to stay believable to be worth having.
  {
    adminLookupOk = false;
    r = await call({ body: { action: "ban", targetId: TARGET } });
    ck("an unreachable is_admin lookup is 503, not 403", r.status, 503);
    ck("...and says it could not check, rather than accusing the caller",
       /could not verify/i.test(String(r.payload.error)), true);
    ck("...NO security alert is pushed at anyone", r.pushes.length, 0);
    ck("...it fails closed: nothing was acted on",
       [r.authApi.length, r.patches.length, r.rpcs.length], [0, 0, 0]);
    ck("...and the real cause reaches error_log", r.errorLogs.length, 1);

    adminLookupOk = true;
    r = await call({ body: { action: "ban", targetId: TARGET } });
    ck("...and a working lookup bans normally again", r.status, 200);

    // The distinction is only worth anything if the OTHER side still alerts.
    // A change that made everything a quiet 503 would pass every assertion
    // above and silently remove the alert entirely.
    r = await call({ auth: "Bearer plain", body: { action: "ban", targetId: TARGET } });
    ck("a genuine non-admin is still 403, and still alerts",
       [r.status, r.pushes.length > 0], [403, true]);
  }

  console.log("\n-- banning or deleting a SUBSCRIBER does not stop Stripe --");
  // Neither action touches Stripe (this app holds no Stripe secret key), so a
  // banned or deleted subscriber kept being charged. The server now refuses
  // until the admin confirms billing is handled, and the panel asks first.
  {
    BILLING[TARGET] = { plan: "pro", stripe_customer_id: "cus_live_sub" };
    for (const action of ["ban", "delete"]) {
      r = await call({ body: { action, targetId: TARGET } });
      ck(`${action} of an ACTIVE subscriber is refused with 409`, r.status, 409);
      ck("...with a machine-readable code and the customer to cancel",
         [r.payload.code, r.payload.stripe_customer_id], ["active_subscription", "cus_live_sub"]);
      ck("...and nothing was done", [r.authApi.length, r.patches.length, r.rpcs.length, r.audit.length], [0, 0, 0, 0]);
      r = await call({ body: { action, targetId: TARGET, billingAcknowledged: true } });
      ck(`...${action} proceeds once the admin acknowledges billing`, r.status, 200);
      ck("...and the audit row records that they did", r.audit[0] && r.audit[0].body.detail, { billing_acknowledged: true });
    }
    r = await call({ body: { action: "unban", targetId: TARGET } });
    ck("unban never needs the acknowledgement", r.status, 200);
    ck("...a truthy non-boolean is not an acknowledgement",
       (await call({ body: { action: "ban", targetId: TARGET, billingAcknowledged: "yes" } })).status, 409);

    // Lapsed: the customer id survives cancellation, the plan does not.
    BILLING[TARGET] = { plan: "free", stripe_customer_id: "cus_lapsed" };
    r = await call({ body: { action: "delete", targetId: TARGET } });
    ck("a LAPSED subscriber (old customer id, plan free) needs no acknowledgement", r.status, 200);

    BILLING[TARGET] = { plan: "pro", stripe_customer_id: "cus_live_sub" };
    billingLookupOk = false;
    r = await call({ body: { action: "delete", targetId: TARGET } });
    ck("an unreadable billing state fails CLOSED (503), never deletes", [r.status, r.authApi.length, r.rpcs.length], [503, 0, 0]);
    billingLookupOk = true;
    delete BILLING[TARGET];
  }

  console.log("\n-- SECOND FACTOR (migration 162's twin, in the API) --");
  // A password-only admin session is a stolen-password admin session. The token
  // carries `aal`; only "aal2" means a TOTP code was verified in this session.
  r = await call({ auth: ADMIN_AAL1, body: { action: "ban", targetId: TARGET } });
  ck("an admin on a password-only (aal1) session is refused", r.status, 403);
  ck("...with a machine-readable mfa_required code", r.payload.code, "mfa_required");
  ck("...and NOTHING reached the Supabase Admin API", [r.authApi.length, r.patches.length, r.audit.length], [0, 0, 0]);
  ck("...and it is NOT reported as an attack: no security alert is pushed", r.pushes.length, 0);
  r = await call({ auth: ADMIN_NO_AAL, body: { action: "ban", targetId: TARGET } });
  ck("a token with no aal claim at all is refused too (fail closed)", [r.status, r.payload.code], [403, "mfa_required"]);
  r = await call({ auth: "Bearer not.a-jwt", body: { action: "ban", targetId: TARGET } });
  ck("a token that is not a JWT never reaches the action (it is not even a user)", [r.status, r.authApi.length], [401, 0]);
  r = await call({ auth: ADMIN_TOKEN, body: { action: "ban", targetId: TARGET } });
  ck("aal2 passes (positive control: the refusals above are about aal, not the harness)", r.status, 200);
  r = await call({ auth: "Bearer plain", body: { action: "ban", targetId: TARGET } });
  ck("a NON-admin is still 403 + alert, ahead of the aal check", [r.status, r.payload.code === undefined, r.pushes.length > 0], [403, true, true]);

  console.log("\n-- ROLES (migration 161) --");
  r = await call({ auth: MOD_TOKEN, body: { action: "ban", targetId: TARGET } });
  ck("a moderator can ban", [r.status, r.authApi.length, r.patches.length], [200, 1, 1]);
  r = await call({ auth: MOD_TOKEN, body: { action: "unban", targetId: TARGET } });
  ck("...and unban", r.status, 200);
  const sweptBefore = [sweptStorage.length, sweptCache.length];
  r = await call({ auth: MOD_TOKEN, body: { action: "delete", targetId: TARGET } });
  ck("a moderator cannot DELETE an account", [r.status, r.payload.code], [403, "owner_required"]);
  ck("...and nothing was touched: no sweep, no RPC, no auth call, no audit row",
     [r.authApi.length, r.rpcs.length, r.audit.length, sweptStorage.length - sweptBefore[0], sweptCache.length - sweptBefore[1]], [0, 0, 0, 0, 0]);
  ck("...and it does not alert every admin (a moderator asking is not an attack)", r.pushes.length, 0);
  r = await call({ auth: MOD_AAL1, body: { action: "delete", targetId: TARGET } });
  ck("a moderator on aal1 is told to verify first, not told about roles", r.payload.code, "mfa_required");
  r = await call({ auth: ADMIN_TOKEN, body: { action: "delete", targetId: TARGET } });
  ck("an owner can delete (positive control)", [r.status, r.rpcs.length], [200, 1]);

  console.log("\n-- 161 NOT APPLIED YET: the code must not outrun the database --");
  // Deploying this handler before the owner runs the migration must not turn
  // every admin action into a 503, which is what PostgREST's whole-select
  // rejection would do. Today's behaviour (every admin an owner) is the fallback.
  legacyColumn = true;
  r = await call({ auth: ADMIN_TOKEN, body: { action: "ban", targetId: TARGET } });
  ck("with no admin_role column an admin can still ban", r.status, 200);
  r = await call({ auth: ADMIN_TOKEN, body: { action: "delete", targetId: TARGET } });
  ck("...and, being today's all-powerful admin, still delete", r.status, 200);
  r = await call({ auth: "Bearer plain", body: { action: "ban", targetId: TARGET } });
  ck("...and a non-admin is still refused, still alerts", [r.status, r.pushes.length > 0], [403, true]);
  legacyColumn = false;
  {
    // A 400 that is NOT about admin_role must still fail closed, not fall back.
    const real = global.fetch;
    global.fetch = async (url, opts) => {
      if (/select=is_admin,admin_role/.test(String(url)) && String((opts || {}).method || "GET") === "GET") {
        return { ok: false, status: 400, text: async () => '{"message":"something else is wrong"}', json: async () => ({}) };
      }
      return real(url, opts);
    };
    r = await call({ auth: ADMIN_TOKEN, body: { action: "delete", targetId: TARGET } });
    global.fetch = real;
    ck("an unrelated 400 on the lookup fails closed (503), never falls back to owner",
       [r.status, r.authApi.length, r.rpcs.length], [503, 0, 0]);
  }

  console.log("\n-- this suite runs the shipping handler --");
  ck("the handler came out of api/admin-user-action.js", typeof handler, "function");
  ck("no reimplementation lives in this file",
     /^(async )?function handler\(req, res\)/m.test(fs.readFileSync(__filename, "utf8")), false);

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error("FAIL  suite threw:", e); process.exit(1); });
