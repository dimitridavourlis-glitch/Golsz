// ============================================================
// GOLSZ — Cloudflare Turnstile server-side verification
// Deploy target: /api/verify-turnstile.js
//
// A real bot-blocking layer in front of signup, on top of (not instead of)
// the existing client-side honeypot in Auth() (golsz-app.html) — the
// honeypot only demotes trust_score after the fact for a bot that fills
// every field; it does nothing to stop a script calling Supabase's signup
// API directly. Called by Auth's submit() BEFORE sb.auth.signUp() runs,
// with the token TurnstileWidget captured client-side.
//
// Inert by design until configured: if TURNSTILE_SECRET_KEY isn't set,
// this returns { success: true } unconditionally — matching
// TURNSTILE_SITE_KEY being empty client-side (see that constant's comment
// in golsz-app.html), so this file can ship and deploy with zero effect
// on real signups until both are set.
//
// Required env var (only once you actually want Turnstile enforced):
//   TURNSTILE_SECRET_KEY   from the same Cloudflare Turnstile widget as
//                          the site key pasted into TURNSTILE_SITE_KEY —
//                          server-only, never ship this one to the browser
// Optional env var:
//   ALLOWED_ORIGIN         same convention as api/scout.js (defaults to
//                          golsz.com + golsz.vercel.app)
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

  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  // P1-3. This used to return { success: true } whenever the secret was
  // missing — in production as well as locally. That is the worst possible
  // default for a bot check: a half-finished rollout (site key pasted into
  // the client, secret never added to Vercel) would look enabled, send real
  // tokens, and verify none of them, with nothing anywhere saying so.
  //
  // The client only calls this endpoint when TURNSTILE_SITE_KEY is set, so a
  // request arriving here means the browser believes Turnstile is active.
  // In PRODUCTION, a missing secret at that point is a misconfiguration and
  // must fail closed. Outside production it stays a loud no-op, so preview
  // deploys and local work are not blocked by a secret nobody has set.
  const isProduction = process.env.VERCEL_ENV === "production";
  if (!secretKey) {
    if (isProduction) {
      console.error("GOLSZ TURNSTILE MISCONFIGURED: a token was submitted but TURNSTILE_SECRET_KEY is not set in production. Signup is failing closed.");
      return res.status(503).json({ success: false, error: "Signup verification is temporarily unavailable. Please try again shortly.", code: "turnstile_misconfigured" });
    }
    console.warn("GOLSZ turnstile: TURNSTILE_SECRET_KEY unset outside production — skipping verification.");
    return res.status(200).json({ success: true, skipped: true });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { token } = body || {};
  if (!token || typeof token !== "string") return res.status(400).json({ success: false, error: "Missing token" });

  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: secretKey, response: token, remoteip: req.headers["x-forwarded-for"] || "" }),
    });
    const data = await r.json();
    // Cloudflare returns 200 with success:false for a failed/expired/replayed
    // token. Surface its error codes so a real misconfiguration (wrong secret,
    // hostname mismatch) is diagnosable from the logs instead of looking like
    // ordinary bot traffic.
    if (!data.success) console.warn("GOLSZ turnstile rejected a token:", JSON.stringify(data["error-codes"] || []));
    return res.status(200).json({ success: !!data.success });
  } catch (e) {
    console.error("GOLSZ turnstile verify error:", e);
    // Fails CLOSED (unlike the rest of this app's metering, which fails
    // open) — a Cloudflare outage should degrade to "signup temporarily
    // unavailable," not to every bot getting through unchecked.
    return res.status(502).json({ success: false, error: "Verification service unavailable" });
  }
}
