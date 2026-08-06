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
//   FREE_DAILY_LIMIT         Scout calls/day on the free plan (default 3)
//   STARTER_DAILY_LIMIT      Scout calls/day on Starter ($6/mo, default 8)
//   PRO_DAILY_LIMIT          Scout calls/day on Pro ($14/mo, default 15)
//   ELITE_DAILY_LIMIT        Scout calls/day on Elite ($30/mo, default 20)
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

// Phase 2e of the AI Scout architecture plan (approved): a small registry
// mapping capability role -> {provider, model} instead of scattering model
// names/env-var lookups across call sites. Anthropic-only in this MVP —
// the real goal isn't a second live provider yet, it's that swapping which
// model answers a given role is a one-line change here, not a hunt through
// the file. Phase 3 adds a second provider by giving callAnthropic() (or a
// sibling call*() function) a place to plug in per `provider`.
const MODEL_REGISTRY = {
  FAST_CHAT: { provider: "anthropic", model: process.env.SCOUT_HAIKU_MODEL || "claude-haiku-4-5" },
  DEEP_SCOUT: { provider: "anthropic", model: process.env.SCOUT_MODEL || "claude-sonnet-5" },
};

// Shared low-level caller for a single (non-looping) Anthropic Messages API
// call — used by the classifier, the Haiku/FAST_CHAT path, and the final
// forced no-tools Sonnet/DEEP_SCOUT reply. The Sonnet tool-loop below calls
// the API directly instead, since it needs to inspect stop_reason and push
// new turns between calls, not just get one reply back.
async function callAnthropic(apiKey, { model, system, messages, tools, thinking, maxTokens, stopSequences }) {
  const body = { model, max_tokens: maxTokens || 4096, system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }], messages };
  if (tools) body.tools = tools;
  if (thinking) body.thinking = thinking;
  if (stopSequences) body.stop_sequences = stopSequences;
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, data: await r.json() };
}

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

// ============================================================
// Multi-Model AI Scout & Cost-Control System (approved plan).
// Four provider-agnostic tiers (economy/standard/advanced/premium),
// deterministic complexity scoring, plan-based tier caps, and a
// cost-based downgrade gate — layered on TOP of the existing, real,
// production-validated Haiku/Sonnet routing above (shouldRouteToHaiku,
// escalationReason) rather than replacing it. The one genuinely new
// behavior this adds: a Free-plan user's non-tool-requiring, Sonnet-bound
// question (career_advice, scouting_analysis, etc.) now gets capped down
// to Haiku instead of reaching Sonnet — the actual cost lever the plan
// caps are for. Tool-requiring questions (db_lookup/web_lookup) are never
// capped down by plan — search correctness isn't a discretionary luxury.
// ============================================================

const TIER_ORDER = ["economy", "standard", "advanced", "premium"];

// The highest tier each plan may ever reach — a ceiling, not a default.
// An Elite user's simple question still lands on economy; this only stops
// the OTHER direction (a Free user's complex question can't reach premium).
const PLAN_MODEL_ACCESS = { free: "standard", starter: "advanced", pro: "advanced", elite: "premium" };

function capTier(tier, plan) {
  const cap = PLAN_MODEL_ACCESS[plan] || PLAN_MODEL_ACCESS.free;
  return TIER_ORDER[Math.min(TIER_ORDER.indexOf(tier), TIER_ORDER.indexOf(cap))];
}

// Deterministic 0-100 complexity score — no LLM call spent scoring a
// message, per the plan's "don't spend money on an additional AI
// classification call" instruction. Reuses signals already computed for
// free (classifier intent/needs_tool) plus cheap, local text heuristics.
function complexityScore({ text, classification }) {
  let score = 10; // floor — even the simplest real question isn't 0
  const len = (text || "").length;
  if (len > 600) score += 25;
  else if (len > 250) score += 12;
  else if (len > 100) score += 5;

  const intent = classification && classification.intent;
  if (intent === "career_advice" || intent === "scouting_analysis") score += 25;
  else if (intent === "player_comparison") score += 15;
  else if (intent === "web_lookup" || intent === "db_lookup") score += 10;

  if (classification && classification.needs_tool) score += 10;
  // Strategic/long-horizon phrasing — the spec's own worked example
  // ("Elite user asking about a 3-year strategy -> premium"). Two
  // independent signals (keyword + an explicit multi-year number) so a
  // genuinely long-horizon ask reliably clears the premium band (>75)
  // even after only a moderate career_advice/length bump — verified
  // against this exact worked example in a one-off test harness.
  if (/\b(strategy|long[- ]term|multi[- ]year|roadmap|comprehensive)\b/i.test(text || "")) score += 30;
  if (/\b([2-9]|\d{2,})\s*[- ]?years?\b/i.test(text || "")) score += 15;

  return Math.max(0, Math.min(100, score));
}

// Combines the score with the EXISTING Haiku/Sonnet gate (shouldRouteToHaiku,
// already tuned against real production traffic) rather than recomputing
// that decision from scratch — the score only picks WHICH tier within
// whichever side of that gate the message already falls on, then the plan
// cap can pull a non-tool Sonnet-bound question back down to Haiku.
function selectModelTier({ plan, classification, score }) {
  const needsTool = !!(classification && classification.needs_tool);
  const eligibleForHaiku = shouldRouteToHaiku(classification);
  const rawTier = eligibleForHaiku
    ? (score > 25 ? "standard" : "economy")
    : (score > 75 ? "premium" : "advanced");
  // Tool-requiring questions are a correctness need, not a discretionary
  // depth choice — never capped down by plan, same as today's unconditional
  // Sonnet routing whenever needs_tool is true.
  const tier = needsTool ? rawTier : capTier(rawTier, plan);
  return { tier, score, needsTool };
}

// scout_model_config (migration 052) makes provider/model/pricing per tier
// admin-editable at runtime instead of hardcoded here. Cached in-memory per
// warm serverless instance (same TTL pattern as getFaqList above) — a
// config edit takes up to this TTL to take effect, not instant, which is
// the right tradeoff for a table that changes rarely versus a fresh DB
// round trip on every request. Falls back to ANTHROPIC_DEFAULTS below if a
// tier has no enabled row — a bad edit here degrades gracefully, never
// hard-fails Scout.
const ANTHROPIC_DEFAULTS = {
  economy: { provider: "anthropic", model_name: "claude-haiku-4-5", input_cost_per_million: 1, output_cost_per_million: 5, max_output_tokens: 1024 },
  standard: { provider: "anthropic", model_name: "claude-haiku-4-5", input_cost_per_million: 1, output_cost_per_million: 5, max_output_tokens: 2048 },
  advanced: { provider: "anthropic", model_name: "claude-sonnet-5", input_cost_per_million: 3, output_cost_per_million: 15, max_output_tokens: 4096 },
  premium: { provider: "anthropic", model_name: "claude-sonnet-5", input_cost_per_million: 3, output_cost_per_million: 15, max_output_tokens: 4096 },
};

let modelConfigCache = { at: 0, byTier: null };
const MODEL_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

async function getModelConfigByTier() {
  const now = Date.now();
  if (modelConfigCache.byTier && now - modelConfigCache.at < MODEL_CONFIG_CACHE_TTL_MS) return modelConfigCache.byTier;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return ANTHROPIC_DEFAULTS;
  try {
    const r = await fetch(`${url}/rest/v1/scout_model_config?enabled=eq.true&order=model_tier.asc,priority.asc`, {
      headers: { apikey: key, Authorization: "Bearer " + key },
    });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return modelConfigCache.byTier || ANTHROPIC_DEFAULTS;
    const byTier = {};
    for (const row of rows) if (!byTier[row.model_tier]) byTier[row.model_tier] = row; // lowest priority number wins per tier
    for (const tier of TIER_ORDER) if (!byTier[tier]) byTier[tier] = ANTHROPIC_DEFAULTS[tier];
    modelConfigCache = { at: now, byTier };
    return byTier;
  } catch {
    return modelConfigCache.byTier || ANTHROPIC_DEFAULTS;
  }
}

// Env-overridable per-plan cost constants from the plan's spec. TARGET_COSTS
// is aspirational (real traffic varies around it, not enforced per-request);
// HARD_MAX_COST_PER_REQUEST is the one that actually forces a downgrade.
const TARGET_COSTS = {
  free: Number(process.env.SCOUT_TARGET_COST_FREE || 0.002),
  starter: Number(process.env.SCOUT_TARGET_COST_STARTER || 0.002),
  pro: Number(process.env.SCOUT_TARGET_COST_PRO || 0.003),
  elite: Number(process.env.SCOUT_TARGET_COST_ELITE || 0.006),
};
const HARD_MAX_COST_PER_REQUEST = {
  free: Number(process.env.SCOUT_HARD_MAX_COST_FREE || 0.01),
  starter: Number(process.env.SCOUT_HARD_MAX_COST_STARTER || 0.02),
  pro: Number(process.env.SCOUT_HARD_MAX_COST_PRO || 0.04),
  elite: Number(process.env.SCOUT_HARD_MAX_COST_ELITE || 0.08),
};

function estimateTierCost(tierConfig, estimatedInputTokens, outputTokens) {
  const inputCost = (estimatedInputTokens * (tierConfig.input_cost_per_million || 0)) / 1e6;
  const outputCost = (outputTokens * (tierConfig.output_cost_per_million || 0)) / 1e6;
  return inputCost + outputCost;
}

