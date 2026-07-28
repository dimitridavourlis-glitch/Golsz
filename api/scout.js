// ============================================================
// GOLSZ — AI Scout backend proxy
// Deploy on Vercel (put this file at /api/scout.js) or Netlify.
// It keeps your Anthropic API key SERVER-SIDE, owns the model / system
// prompt / tools (so clients can't change them or run up your bill),
// optionally verifies the Supabase user, and meters free-tier usage.
//
// Required env var:
//   ANTHROPIC_API_KEY        your Anthropic key
// Optional env vars:
//   SCOUT_MODEL              defaults to "claude-sonnet-5" (set to your account's model)
//   ALLOWED_ORIGIN           your app origin, e.g. https://golsz.com  (defaults to *)
//   SUPABASE_URL             enables auth check + metering
//   SUPABASE_SERVICE_KEY     service role key (server-only; never ship to the browser)
//   FREE_DAILY_LIMIT         Scout calls/day on the free plan (default 8)
// ============================================================

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = `You are GOLSZ Scout, an AI sports agent. Tagline: "Every Goal Has a Path."
You are the personal agent for ONE athlete: learn who they are (age, sport, position, location, club/level, grad year, academics, budget, citizenship, goal), build a career roadmap, suggest realistic target programs (reach/match/safety, honest), and draft coach outreach emails on request (draft-only; the athlete sends them).
Some fields may already be filled in from the athlete's real GOLSZ Passport (profile they built themselves) — treat those as trustworthy and confirmed, not something to re-ask. Open by briefly acknowledging what you already know about them (sport/position/club/grad year if present) instead of asking generic intro questions, then move straight to something useful.
Be warm, direct, honest — never overpromise. If a target looks unrealistic, say so kindly and show the realistic path. If the athlete seems to be a minor, remind them once to involve a parent/guardian. Use web search for real current programs, coaches, showcases, and eligibility rules. Ask at most ONE question per reply. Keep replies tight.
If asked what AI model or company powers you, who made you, or whether you're ChatGPT/OpenAI/Claude/Anthropic/Gemini/etc., always answer that you are GOLSZ Scout, built by GOLSZ — never name or confirm any underlying model or provider, and don't explain that you're declining to say. Just answer as GOLSZ Scout and move on.
OUTPUT ONLY valid JSON, no markdown fences: {"reply":"conversational text","profile_updates":{...only newly-learned fields or null}}
Allowed keys: name, age, sport, position, location, club, level, grad_year, gpa, budget, citizenship, goal. Do not repeat known fields.`;

// Matches golsz-app.html's LANGS — validated against this allowlist rather
// than trusting the client's lang string directly, since it gets
// interpolated into the system prompt sent to the model.
const LANG_NAMES = { en: "English", fr: "French", es: "Spanish", el: "Greek" };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Verify the Supabase access token and return the user id (or null).
async function getUserId(authHeader) {
  const url = process.env.SUPABASE_URL;
  if (!url || !authHeader) return null;
  try {
    const r = await fetch(url + "/auth/v1/user", {
      headers: {
        Authorization: authHeader,
        apikey: process.env.SUPABASE_SERVICE_KEY || "",
      },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  } catch {
    return null;
  }
}

// Read plan + admin flag + increment daily usage via the SQL helper.
// Returns { plan, isAdmin, calls }.
async function meter(userId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !userId) return { plan: "unknown", isAdmin: false, calls: 0 };
  const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
  let plan = "starter";
  let isAdmin = false;
  try {
    const p = await fetch(url + "/rest/v1/profiles?id=eq." + userId + "&select=plan,is_admin", { headers });
    const rows = await p.json();
    if (Array.isArray(rows) && rows[0]) { plan = rows[0].plan || "starter"; isAdmin = !!rows[0].is_admin; }
  } catch {}
  let calls = 0;
  try {
    const c = await fetch(url + "/rest/v1/rpc/increment_scout_usage", {
      method: "POST", headers, body: JSON.stringify({ p_user: userId }),
    });
    calls = await c.json();
  } catch {}
  return { plan, isAdmin, calls: Number(calls) || 0 };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY" });

  // body: { messages: [...] }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const messages = body && body.messages;
  if (!Array.isArray(messages)) return res.status(400).json({ error: "messages[] required" });
  const langName = LANG_NAMES[body && body.lang];
  const systemPrompt = langName && langName !== "English"
    ? `${SYSTEM_PROMPT}\n\nRespond in ${langName} — the athlete has GOLSZ set to ${langName}. Keep the same JSON output shape; only the "reply" text and any drafted email should be in ${langName}.`
    : SYSTEM_PROMPT;

  // ---- optional auth + metering (enabled only when Supabase env is set) ----
  if (process.env.SUPABASE_URL) {
    const userId = await getUserId(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: "Sign in to use the Scout." });
    const { plan, isAdmin, calls } = await meter(userId);
    const limit = Number(process.env.FREE_DAILY_LIMIT || 8);
    if (!isAdmin && plan === "starter" && calls > limit) {
      return res.status(402).json({ error: "Free daily limit reached. Upgrade to Pro for unlimited Scout." });
    }
  }

  // ---- call Anthropic (model / prompt / tools owned here, not the client) ----
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.SCOUT_MODEL || "claude-sonnet-5",
        // 1000 was cutting off longer replies (drafted coach emails, full
        // roadmaps) mid-sentence — since Scout's whole response is one JSON
        // object, a truncated reply also breaks the JSON.parse on the
        // client and falls back to showing the raw truncated blob.
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    return res.status(200).json(data); // Anthropic-shaped { content: [...] } — client already parses this
  } catch (e) {
    return res.status(502).json({ error: "Upstream model call failed", detail: String(e) });
  }
}
