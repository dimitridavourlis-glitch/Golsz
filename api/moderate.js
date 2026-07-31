// ============================================================
// GOLSZ — content moderation check (Vercel serverless function)
// Deploy target: /api/moderate.js (Vercel auto-detects it, same as
// api/scout.js — zero config, no new npm dependency).
//
// Backs golsz-app.html's moderateText() — a defense-in-depth check run
// before user-generated text reaches other people (Feed posts, DMs),
// gets saved to a public profile (Passport bio, highlight titles), or is
// sent to Scout. GOLSZ includes minors as users, so this exists to keep
// sexual/18+/adult content off the platform beyond what the existing
// report/block moderation tools already catch after the fact.
//
// A real classifier call (small, fast Claude model) rather than a
// keyword blocklist — blunt/creative phrasing trivially defeats keyword
// lists, and a blocklist can't tell "let's talk about turnovers" from
// something actually inappropriate.
//
// Required env var:
//   ANTHROPIC_API_KEY        same key api/scout.js already uses
// Optional env vars:
//   MODERATION_MODEL         defaults to "claude-haiku-4-5-20251001" (cheap/fast — this is a yes/no classifier, not a chat)
//   ALLOWED_ORIGIN           same allowlist convention as every other endpoint here
//   SUPABASE_URL             enables the signed-in-user check below
//   SUPABASE_SERVICE_KEY     service role key (server-only; never ship to the browser)
// ============================================================

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const MODERATION_SYSTEM_PROMPT = `You are a content-safety classifier for GOLSZ, a sports-recruiting platform used by athletes, coaches, scouts, and agents of all ages, including minors. Classify ONLY whether the given text contains sexual/explicit content, 18+/adult content, romantic or sexual solicitation, grooming language, or anything else inappropriate for a platform that includes minors. Normal sports talk, competitive trash talk, injuries, blunt or informal language, and ordinary profanity that isn't sexual or predatory are all fine — do not flag those. Respond with ONLY valid JSON, no markdown fences: {"flagged": true or false, "reason": "short reason, empty string if not flagged"}`;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "https://golsz.com,https://golsz.vercel.app")
  .split(",").map((s) => s.trim()).filter(Boolean);
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Verify the Supabase access token and return the user id (or null) —
// same pattern as api/scout.js's getUserId(). Requiring a real signed-in
// user here (when Supabase env is configured) keeps this from being a
// free-standing endpoint anyone could hit to run up the Anthropic bill —
// every real call site (post/message/bio/highlight/Scout) already
// requires being signed in anyway.
async function getUserId(authHeader) {
  const url = process.env.SUPABASE_URL;
  if (!url || !authHeader) return null;
  try {
    const r = await fetch(url + "/auth/v1/user", {
      headers: { Authorization: authHeader, apikey: process.env.SUPABASE_SERVICE_KEY || "" },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const text = body && body.text;
  if (!text || typeof text !== "string" || !text.trim()) return res.status(200).json({ flagged: false });

  if (process.env.SUPABASE_URL) {
    const userId = await getUserId(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: "Sign in required." });
  }

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.MODERATION_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system: MODERATION_SYSTEM_PROMPT,
        // Capped — this only needs to classify a post/message/bio-length
        // string, not an essay, and keeps a single call cheap either way.
        messages: [{ role: "user", content: text.slice(0, 4000) }],
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error("moderation upstream error " + r.status);
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    return res.status(200).json({ flagged: !!parsed.flagged, reason: parsed.reason || "" });
  } catch (e) {
    // Fail open — see golsz-app.html's moderateText() for the same
    // reasoning: a moderation-service hiccup shouldn't block someone
    // from posting/messaging entirely. This is defense-in-depth on top
    // of the existing report/block tools, not the only safeguard.
    console.error("GOLSZ moderation error:", e);
    return res.status(200).json({ flagged: false });
  }
}