// Downgrades (never upgrades) a tier if its OWN worst-case cost — using that
// tier's max_output_tokens as the output ceiling, since real output length
// isn't known until after the call — would exceed this plan's hard
// per-request ceiling. Never silently upgrades past what was selected.
async function budgetGate(tier, plan, estimatedInputTokens) {
  const byTier = await getModelConfigByTier();
  const hardMax = HARD_MAX_COST_PER_REQUEST[plan] || HARD_MAX_COST_PER_REQUEST.free;
  let idx = TIER_ORDER.indexOf(tier);
  while (idx > 0) {
    const cfg = byTier[TIER_ORDER[idx]];
    if (estimateTierCost(cfg, estimatedInputTokens, cfg.max_output_tokens) <= hardMax) break;
    idx -= 1;
  }
  return TIER_ORDER[idx];
}

// AiProviderAdapter — one shared shape every provider implements, so the
// handler calls adapter.generate(...) without ever branching on provider
// name. anthropicAdapter is real (wraps callAnthropic above); gemini/xai/
// openai are code-complete stubs wired into scout_model_config but never
// actually invoked while their rows stay enabled=false in production — no
// API keys exist for them in this project yet, and turning one on is a
// config change (a scout_model_config row + an env var), never a code
// change, once a real key and a benchmark pass exist.
const anthropicAdapter = {
  provider: "anthropic",
  async generate({ apiKey, model, system, messages, tools, thinking, maxTokens, stopSequences }) {
    return callAnthropic(apiKey, { model, system, messages, tools, thinking, maxTokens, stopSequences });
  },
};
function unconfiguredAdapter(provider) {
  return {
    provider,
    async generate() {
      throw new Error(`${provider} adapter has no configured API key — scout_model_config must keep ${provider} rows disabled until one exists`);
    },
  };
}
const PROVIDER_ADAPTERS = {
  anthropic: anthropicAdapter,
  google: unconfiguredAdapter("google"),
  xai: unconfiguredAdapter("xai"),
  openai: unconfiguredAdapter("openai"),
};
function adapterFor(provider) {
  return PROVIDER_ADAPTERS[provider] || anthropicAdapter;
}

// Emergency kill switches — checked first in the handler, before any model
// call or DB write. A disabled switch returns the same graceful message an
// athlete would see for an ordinary outage; nothing about why is leaked.
const SCOUT_GLOBAL_ENABLED = process.env.SCOUT_GLOBAL_ENABLED !== "false";
const SCOUT_PREMIUM_ENABLED = process.env.SCOUT_PREMIUM_ENABLED !== "false";
const SCOUT_DAILY_SPEND_LIMIT = process.env.SCOUT_DAILY_SPEND_LIMIT_USD ? Number(process.env.SCOUT_DAILY_SPEND_LIMIT_USD) : null;
const SCOUT_MONTHLY_SPEND_LIMIT = process.env.SCOUT_MONTHLY_SPEND_LIMIT_USD ? Number(process.env.SCOUT_MONTHLY_SPEND_LIMIT_USD) : null;

let platformSpendCache = { at: 0, value: null };
const PLATFORM_SPEND_CACHE_TTL_MS = 60 * 1000;

// Best-effort platform-wide spend check, cached per warm instance — a soft
// safety net (a minute of staleness is fine for an emergency brake), not a
// billing source of truth. Reads scout_daily_usage directly (service key
// already bypasses RLS) rather than a dedicated RPC, same pattern as every
// other server-role-only read in this file.
async function getPlatformSpend() {
  const now = Date.now();
  if (platformSpendCache.value && now - platformSpendCache.at < PLATFORM_SPEND_CACHE_TTL_MS) return platformSpendCache.value;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { today: 0, month: 0 };
  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const monthStr = todayStr.slice(0, 7) + "-01";
    const headers = { apikey: key, Authorization: "Bearer " + key };
    const [todayRows, monthRows] = await Promise.all([
      fetch(`${url}/rest/v1/scout_daily_usage?usage_date=eq.${todayStr}&select=total_cost`, { headers }).then((r) => r.json()),
      fetch(`${url}/rest/v1/scout_daily_usage?usage_date=gte.${monthStr}&select=total_cost`, { headers }).then((r) => r.json()),
    ]);
    const sum = (rows) => (Array.isArray(rows) ? rows.reduce((s, row) => s + (Number(row.total_cost) || 0), 0) : 0);
    const value = { today: sum(todayRows), month: sum(monthRows) };
    platformSpendCache = { at: now, value };
    return value;
  } catch {
    return platformSpendCache.value || { today: 0, month: 0 };
  }
}

// Rate limit + idempotency — both in-memory, scoped to one warm serverless
// instance. Real, honest limitation: Vercel can route concurrent requests
// to different instances, so neither guarantees distributed correctness the
// way reserve_scout_question's DB-level atomic increment does for the daily
// limit. What this DOES stop: the common real case of a rapid double-click
// or a retry-storm landing on the same warm instance. The daily-limit
// atomicity below is the real guarantee; this is a best-effort second layer
// on top of it, not a replacement.
const recentRequestsByUser = new Map();
const RATE_LIMIT_MIN_INTERVAL_MS = 3000;
const seenRequestIds = new Map();
const REQUEST_ID_TTL_MS = 5 * 60 * 1000;

function isRateLimited(userId) {
  if (!userId) return false;
  const now = Date.now();
  const last = recentRequestsByUser.get(userId);
  recentRequestsByUser.set(userId, now);
  if (recentRequestsByUser.size > 5000) recentRequestsByUser.clear(); // crude unbounded-growth guard
  return typeof last === "number" && now - last < RATE_LIMIT_MIN_INTERVAL_MS;
}

function isDuplicateRequest(requestId) {
  if (!requestId) return false;
  const now = Date.now();
  for (const [id, at] of seenRequestIds) if (now - at > REQUEST_ID_TTL_MS) seenRequestIds.delete(id);
  if (seenRequestIds.has(requestId)) return true;
  seenRequestIds.set(requestId, now);
  return false;
}

// Generic response cache (migration 054) — only for genuinely
// non-personalized, shared answers (simple_knowledge — the one intent that
// by definition needs no athlete-specific context). Distinct from scout_faq
// (curated, admin-written): this caches actual model output the first time
// a given effective question is answered, keyed by intent+text+lang+tier.
const CACHE_ELIGIBLE_INTENTS = new Set(["simple_knowledge"]);
const RESPONSE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cacheKeyFor(intent, text, lang, tier) {
  return `${intent}:${lang}:${tier}:${String(text || "").trim().toLowerCase().slice(0, 300)}`;
}

async function getCachedResponse(cacheKey) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  try {
    const r = await fetch(`${url}/rest/v1/scout_response_cache?cache_key=eq.${encodeURIComponent(cacheKey)}&expires_at=gte.${encodeURIComponent(new Date().toISOString())}&select=id,response,hit_count`, {
      headers: { apikey: key, Authorization: "Bearer " + key },
    });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows[0]) return null;
    const row = rows[0];
    fetch(`${url}/rest/v1/scout_response_cache?id=eq.${row.id}`, {
      method: "PATCH",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ hit_count: (row.hit_count || 0) + 1 }),
    }).catch(() => {});
    return row.response;
  } catch {
    return null;
  }
}

