// ============================================================
// GOLSZ — Server-side signup rate limiting (migration 074)
// Deploy target: /api/signup-guard.js
//
// The client-side honeypot in Auth() (golsz-app.html) only demotes
// trust_score after the fact for a bot that fills every field — it does
// nothing to stop a script calling Supabase's signup API directly, and
// nothing to stop the same IP spinning up many accounts. This is a real
// gate: Auth's submit() calls this endpoint BEFORE sb.auth.signUp() runs;
// the IP is read here from Vercel's x-forwarded-for header (never trusted
// from the client body — a bot could put anything there) and checked via
// reserve_signup_attempt() (074, security-definer, service-role only).
//
// Fails OPEN like the rest of this app's rate limits (a Supabase hiccup
// shouldn't block real signups) — unlike verify-turnstile.js, which fails
// closed, since a missing/wrong IP header here just means "can't rate
// limit this request," not "this request is unverified."
//
// Required env vars (same as api/scout.js):
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY     service role key (server-only)
// Optional env vars:
//   SIGNUP_DAILY_LIMIT_PER_IP   default 10
//   ALLOWED_ORIGIN               same convention as api/verify-turnstile.js
// ============================================================

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "https://golsz.com,https://golsz.vercel.app")
  .split(",").map((s) => s.trim()).filter(Boolean);

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return res.status(200).json({ allowed: true, skipped: true });

  // x-forwarded-for can be a comma-separated chain (client, proxy1, proxy2...)
  // when it passes through multiple hops — the first entry is the original
  // client, same convention verify-turnstile.js's remoteip forwarding relies on.
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded || "").split(",")[0].trim();
  const dailyLimit = Number(process.env.SIGNUP_DAILY_LIMIT_PER_IP || 10);

  try {
    const r = await fetch(`${url}/rest/v1/rpc/reserve_signup_attempt`, {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ p_ip: ip, p_daily_limit: dailyLimit }),
    });
    if (!r.ok) return res.status(200).json({ allowed: true }); // fail open on a Supabase-side error
    const data = await r.json();
    return res.status(200).json({ allowed: !!(data && data.allowed) });
  } catch (e) {
    console.error("GOLSZ signup-guard error:", e);
    return res.status(200).json({ allowed: true }); // fail open — see header comment
  }
}
