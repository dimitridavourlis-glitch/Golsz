// api/signup-guard.js must not keep sign-up IP addresses forever.
//
// signup_attempts (migration 074) stores raw IPs for the per-IP daily limit,
// and nothing deleted them — the audit of 2026-10-09 found every sign-up IP
// retained indefinitely, while the limit only ever reads today's row.
// privacy.html now promises deletion after 30 days; this pins the code that
// keeps that promise, and that a failed sweep never blocks a signup.
//
// The real handler is require()d with fetch mocked.
const path = require("path");
const fs = require("fs");
const REPO = path.join(__dirname, "..");
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
const mod = require(REPO + "/api/signup-guard.js");
const handler = mod.default;

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

let calls = [], deleteOk = true, deleteThrows = false;
global.fetch = async (url, opts = {}) => {
  const u = String(url), method = String(opts.method || "GET").toUpperCase();
  calls.push({ u, method });
  if (u.includes("/rpc/reserve_signup_attempt")) return { ok: true, status: 200, json: async () => ({ allowed: true }) };
  if (method === "DELETE" && u.includes("/rest/v1/signup_attempts")) {
    if (deleteThrows) throw new Error("network");
    return { ok: deleteOk, status: deleteOk ? 204 : 500 };
  }
  throw new Error("unexpected " + u);
};
function call() {
  return new Promise((resolve) => {
    const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; },
      json(j) { resolve({ status: this.statusCode, body: j }); return this; }, end() { resolve({ status: this.statusCode }); } };
    handler({ method: "POST", headers: { "x-forwarded-for": "203.0.113.5" } }, res);
  });
}

(async () => {
  console.log("\n-- the cutoff --");
  ck("retention is 30 days", mod.SIGNUP_IP_RETENTION_DAYS, 30);
  ck("cutoff is a UTC date 30 days back", mod.retentionCutoff(new Date("2026-10-09T23:30:00Z")), "2026-09-09");
  ck("cutoff crosses month/year boundaries", mod.retentionCutoff(new Date("2026-01-15T00:00:00Z")), "2025-12-16");

  console.log("\n-- a signup sweeps old rows --");
  calls = [];
  let r = await call();
  ck("signup still allowed", r.body.allowed, true);
  const del = calls.find((c) => c.method === "DELETE");
  ck("old IP rows were deleted", !!del, true);
  ck("...only rows before the cutoff", !!(del && /signup_attempts\?attempt_date=lt\.\d{4}-\d{2}-\d{2}$/.test(del.u)), true);

  console.log("\n-- a failed sweep never blocks signup --");
  deleteOk = false; r = await call();
  ck("sweep returned 500: signup still allowed", r.body.allowed, true);
  deleteOk = true; deleteThrows = true; r = await call();
  ck("sweep threw: signup still allowed", r.body.allowed, true);

  console.log("\n-- the policy says what the code does --");
  const privacy = fs.readFileSync(REPO + "/privacy.html", "utf8");
  ck("privacy.html states the 30-day deletion", /deleted automatically after 30 days/.test(privacy), true);
  ck("...and no longer says these are never deleted", /do not currently delete these records/.test(privacy), false);

  console.log(`\n${p}/${p + f} passed`);
  if (f) process.exit(1);
})();