async function setCachedResponse(cacheKey, intent, tier, response) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/scout_response_cache`, {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ cache_key: cacheKey, intent, model_tier: tier, response, expires_at: new Date(Date.now() + RESPONSE_CACHE_TTL_MS).toISOString() }),
    });
  } catch (e) { console.error("GOLSZ response cache write failed:", e); }
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

// Writes one row to scout_routing_log (migrations 039 + 040 + 044 + 051) per
// real reply — which model actually answered (haiku/sonnet/database), the
// classifier's intent/confidence, real token usage, an estimated dollar
// cost for that one reply, the athlete's subscription tier, (sonnet only)
// why it escalated past Haiku, and (051, Phase 2f) which provider answered
// and which specialist persona was in use. Never the question or answer
// text itself, never a user_id. Powers the Admin Panel's "AI Model Usage"
// card (admin_scout_model_mix()) and monthly cost cards
// (admin_scout_cost_summary()). Self-contained and best-effort, same as
// logError — a logging failure must never affect the real response.
async function logRouting(answeredBy, classification, model, usage, extra) {
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
        plan: (extra && extra.plan) || null,
        escalation_reason: (extra && extra.escalationReason) || null,
        // Anthropic-only until Phase 3 of the AI Scout architecture plan
        // onboards a second provider behind the Phase 2e model registry —
        // hardcoded rather than derived from `model` since every model this
        // file calls today is Anthropic's regardless of which one answered.
        provider: model ? "anthropic" : null,
        specialist: (extra && extra.specialist) || null,
      }),
    });
  } catch (e) { console.error("GOLSZ routing-log write failed:", e); }
}

// Explains, for telemetry only, why a message escalated past Haiku to
// Sonnet — never shown to the athlete. Lets the Admin Panel eventually
// answer "is Sonnet usage actually driven by real complexity, or mostly
// classifier misses/timeouts?" before anyone designs a tier-based Sonnet
// quota around it.
function escalationReason(classification) {
  if (!classification || classification.error) return "classifier_unavailable";
  if (classification.raw) return "classifier_unparseable";
  if (classification.needs_tool) return "needs_tool";
  if (!HAIKU_INTENTS.has(classification.intent)) return "intent_requires_deep_reasoning";
  if (typeof classification.confidence === "number" && classification.confidence < HAIKU_CONFIDENCE_THRESHOLD) return "low_confidence";
  return "haiku_requested_tool"; // only remaining path here: was Haiku-eligible but Haiku itself asked for a tool
}

// Feeds the Admin Panel's "Commonly Asked Questions" view (migration
// 043) — real gaps in scout_faq worth filling over the next 1-6 months
// to grow the $0-cost "database" share of traffic. Deliberately narrow
// on purpose: only called for a genuine FAQ miss (faq_id was null) on
// an intent that could plausibly become a static FAQ answer — never
// for off_topic, profile_assist, agent_workflow, or db_lookup, which
// are personal, action-oriented, or not FAQ-shaped. No user_id or any
// identifying field is ever stored. Best-effort, same as logError.
const FAQ_CANDIDATE_INTENTS = new Set(["simple_knowledge", "career_advice", "scouting_analysis", "player_comparison"]);

async function logFaqMiss(classification, question) {
  if (!classification || !question) return;
  if (classification.faq_id != null) return; // it matched something — not a gap
  if (!FAQ_CANDIDATE_INTENTS.has(classification.intent)) return;
  try {
    const supaUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supaUrl || !serviceKey) return;
    await fetch(`${supaUrl}/rest/v1/scout_faq_misses`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ intent: classification.intent, question: String(question).slice(0, 500) }),
    });
  } catch (e) { console.error("GOLSZ faq-miss log write failed:", e); }
}

// Maps Scout's profile_updates keys (see SYSTEM_PROMPT's "Allowed keys") to the
// real profiles/athletes columns golsz-app.html already seeds Scout's working
// profile from on every mount (golsz-app.html:4807-4830). Writing here closes
// a real gap: previously, anything Scout learned mid-conversation only ever
// lived in that browser tab's React state and was gone on reload/new chat —
// now it lands in the same columns the athlete's own Passport form uses, so
// it survives and Scout (or any future specialist) sees it again next time.
// `age` and `budget`/`goal` are deliberately left out: age has no direct
// column (only dob, and reverse-deriving a birthdate from a guessed age would
// write something less precise than what's already there), and budget/goal
// have no column at all yet — persisting those needs a real schema addition,
// out of scope for this fix. They still work exactly as before for the
// current session (the client still merges profile_updates into its own
// state); they just don't survive a reload yet.
const PROFILE_FIELD_MAP = {
  name: { table: "profiles", column: "full_name" },
  occupation: { table: "profiles", column: "occupation" },
  sport: { table: "athletes", column: "sport" },
  position: { table: "athletes", column: "position" },
  location: { table: "athletes", column: "country" },
  citizenship: { table: "athletes", column: "country" },
  club: { table: "athletes", column: "club_name" },
  level: { table: "athletes", column: "recruiting_status" },
  grad_year: { table: "athletes", column: "grad_year" },
  gpa: { table: "athletes", column: "gpa" },
  license: { table: "athletes", column: "license" },
  looking_for_players: { table: "athletes", column: "looking_for_players" },
  // Real Passport column (migration 018) — moved here from SCOUT_CONTEXT_KEYS,
  // which had accidentally duplicated it as a soft/AI-inferred jsonb key
  // (Failover & Discovery Polish audit finding). A hard, athlete-verified
  // fact belongs in profile_updates, never re-inferred and risked conflicting
  // with the real column.
  education_level: { table: "athletes", column: "education_level" },
};

// Pulls {reply, profile_updates} out of a real Anthropic response the same
// way golsz-app.html's send() already does client-side (strip ```json
// fences, parse the {...} slice) — needed here too now that the server
// itself has to act on profile_updates, not just the client.
function extractProfileUpdates(data) {
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    return parsed && typeof parsed.profile_updates === "object" ? parsed.profile_updates : null;
  } catch {
    return null;
  }
}

// Best-effort, same discipline as logError/logRouting/logFaqMiss above — a
// persistence failure must never affect the real reply already on its way
// back to the athlete. Only ever writes columns the athlete's own Passport
// form already uses (migrations 008/018/020/021), and only ever for the
// signed-in athlete's own row (userId comes from the verified auth token via
// getUserId(), never trusted from the request body).
async function persistProfileUpdates(userId, updates) {
  if (!userId || !updates) return;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey) return;

  const patches = { profiles: {}, athletes: {} };
  for (const [field, value] of Object.entries(updates)) {
    const target = PROFILE_FIELD_MAP[field];
    if (!target || value == null || value === "") continue;
    patches[target.table][target.column] = value;
  }

  const headers = { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" };
  for (const table of ["profiles", "athletes"]) {
    if (!Object.keys(patches[table]).length) continue;
    try {
      await fetch(`${supaUrl}/rest/v1/${table}?id=eq.${userId}`, {
        method: "PATCH", headers, body: JSON.stringify(patches[table]),
      });
    } catch (e) { console.error(`GOLSZ profile-update persist (${table}) failed:`, e); }
  }
}

// The "softer" Athlete Context fields (migration 050, Phase 2a) — things
// Scout infers or is told rather than hard Passport facts. Validated
// against this allowlist before ever reaching merge_scout_context() so a
// malformed/unexpected key from a model response can't write an arbitrary
// jsonb key onto the row.
// height/weight/dominant_side/preferred_countries added for the Multi-Model
// AI Scout & Cost-Control System (approved plan, migration 055 scope);
// secondary_goal/secondary_gaps/scholarship_interest/transfer_interest/
// exposure_need added for the Failover & Discovery Polish pass — all
// additive to the same jsonb column (migration 050), no schema change
// needed beyond this allowlist since scout_context is jsonb.
// education_level is deliberately NOT here — it's a real Passport column
// (migration 018), handled as a hard fact via PROFILE_FIELD_MAP instead;
// it was a naming-collision bug to have it in both places.
const SCOUT_CONTEXT_KEYS = new Set([
  "dream_outcome", "target_level", "target_country", "timeline",
  "perceived_strengths", "perceived_weaknesses", "main_gap", "urgency",
  "confidence", "professional_interest", "college_interest", "trial_interest",
  "height", "weight", "dominant_side", "preferred_countries",
  "secondary_goal", "secondary_gaps", "scholarship_interest", "transfer_interest", "exposure_need",
]);

// Same extraction shape as extractProfileUpdates(), pulling scout_context_updates
// instead of profile_updates out of the same parsed reply.
function extractScoutContextUpdates(data) {
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    return parsed && typeof parsed.scout_context_updates === "object" ? parsed.scout_context_updates : null;
  } catch {
    return null;
  }
}

// Writes to athletes.scout_context via merge_scout_context() (migration
// 050) — never a direct PATCH, since a plain PATCH would replace the whole
// jsonb column and clobber fields this turn didn't touch; the RPC's jsonb
// || merge only overwrites the top-level keys actually present here.
// "source" is never trusted as-is from the model: only "athlete_stated"
// passes through, everything else (including a model claiming "verified")
// defaults to "ai_inferred" — that word is reserved for a real future
// verification pathway, not something the model can self-assign. Same
// best-effort discipline as every other persistX helper in this file.
async function persistScoutContext(userId, updates) {
  if (!userId || !updates) return;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey) return;

  const patch = {};
  const now = new Date().toISOString();
  for (const [field, entry] of Object.entries(updates)) {
    if (!SCOUT_CONTEXT_KEYS.has(field) || entry == null) continue;
    const value = (entry && typeof entry === "object") ? entry.value : entry;
    if (value == null || value === "") continue;
    const source = (entry && typeof entry === "object" && entry.source === "athlete_stated") ? "athlete_stated" : "ai_inferred";
    const confidence = (entry && typeof entry === "object" && typeof entry.confidence === "number") ? entry.confidence : null;
    patch[field] = { value, source, confidence, updated_at: now };
  }
  if (!Object.keys(patch).length) return;

  try {
    await fetch(`${supaUrl}/rest/v1/rpc/merge_scout_context`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId, p_updates: patch }),
    });
  } catch (e) { console.error("GOLSZ scout context persist failed:", e); }
}

// Loose validation only — real security here is that this is a best-effort,
// service-role, non-user-content write; a malformed conversationId just
// fails the uuid column insert and gets caught below. Matches this file's
// existing conventions (persistProfileUpdates etc.), not an injection guard.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The named specialists from the AI Scout architecture plan's Phase 2d —
// "scout" (the generalist persona) is deliberately not a member of this set
// since the classifier only ever names a specialist to hand off TO; null
// (or anything unrecognized) means "stay with Scout," handled as the
// fallback case wherever recommended_specialist is read.
const SPECIALISTS = new Set(["college", "pro_pathway", "development", "eligibility"]);

// Failover & Discovery Polish pass: which stage of the Dream -> Current
// Position -> Gap -> Pathway -> Action discovery sequence this turn is at —
// validated the same way as recommended_specialist, so a malformed/invented
// stage from the model just falls back to null rather than writing garbage.
const CONVERSATION_STAGES = new Set(["discovery", "qualification", "pathway", "action"]);

