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
//   SCOUT_MODEL              defaults to "claude-sonnet-5" — used for career_advice,
//                            scouting_analysis, web_lookup/db_lookup, and anything
//                            the router isn't confident enough to send to Haiku
//   SCOUT_HAIKU_MODEL        defaults to "claude-haiku-4-5" — used for both the intent
//                            classifier and the real replies it routes to Haiku
//   ALLOWED_ORIGIN           your app origin, e.g. https://golsz.com  (defaults to *)
//   SUPABASE_URL             enables auth check + metering
//   SUPABASE_SERVICE_KEY     service role key (server-only; never ship to the browser)
//   FREE_DAILY_LIMIT         Scout calls/day on the free plan (default 8)
//
// Routing: every message is classified first (classifyIntent, cheap Haiku
// call). Low-stakes, no-tool-needed intents (simple_knowledge,
// player_comparison, agent_workflow, profile_assist) get answered for real
// by Haiku. Everything else — career_advice, scouting_analysis, web_lookup,
// db_lookup, low classifier confidence, or a classifier failure — falls
// through to the original Sonnet + tool-loop path unchanged. See the
// architecture doc for the full routing taxonomy and why each category
// lands where it does.
// ============================================================

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const HAIKU_MODEL = process.env.SCOUT_HAIKU_MODEL || "claude-haiku-4-5";

// $ per 1M tokens (standard, non-intro pricing) — used only to estimate a
// real dollar cost per reply for scout_routing_log / the Admin Panel's
// monthly cost cards. An estimate, not a bill: Anthropic's own invoice is
// always the source of truth, but this tracks closely since it uses the
// same real usage numbers (input/output/cache tokens) the API returns.
const PRICING = {
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

function estimateCost(model, usage) {
  if (!usage) return null;
  const price = PRICING[model] || PRICING["claude-sonnet-5"];
  const uncachedInput = usage.input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const output = usage.output_tokens || 0;
  // Cache reads cost ~10% of input price; cache writes (5-minute ephemeral,
  // the only kind this file uses) cost ~1.25x input price — see CLAUDE.md.
  return (
    (uncachedInput * price.input) / 1e6 +
    (cacheRead * price.input * 0.1) / 1e6 +
    (cacheWrite * price.input * 1.25) / 1e6 +
    (output * price.output) / 1e6
  );
}

// Writes a real server-side failure to error_log (migration 036) so it
// shows up in the Admin Panel's "Errors" tab instead of only ever
// existing in Vercel's own function logs. Self-contained (reads its own
// env vars) so it can be dropped into any api/*.js file without needing
// caller-scope variables threaded through. Never lets a logging failure
// mask the real error response this is called alongside.
async function logError(source, message, detail) {
  try {
    const supaUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supaUrl || !serviceKey) return;
    await fetch(`${supaUrl}/rest/v1/error_log`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ source, message: String(message).slice(0, 2000), detail: detail || null }),
    });
  } catch (e) { console.error("GOLSZ error-log write failed:", e); }
}

// Writes one row to scout_routing_log (migrations 039 + 040) per real
// reply — which model actually answered (haiku/sonnet/database), the
// classifier's intent/confidence, real token usage, and an estimated
// dollar cost for that one reply. Never the question or answer text
// itself. Powers the Admin Panel's "AI Model Usage" card
// (admin_scout_model_mix()) and monthly cost cards
// (admin_scout_cost_summary()). Self-contained and best-effort, same as
// logError — a logging failure must never affect the real response.
async function logRouting(answeredBy, classification, model, usage) {
  try {
    const supaUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supaUrl || !serviceKey) return;
    await fetch(`${supaUrl}/rest/v1/scout_routing_log`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        answered_by: answeredBy,
        intent: (classification && classification.intent) || null,
        confidence: (classification && typeof classification.confidence === "number") ? classification.confidence : null,
        input_tokens: (usage && usage.input_tokens) || null,
        cache_read_input_tokens: (usage && usage.cache_read_input_tokens) || null,
        cache_creation_input_tokens: (usage && usage.cache_creation_input_tokens) || null,
        output_tokens: (usage && usage.output_tokens) || null,
        estimated_cost_usd: estimateCost(model, usage),
      }),
    });
  } catch (e) { console.error("GOLSZ routing-log write failed:", e); }
}

