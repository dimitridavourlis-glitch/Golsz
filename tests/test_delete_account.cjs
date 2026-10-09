// api/delete-account.js — self-service erasure, driven end to end.
//
// Four things this suite pins, each of which was wrong before 2026-10-09:
//
//  1. THE BILLING GATE LIVED ONLY IN THE CLIENT, AND KEYED ON THE WRONG FACT.
//     Settings refused whenever stripe_customer_id was set — but the webhook
//     never clears that id, so anyone who had EVER paid could never delete
//     their account, while a direct POST to this endpoint skipped the check
//     entirely and could strand a live subscription. The rule is now "a
//     customer id AND a plan that is not free", enforced here.
//  2. admin_delete_profile_data() was called by the ADMIN delete path only.
//     Migration 027 says the five base tables it clears do not cascade.
//  3. Cached Scout replies (scout_response_cache, keyed by text) survived.
//  4. A failed storage LISTING returned silently, so photos could be left
//     behind with no record anywhere.
//
// The module has no imports, so the real handler is require()d directly,
// with fetch mocked. Nothing here is a copy of the logic.

const path = require("path");
const REPO = path.join(__dirname, "..");

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";

const handler = require(REPO + "/api/delete-account.js").default;

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let calls = [];
let billing = { plan: "free", stripe_customer_id: null };
let billingOk = true;
let children = [];
let rpcOk = true;
let cacheOk = true;
let listOk = true;

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String(opts.method || "GET").toUpperCase();
  let body = null;
  try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = opts.body; }
  calls.push({ url: u, method, body });
  const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
  const bad = (status) => ({ ok: false, status, json: async () => ({ message: "boom" }), text: async () => "boom" });

  if (u.endsWith("/auth/v1/user")) {
    return (opts.headers || {}).Authorization === "Bearer user" ? ok({ id: USER }) : bad(401);
  }
  if (method === "GET" && u.includes("/rest/v1/profiles?id=eq.") && u.includes("select=plan,stripe_customer_id")) {
    return billingOk ? ok([billing]) : bad(503);
  }
  if (method === "GET" && u.includes("/rest/v1/parent_links")) {
    return ok(children.map((c) => ({ athlete_id: c.id })));
  }
  if (method === "GET" && u.includes("/rest/v1/profiles?id=in.")) return ok(children);
  if (u.includes("/storage/v1/object/list/")) return listOk ? ok([{ name: "photo.jpg" }]) : bad(500);
  if (method === "DELETE" && u.includes("/storage/v1/object/")) return ok({});
  if (method === "DELETE" && u.includes("/rest/v1/scout_response_cache")) return cacheOk ? ok([]) : bad(400);
  if (u.includes("/rest/v1/rpc/admin_delete_profile_data")) return rpcOk ? ok(null) : bad(500);
  if (method === "DELETE" && u.includes("/auth/v1/admin/users/")) return ok({});
  if (u.includes("/rest/v1/error_log")) return ok([]);
  return ok([]);
};

const mkRes = () => {
  const r = { statusCode: null, payload: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.payload = b; return r; };
  return r;
};

async function del(body = { confirm: true }) {
  calls = [];
  const res = mkRes();
  await handler({ method: "POST", headers: { authorization: "Bearer user" }, body }, res);
  const idx = (pred) => calls.findIndex(pred);
  return {
    status: res.statusCode,
    payload: res.payload,
    calls,
    authDeletes: calls.filter((c) => c.method === "DELETE" && c.url.includes("/auth/v1/admin/users/")).map((c) => c.url.split("/").pop()),
    rpcs: calls.filter((c) => c.url.includes("admin_delete_profile_data")).map((c) => c.body && c.body.p_target),
    cache: calls.filter((c) => c.method === "DELETE" && c.url.includes("scout_response_cache"))
      .map((c) => decodeURIComponent(c.url.split("cache_key=like.")[1] || "")),
    errorLogs: calls.filter((c) => c.url.includes("/rest/v1/error_log")).map((c) => c.body && c.body.message),
    idx,
  };
}

function reset() {
  billing = { plan: "free", stripe_customer_id: null };
  billingOk = true; children = []; rpcOk = true; cacheOk = true; listOk = true;
}