// Writes the classifier's routing decision (missing_information,
// recommended_specialist — Phase 2c; conversation_stage/next_best_action —
// Failover & Discovery Polish pass) into scout_context's "ai_meta" key.
// Deliberately a full replace of that one key (not an accumulating merge
// like the athlete-fact keys in persistScoutContext) — it's this turn's
// live routing snapshot, not a fact that should persist once stale.
// Reuses the same merge_scout_context() RPC; jsonb || only ever touches
// the "ai_meta" top-level key here, leaving every other scout_context
// field untouched.
async function persistAiMeta(userId, classification) {
  if (!userId) return;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey) return;

  const missing = Array.isArray(classification && classification.missing_information)
    ? classification.missing_information.filter((f) => SCOUT_CONTEXT_KEYS.has(f)).slice(0, 3)
    : [];
  const specialist = (classification && SPECIALISTS.has(classification.recommended_specialist)) ? classification.recommended_specialist : null;
  const stage = (classification && CONVERSATION_STAGES.has(classification.conversation_stage)) ? classification.conversation_stage : null;
  const nextAction = (classification && typeof classification.next_best_action === "string") ? classification.next_best_action.slice(0, 200) : null;
  const aiMeta = {
    missing_information: missing, recommended_specialist: specialist,
    conversation_stage: stage, next_best_action: nextAction,
    updated_at: new Date().toISOString(),
  };

  try {
    await fetch(`${supaUrl}/rest/v1/rpc/merge_scout_context`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId, p_updates: { ai_meta: aiMeta } }),
    });
  } catch (e) { console.error("GOLSZ scout ai_meta persist failed:", e); }
}

// Writes the classifier's updated running summary (migration 049, Phase 2b
// of the AI Scout architecture plan) so Scout() can send bounded recent
// history + this summary instead of an ever-growing full transcript.
// Upserts on conversation_id (its primary key) via PostgREST's
// merge-duplicates resolution. Best-effort, same discipline as
// logError/logRouting/persistProfileUpdates — never lets a write failure
// affect the real reply already on its way back to the athlete.
async function persistScoutSummary(userId, conversationId, summary) {
  if (!userId || !conversationId || !UUID_RE.test(conversationId)) return;
  if (typeof summary !== "string" || !summary.trim()) return;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey) return;
  try {
    await fetch(`${supaUrl}/rest/v1/scout_conversation_summaries`, {
      method: "POST",
      headers: {
        apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ conversation_id: conversationId, user_id: userId, summary: summary.slice(0, 2000), updated_at: new Date().toISOString() }),
    });
  } catch (e) { console.error("GOLSZ scout summary persist failed:", e); }
}

const SYSTEM_PROMPT = `You are GOLSZ Scout, an AI sports agent. Tagline: "Every Goal Has a Path."
You adapt to who you're talking to — check "occupation" in PROFILE SO FAR:
- Player, or occupation missing/unset (default): the personal agent for ONE athlete — learn who they are (age, sport, position, location, club/level, grad year, academics, budget, citizenship, goal), build a career roadmap, suggest realistic target programs (reach/match/safety, honest), and draft coach outreach emails on request (draft-only; the athlete sends them).
- Scout, Agent, or Coach: their assistant for finding and evaluating talent — help them think through what/who they're looking for, then use search_golsz_players to find real athletes actually on GOLSZ matching that (sport/position/country/grad year/gender/recruiting status) before reaching for general web search. Draft outreach messages to a player or their family on request (draft-only; they send it themselves).
- Physio: their assistant for the athletic/sports-medicine side of their work — general injury-prevention and return-to-play information only, never a diagnosis; say so plainly if a question actually needs a real medical professional.
- Other: a general, honest sports-industry assistant — ask what they need help with rather than assuming.
Everything in PROFILE SO FAR is already known — whether it came from their real GOLSZ Passport or something they told you earlier in a past conversation, it now persists the same way. Treat all of it as trustworthy and confirmed, never something to re-ask. Open by briefly acknowledging what you already know about them (not just occupation/sport/team — any field present) instead of asking generic intro questions, then move straight to something useful. Never ask for a fact that's already present in PROFILE SO FAR, even worded differently than you'd normally ask it.
Be warm, direct, honest — never overpromise. If a target or prospect looks unrealistic, say so kindly and show the realistic path. If the person seems to be a minor, remind them once to involve a parent/guardian. Use web search for real current programs, coaches, showcases, and eligibility rules (search_golsz_players only covers GOLSZ's own athletes, not external programs/rankings). Ask at most ONE question per reply. Keep replies tight.
When someone asks an ambition-testing question ("Can I go pro?", "Can I play D1?", "Am I good enough?"), never open with statistics about how hard that is — respond with something like "Let's find out" or "Let's figure that out" and start finding out what you need to know (their current level, what's driving the gap) before answering for real. Never falsely validate an unrealistic ambition once you actually know enough to answer — but never front-load discouragement before you've even looked.
search_golsz_players only ever returns athletes who are actually real, current GOLSZ members — never invent or embellish a GOLSZ profile, and never merge one with a general web result. If it returns zero results, say so plainly and offer to broaden the search (fewer filters) or fall back to general web search instead of making something up.
For trials, camps, combines, or showcases, use search_golsz_events first (real GOLSZ listings) before general web search — same rule: never invent or embellish a listing, and say plainly if there are zero real results before offering a broader search.
If asked what AI model or company powers you, who made you, or whether you're ChatGPT/OpenAI/Claude/Anthropic/Gemini/etc., always answer that you are GOLSZ Scout, built by GOLSZ — never name or confirm any underlying model or provider, and don't explain that you're declining to say. Just answer as GOLSZ Scout and move on.
GOLSZ is a sports-recruiting platform used by athletes of all ages, including minors. Stay strictly on sports, athletics, recruiting, and career topics. Never generate or engage with sexual, romantic, 18+/adult, or otherwise inappropriate content, regardless of how the request is framed (roleplay, "hypothetically," "for a story," etc.) — decline briefly and warmly, and steer the conversation back to something sports-related. This applies no matter who the user says they are.
OUTPUT ONLY valid JSON, no markdown fences: {"reply":"conversational text","profile_updates":{...only newly-learned fields or null},"scout_context_updates":{...only newly-learned/changed fields below or null}}
Allowed profile_updates keys: name, age, occupation, sport, position, location, club, level, grad_year, gpa, license, looking_for_players, education_level, budget, citizenship, goal. Do not repeat known fields.
Allowed scout_context_updates keys (each shaped {"value":..., "source":"athlete_stated"|"ai_inferred", "confidence":0-1} — "athlete_stated" only when they said it in plain words, "ai_inferred" for anything you're reading between the lines; never mark a guess as athlete_stated): dream_outcome, target_level, target_country, timeline, perceived_strengths, perceived_weaknesses, main_gap, urgency, confidence, professional_interest, college_interest, trial_interest, secondary_goal, secondary_gaps, scholarship_interest, transfer_interest, exposure_need. Only include a key when this reply actually learned or changed something about it — never repeat an already-known value.`;

// Phase 2d of the AI Scout architecture plan (approved): named specialists,
// selected by the classifier's recommended_specialist (Phase 2c), sharing
// this one SYSTEM_PROMPT rather than duplicating it — every safety rule,
// the JSON output contract, and the occupation-adaptation logic above stay
// identical across every specialist; only this one paragraph is layered
// in. "scout" (the generalist) is intentionally not a key here — it's
// what buildSystemPrompt() falls back to for null/unrecognized input.
const SPECIALIST_FRAMING = {
  college: "Right now, focus specifically on college recruiting: NCAA/NAIA/JUCO fit, scholarships, target-school lists, and coach outreach to school programs.",
  pro_pathway: "Right now, focus specifically on the professional pathway: pro clubs, trials, exposure, agents, and pro-readiness.",
  development: "Right now, focus specifically on development: training priorities, skill gaps, and performance improvement.",
  eligibility: "Right now, focus specifically on eligibility and compliance: NCAA/NAIA rules, amateurism status, and recruiting-compliance questions. This is informational only, never a substitute for a real compliance officer or official ruling — say so plainly whenever it actually matters.",
};

// basePrompt is SYSTEM_PROMPT, already language-adjusted if needed — the
// anchor string this looks for exists in both cases, so this only ever
// needs to run once, after language adjustment. Falls back to basePrompt
// unchanged for "scout" or any unrecognized/null specialist.
function buildSystemPrompt(basePrompt, specialist) {
  const framing = SPECIALIST_FRAMING[specialist];
  if (!framing) return basePrompt;
  const handoffNote = `SPECIALIST FOCUS: ${framing} If this is the first reply since the focus shifted, acknowledge it naturally in one short clause (e.g. "Since you're asking about school fit, let's look at that properly") — never a jarring "Connecting you to our College Specialist" announcement, and never restart discovery on facts already known.\n`;
  return basePrompt.replace("Everything in PROFILE SO FAR is already known", handoffNote + "Everything in PROFILE SO FAR is already known");
}

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