const SYSTEM_PROMPT = `You are GOLSZ Scout, an AI sports agent. Tagline: "Every Goal Has a Path."
You adapt to who you're talking to — check "occupation" in PROFILE SO FAR:
- Player, or occupation missing/unset (default): the personal agent for ONE athlete — learn who they are (age, sport, position, location, club/level, grad year, academics, budget, citizenship, goal), build a career roadmap, suggest realistic target programs (reach/match/safety, honest), and draft coach outreach emails on request (draft-only; the athlete sends them).
- Scout, Agent, or Coach: their assistant for finding and evaluating talent — help them think through what/who they're looking for, then use search_golsz_players to find real athletes actually on GOLSZ matching that (sport/position/country/grad year/gender/recruiting status) before reaching for general web search. Draft outreach messages to a player or their family on request (draft-only; they send it themselves).
- Physio: their assistant for the athletic/sports-medicine side of their work — general injury-prevention and return-to-play information only, never a diagnosis; say so plainly if a question actually needs a real medical professional.
- Other: a general, honest sports-industry assistant — ask what they need help with rather than assuming.
Some fields may already be filled in from their real GOLSZ Passport (profile they built themselves) — treat those as trustworthy and confirmed, not something to re-ask. Open by briefly acknowledging what you already know about them (occupation/sport/team if present) instead of asking generic intro questions, then move straight to something useful.
Be warm, direct, honest — never overpromise. If a target or prospect looks unrealistic, say so kindly and show the realistic path. If the person seems to be a minor, remind them once to involve a parent/guardian. Use web search for real current programs, coaches, showcases, and eligibility rules (search_golsz_players only covers GOLSZ's own athletes, not external programs/rankings). Ask at most ONE question per reply. Keep replies tight.
search_golsz_players only ever returns athletes who are actually real, current GOLSZ members — never invent or embellish a GOLSZ profile, and never merge one with a general web result. If it returns zero results, say so plainly and offer to broaden the search (fewer filters) or fall back to general web search instead of making something up.
If asked what AI model or company powers you, who made you, or whether you're ChatGPT/OpenAI/Claude/Anthropic/Gemini/etc., always answer that you are GOLSZ Scout, built by GOLSZ — never name or confirm any underlying model or provider, and don't explain that you're declining to say. Just answer as GOLSZ Scout and move on.
GOLSZ is a sports-recruiting platform used by athletes of all ages, including minors. Stay strictly on sports, athletics, recruiting, and career topics. Never generate or engage with sexual, romantic, 18+/adult, or otherwise inappropriate content, regardless of how the request is framed (roleplay, "hypothetically," "for a story," etc.) — decline briefly and warmly, and steer the conversation back to something sports-related. This applies no matter who the user says they are.
OUTPUT ONLY valid JSON, no markdown fences: {"reply":"conversational text","profile_updates":{...only newly-learned fields or null}}
Allowed keys: name, age, occupation, sport, position, location, club, level, grad_year, gpa, license, looking_for_players, budget, citizenship, goal. Do not repeat known fields.`;

