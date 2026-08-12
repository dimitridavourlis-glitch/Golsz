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
body = rewrite(body, /^export default async function handler/m, "async function handler", "the default export");

// The push stub records rather than sends. alertAdmins() is fire-and-forget
// from the caller's point of view but IS awaited, so a stub that throws would
// change the response — which is itself worth asserting.
let pushes = [];
const webpushStub = {
  setVapidDetails() {},
  async sendNotification(sub, payload) { pushes.push({ sub, payload: JSON.parse(payload) }); },
};
const handler = new Function("__webpush", body + "\nreturn handler;")(webpushStub);

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
const TOKENS = { "Bearer admin": ADMIN, "Bearer plain": NON_ADMIN };
const ADMINS = new Set([ADMIN, OTHER_ADMIN]);
let authApiOk = true;
let rpcOk = true;

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
    const m = /id=eq\.([^&]+)/.exec(u);
    return { ok: true, json: async () => [{ is_admin: ADMINS.has(m && m[1]) }] };
  }
  if (u.includes("/auth/v1/admin/users/")) {
    return { ok: authApiOk, status: authApiOk ? 200 : 500, json: async () => ({}) };
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

async function call({ auth = "Bearer admin", method = "POST", body = {}, origin } = {}) {
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

  console.log("\n-- this suite runs the shipping handler --");
  ck("the handler came out of api/admin-user-action.js", typeof handler, "function");
  ck("no reimplementation lives in this file",
     /^(async )?function handler\(req, res\)/m.test(fs.readFileSync(__filename, "utf8")), false);

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error("FAIL  suite threw:", e); process.exit(1); });