(async () => {
  console.log("-- the harness reaches the handler --");
  reset();
  let r = await del();
  ck("a never-paid account is deleted", r.status, 200);
  ck("...and the auth user really is deleted", r.authDeletes, [USER]);

  console.log("\n-- 1. billing: ACTIVE subscription, not \"ever paid\" --");
  reset();
  billing = { plan: "pro", stripe_customer_id: "cus_live" };
  r = await del();
  ck("an ACTIVE subscriber is refused server-side (a direct POST cannot strand a subscription)", r.status, 409);
  ck("...with the code the client maps to settings_delete_cancel_first", r.payload && r.payload.code, "active_subscription");
  ck("...and NOTHING was deleted", [r.authDeletes.length, r.rpcs.length, r.cache.length], [0, 0, 0]);
  ck("...not even the photos", r.calls.some((c) => c.url.includes("/storage/")), false);

  billing = { plan: null, stripe_customer_id: "cus_unknown" };
  r = await del();
  ck("a customer id with an UNKNOWN plan is treated as active (fails closed)", r.status, 409);

  billing = { plan: "free", stripe_customer_id: "cus_lapsed" };
  r = await del();
  ck("a LAPSED subscriber (old customer id, plan free) CAN delete their account", r.status, 200);
  ck("...and is", r.authDeletes, [USER]);

  billingOk = false;
  billing = { plan: "free", stripe_customer_id: null };
  r = await del();
  ck("an unreadable billing state is a 503, not a delete", [r.status, r.authDeletes.length], [503, 0]);
  ck("...and the cause is logged", r.errorLogs.some((m) => /Billing lookup failed/.test(m)), true);

  console.log("\n-- 2. the tables that do not cascade --");
  reset();
  r = await del();
  ck("admin_delete_profile_data runs for the user", r.rpcs, [USER]);
  ck("...BEFORE the auth user is deleted",
     r.idx((c) => c.url.includes("admin_delete_profile_data")) <
     r.idx((c) => c.method === "DELETE" && c.url.includes("/auth/v1/admin/users/")), true);
  rpcOk = false;
  r = await del();
  ck("if it fails, the request fails", r.status, 502);
  ck("...and the auth user is NOT deleted (that would orphan the rows)", r.authDeletes, []);
  ck("...and the failure is in error_log", r.errorLogs.some((m) => /admin_delete_profile_data failed/.test(m)), true);

  console.log("\n-- 3. cached Scout replies --");
  reset();
  r = await del();
  ck("both per-athlete key shapes are deleted", r.cache, [`req:${USER}:*`, `*:u:${USER}|*`]);
  ck("...before the auth delete",
     r.idx((c) => c.url.includes("scout_response_cache")) <
     r.idx((c) => c.method === "DELETE" && c.url.includes("/auth/v1/admin/users/")), true);
  cacheOk = false;
  r = await del();
  ck("a failed cache delete is logged with its pattern", r.errorLogs.filter((m) => /Cached Scout replies were NOT deleted/.test(m)).length, 2);
  ck("...and does not block the erasure itself", [r.status, r.authDeletes], [200, [USER]]);

  console.log("\n-- 4. a failed storage listing is no longer silent --");
  reset();
  listOk = false;
  r = await del();
  ck("a failed LIST is logged, per bucket", r.errorLogs.filter((m) => /Storage files were NOT deleted/.test(m)).length, 2);
  ck("...and the account is still deleted", [r.status, r.authDeletes], [200, [USER]]);

  console.log("\n-- managed children --");
  reset();
  children = [{ id: CHILD, full_name: "Kid" }];
  r = await del({ confirm: true, confirm_delete_children: true });
  ck("the child is deleted before the parent", r.authDeletes, [CHILD, USER]);
  ck("...each gets the non-cascading cleanup", r.rpcs, [CHILD, USER]);
  // The RPC also deletes the parent_links row — the only route back to the
  // child. Run before a child auth delete that then failed, it would leave a
  // minor's account nobody can reach and a retry could not find.
  ck("...the CHILD's cleanup runs only AFTER the child's auth delete succeeded",
     r.idx((c) => c.url.includes("admin_delete_profile_data") && c.body && c.body.p_target === CHILD) >
     r.idx((c) => c.method === "DELETE" && c.url.endsWith("/auth/v1/admin/users/" + CHILD)), true);
  ck("...and each child's cached replies go too", r.cache.filter((x) => x.includes(CHILD)).length, 2);

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error("FAIL  suite threw:", e); process.exit(1); });