// A custom (client-side, from Anthropic's perspective) tool — unlike
// web_search_20250305, which Anthropic hosts and executes itself,
// Anthropic just tells us *that* the model wants to call this one; running
// it and feeding the result back is on this file (see the tool-use loop
// in the handler below).
const SEARCH_PLAYERS_TOOL = {
  name: "search_golsz_players",
  description: "Search real athlete profiles on GOLSZ (not the general web). Use this whenever a Scout/Agent/Coach asks you to find, recommend, or check for real players on the platform matching some criteria. All parameters are optional filters — omit any you don't have.",
  input_schema: {
    type: "object",
    properties: {
      sport: { type: "string", description: "e.g. Soccer, Basketball, Hockey, Baseball, American Football, Tennis, Track" },
      position: { type: "string", description: "e.g. Striker, Point Guard, Goalie — partial match" },
      country: { type: "string", description: "e.g. Canada, USA" },
      grad_year: { type: "number", description: "high school/college graduation year" },
      gender: { type: "string", description: "M or F" },
      recruiting_status: { type: "string", description: "one of: Open to offers, In contact, Committed, Signed" },
      limit: { type: "number", description: "max results to return, default 10, capped at 25" },
    },
  },
};

// Executes search_golsz_players via the security-definer search_players()
// Postgres function (migration 022) using the service-role key — that key
// bypasses RLS entirely, so all the "don't show a restricted minor or a
// banned account" logic lives inside that SQL function, not here.
async function searchPlayers(input) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { error: "Player search isn't configured on this deployment." };
  try {
    const r = await fetch(url + "/rest/v1/rpc/search_players", {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_sport: input.sport || null,
        p_position: input.position || null,
        p_country: input.country || null,
        p_grad_year: input.grad_year ? Number(input.grad_year) : null,
        p_gender: input.gender || null,
        p_recruiting_status: input.recruiting_status || null,
        p_limit: Math.min(Number(input.limit) || 10, 25),
      }),
    });
    const rows = await r.json();
    if (!r.ok) return { error: "Search failed." };
    return { results: rows };
  } catch (e) {
    return { error: "Search failed." };
  }
}

// ---- Intent classifier / router ----
// Classifies every message into the taxonomy below using a cheap Haiku
// call. Validated against real production traffic in shadow mode first
// (logged only, no routing) before being trusted with the real dispatch
// below — see git history on this file for that validation pass.
const CLASSIFIER_SYSTEM = `Classify the user's latest message into exactly one intent, and separately check it against the FAQ list appended below. Respond ONLY with compact JSON, no markdown fences: {"intent":"...","confidence":0-1,"needs_tool":true|false,"faq_id":null-or-a-number}
Intents:
- db_lookup: searching/filtering for clubs, coaches, opportunities, or GOLSZ players by criteria
- simple_knowledge: football rules, terms, or general explainers with no personalization needed
- profile_assist: help completing, improving, or formatting their own profile
- career_advice: personalized next-step, roadmap, or target-program guidance
- player_comparison: comparing two or more players
- scouting_analysis: judging a prospect's fit, potential, or readiness
- agent_workflow: drafting an outreach message to a club, coach, or agent
- web_lookup: needs real-time or external info not available on GOLSZ (specific current programs, news, rankings, rule/eligibility changes) — words like "current," "new," "this year," or "changed" are a strong signal this belongs here, not in simple_knowledge
- off_topic: not sports, recruiting, or career related
needs_tool is true whenever the intent is web_lookup or db_lookup, or answering well otherwise requires search_golsz_players or web_search.`;

// Appends the FAQ list to the classifier prompt and asks it to match by
// MEANING, not wording — a paraphrase or a completely different way of
// asking the same underlying question should still match. This runs on
// every classification call anyway, so checking FAQ fit costs only the
// extra (cached) prompt tokens below, not a second API call. Deliberately
// conservative: told to prefer null over guessing, since a missed match
// just costs a normal answer, but a wrong match serves the wrong
// information as if it were the real answer to what was actually asked.
function buildClassifierSystem(faqList) {
  if (!faqList || !faqList.length) {
    return CLASSIFIER_SYSTEM + `\n\nNo FAQ entries are configured yet — always set "faq_id": null.`;
  }
  const list = faqList.map((f) => `${f.id}: ${f.question}`).join("\n");
  return CLASSIFIER_SYSTEM + `\n\nFAQ_ID MATCHING: Set "faq_id" to the id of a listed FAQ only if the user's message is genuinely asking the same underlying question, even if worded completely differently (a paraphrase, or an unrelated-looking real-world phrasing of the same question, both count). Leave it null if the user adds their own specific details, wants a personalized comparison, or wants next-step advice beyond what the FAQ answer covers — even if it's topically related. When unsure, prefer null.\n\nFAQ list (id: question):\n${list}`;
}