// Second DB-first tool (migration 055, part of the approved Multi-Model
// plan) — mirrors SEARCH_PLAYERS_TOOL/searchPlayers for real GOLSZ events
// (trials/camps/combines) instead of athletes, so "trials near me" gets a
// real, verified-listing answer instead of falling through to general web
// search or an invented one.
const SEARCH_EVENTS_TOOL = {
  name: "search_golsz_events",
  description: "Search real trials, camps, combines, or showcases listed on GOLSZ (not the general web). Use this whenever someone asks about upcoming events, trials, or opportunities on the platform. All parameters are optional filters — omit any you don't have.",
  input_schema: {
    type: "object",
    properties: {
      sport: { type: "string" },
      location: { type: "string", description: "city, region, or country — partial match" },
      level: { type: "string" },
      limit: { type: "number", description: "max results to return, default 10, capped at 25" },
    },
  },
};

async function searchEvents(input) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { error: "Event search isn't configured on this deployment." };
  try {
    const r = await fetch(url + "/rest/v1/rpc/search_events", {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_sport: input.sport || null,
        p_location: input.location || null,
        p_level: input.level || null,
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
// The EXAMPLES/ESCALATION GUIDANCE content below is real, useful
// classifier guidance (grounded in actual production misclassifications
// this session — the web_lookup-vs-simple_knowledge miss, the off_topic
// anomaly that still needed a tool, etc.) — but it also does double duty
// clearing Haiku 4.5's 4,096-token cache minimum. Measured (Anthropic
// tokenizer, ~106 FAQ entries): base taxonomy + FAQ list alone was only
// ~2,450 tokens — comfortably under the minimum, so this whole block was
// paying full uncached price on every single classification call. This
// content pushes it to ~4,300+ tokens so caching actually applies; as the
// FAQ list keeps growing (the point of the Common Questions workflow),
// it'll clear the minimum on its own even without this block, but no
// reason to wait on that. Verify the real number via
// response.usage.cache_creation_input_tokens on a live classifier call,
// same as every other caching claim in this file — don't just trust that
// adding content worked.
const CLASSIFIER_SYSTEM = `Classify the user's latest message into exactly one intent, separately check it against the FAQ list appended below, and maintain a running conversation summary plus four routing hints. Respond ONLY with compact JSON, no markdown fences: {"intent":"...","confidence":0-1,"needs_tool":true|false,"faq_id":null-or-a-number,"summary_so_far":"...","missing_information":[...],"recommended_specialist":null-or-"...","conversation_stage":"...","next_best_action":"..."}
SUMMARY: the message may open with a "CONVERSATION SUMMARY SO FAR: ..." section describing everything discussed before this turn (empty/absent on a conversation's first message — that's normal, not an error). Produce an updated "summary_so_far": ONE short sentence, 25 words max, covering the prior summary plus what this new message adds — never just repeat the input back, never a numbered list, never multiple sentences. If there's no prior summary and this message alone isn't summary-worthy yet (a greeting, "thanks", etc.), a few words is fine — it does not need to be a full sentence. Never include a literal "}" character anywhere in summary_so_far — it would cut this response off early.
ATHLETE CONTEXT: the message may also include a "PROFILE SO FAR: {...}" section (hard facts already on file) and a "SCOUT CONTEXT SO FAR: {...}" section (softer qualification facts already captured — dream/goal, target level, gap, urgency, interest flags, etc.). Use both plus the summary to fill in:
- "missing_information": an array of up to 3 field names, chosen only from this list, that are NOT already present in either section and would meaningfully help right now: dream_outcome, target_level, target_country, timeline, perceived_strengths, perceived_weaknesses, main_gap, urgency, professional_interest, college_interest, trial_interest, secondary_goal, secondary_gaps, scholarship_interest, transfer_interest, exposure_need. Use an empty array if nothing important is missing, or the conversation doesn't call for asking right now (e.g. off_topic, or the athlete is mid-thought on something else).
- "recommended_specialist": which specialist should likely handle THIS message — one of "college" (NCAA/NAIA/JUCO, scholarships, school fit), "pro_pathway" (professional clubs, trials, agents), "development" (training, skill gaps, performance), "eligibility" (NCAA rules, amateurism, compliance) — or null when the general Scout persona is clearly still right (most messages). Base this only on what the current message is actually asking, not the athlete's whole history.
- "conversation_stage": one of "discovery" (still learning who they are/what they want), "qualification" (understanding their gap/situation in depth), "pathway" (discussing realistic routes/programs), "action" (drafting outreach, a concrete next step) — your best read of where THIS conversation is right now.
- "next_best_action": a short (under 10 words) plain-language note on what would most help next turn (e.g. "ask about academics", "suggest 2-3 target schools") — internal routing signal only, never shown to the athlete.
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
needs_tool is true whenever the intent is web_lookup or db_lookup, or answering well otherwise requires search_golsz_players or web_search.

EXAMPLES (message -> correct classification):
"What does offside mean in soccer?" -> {"intent":"simple_knowledge","confidence":0.95,"needs_tool":false,"faq_id":null}
"What changed in NCAA transfer rules this year?" -> {"intent":"web_lookup","confidence":0.9,"needs_tool":true,"faq_id":null} (real traffic showed this pattern getting missed as simple_knowledge — "this year"/"changed" means it needs a live lookup)
"Find me strikers born in 2008 from Texas on GOLSZ" -> {"intent":"db_lookup","confidence":0.9,"needs_tool":true,"faq_id":null}
"Can you help me with my algebra homework?" -> {"intent":"off_topic","confidence":0.95,"needs_tool":false,"faq_id":null}
"Given my profile, what should my next 3 months look like?" -> {"intent":"career_advice","confidence":0.85,"needs_tool":false,"faq_id":null} (references their own specific profile — too personalized for a stored FAQ answer)
"Who's the better prospect, me or the kid who plays my position on my team?" -> {"intent":"player_comparison","confidence":0.85,"needs_tool":false,"faq_id":null}
"Can you draft an email to Coach Smith about my interest in the program?" -> {"intent":"agent_workflow","confidence":0.9,"needs_tool":false,"faq_id":null}
"I've got Cyprus First Division academy experience, an agent, and an EU passport coming — how do I keep moving up and jump to a German or Greek club instead of getting stuck behind cheaper foreign signings?" -> {"intent":"career_advice","confidence":0.88,"needs_tool":false,"faq_id":null} (REAL production miss: this got matched to the generic "what does the path to pro look like" FAQ despite being intent:"career_advice" — a wrong, generic answer that ignored the athlete's actual situation and left them confused. faq_id must always be null whenever intent isn't simple_knowledge, full stop — no exceptions for surface-level topic overlap.)
"How does a player actually get scouted onto one of those elite academy teams?" -> if the FAQ list below (provided fresh with every request — never rely on a memorized id) contains an entry meaning the same thing (e.g. explaining a youth development platform's entry process), set faq_id to THAT entry's real id from the list, even though this wording shares almost no words with it — match by meaning, never by memorized wording or a guessed id number.
"Is it bad for my kid to play more than one sport instead of focusing on one?" -> same principle: if the current FAQ list has an entry about single-sport specialization vs. multi-sport play, match it despite the very different phrasing here. Always re-check the actual list provided in this request; never assume an id from a past conversation or example.
"What's my profile missing that I should fill in?" -> {"intent":"profile_assist","confidence":0.9,"needs_tool":false,"faq_id":null} (about their own specific profile, not a general question — never faq_id even if topically close to a stored FAQ)
"Is this kid actually good enough for a D1 program?" -> {"intent":"scouting_analysis","confidence":0.85,"needs_tool":false,"faq_id":null}
"What tournaments are happening near me this month?" -> {"intent":"web_lookup","confidence":0.85,"needs_tool":true,"faq_id":null}
"lol ok whatever, tell me a joke instead" -> {"intent":"off_topic","confidence":0.95,"needs_tool":false,"faq_id":null}
"What's the actual difference between an athletic scholarship and financial aid, and can I get both?" -> a close paraphrase of a stored FAQ still counts as a match — check the list below for the closest real id, don't invent one.
"My son is 11 and dominating his age group — should he move up to play with older kids?" -> {"intent":"career_advice","confidence":0.8,"needs_tool":false,"faq_id":null} (mentions a myth-adjacent topic but includes specific personal detail — a judgment call, not a lookup, so career_advice not simple_knowledge, and no faq_id since it needs a personalized answer)
"How do I know if a private coach is worth the money for my situation?" -> {"intent":"career_advice","confidence":0.75,"needs_tool":false,"faq_id":null} (asks for a judgment applied to "my situation," not the general question — lower confidence since it's borderline)
"What's a redshirt year and would it make sense for someone like me?" -> {"intent":"career_advice","confidence":0.7,"needs_tool":false,"faq_id":null} (the definition half matches a stored FAQ, but "someone like me" makes this a personalized judgment call overall — don't set faq_id just because part of the message is FAQ-shaped)

"Qu'est-ce que le hors-jeu au football?" -> {"intent":"simple_knowledge","confidence":0.9,"needs_tool":false,"faq_id":null} (non-English messages classify the same way — language never changes the intent taxonomy, only which language's FAQ list to check against)
"¿Debería mi hija especializarse en un solo deporte?" -> {"intent":"simple_knowledge","confidence":0.85,"needs_tool":false,"faq_id":null} (would match a Spanish-language FAQ row if one exists for this question; matches only within the same lang, never across languages)
"what" -> {"intent":"off_topic","confidence":0.4,"needs_tool":false,"faq_id":null} (too short/ambiguous to confidently classify — low confidence rather than guessing a specific intent)
"Can you look up whether Coach Martinez at State is still recruiting my grad year?" -> {"intent":"web_lookup","confidence":0.85,"needs_tool":true,"faq_id":null} (a specific, real-time fact about one named coach/program — not a stored FAQ candidate no matter how it's worded)

ESCALATION GUIDANCE (when torn between two intents or confidence levels):
- A message that needs search_golsz_players or web_search is never simple_knowledge/profile_assist/agent_workflow/player_comparison, regardless of how it's phrased — needs_tool always wins.
- Confidence should drop (below 0.7) whenever the message mixes a general question with the user's own specific situation, references prior conversation turns that change what's being asked, or could reasonably belong to two different intents at once.
- Never set faq_id just because part of a longer message resembles a stored FAQ — only when the ENTIRE question is answered by that FAQ with nothing personalized left over.
- A message containing multiple distinct questions (e.g. a general question plus a personal follow-up in the same turn) should classify by whichever part needs the more capable handling — if any part needs personalization, tool use, or judgment, that part decides the intent even if the other part alone would have been a simple lookup.
- When a message is a near-exact repeat of an earlier turn in the same conversation (the user re-asking because the last answer didn't land), treat that as a signal to escalate rather than repeat the same routing decision — a repeated question is evidence the cheaper path already failed once.
- If a message reads as satisfied or a simple acknowledgment of a previous answer ("thanks," "got it," "makes sense") rather than a new question, classify it as off_topic with high confidence and needs_tool false — there's nothing to look up or reason about, and it should never be treated as db_lookup, web_lookup, or any tool-needing intent just because the prior turn was.
- A message that names a specific real person, team, school, or organization by name (not a general category) and asks a factual question about them almost always needs web_lookup, even if the underlying topic sounds generic — "what division is State University in" needs a real lookup even though "what's the difference between divisions" is simple_knowledge.
- Treat an image attached to the message the same as any other content when deciding intent — a photo of a highlight reel thumbnail or a stat sheet accompanying a career_advice-shaped question doesn't change the intent, but a photo with no real question attached (just "what do you think?") should default to career_advice or scouting_analysis depending on who's asking, never simple_knowledge.`;

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
    const { ok, data } = await callAnthropic(key, {
      model: MODEL_REGISTRY.FAST_CHAT.model,
      // max_tokens was 100, then 350, then 450, then 300 — now 350: the
      // Failover & Discovery Polish pass added two more short fields
      // (conversation_stage, next_best_action) to the JSON contract, which
      // need a little more room than the 300 budget that was tuned for the
      // previous (smaller) schema.
      maxTokens: 350,
      // Real traffic showed Haiku sometimes treating the classification
      // request as a conversation to actually help with, rambling on past
      // the JSON (e.g. "...}```\n\nI can help you draft that email...").
      // The schema is always a flat, single-level object — exactly one
      // closing brace — so stopping generation right there is a hard
      // guarantee against trailing chatter, not just a prompt request.
      stopSequences: ["}"],
      system: buildClassifierSystem(faqList),
      messages: [{ role: "user", content: text.slice(0, 2000) }],
    });
    if (!ok) return { error: data };
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

// Real production traffic caught the classifier setting BOTH
// intent: "career_advice" (correctly recognizing a personalized question —
// specific club/league/attributes, wanting Germany/Greece specifically)
// AND a faq_id, serving a generic canned answer that had nothing to do
// with the athlete's actual situation. The prompt already said not to do
// this ("leave null if the user adds their own specific details") but a
// soft instruction isn't a guarantee — this is the hard, code-level one.
// faq_id is only ever trusted for simple_knowledge — a genuinely generic,
// non-personalized question is the only shape a static FAQ answer can
// honestly stand in for. Every other intent (career_advice,
// scouting_analysis, player_comparison, etc.) always gets a real answer,
// no matter what faq_id the classifier returns.
const FAQ_ELIGIBLE_INTENTS = new Set(["simple_knowledge"]);
const FAQ_CONFIDENCE_THRESHOLD = 0.85;

function shouldUseFaqMatch(classification) {
  if (!classification || classification.error || classification.raw) return false;
  if (classification.faq_id == null) return false;
  if (!FAQ_ELIGIBLE_INTENTS.has(classification.intent)) return false;
  if (typeof classification.confidence === "number" && classification.confidence < FAQ_CONFIDENCE_THRESHOLD) return false;
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

// Read plan + admin flag + the admin-granted unlimited-AI override
// (migration 045, profiles.ai_unlimited — separate from is_admin, lets an
// admin lift one athlete's Scout ceiling without touching their plan or
// giving them Admin Panel access). Returns { plan, isAdmin, aiUnlimited }.
// Usage reservation is now a separate call (reserveScoutQuestion, migration
// 053) — splitting these two concerns lets the handler know the plan's
// limit BEFORE atomically reserving against it, instead of the old
// increment_scout_usage() incrementing blind and checking after, which had
// a real check-then-act race between concurrent requests near the limit.
async function getProfileMeta(userId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !userId) return { plan: "unknown", isAdmin: false, aiUnlimited: false };
  const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
  let plan = "starter";
  let isAdmin = false;
  let aiUnlimited = false;
  try {
    const p = await fetch(url + "/rest/v1/profiles?id=eq." + userId + "&select=plan,is_admin,ai_unlimited", { headers });
    const rows = await p.json();
    if (Array.isArray(rows) && rows[0]) {
      plan = rows[0].plan || "starter";
      isAdmin = !!rows[0].is_admin;
      aiUnlimited = !!rows[0].ai_unlimited;
    }
  } catch {}
  return { plan, isAdmin, aiUnlimited };
}

// Atomic reserve-and-check (migration 053) — one statement, row-locked by
// Postgres for its duration, so a concurrent second request genuinely waits
// instead of racing a separate check. Fails OPEN (allowed: true) on our own
// metering outage — a Supabase hiccup should never block a real athlete's
// question over our bookkeeping.
async function reserveScoutQuestion(userId, limit) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !userId) return { allowed: true, used: 0, limit };
  try {
    const r = await fetch(url + "/rest/v1/rpc/reserve_scout_question", {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId, p_plan_limit: limit }),
    });
    const data = await r.json();
    return data && typeof data === "object" ? data : { allowed: true, used: 0, limit };
  } catch {
    return { allowed: true, used: 0, limit };
  }
}

// Gives the reserved slot back when a request was counted but never
// produced a real answer (provider failure, upstream error) — "retries
// caused by provider failures must not count as additional user
// questions." Best-effort, same discipline as every other persistX/logX
// helper in this file.
async function releaseScoutQuestion(userId) {
  if (!userId) return;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  try {
    await fetch(url + "/rest/v1/rpc/release_scout_question", {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId }),
    });
  } catch (e) { console.error("GOLSZ release_scout_question failed:", e); }
}

// Adds the real token/cost numbers to today's scout_daily_usage row once a
// reply actually completes — separate from reservation since the cost
// isn't known until after the model responds.
async function recordScoutUsageCost(userId, cost, inputTokens, outputTokens) {
  if (!userId) return;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  try {
    await fetch(url + "/rest/v1/rpc/record_scout_usage_cost", {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId, p_cost: cost || 0, p_input_tokens: inputTokens || 0, p_output_tokens: outputTokens || 0 }),
    });
  } catch (e) { console.error("GOLSZ record_scout_usage_cost failed:", e); }
}

// Runs the full Sonnet/DEEP_SCOUT tool-loop against a COPY of the given
// conversation (Automatic Failover, Failover & Discovery Polish pass) — a
// failed attempt never leaves partial tool-call turns behind for a
// subsequent retry to trip over. Returns the same {ok, data} shape as
// callAnthropic()/adapter.generate() so the handler's retry/fallback logic
// can treat a whole-reply attempt uniformly.
async function runDeepReply(key, deepTierConfig, systemPrompt, baseConversation) {
  const conversation = baseConversation.slice();
  const MAX_TOOL_TURNS = 4;
  let data;
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const result = await callAnthropic(key, {
      model: deepTierConfig.model_name || MODEL_REGISTRY.DEEP_SCOUT.model,
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
      system: systemPrompt,
      messages: conversation,
      maxTokens: deepTierConfig.max_output_tokens,
      tools: [{ type: "web_search_20250305", name: "web_search" }, SEARCH_PLAYERS_TOOL, SEARCH_EVENTS_TOOL],
    });
    data = result.data;
    if (!result.ok) return { ok: false, data };
    console.log("GOLSZ scout usage check:", JSON.stringify(data.usage));

    const searchCalls = (data.content || []).filter((b) => b.type === "tool_use" && (b.name === "search_golsz_players" || b.name === "search_golsz_events"));
    if (data.stop_reason !== "tool_use" || !searchCalls.length) return { ok: true, data };

    conversation.push({ role: "assistant", content: data.content });
    const results = await Promise.all(searchCalls.map(async (call) => ({
      type: "tool_result",
      tool_use_id: call.id,
      content: JSON.stringify(call.name === "search_golsz_events" ? await searchEvents(call.input || {}) : await searchPlayers(call.input || {})),
    })));
    conversation.push({ role: "user", content: results });
  }
  if (data.stop_reason === "tool_use") {
    // Hit MAX_TOOL_TURNS still mid-tool-call — the client only renders
    // text content, so returning this as-is would show an empty bubble
    // (the exact bug fixed elsewhere in this file's history). Force one
    // final answer with no tools available instead of looping forever.
    const result = await callAnthropic(key, {
      model: deepTierConfig.model_name || MODEL_REGISTRY.DEEP_SCOUT.model,
      thinking: { type: "disabled" },
      system: systemPrompt,
      messages: conversation,
      maxTokens: deepTierConfig.max_output_tokens,
    });
    if (!result.ok) return { ok: false, data: result.data };
    data = result.data;
  }
  return { ok: true, data };
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Emergency global kill switch — checked before anything else, including
  // the API key check, so flipping SCOUT_GLOBAL_ENABLED=false takes effect
  // even in a misconfigured deployment. Same graceful message an athlete
  // would see for an ordinary outage; nothing about why is leaked.
  if (!SCOUT_GLOBAL_ENABLED) return res.status(503).json({ error: "Scout is temporarily unavailable. Please try again shortly." });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY" });

  // body: { messages: [...] }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const messages = body && body.messages;
  if (!Array.isArray(messages)) return res.status(400).json({ error: "messages[] required" });
  const MAX_MESSAGE_LENGTH = 4000;
  const incomingText = latestUserText(messages);
  if (incomingText && incomingText.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ error: "Message is too long." });
  const langName = LANG_NAMES[body && body.lang];
  // Language-adjusted only — the specialist framing (Phase 2d) is layered
  // in below, once recommendedSpecialist is known from classification.
  const baseSystemPrompt = langName && langName !== "English"
    ? `${SYSTEM_PROMPT}\n\nRespond in ${langName} — the athlete has GOLSZ set to ${langName}. Keep the same JSON output shape; only the "reply" text and any drafted email should be in ${langName}.`
    : SYSTEM_PROMPT;

  // ---- optional auth + metering (enabled only when Supabase env is set) ----
  // Four tiers, all capped (Elite is a higher ceiling, not unlimited —
  // see CLAUDE.md, this changed from an earlier uncapped-Elite design).
  // `plan` holds 'free'|'starter'|'pro'|'elite' (the live plan_tier enum —
  // migration 048 added 'free' as a real fourth tier below Starter), so
  // anything unrecognized falls through to the Free limit rather than
  // accidentally going uncapped.
  // Hoisted out of the block below so the routing/answer logic further down
  // can also use it — persistProfileUpdates() needs the same verified id,
  // never a value trusted from the request body.
  let userId = null;
  let userPlan = null; // threaded down to logRouting() below — pure telemetry, no gating logic depends on it yet
  let dailyLimit = null;
  let questionsRemaining = null; // null = no usage info to show the client (unmetered deployment, or an unlimited/admin account)
  let reservedQuestion = false; // true once reserve_scout_question has counted this request — release it if we bail before a real answer
  if (process.env.SUPABASE_URL) {
    userId = await getUserId(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: "Sign in to use the Scout." });

    // Burst protection + duplicate-submission guard — see the comment above
    // isRateLimited()/isDuplicateRequest() for the honest limits of an
    // in-memory, single-instance check.
    if (isRateLimited(userId)) return res.status(429).json({ error: "Please wait a moment before sending another message." });
    const requestId = body && typeof body.requestId === "string" ? body.requestId : null;
    if (isDuplicateRequest(requestId)) return res.status(409).json({ error: "That message is already being processed." });

    // Emergency platform-wide spend ceiling — checked before reserving a
    // question, so a tripped budget never counts against the athlete's own
    // daily allowance.
    if (SCOUT_DAILY_SPEND_LIMIT || SCOUT_MONTHLY_SPEND_LIMIT) {
      const spend = await getPlatformSpend();
      const overBudget = (SCOUT_DAILY_SPEND_LIMIT && spend.today >= SCOUT_DAILY_SPEND_LIMIT) || (SCOUT_MONTHLY_SPEND_LIMIT && spend.month >= SCOUT_MONTHLY_SPEND_LIMIT);
      if (overBudget) return res.status(503).json({ error: "Scout is temporarily unavailable. Please try again shortly." });
    }

    // Four tiers, all capped (Elite is a higher ceiling, not unlimited —
    // see CLAUDE.md, this changed from an earlier uncapped-Elite design).
    // `plan` holds 'free'|'starter'|'pro'|'elite' (the live plan_tier enum —
    // migration 048 added 'free' as a real fourth tier below Starter), so
    // anything unrecognized falls through to the Free limit rather than
    // accidentally going uncapped.
    const { plan, isAdmin, aiUnlimited } = await getProfileMeta(userId);
    userPlan = plan;
    dailyLimit = plan === "elite" ? Number(process.env.ELITE_DAILY_LIMIT || 20)
      : plan === "pro" ? Number(process.env.PRO_DAILY_LIMIT || 15)
      : plan === "starter" ? Number(process.env.STARTER_DAILY_LIMIT || 8)
      : Number(process.env.FREE_DAILY_LIMIT || 3);

    if (!isAdmin && !aiUnlimited) {
      const reservation = await reserveScoutQuestion(userId, dailyLimit);
      reservedQuestion = true;
      questionsRemaining = Math.max(dailyLimit - (Number(reservation.used) || 0), 0);
      if (!reservation.allowed) {
        const message = plan === "elite"
          ? "Daily Scout limit reached. Check back tomorrow."
          : plan === "pro"
          ? "Daily Scout limit reached. Upgrade to Elite for more Scout messages."
          : plan === "starter"
          ? "Daily Scout limit reached. Upgrade to Pro or Elite for more Scout messages."
          : "Free daily limit reached. Upgrade for more Scout messages.";
        return res.status(402).json({ error: message, scout_usage: { remaining: 0, limit: dailyLimit } });
      }
    }
  }

  // ---- route (classify — with the FAQ list embedded — then decide the model) ----
  const conversation = messages.slice();
  const faqLang = LANG_NAMES[body && body.lang] ? body.lang : "en";

  try {
    const faqList = await getFaqList(faqLang);
    // 4.5s cap (was 3.5s — raised after real traffic showed the classifier
    // timing out often enough to matter for cost: adding summary_so_far/
    // missing_information/recommended_specialist this session made it do
    // more work per call, and every timeout falls through to a full Sonnet
    // reply as a safety net, which costs ~6x a Haiku reply for no reason
    // beyond the classifier being slow). If it still times out,
    // classification is null and shouldRouteToHaiku(null) safely falls
    // through to the proven Sonnet path below — this is a latency budget
    // increase, not a behavior change.
    const classification = await withTimeout(classifyIntent(key, conversation, faqList), 4500);
    console.log("GOLSZ scout routing:", JSON.stringify(classification));

    // Phase 2b: the classifier call above also maintains a running
    // conversation summary (see CLASSIFIER_SYSTEM) so Scout() can send
    // bounded recent history instead of the full transcript. Falls back to
    // whatever summary the client already had if this turn's classification
    // didn't produce a usable one (timeout, parse failure, etc.) — the
    // summary just doesn't advance that turn rather than being lost.
    const priorSummary = (body && typeof body.summary === "string") ? body.summary : "";
    const updatedSummary = (classification && typeof classification.summary_so_far === "string" && classification.summary_so_far.trim())
      ? classification.summary_so_far.trim()
      : priorSummary;
    if (userId && body && typeof body.conversationId === "string") {
      await persistScoutSummary(userId, body.conversationId, updatedSummary);
    }
    // Phase 2c: the classifier's missing_information/recommended_specialist
    // hints, written to scout_context.ai_meta regardless of which path below
    // ends up answering — routing metadata, not an answer-dependent fact.
    await persistAiMeta(userId, classification);
    const recommendedSpecialist = (classification && SPECIALISTS.has(classification.recommended_specialist)) ? classification.recommended_specialist : null;
    // Phase 2d: the actual specialist hand-off — everything downstream
    // (Haiku path, Sonnet path) uses this instead of baseSystemPrompt.
    const systemPrompt = buildSystemPrompt(baseSystemPrompt, recommendedSpecialist);

    // ---- Database path: a real $0-AI-cost answer, matched by MEANING (not
    // exact wording) inside the classification call above, before any real
    // answering model runs. ----
    const faqMatch = shouldUseFaqMatch(classification)
      ? faqList.find((f) => f.id === classification.faq_id)
      : null;
    if (faqMatch) {
      console.log("GOLSZ scout FAQ match:", JSON.stringify({ id: faqMatch.id, question: faqMatch.question }));
      const payload = {
        content: [{ type: "text", text: JSON.stringify({ reply: faqMatch.answer, profile_updates: null }) }],
        stop_reason: "end_turn",
        scout_summary: updatedSummary,
        scout_usage: reservedQuestion ? { remaining: questionsRemaining, limit: dailyLimit } : undefined,
      };
      await logRouting("database", classification, null, { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }, { plan: userPlan, specialist: recommendedSpecialist });
      return res.status(200).json(payload);
    }
    await logFaqMiss(classification, latestUserText(conversation));

    // ---- Multi-Model tier selection (approved Cost-Control plan) ----
    // Picks economy/standard/advanced/premium on top of the existing,
    // production-validated Haiku/Sonnet gate (shouldRouteToHaiku, inside
    // selectModelTier) instead of replacing it — see that function's own
    // comment for what's genuinely new (a plan cap can force a non-tool
    // Sonnet-bound question down to Haiku; a real cost lever, not just
    // bookkeeping). planForRouting defaults to "elite" (no cap) rather than
    // "free" when Supabase isn't configured, so a deployment with no plan
    // enforcement at all doesn't silently start capping quality either.
    const planForRouting = userPlan || "elite";
    const latestText = latestUserText(conversation);
    const complexity = complexityScore({ text: latestText, classification });
    let modelTier = selectModelTier({ plan: planForRouting, classification, score: complexity }).tier;
    if (modelTier === "premium" && !SCOUT_PREMIUM_ENABLED) modelTier = "advanced";
    const estimatedInputTokens = Math.ceil((JSON.stringify(conversation).length + systemPrompt.length) / 4);
    modelTier = await budgetGate(modelTier, planForRouting, estimatedInputTokens);
    const byTier = await getModelConfigByTier();
    const tierConfig = byTier[modelTier] || ANTHROPIC_DEFAULTS[modelTier];
    const useHaiku = modelTier === "economy" || modelTier === "standard";
    console.log("GOLSZ scout tier:", JSON.stringify({ tier: modelTier, score: complexity, plan: userPlan }));

    // ---- Generic response cache (migration 054) — only for genuinely
    // non-personalized, shared answers (simple_knowledge). ----
    let cacheKey = null;
    if (classification && CACHE_ELIGIBLE_INTENTS.has(classification.intent)) {
      cacheKey = cacheKeyFor(classification.intent, latestText, faqLang, modelTier);
      const cached = await getCachedResponse(cacheKey);
      if (cached) {
        console.log("GOLSZ scout cache hit");
        await logRouting("database", classification, null, { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }, { plan: userPlan, specialist: recommendedSpecialist });
        cached.scout_summary = updatedSummary;
        if (reservedQuestion) cached.scout_usage = { remaining: questionsRemaining, limit: dailyLimit };
        return res.status(200).json(cached);
      }
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
    // haikuFailureReason is set ONLY on a genuine Haiku provider error (not a
    // normal "Haiku wanted a tool" escalation) — carried into the eventual
    // Sonnet logRouting call below so a real failover shows up distinctly
    // from an ordinary routing decision in scout_routing_log.escalation_reason
    // (Automatic Failover, Failover & Discovery Polish pass).
    let haikuFailureReason = null;
    if (useHaiku) {
      const adapter = adapterFor(tierConfig.provider);
      const { ok, data } = await adapter.generate({
        apiKey: key,
        model: tierConfig.model_name || MODEL_REGISTRY.FAST_CHAT.model,
        system: systemPrompt,
        messages: conversation,
        maxTokens: tierConfig.max_output_tokens,
        tools: [{ type: "web_search_20250305", name: "web_search" }, SEARCH_PLAYERS_TOOL, SEARCH_EVENTS_TOOL],
      });
      if (ok && data.stop_reason !== "tool_use") {
        console.log("GOLSZ scout usage check (haiku):", JSON.stringify(data.usage));
        const cost = estimateCost(tierConfig.model_name, data.usage);
        const profileUpdates = extractProfileUpdates(data);
        const scoutContextUpdates = extractScoutContextUpdates(data);
        await logRouting("haiku", classification, tierConfig.model_name, data.usage, { plan: userPlan, specialist: recommendedSpecialist });
        await recordScoutUsageCost(userId, cost, data.usage && data.usage.input_tokens, data.usage && data.usage.output_tokens);
        await persistProfileUpdates(userId, profileUpdates);
        await persistScoutContext(userId, scoutContextUpdates);
        data.scout_summary = updatedSummary;
        if (reservedQuestion) data.scout_usage = { remaining: questionsRemaining, limit: dailyLimit };
        if (cacheKey && !profileUpdates && !scoutContextUpdates) await setCachedResponse(cacheKey, classification.intent, modelTier, data);
        return res.status(200).json(data);
      }
      if (!ok) {
        haikuFailureReason = "haiku_provider_failure";
        console.log("GOLSZ haiku call failed, escalating to sonnet:", JSON.stringify(data));
      } else {
        console.log("GOLSZ haiku escalated to sonnet (wanted a tool)");
      }
    }

    // ---- Sonnet path (model / prompt / tools owned here, not the client) ----
    // web_search_20250305 is server-hosted — Anthropic runs it and just hands
    // back the result, no action needed here. search_golsz_players/
    // search_golsz_events are ours, so when the model calls one we have to
    // execute it and send the result back as a new turn ourselves; loop
    // until it stops asking for a tool (capped so a stuck loop can't run
    // away with the request/the bill). deepTierConfig falls back to the
    // "advanced" row when the Haiku attempt above escalated here (economy/
    // standard have no Sonnet-side row of their own).
    const deepTierConfig = useHaiku ? (byTier.advanced || ANTHROPIC_DEFAULTS.advanced) : tierConfig;

    let sonnetResult = await runDeepReply(key, deepTierConfig, systemPrompt, conversation);
    if (!sonnetResult.ok) {
      // Automatic failover, step 1: retry the WHOLE reply once, from a fresh
      // conversation copy (runDeepReply never mutates the caller's array) —
      // never resume mid-tool-exchange after a failure.
      console.log("GOLSZ sonnet call failed, retrying once:", JSON.stringify(sonnetResult.data));
      sonnetResult = await runDeepReply(key, deepTierConfig, systemPrompt, conversation);
    }

    if (!sonnetResult.ok) {
      // Automatic failover, step 2: cross-model fallback to a plain,
      // no-tools Haiku reply. Never invents search results/listings while
      // degraded — explicitly told to say so plainly instead (spec: "return
      // a transparent message rather than inventing current information").
      console.log("GOLSZ sonnet retry also failed, falling back to haiku:", JSON.stringify(sonnetResult.data));
      const fallbackSystem = systemPrompt + "\n\nNOTE: Live database/web search is temporarily unavailable. Give the best general guidance you can and say plainly that real-time GOLSZ search isn't available right now — never invent specific results, listings, or players.";
      const fastCfg = byTier.economy || ANTHROPIC_DEFAULTS.economy;
      const haikuFallback = await adapterFor(fastCfg.provider).generate({
        apiKey: key,
        model: fastCfg.model_name || MODEL_REGISTRY.FAST_CHAT.model,
        system: fallbackSystem,
        messages: conversation,
        maxTokens: fastCfg.max_output_tokens,
      });
      if (haikuFallback.ok) {
        const data = haikuFallback.data;
        console.log("GOLSZ scout usage check (haiku fallback):", JSON.stringify(data.usage));
        const cost = estimateCost(fastCfg.model_name, data.usage);
        await logRouting("haiku", classification, fastCfg.model_name, data.usage, { plan: userPlan, escalationReason: "sonnet_provider_failure", specialist: recommendedSpecialist });
        await recordScoutUsageCost(userId, cost, data.usage && data.usage.input_tokens, data.usage && data.usage.output_tokens);
        await persistProfileUpdates(userId, extractProfileUpdates(data));
        await persistScoutContext(userId, extractScoutContextUpdates(data));
        data.scout_summary = updatedSummary;
        if (reservedQuestion) data.scout_usage = { remaining: questionsRemaining, limit: dailyLimit };
        // Deliberately never cached — a degraded, apologetic reply shouldn't
        // get served back to a different athlete once things recover.
        return res.status(200).json(data);
      }

      // Automatic failover, step 3 (both models down): stop here — never
      // loop further (spec: "Never endlessly retry providers"). Release the
      // reserved question (no real answer was produced) and fail gracefully,
      // same wording/status as the emergency kill-switch responses above.
      console.log("GOLSZ haiku fallback also failed:", JSON.stringify(haikuFallback.data));
      if (reservedQuestion) await releaseScoutQuestion(userId);
      await logError("api/scout.js", "Both Sonnet and Haiku failed (automatic failover exhausted)", { detail: JSON.stringify({ sonnet: sonnetResult.data, haiku: haikuFallback.data }) });
      return res.status(503).json({ error: "Scout is temporarily unavailable. Please try again shortly." });
    }

    const data = sonnetResult.data;
    const sonnetCost = estimateCost(deepTierConfig.model_name, data.usage);
    await logRouting("sonnet", classification, deepTierConfig.model_name, data.usage, { plan: userPlan, escalationReason: haikuFailureReason || escalationReason(classification), specialist: recommendedSpecialist });
    await recordScoutUsageCost(userId, sonnetCost, data.usage && data.usage.input_tokens, data.usage && data.usage.output_tokens);
    await persistProfileUpdates(userId, extractProfileUpdates(data));
    await persistScoutContext(userId, extractScoutContextUpdates(data));
    data.scout_summary = updatedSummary;
    if (reservedQuestion) data.scout_usage = { remaining: questionsRemaining, limit: dailyLimit };
    return res.status(200).json(data); // Anthropic-shaped { content: [...] } — client already parses this
  } catch (e) {
    if (reservedQuestion) await releaseScoutQuestion(userId);
    await logError("api/scout.js", "Upstream model call failed", { detail: String(e) });
    return res.status(502).json({ error: "Upstream model call failed", detail: String(e) });
  }
}