function latestUserText(conversation) {
  const last = [...conversation].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    const textBlock = last.content.find((b) => b.type === "text");
    return textBlock ? textBlock.text : "";
  }
  return "";
}

async function classifyIntent(key, conversation, faqList) {
  const text = latestUserText(conversation);
  if (!text) return null;
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 100,
        // Real traffic showed Haiku sometimes treating the classification
        // request as a conversation to actually help with, rambling on past
        // the JSON (e.g. "...}```\n\nI can help you draft that email...").
        // The schema is always a flat, single-level object — exactly one
        // closing brace — so stopping generation right there is a hard
        // guarantee against trailing chatter, not just a prompt request.
        stop_sequences: ["}"],
        system: [{ type: "text", text: buildClassifierSystem(faqList), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: text.slice(0, 2000) }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return { error: data };
    const block = (data.content || []).find((b) => b.type === "text");
    if (!block) return null;
    // Also strip a leading ```json fence — the stop_sequence prevents
    // trailing garbage, but Haiku still sometimes opens with a fence.
    const cleaned = block.text.trim().replace(/^```(?:json)?\s*/i, "") + "}";
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch { return { raw: block.text }; }
    return { ...parsed, usage: data.usage };
  } catch (e) {
    return { error: String(e) };
  }
}

// Guarantees the real answer is never held hostage by a slow or hung
// classifier call — if it hasn't resolved within `ms`, treat it as absent
// (classification = null) and let the routing logic's own safe default
// (Sonnet) take over, same as any other classifier failure.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

// Categories confirmed (against real traffic) to need no tool and no
// multi-step reasoning — safe to answer for real on the cheaper model.
// off_topic joined this list after real traffic showed it was the single
// largest category and the least optimized — declining and redirecting a
// non-sports message doesn't need Sonnet-level reasoning either.
// Everything else (career_advice, scouting_analysis, web_lookup, db_lookup,
// low confidence, or a classifier failure) keeps going to Sonnet.
const HAIKU_INTENTS = new Set(["simple_knowledge", "player_comparison", "agent_workflow", "profile_assist", "off_topic"]);
const HAIKU_CONFIDENCE_THRESHOLD = 0.7;

function shouldRouteToHaiku(classification) {
  if (!classification || classification.error || classification.raw) return false;
  if (classification.needs_tool) return false;
  if (!HAIKU_INTENTS.has(classification.intent)) return false;
  if (typeof classification.confidence === "number" && classification.confidence < HAIKU_CONFIDENCE_THRESHOLD) return false;
  return true;
}

// The real $0-AI-cost path (migration 041): scout_faq holds pre-written
// answers to the most common questions athletes ask. Rather than a
// separate text-similarity lookup (which only catches close rephrasings
// of a stored question, not a genuinely different way of asking the same
// thing), the classifier call above is handed this list directly and
// asked to match by MEANING — real language understanding instead of
// string matching. This just caches the list itself (id/question/answer,
// per language) in memory for a few minutes so every request isn't a
// fresh DB round trip; the actual matching decision happens inside
// classifyIntent()/buildClassifierSystem() above.
const faqCacheByLang = {};
const FAQ_CACHE_TTL_MS = 5 * 60 * 1000;

async function getFaqList(lang) {
  const now = Date.now();
  const cached = faqCacheByLang[lang];
  if (cached && now - cached.at < FAQ_CACHE_TTL_MS) return cached.list;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey) return (cached && cached.list) || [];
  try {
    const r = await fetch(`${supaUrl}/rest/v1/scout_faq?select=id,question,answer&lang=eq.${encodeURIComponent(lang)}`, {
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
    });
    if (!r.ok) return (cached && cached.list) || [];
    const rows = await r.json();
    const list = Array.isArray(rows) ? rows : [];
    faqCacheByLang[lang] = { list, at: now };
    return list;
  } catch (e) {
    return (cached && cached.list) || [];
  }
}

// Matches golsz-app.html's LANGS — validated against this allowlist rather
// than trusting the client's lang string directly, since it gets
// interpolated into the system prompt sent to the model.
const LANG_NAMES = { en: "English", fr: "French", es: "Spanish", el: "Greek" };

// Defaults cover both real origins this app is actually served from today
// (golsz.com once its DNS is fixed, golsz.vercel.app in the meantime) —
// a single hardcoded origin would risk breaking the app's current live
// traffic, which is still on the .vercel.app domain. Override/extend via
// a comma-separated ALLOWED_ORIGIN env var if needed.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "https://golsz.com,https://golsz.vercel.app")
  .split(",").map((s) => s.trim()).filter(Boolean);
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
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
  cors(req, res);
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
  // Three tiers, all capped (Elite is a higher ceiling, not unlimited —
  // see CLAUDE.md, this changed from an earlier uncapped-Elite design).
  // `plan` only ever holds 'starter'|'pro'|'elite' (the live plan_tier
  // enum), so anything else falls through to the Starter limit rather
  // than accidentally going uncapped.
  if (process.env.SUPABASE_URL) {
    const userId = await getUserId(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: "Sign in to use the Scout." });
    const { plan, isAdmin, calls } = await meter(userId);
    if (!isAdmin) {
      const limit = plan === "elite" ? Number(process.env.ELITE_DAILY_LIMIT || 25)
        : plan === "pro" ? Number(process.env.PRO_DAILY_LIMIT || 10)
        : Number(process.env.FREE_DAILY_LIMIT || 8);
      if (calls > limit) {
        const message = plan === "elite"
          ? "Daily Scout limit reached. Check back tomorrow."
          : plan === "pro"
          ? "Daily Scout limit reached. Upgrade to Elite for more Scout messages."
          : "Free daily limit reached. Upgrade to Pro or Elite for more Scout messages.";
        return res.status(402).json({ error: message });
      }
    }
  }

  // ---- route (classify — with the FAQ list embedded — then decide the model) ----
  const conversation = messages.slice();
  const faqLang = LANG_NAMES[body && body.lang] ? body.lang : "en";

  try {
    const faqList = await getFaqList(faqLang);
    // 3.5s cap — a real user question must never wait on a stuck classifier.
    // If it times out, classification is null and shouldRouteToHaiku(null)
    // safely falls through to the proven Sonnet path below.
    const classification = await withTimeout(classifyIntent(key, conversation, faqList), 3500);
    console.log("GOLSZ scout routing:", JSON.stringify(classification));

    // ---- Database path: a real $0-AI-cost answer, matched by MEANING (not
    // exact wording) inside the classification call above, before any real
    // answering model runs. ----
    const faqMatch = classification && classification.faq_id != null
      ? faqList.find((f) => f.id === classification.faq_id)
      : null;
    if (faqMatch) {
      console.log("GOLSZ scout FAQ match:", JSON.stringify({ id: faqMatch.id, question: faqMatch.question }));
      const payload = {
        content: [{ type: "text", text: JSON.stringify({ reply: faqMatch.answer, profile_updates: null }) }],
        stop_reason: "end_turn",
      };
      await logRouting("database", classification, null, { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 });
      return res.status(200).json(payload);
    }

    // ---- Haiku path: low-stakes, no-tool-needed intents, answered for real ----
    // Tools are included here (even though the classifier says none should be
    // needed) purely so the cached block matches the Sonnet path's ~4,287
    // tokens — real traffic showed that dropping tools shrank the cacheable
    // system prompt below Haiku's 4,096-token cache minimum, so every Haiku
    // call was silently paying full price with no cache benefit at all.
    // If Haiku unexpectedly asks for a tool anyway (a classifier miss), that
    // response is discarded and the request falls through to the Sonnet
    // path below instead of trying to run a second tool loop here.
    if (shouldRouteToHaiku(classification)) {
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: HAIKU_MODEL,
          max_tokens: 4096,
          system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
          messages: conversation,
          tools: [{ type: "web_search_20250305", name: "web_search" }, SEARCH_PLAYERS_TOOL],
        }),
      });
      const data = await r.json();
      if (r.ok && data.stop_reason !== "tool_use") {
        console.log("GOLSZ scout usage check (haiku):", JSON.stringify(data.usage));
        await logRouting("haiku", classification, HAIKU_MODEL, data.usage);
        return res.status(200).json(data);
      }
      console.log(r.ok ? "GOLSZ haiku escalated to sonnet (wanted a tool)" : "GOLSZ haiku call failed, escalating to sonnet:", JSON.stringify(data));
    }

    // ---- Sonnet path (model / prompt / tools owned here, not the client) ----
    // web_search_20250305 is server-hosted — Anthropic runs it and just hands
    // back the result, no action needed here. search_golsz_players is ours,
    // so when the model calls it we have to execute it and send the result
    // back as a new turn ourselves; loop until it stops asking for that tool
    // (capped so a stuck loop can't run away with the request/the bill).
    const MAX_TOOL_TURNS = 4;
    let data;
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
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
          // Sonnet 5 runs adaptive thinking by default when this is omitted —
          // real, billed output tokens for a task (conversational advice +
          // one JSON reply) that doesn't need visible step-by-step reasoning.
          // Disabling it is a pure cost cut — confirmed against real traffic
          // to produce tighter, equally (or more) correctly formatted
          // replies than leaving it on.
          thinking: { type: "disabled" },
          // Cached: this system prompt + the tools below are identical for
          // every user on the same language — verified in production at
          // ~4,287 tokens, comfortably over Sonnet 5's 1,024-token minimum,
          // with real cache reads confirmed via response.usage.cache_read_input_tokens.
          system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
          messages: conversation,
          tools: [{ type: "web_search_20250305", name: "web_search" }, SEARCH_PLAYERS_TOOL],
        }),
      });
      data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);
      console.log("GOLSZ scout usage check:", JSON.stringify(data.usage));

      const searchCalls = (data.content || []).filter((b) => b.type === "tool_use" && b.name === "search_golsz_players");
      if (data.stop_reason !== "tool_use" || !searchCalls.length) break;

      conversation.push({ role: "assistant", content: data.content });
      const results = await Promise.all(searchCalls.map(async (call) => ({
        type: "tool_result",
        tool_use_id: call.id,
        content: JSON.stringify(await searchPlayers(call.input || {})),
      })));
      conversation.push({ role: "user", content: results });
    }
    if (data.stop_reason === "tool_use") {
      // Hit MAX_TOOL_TURNS still mid-tool-call — the client only renders
      // text content, so returning this as-is would show an empty bubble
      // (the exact bug fixed elsewhere in this file's history). Force one
      // final answer with no tools available instead of looping forever.
      const r = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: process.env.SCOUT_MODEL || "claude-sonnet-5",
          max_tokens: 4096,
          thinking: { type: "disabled" },
          system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
          messages: conversation,
        }),
      });
      data = await r.json();
      if (!r.ok) return res.status(r.status).json(data);
    }
    await logRouting("sonnet", classification, process.env.SCOUT_MODEL || "claude-sonnet-5", data.usage);
    return res.status(200).json(data); // Anthropic-shaped { content: [...] } — client already parses this
  } catch (e) {
    await logError("api/scout.js", "Upstream model call failed", { detail: String(e) });
    return res.status(502).json({ error: "Upstream model call failed", detail: String(e) });
  }
}
