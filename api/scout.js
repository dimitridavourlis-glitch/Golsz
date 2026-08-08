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
//   FREE_LIFETIME_LIMIT      total Scout calls EVER on the free plan, never
//                            resets (default 40) — separate from
//                            FREE_DAILY_LIMIT, see migration 068
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

// THE fix for "Connection dropped mid-play." A single Scout message is not
// one model call — it's a classifier call (bounded at 4.5s below), then
// runDeepReply()'s tool loop, which can legitimately make up to 4 Sonnet
// calls with server-side web search plus a 5th forced final answer, and on
// a provider failure the whole thing retries once. Without this export,
// Vercel applied its DEFAULT function timeout (10s), so the platform killed
// the function mid-flight on any reply that needed real search — the client
// saw the fetch fail and showed the generic "connection dropped" fallback,
// even though nothing was actually wrong with the connection OR the model
// (server logs showed the Anthropic calls succeeding right up to the kill).
// 60s is the Hobby-plan ceiling and is valid on every paid plan too.
// SCOUT_BUDGET_MS below keeps our own work inside this window so we always
// return a real reply rather than relying on the platform limit as a
// backstop.
export const config = { maxDuration: 60 };

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Total server-side wall-clock budget for one Scout request, kept safely
// under `maxDuration` above so we finish and respond ourselves instead of
// being killed. runDeepReply() checks the remaining budget before starting
// another tool turn (and the handler before spending it on a retry), so a
// slow/greedy tool loop degrades into "answer with what you have now"
// rather than into a dead request.
const SCOUT_BUDGET_MS = 50000;
// Don't start another tool turn unless there's plausibly room for it plus
// the forced final answer — a Sonnet call with web search commonly runs
// 8-12s, so below this we stop looping and go straight to the final answer.
const TOOL_TURN_MIN_MS = 14000;

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
// `system` is the STATIC prefix and carries the cache breakpoint; the optional
// `systemDynamic` is appended as a second, UNCACHED system block.
//
// Why: cache_control used to wrap the entire system prompt, which contains the
// athlete's own record — so every athlete had a unique prefix and each
// conversation paid to WRITE ~9-20k tokens (billed at 1.25x input) that were
// then read only a handful of times. Measured on real traffic: cache writes
// were ~85% of the cost of a Sonnet reply, avg $0.086 and up to $0.40.
// Splitting the breakpoint lets the persona/capabilities/plan prefix be cached
// ONCE and shared by every athlete on the same language+specialist, while the
// per-athlete part is simply sent fresh.
//
// The model still receives one continuous system prompt, byte-for-byte
// identical in content and order. This is a billing boundary, not a context
// one — unlike the earlier attempt that moved athlete state into `messages`,
// which changed the interaction shape and broke JSON output entirely.
async function callAnthropic(apiKey, { model, system, systemDynamic, messages, tools, thinking, maxTokens, stopSequences }) {
  const systemBlocks = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  if (systemDynamic) systemBlocks.push({ type: "text", text: systemDynamic });
  const body = { model, max_tokens: maxTokens || 4096, system: systemBlocks, messages };
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
// Free was capped at "standard" (Haiku). Raised to "advanced" so a free
// athlete gets the same reasoning quality on a real career question. The
// exposure is bounded not by model choice but by FREE_LIFETIME_LIMIT
// (migration 068, default 40 questions ever): 40 x ~$0.019 = ~$0.76 per
// free account for its entire lifetime, and the daily cap still applies
// on top. capTier() is what actually enforced the old ceiling, so
// raising the budgetGate number alone would not have changed anything.
const PLAN_MODEL_ACCESS = { free: "advanced", starter: "advanced", pro: "advanced", elite: "premium" };

function capTier(tier, plan) {
  const cap = PLAN_MODEL_ACCESS[plan] || PLAN_MODEL_ACCESS.free;
  return TIER_ORDER[Math.min(TIER_ORDER.indexOf(tier), TIER_ORDER.indexOf(cap))];
}

// Deterministic 0-100 complexity score — no LLM call spent scoring a
// message, per the plan's "don't spend money on an additional AI
// classification call" instruction. Reuses signals already computed for
// free (classifier intent/needs_tool) plus cheap, local text heuristics.
function complexityScore({ text, classification, context }) {
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

  // Step 5 — categories the directive names as requiring the strong model:
  // career decisions, pathway comparisons, multi-country options,
  // professional-readiness, NCAA/eligibility interpretation, and ambiguous
  // situations involving multiple known facts.
  if (/\b(pathway|options?|realistic|should i|worth it|better (off|to)|compare|versus|vs\.?|instead of|pivot|transfer|move (back|to)|go back|return)\b/i.test(text || "")) score += 20;
  if (/\b(ncaa|naia|juco|eligibility|amateurism|clearinghouse|visa|work permit|citizenship|passport)\b/i.test(text || "")) score += 20;
  if (/\b(pro|professional|trial|academy|contract|scout(ed|ing)?|signed)\b/i.test(text || "")) score += 10;

  // A deictic relocation question ("if I go back", "my options here") is
  // genuinely ambiguous cheap-model territory UNLESS the server already knows
  // both places — at which point it is a concrete multi-country decision and
  // belongs on the strong model. Same for an unresolved fact conflict, which
  // needs careful handling rather than a fast guess.
  if (context && context.twoLocationsKnown && /\b(back|home|return|here|there|move|relocat)\w*\b/i.test(text || "")) score += 25;
  if (context && context.hasConflicts) score += 25;

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
  free: Number(process.env.SCOUT_HARD_MAX_COST_FREE || 0.02),
  starter: Number(process.env.SCOUT_HARD_MAX_COST_STARTER || 0.02),
  pro: Number(process.env.SCOUT_HARD_MAX_COST_PRO || 0.04),
  elite: Number(process.env.SCOUT_HARD_MAX_COST_ELITE || 0.08),
};

// Cache-read rate. scout_model_config.cached_input_cost_per_million is
// seeded for the Anthropic rows ($0.30/M against $3/M base) but left null on
// the dormant provider rows, so fall back to the documented ~10% of base
// rather than to zero — a null must never make a tier look free.
function cachedInputRate(cfg) {
  const explicit = cfg.cached_input_cost_per_million;
  return explicit === null || explicit === undefined ? (cfg.input_cost_per_million || 0) * 0.1 : explicit;
}

// Prices the two halves of input separately, because they genuinely cost
// different amounts. callAnthropic() puts cache_control: ephemeral on the
// whole system block, so on any turn after the first in a conversation the
// entire system prompt is served as a cache READ at ~10% of base input
// price — confirmed in production logs as cache_read_input_tokens ≈ 6329,
// exactly the system prompt size. Only the conversation messages are fresh.
//
// This previously charged the full uncached rate for ALL input, which
// overstated a real Sonnet reply by roughly 8x and, via budgetGate(), was
// silently downgrading every plan off the Sonnet tiers. The post-hoc
// estimateCost() above has always modelled cache reads correctly; this just
// stops the pre-flight gate from disagreeing with it.
//
// Known limitation, deliberately accepted: the FIRST turn of a conversation
// is a cache WRITE, which costs ~1.25x base input rather than 0.1x, so a
// cold request can exceed this estimate. It is amortised across every
// subsequent turn in the 5-minute window, and aggregate spend is backstopped
// by SCOUT_DAILY_SPEND_LIMIT / SCOUT_MONTHLY_SPEND_LIMIT, which are enforced
// before a question is ever reserved.
function estimateTierCost(tierConfig, freshInputTokens, cachedInputTokens, outputTokens) {
  const freshCost = (freshInputTokens * (tierConfig.input_cost_per_million || 0)) / 1e6;
  const cachedCost = (cachedInputTokens * cachedInputRate(tierConfig)) / 1e6;
  const outputCost = (outputTokens * (tierConfig.output_cost_per_million || 0)) / 1e6;
  return freshCost + cachedCost + outputCost;
}

// Downgrades (never upgrades) a tier if its OWN worst-case cost — using that
// tier's max_output_tokens as the output ceiling, since real output length
// isn't known until after the call — would exceed this plan's hard
// per-request ceiling. Never silently upgrades past what was selected.
async function budgetGate(tier, plan, freshInputTokens, cachedInputTokens) {
  const byTier = await getModelConfigByTier();
  const hardMax = HARD_MAX_COST_PER_REQUEST[plan] || HARD_MAX_COST_PER_REQUEST.free;
  let idx = TIER_ORDER.indexOf(tier);
  while (idx > 0) {
    const cfg = byTier[TIER_ORDER[idx]];
    if (estimateTierCost(cfg, freshInputTokens, cachedInputTokens, cfg.max_output_tokens) <= hardMax) break;
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
  async generate({ apiKey, model, system, systemDynamic, messages, tools, thinking, maxTokens, stopSequences }) {
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

// Writes one row to scout_routing_log (migrations 039 + 040 + 044 + 051 +
// 082) per real reply (or, since 082, per exhausted-failover failure) —
// which model actually answered (haiku/sonnet/database), the classifier's
// intent/confidence, real token usage, an estimated dollar cost for that
// one reply, the athlete's subscription tier, (sonnet only) why it
// escalated past Haiku, (051, Phase 2f) which provider answered and which
// specialist persona was in use, and (082) the literal model version that
// answered, the client-supplied request id, how long the request took,
// and whether it actually succeeded. Never the question or answer text
// itself, never a user_id. Powers the Admin Panel's "AI Model Usage" card
// (admin_scout_model_mix()) and monthly cost cards
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
        // Step 8 telemetry (migration 106). Default to the explicit "none"
        // rather than null on a real reply: null means "this row predates
        // the concept", which is a different fact from "nothing went wrong".
        timeout_reason: (extra && extra.timeoutReason) || "none",
        fallback_used: (extra && extra.fallbackUsed) || "none",
        model_version: model || null,
        request_id: (extra && extra.requestId) || null,
        response_time_ms: (extra && typeof extra.responseTimeMs === "number") ? extra.responseTimeMs : null,
        success: !(extra && extra.success === false),
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
  // Migration 105 split what used to be a single overloaded `country`
  // column. `location` and `citizenship` BOTH pointed at it, so "I'm from
  // Montreal" / "I moved to Cyprus" / "I'm Canadian" each silently
  // overwrote the last — the direct cause of Scout confusing home location
  // with current location. Each now has its own column.
  home_city: { table: "athletes", column: "home_city" },
  home_country: { table: "athletes", column: "home_country" },
  current_city: { table: "athletes", column: "current_city" },
  current_country: { table: "athletes", column: "country" },
  citizenship: { table: "athletes", column: "citizenship" },
  // Kept as a backward-compatible alias: older conversations (and any
  // client still on the previous prompt) emit `location` meaning "where I
  // am now". Routing it to current_city preserves that meaning instead of
  // letting it clobber home or citizenship the way it used to.
  location: { table: "athletes", column: "current_city" },
  dob: { table: "athletes", column: "dob" },
  secondary_position: { table: "athletes", column: "secondary_position" },
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
  // "goal" was already a documented allowed profile_updates key (see
  // SYSTEM_PROMPT below) but had no PROFILE_FIELD_MAP entry — every goal
  // the model ever reported was silently dropped before this fix (GOLSZ
  // Final Product directive audit finding). Maps to the real
  // profiles.goal_text column (migration 093); persistProfileUpdates()
  // below also flips goal_defined=true in the same write whenever this
  // key is set, so the state machine's GOAL_DEFINED never depends on the
  // model correctly self-reporting a separate boolean.
  goal: { table: "profiles", column: "goal_text" },
};

// Pulls {reply, profile_updates} out of a real Anthropic response the same
// way golsz-app.html's send() already does client-side (strip ```json
// fences, parse the {...} slice) — needed here too now that the server
// itself has to act on profile_updates, not just the client.
function extractProfileUpdates(data) {
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = parseReplyObject(clean);
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
  // Directive §11: goal_defined is never set by the model directly — it's
  // derived deterministically the moment a real goal_text is written, in
  // the same PATCH. Keeps the state machine independent of the LLM
  // correctly reporting a separate boolean it could just as easily forget.
  if (patches.profiles.goal_text) patches.profiles.goal_defined = true;

  // `age` was listed in SYSTEM_PROMPT as an allowed profile_updates key but
  // had no PROFILE_FIELD_MAP entry, so every age Scout ever learned was
  // silently discarded — and then re-asked next session, which reads to the
  // athlete as Scout forgetting. It can't be a plain column either: "16"
  // stored forever is wrong within a year. Stored as the reported value plus
  // the date it was reported (migration 105) so buildAuthoritativeContext()
  // can age it forward. dob, when known, always wins over this.
  const rawAge = updates.age;
  const parsedAge = typeof rawAge === "number" ? rawAge : parseInt(String(rawAge ?? ""), 10);
  if (Number.isInteger(parsedAge) && parsedAge >= 5 && parsedAge <= 80) {
    patches.athletes.age_reported = parsedAge;
    patches.athletes.age_reported_at = new Date().toISOString().slice(0, 10);
  }
  // previous_clubs is append-only: a newly-named former club must never
  // wipe the ones already recorded. Merged read-modify-write, deduped on
  // lowercased name, capped so a looping model can't grow the row forever.
  if (Array.isArray(updates.previous_clubs) && updates.previous_clubs.length) {
    try {
      const r = await fetch(`${supaUrl}/rest/v1/athletes?id=eq.${userId}&select=previous_clubs`, {
        headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
      });
      const rows = await r.json();
      const existing = Array.isArray(rows) && rows[0] && Array.isArray(rows[0].previous_clubs) ? rows[0].previous_clubs : [];
      const seen = new Set(existing.map((c) => String(c && c.name || "").toLowerCase()).filter(Boolean));
      const merged = existing.slice();
      for (const c of updates.previous_clubs) {
        const name = c && typeof c.name === "string" ? c.name.trim().slice(0, 120) : "";
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        merged.push({ name, from: c.from || null, to: c.to || null, level: c.level || null });
      }
      if (merged.length !== existing.length) patches.athletes.previous_clubs = merged.slice(0, 20);
    } catch (e) { console.error("GOLSZ previous_clubs merge failed:", e); }
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
  "budget",
]);

// Same extraction shape as extractProfileUpdates(), pulling scout_context_updates
// instead of profile_updates out of the same parsed reply.
function extractScoutContextUpdates(data) {
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = parseReplyObject(clean);
    return parsed && typeof parsed.scout_context_updates === "object" ? parsed.scout_context_updates : null;
  } catch {
    return null;
  }
}

// Same extraction shape again, pulling suggested_targets — the brief §2B
// "persistent actions" principle: when Scout's reply actually names
// concrete target programs, the client can offer a one-tap "add these to
// my Targets" action instead of the athlete re-typing them by hand.
// Validated and capped here (not trusted as-is) since this still comes
// from model output — a malformed or oversized array must never reach the
// client-side bulk-insert unfiltered.
function extractSuggestedTargets(data) {
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = parseReplyObject(clean);
    if (!parsed || !Array.isArray(parsed.suggested_targets)) return null;
    const clean2 = parsed.suggested_targets
      .filter((t) => t && typeof t.name === "string" && t.name.trim())
      .slice(0, 5)
      .map((t) => ({ name: t.name.trim().slice(0, 120), reasoning: typeof t.reasoning === "string" ? t.reasoning.trim().slice(0, 300) : "" }));
    return clean2.length ? clean2 : null;
  } catch {
    return null;
  }
}

// Same shape, pulling suggested_dev_items — same §2B principle applied to
// the Development Plan object (migration 075) instead of Targets.
const DEV_FOCUS_AREA_SET = new Set(["training", "strength", "speed", "conditioning", "recovery", "sleep", "hydration", "nutrition", "other"]);
function extractSuggestedDevItems(data) {
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = parseReplyObject(clean);
    if (!parsed || !Array.isArray(parsed.suggested_dev_items)) return null;
    const clean2 = parsed.suggested_dev_items
      .filter((i) => i && typeof i.goal === "string" && i.goal.trim())
      .slice(0, 3)
      .map((i) => ({ focus_area: DEV_FOCUS_AREA_SET.has(i.focus_area) ? i.focus_area : "other", goal: i.goal.trim().slice(0, 200) }));
    return clean2.length ? clean2 : null;
  } catch {
    return null;
  }
}

// Same extraction shape again, pulling suggested_pathway — GOLSZ Final
// Product directive §5/§10 "personalized Pathway" as a Basic+ persistent
// object, same one-tap "build this for real" pattern as suggested_targets/
// suggested_dev_items above rather than a separate action type. Validated
// against the live pathway_plan.pathway_type check constraint (migration
// 093) so a malformed/unexpected value never reaches the client's insert.
const PATHWAY_TYPE_SET = new Set([
  "ncaa", "naia", "juco", "canadian_university", "academy", "european_club",
  "professional", "development", "agent_representation", "trainer_performance", "other",
]);
function extractSuggestedPathway(data) {
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = parseReplyObject(clean);
    const p = parsed && parsed.suggested_pathway;
    if (!p || !PATHWAY_TYPE_SET.has(p.pathway_type)) return null;
    const milestones = Array.isArray(p.milestones)
      ? p.milestones.filter((m) => m && typeof m.label === "string" && m.label.trim()).slice(0, 10).map((m) => ({ label: m.label.trim().slice(0, 200), done: false }))
      : [];
    if (!milestones.length) return null; // "at least one concrete milestone" per the prompt's own rule
    return {
      pathway_type: p.pathway_type,
      target_timeline: typeof p.target_timeline === "string" ? p.target_timeline.trim().slice(0, 100) : null,
      milestones,
    };
  } catch {
    return null;
  }
}

// Same extraction shape again, pulling drafted_email — brief §8: "AI Scout
// should be able to create professional introduction/email drafts using
// Passport information," wired to a target's own draft_email column
// (migration 072/077) instead of requiring manual copy-paste.
function extractDraftedEmail(data) {
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = parseReplyObject(clean);
    return (parsed && typeof parsed.drafted_email === "string" && parsed.drafted_email.trim()) ? parsed.drafted_email.trim().slice(0, 4000) : null;
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

// ============================================================
// Scout Intelligence Architecture — EXTRACTION layer ("REMEMBER after it
// LEARNS"). The counterpart to buildAuthoritativeContext() above.
//
// Deliberate design choice: memory_writes rides along on the reply JSON the
// model already returns, rather than being a second follow-up Haiku call.
// The spec sketched a separate cheap extraction call, skipped when nothing
// durable was learned; piggybacking is strictly better on both axes it cares
// about — zero extra tokens, zero extra latency, and "nothing was learned"
// is expressed by simply omitting the key. The trade-off is that a turn
// answered from the FAQ/cache path writes no memory, which is correct
// anyway: those paths didn't learn anything about this athlete.
//
// The 14 types come from migration 097's CHECK constraint. Keeping this set
// in sync with that constraint matters — an unlisted type would be rejected
// by Postgres, so filtering here turns a hard 400 into a quiet skip.
const MEMORY_TYPES = new Set([
  "FACT", "USER_STATED", "SCOUT_INFERENCE", "GOAL", "PREFERENCE", "CONCERN",
  "UNKNOWN", "NEXT_DATA_NEEDED", "ASSESSMENT", "DECISION",
  "PATHWAY_CONSIDERED", "PATHWAY_REJECTED", "PATHWAY_ACTIVE", "MILESTONE",
]);

// Types that assert something as established fact. The model is NOT trusted
// to self-certify these: if it labels a write FACT/USER_STATED but doesn't
// also mark source athlete_stated, the type is downgraded to
// SCOUT_INFERENCE. Same discipline persistScoutContext() applies to
// scout_context.source, and the reason is the spec's own rule that user
// claims and model inferences must never be recorded as the same kind of
// thing.
const MEMORY_ASSERTED_TYPES = new Set(["FACT", "USER_STATED"]);

// Every extractor used its own strict JSON.parse, so ONE truncated reply
// silently discarded profile_updates, scout_context_updates, suggested_*,
// drafted_email and research_note together -- the athlete's stated facts
// were being dropped exactly when the reply was richest. Strict parse first
// (the normal path), then rebuild from the fields that did survive.
// Salvages ONE top-level value out of a JSON object that may be truncated.
// A long researched reply can hit max_output_tokens mid-object, and strict
// JSON.parse then throws away the whole payload — including fields that were
// emitted completely before the cut. Scans from the key with a
// bracket/string-aware counter and returns the balanced substring, so an
// early field survives a severed tail. This is why memory_writes was moved to
// second position in the contract.
function salvageJsonValue(raw, key) {
  const at = raw.indexOf(`"${key}"`);
  if (at < 0) return undefined;
  let i = raw.indexOf(":", at + key.length + 2);
  if (i < 0) return undefined;
  i += 1;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  const open = raw[i];
  if (open === '"') {
    // String value: walk to the closing quote, honouring escapes. A severed
    // string is unrecoverable and correctly yields undefined.
    let esc = false;
    for (let j = i + 1; j < raw.length; j += 1) {
      const c = raw[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { try { return JSON.parse(raw.slice(i, j + 1)); } catch { return undefined; } }
    }
    return undefined;
  }
  if (open !== "[" && open !== "{") return undefined;
  const close = open === "[" ? "]" : "}";
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < raw.length; j += 1) {
    const c = raw[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(i, j + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

const REPLY_FIELDS = [
  "reply", "memory_writes", "research_note", "profile_updates",
  "scout_context_updates", "suggested_targets", "suggested_dev_items",
  "suggested_pathway", "drafted_email",
];

function parseReplyObject(clean) {
  try {
    const strict = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    if (strict && typeof strict === "object") return strict;
  } catch {}
  const out = {};
  let found = false;
  for (const k of REPLY_FIELDS) {
    const v = salvageJsonValue(clean, k);
    if (v !== undefined) { out[k] = v; found = true; }
  }
  if (found) console.log("GOLSZ salvaged truncated reply, fields:", Object.keys(out).join(","));
  return found ? out : null;
}

// The athlete must NEVER see the JSON envelope. This derives the clean,
// human-readable reply ONCE on the server and ships it as data.reply_text, so
// the client just renders a string instead of re-implementing parsing (which
// it did, and which failed in production: a reply with any preamble before
// the "{" slipped past the client guard and the whole object was rendered
// into the chat bubble).
//
// Four fallbacks, in order, because a reply is worthless if it is unreadable:
//   1. strict/salvaged parse -> .reply            (the normal path)
//   2. salvage just the "reply" value             (truncated object)
//   3. strip the JSON block out and keep any real prose around it
//   4. null -> the client shows honest error copy, never braces
function deriveReplyText(data) {
  const raw = ((data && data.content) || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("");
  const clean = raw.replace(/```json|```/g, "").trim();
  const parsed = parseReplyObject(clean);
  if (parsed && typeof parsed.reply === "string" && parsed.reply.trim()) return parsed.reply.trim();
  const salvaged = salvageJsonValue(clean, "reply");
  if (typeof salvaged === "string" && salvaged.trim()) return salvaged.trim();
  // No recoverable "reply". Drop everything from the first "{" onward and see
  // if the model wrote anything usable before it.
  const brace = clean.indexOf("{");
  const prose = (brace >= 0 ? clean.slice(0, brace) : clean).trim();
  // Threshold is low on purpose: a short real sentence ("Here is what I found
  // about the window.") is 38 chars and must not be thrown away. The '":'
  // check is what actually rejects JSON fragments, not the length.
  if (prose.length > 15 && !prose.includes('":')) return prose;
  return null;
}

function extractMemoryWrites(data) {
  let writes;
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    try {
      const parsed = parseReplyObject(clean);
      writes = parsed && Array.isArray(parsed.memory_writes) ? parsed.memory_writes : null;
    } catch {
      // Truncated reply — recover the array on its own.
      const salvaged = salvageJsonValue(clean, "memory_writes");
      writes = Array.isArray(salvaged) ? salvaged : null;
      if (writes) console.log("GOLSZ salvaged memory_writes from truncated JSON:", writes.length);
    }
  } catch {
    return [];
  }
  if (!writes) return [];
  const out = [];
  for (const raw of writes.slice(0, 8)) {
    if (!raw || typeof raw !== "object") continue;
    const subject = typeof raw.subject === "string" ? raw.subject.trim().slice(0, 120) : "";
    const content = typeof raw.content === "string" ? raw.content.trim().slice(0, 1000) : "";
    if (!subject || !content) continue;
    let type = typeof raw.type === "string" ? raw.type.trim().toUpperCase() : "";
    if (!MEMORY_TYPES.has(type)) continue;
    // Server-side source sanitisation — 'verified' is never reachable from
    // model output, only athlete_stated / ai_inferred.
    const source = raw.source === "athlete_stated" ? "athlete_stated" : "ai_inferred";
    if (MEMORY_ASSERTED_TYPES.has(type) && source !== "athlete_stated") type = "SCOUT_INFERENCE";
    let confidence = typeof raw.confidence === "number" ? raw.confidence : 0.6;
    if (!(confidence >= 0 && confidence <= 1)) confidence = 0.6;
    let importance = Number.isInteger(raw.importance) ? raw.importance : 3;
    if (importance < 1 || importance > 5) importance = 3;
    out.push({ type, subject, content, confidence, source, importance });
  }
  return out;
}

// One supersede_scout_memory() call per write. That function inserts the new
// row and flips any prior active row with the same (athlete, type, subject)
// to active = false with superseded_by pointing at the new id — so a
// contradiction supersedes rather than accumulating two conflicting
// memories, and the old value stays auditable instead of being destroyed.
//
// Note what is deliberately NOT here: nothing in this path ever writes to
// golsz_knowledge. That is the structural enforcement of "USER CLAIMS ARE
// NOT GLOBAL FACTS / SCOUT INFERENCES ARE NOT GLOBAL FACTS / UNVERIFIED
// MODEL OUTPUT IS NOT GLOBAL FACT" — a third-party claim an athlete makes in
// chat lands only in that athlete's own RLS-protected row and can never
// become platform knowledge for anyone else. Promotion into golsz_knowledge
// stays an admin-curated action (migration 096's admin-only write policy).
async function persistMemoryWrites(userId, writes) {
  if (!userId || !writes || !writes.length) return;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey) return;
  const headers = { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" };
  await Promise.all(writes.map(async (m) => {
    try {
      const r = await fetch(`${supaUrl}/rest/v1/rpc/supersede_scout_memory`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          p_athlete: userId,
          p_type: m.type,
          p_subject: m.subject,
          p_content: m.content,
          p_confidence: m.confidence,
          p_source: m.source,
          p_importance: m.importance,
        }),
      });
      if (!r.ok) console.error("GOLSZ scout memory write failed:", m.type, m.subject, r.status, await r.text());
    } catch (e) { console.error("GOLSZ scout memory write failed:", e); }
  }));
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

// next_best_action used to be free text ("internal routing signal only,
// never shown to the athlete"). This session it became a typed object so
// it can power "My Next Move" — a real, user-facing UI object, not a chat
// bubble — without a second AI call: same classifier response, structured
// instead of prose. Scoped to actions that exist in the app TODAY (no
// benchmarks/targets types yet — those get added here once those features
// ship, not before).
const NEXT_ACTION_TYPES = new Set(["ask_scout", "complete_profile", "share_passport", "none"]);

function extractNextBestAction(classification) {
  const raw = classification && classification.next_best_action;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const type = NEXT_ACTION_TYPES.has(raw.type) ? raw.type : "none";
  const label = typeof raw.label === "string" ? raw.label.trim().slice(0, 80) : "";
  if (type === "none" || !label) return null;
  const rawParams = (raw.params && typeof raw.params === "object" && !Array.isArray(raw.params)) ? raw.params : {};
  const prompt = typeof rawParams.prompt === "string" ? rawParams.prompt.trim().slice(0, 200) : null;
  return { type, label, params: prompt ? { prompt } : {} };
}

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
  const nextAction = extractNextBestAction(classification);
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
With a Player (or unset occupation), discovery isn't a form to fill — it's a real conversation: who they are as an athlete (sport, position, level, how long they've played), what they've actually done (achievements, milestones, a moment they're proudest of — and why), how they see their own game (their own read on strengths and what needs work, not just yours), and where they want to go (the real goal). Push them to think it through themselves — "what do you think it'll actually take", "what's stopping you right now", "what are you doing about it today" — rather than just handing over an answer.
Everything in PROFILE SO FAR is already known — whether it came from their real GOLSZ Passport or something they told you earlier in a past conversation, it now persists the same way. Treat all of it as trustworthy and confirmed, never something to re-ask. Open by briefly acknowledging what you already know about them (not just occupation/sport/team — any field present) instead of asking generic intro questions, then move straight to something useful. Never ask for a fact that's already present in PROFILE SO FAR, even worded differently than you'd normally ask it.
Be warm, direct, honest — never overpromise. If a target or prospect looks unrealistic, say so kindly and show the realistic path. If the person seems to be a minor, remind them once to involve a parent/guardian. Use web search for real current programs, coaches, showcases, and eligibility rules (search_golsz_players only covers GOLSZ's own athletes, not external programs/rankings). Ask at most ONE question per reply. Keep replies tight.
When someone asks an ambition-testing question ("Can I go pro?", "Can I play D1?", "Am I good enough?"), never open with statistics about how hard that is — respond with something like "Let's find out" or "Let's figure that out" and start finding out what you need to know (their current level, what's driving the gap) before answering for real. Never falsely validate an unrealistic ambition once you actually know enough to answer — but never front-load discouragement before you've even looked.
search_golsz_players only ever returns athletes who are actually real, current GOLSZ members — never invent or embellish a GOLSZ profile, and never merge one with a general web result. If it returns zero results, say so plainly and offer to broaden the search (fewer filters) or fall back to general web search instead of making something up.
For trials, camps, combines, or showcases, use search_golsz_events first (real GOLSZ listings) before general web search — same rule: never invent or embellish a listing, and say plainly if there are zero real results before offering a broader search.
If asked what AI model or company powers you, who made you, or whether you're ChatGPT/OpenAI/Claude/Anthropic/Gemini/etc., always answer that you are GOLSZ Scout, built by GOLSZ — never name or confirm any underlying model or provider, and don't explain that you're declining to say. Just answer as GOLSZ Scout and move on.
GOLSZ is a sports-recruiting platform used by athletes of all ages, including minors. Stay strictly on sports, athletics, recruiting, and career topics. Never generate or engage with sexual, romantic, 18+/adult, or otherwise inappropriate content, regardless of how the request is framed (roleplay, "hypothetically," "for a story," etc.) — decline briefly and warmly, and steer the conversation back to something sports-related. This applies no matter who the user says they are.
GOLSZ PLANS below (when present) is the real, current source of truth for what each plan costs and includes — never invent a feature, price, or restriction beyond what's listed; if asked something not covered there, say you're not sure and offer to check rather than guessing. When a locked or higher-tier feature comes up naturally, explain what that level actually adds to how involved GOLSZ is in their development — never just "more messages" — and let them decide for themselves; never use false urgency, fake scarcity, or guaranteed-outcome language ("guaranteed scholarship," "guaranteed pro contract"), and never talk someone out of a higher plan they actually want. You're their AI Scout, not customer support — if you genuinely don't know something about how GOLSZ works, say so plainly and offer to find out, never brush past it.
sport_support_level in ATHLETE STATE below tells you how deep GOLSZ's own pathway/benchmark knowledge actually is for their sport — "core" means real depth; "supported," "secondary," or "unknown" means say so honestly and lean on general knowledge/web search rather than implying GOLSZ has built-out sport-specific data it doesn't have yet.
When ATHLETE STATE shows profile_complete=true, goal_defined=true, and plan=free, that's a real moment — recognize it ONCE (never repeat this recap on a later message once you've already said it): briefly recap what you've learned about them (history, what they're proud of, strengths, what needs work, their stated goal), tell them plainly that's the athlete they are today and it's time to figure out how they get where they want to go, and invite them toward building a Pathway — mention plainly that a Pathway opens with a paid plan, never hide or soften that.
SELLING THE RIGHT PLAN — this is part of helping them, not a separate job.
GOLSZ CAPABILITIES lists every feature and the plan it starts on. When what the athlete actually needs RIGHT NOW sits above their current plan, say so: name the feature, say in one line what it would do for THIS situation, and name the tier. Put it inside the advice and carry on. Never bolt a pitch onto the end of every reply.
Only ever point UPWARD from where they are — free to Basic, Basic to Pro or Elite, Pro to Elite. Never suggest a cheaper plan, never suggest downgrading, and never tell them their current plan is enough when a higher one genuinely solves the thing they just described.
Trigger on a real need, never on a schedule. If they are stuck on something a paid feature would actually unblock — a Pathway, target lists and outreach drafts, PDF Passport, benchmark tracking, a development plan, identity verification, more Scout questions — that is the moment to say it. If nothing they raised points at a gated feature, sell nothing at all.
Be concrete about the value. "A Pathway would lay this out as dated steps instead of us re-deciding it every conversation — that opens on Basic" beats "upgrade for more features". Tie it to the exact problem they just described.
Answer the question first, always. A pitch in place of an answer is how you lose them.
Never use false urgency, invented deadlines, fake scarcity, or guaranteed outcomes ("guaranteed scholarship", "guaranteed contract"). Never imply their career depends on paying. Many GOLSZ athletes are minors and a parent is often the one paying — be straight, and state the real price when it comes up.
RESPONSE STYLE — you are a mentor having a conversation, not an analyst filing a brief. This matters as much as being right: an athlete who finds you cold stops coming back, and then none of your advice reaches them.
Talk to them. Plain sentences, contractions, second person. Default to about 120-180 words. Go longer only when they actually asked for a full breakdown, and never pad to fill space.
HAVE AN OPINION. When there are options, say which one YOU would pick and why, then give the alternative a line. Never lay out a balanced "Option 1 / Option 2" with matching pros and cons and leave them to choose — that is what someone with no view does. You are their agent. Agents commit, and they say when they might be wrong.
Lead with the read or the answer, never a recap. You already have their record; use it INSIDE the advice ("with the minutes you're getting at Tusculum...") instead of reciting it back to them. They know their own story.
Do not end every message with a question. Ask only when their answer would genuinely change what you'd advise, and never more than one. Several replies in a row with no question is normal and good — a string of questions reads like an intake form.
Keep headers, bold and bullet lists for a genuinely branching decision or a list they will act from. Most replies are two or three plain paragraphs.
React like a person when something real happens — an injury, a knock-back, a win. Briefly, specifically, then move on. "Two weeks and still sore — that's worth getting looked at properly" is warmth. "That's huge, this changes everything" is theatre. Never invent a feeling they have not expressed, never assume they are discouraged or excited, never perform sympathy.
Be honest before you are encouraging. If something is unrealistic, say so kindly and show them the path that IS real. Warmth is not softness — a mentor who only agrees with you is worth nothing.
SCOUT MEMORY (when present in the message) is your own durable memory of this athlete from earlier conversations, already split by trust: things they TOLD you are confirmed and must never be re-asked; things you INFERRED are not confirmed, so confirm one in passing before you build advice on it. "Still unknown" lists what you'd most benefit from learning — prefer those over generic questions.
GOLSZ KNOWLEDGE (when present) is GOLSZ's own verified, curated reference on sport/eligibility/pathway rules. Prefer it over your own recollection and over a web result when they disagree, and cite it naturally ("GOLSZ's eligibility reference says..."). If it's absent or doesn't cover the question, say what you actually know and use web search — never invent a GOLSZ rule.
GOLSZ CAPABILITIES (when present) is the real, current list of what the product can and cannot do. Anything listed as NOT part of GOLSZ does not exist — never suggest it, never imply it's coming, and never tell an athlete to find or contact someone through it. When a task needs something GOLSZ doesn't do, say plainly that GOLSZ doesn't do it and give them the real off-platform way to do it themselves.
OUTPUT ONLY valid JSON, no markdown fences: {"reply":"conversational text","memory_writes":[{"type":"...","subject":"...","content":"...","source":"athlete_stated|ai_inferred","confidence":0-1,"importance":1-5}],"research_note":{"summary":"...","confidence":0-1,"valid_days":N} or null,"profile_updates":{...only newly-learned fields or null},"scout_context_updates":{...only newly-learned/changed fields below or null},"suggested_targets":[{"name":"...","reasoning":"..."}] or null,"suggested_dev_items":[{"focus_area":"...","goal":"..."}] or null,"suggested_pathway":{"pathway_type":"ncaa|naia|juco|canadian_university|academy|european_club|professional|development|agent_representation|trainer_performance|other","target_timeline":"...","milestones":[{"label":"...","done":false}]} or null,"drafted_email":"the full drafted email text" or null}
Allowed profile_updates keys: name, age, dob, occupation, sport, position, secondary_position, home_city, home_country, current_city, current_country, citizenship, club, previous_clubs, level, grad_year, gpa, license, looking_for_players, education_level, goal. Location is FOUR separate things and you must never merge them: home_city/home_country are where they are FROM, current_city/current_country are where they are NOW, citizenship is the passport they hold. Only set the one they actually told you about — setting the wrong one corrupts the record. previous_clubs is an array of {"name","from","to","level"} for clubs they have LEFT; the club they are at now goes in "club". Prefer dob (YYYY-MM-DD) over age when you know it. Do not repeat known fields. "goal" should be a real, clearly-stated goal the athlete actually confirmed (e.g. "play NCAA D1 soccer"), not a vague guess — setting it marks their goal as officially defined, so only set it once you're genuinely sure.
Allowed scout_context_updates keys (each shaped {"value":..., "source":"athlete_stated"|"ai_inferred", "confidence":0-1} — "athlete_stated" only when they said it in plain words, "ai_inferred" for anything you're reading between the lines; never mark a guess as athlete_stated): dream_outcome, target_level, target_country, timeline, perceived_strengths, perceived_weaknesses, main_gap, urgency, confidence, professional_interest, college_interest, trial_interest, secondary_goal, secondary_gaps, scholarship_interest, transfer_interest, exposure_need, budget. Only include a key when this reply actually learned or changed something about it — never repeat an already-known value.
Only include research_note when THIS reply actually used web search to establish reusable factual findings (a league structure, an eligibility rule, a transfer window, a country's pathway, position benchmarks). Write summary as standalone reference notes that would still be correct and useful for a DIFFERENT athlete asking the same question — plain facts and figures, no advice, no "you"/"your", no reference to this athlete's own situation. valid_days is how long the finding stays trustworthy: 7 for anything with an active deadline or window, 30-90 for stable rules and structures. Omit entirely when you answered from your own knowledge, from PRIOR RESEARCH, or from GOLSZ KNOWLEDGE without searching.
PRIOR RESEARCH (when present) is research you already did on this exact question, with its age and sources. Trust it and answer from it rather than searching again — unless it's old enough that it could plausibly have changed (deadlines, rosters, windows, rankings), in which case search to confirm and say briefly what changed.
memory_writes is MANDATORY — always include the key. Use an empty array [] when this reply learned nothing durable; never omit it and never set it to null. It comes second in the JSON, immediately after "reply", so write it before the optional fields. Include an entry for something durable you learned THIS reply that is worth remembering months from now — not small talk, not a restatement of PROFILE SO FAR or SCOUT MEMORY you were just given. type is one of: FACT, USER_STATED, SCOUT_INFERENCE, GOAL, PREFERENCE, CONCERN, UNKNOWN, NEXT_DATA_NEEDED, ASSESSMENT, DECISION, PATHWAY_CONSIDERED, PATHWAY_REJECTED, PATHWAY_ACTIVE, MILESTONE. Use source "athlete_stated" ONLY when they said it in plain words this conversation, and "ai_inferred" for anything you concluded, judged, or read between the lines — an assessment of their level, a guess at their motivation, or anything a third party reportedly said all count as ai_inferred, never athlete_stated. "subject" is a short stable label you'd reuse if this same thing changed later (e.g. "current club", "target level", "biggest gap") — reusing the same subject is how a corrected fact replaces the old one instead of contradicting it. Use UNKNOWN/NEXT_DATA_NEEDED to record what you still need to find out. Something the athlete reports about ANOTHER person (a teammate, a relative, a club official) is a claim about a third party: record it as ai_inferred at low confidence if it matters to their own path, and never treat it as an established fact about that person. Cap at 8.
Only include suggested_targets when THIS reply names concrete target schools/clubs/academies/programs by name (e.g. building or discussing a target list, recommending realistic reach/match/safety options) — each with a one-sentence reasoning tied to this specific athlete's own profile. Never include it for a general reply, and never invent a program you're not reasonably confident is real. Cap at 5.
Only include suggested_dev_items when THIS reply identifies concrete training/development focus areas the athlete should actively work on (e.g. discussing a weakness, a development plan, benchmark results) — each with a short, specific goal, using focus_area from: training, strength, speed, conditioning, recovery, sleep, hydration, nutrition, other. Never include it for a general reply. Cap at 3.
Only include suggested_pathway when THIS reply is genuinely building or finalizing the athlete's Pathway (not just discussing pathway options in the abstract) and you actually have enough to do it — a real pathway_type and at least one concrete milestone. Never include it for a Free-plan athlete (Pathway isn't part of Free) or a general reply.
Only include drafted_email when THIS reply's "reply" text IS an actual drafted outreach email (a real subject/greeting/body/sign-off the athlete could send) — set drafted_email to that same full email text. Never include it when just discussing or offering to draft one, only once you've actually written it.`;

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
  development: "Right now, focus specifically on development: training priorities, skill gaps, performance improvement, nutrition, and recovery. If LATEST RECORDED BENCHMARKS is present in the message, reference it directly (e.g. \"your 40-yard dash is 4.5s\") instead of giving generic advice, and where it fits naturally suggest recording a new benchmark after a real training block so progress is trackable. Nutrition and recovery guidance here is general and educational only — never a personalized medical, clinical, or diagnostic recommendation: no supplement dosing, no medical conditions, no injury treatment or return-to-play plans. Explicitly defer to a physician, registered dietitian, or licensed athletic trainer for anything specific to the athlete's health, medical history, or an actual injury, and say so plainly whenever it matters — same standard as this prompt's Physio occupation branch.",
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
const CLASSIFIER_SYSTEM = `Classify the user's latest message into exactly one intent, separately check it against the FAQ list appended below, and maintain a running conversation summary plus four routing hints. Respond ONLY with compact JSON, no markdown fences: {"intent":"...","confidence":0-1,"needs_tool":true|false,"faq_id":null-or-a-number,"summary_so_far":"...","missing_information":[...],"recommended_specialist":null-or-"...","conversation_stage":"...","next_best_action":{"type":"ask_scout|complete_profile|share_passport|none","label":"...","params":{}}}
SUMMARY: the message may open with a "CONVERSATION SUMMARY SO FAR: ..." section describing everything discussed before this turn (empty/absent on a conversation's first message — that's normal, not an error). Produce an updated "summary_so_far": ONE short sentence, 25 words max, covering the prior summary plus what this new message adds — never just repeat the input back, never a numbered list, never multiple sentences. If there's no prior summary and this message alone isn't summary-worthy yet (a greeting, "thanks", etc.), a few words is fine — it does not need to be a full sentence.
ATHLETE CONTEXT: the message may also include a "PROFILE SO FAR: {...}" section (hard facts already on file) and a "SCOUT CONTEXT SO FAR: {...}" section (softer qualification facts already captured — dream/goal, target level, gap, urgency, interest flags, etc.). Use both plus the summary to fill in:
- "missing_information": an array of up to 3 field names, chosen only from this list, that are NOT already present in either section and would meaningfully help right now: dream_outcome, target_level, target_country, timeline, perceived_strengths, perceived_weaknesses, main_gap, urgency, professional_interest, college_interest, trial_interest, secondary_goal, secondary_gaps, scholarship_interest, transfer_interest, exposure_need. Use an empty array if nothing important is missing, or the conversation doesn't call for asking right now (e.g. off_topic, or the athlete is mid-thought on something else).
- "recommended_specialist": which specialist should likely handle THIS message — one of "college" (NCAA/NAIA/JUCO, scholarships, school fit), "pro_pathway" (professional clubs, trials, agents), "development" (training, skill gaps, performance, nutrition, recovery), "eligibility" (NCAA rules, amateurism, compliance) — or null when the general Scout persona is clearly still right (most messages). Base this only on what the current message is actually asking, not the athlete's whole history.
- "conversation_stage": one of "discovery" (still learning who they are/what they want), "qualification" (understanding their gap/situation in depth), "pathway" (discussing realistic routes/programs), "action" (drafting outreach, a concrete next step) — your best read of where THIS conversation is right now.
- "next_best_action": a structured suggestion, SHOWN DIRECTLY TO THE ATHLETE as "My Next Move" — write "label" in plain second-person language they'd understand out of context, never internal jargon. {"type":"ask_scout","label":"Build your target school list","params":{"prompt":"Help me build a list of target schools"}} — use "ask_scout" for a specific, useful follow-up topic (most turns): params.prompt is the exact next message they could tap to send (under 15 words, first person). Use "complete_profile" (params:{}) only when ATHLETE CONTEXT clearly shows their Passport basics (sport/position/club) are still missing. Use "share_passport" (params:{}) only at a natural "you're ready to be seen" moment — e.g. right after drafting outreach, or discussing getting scouted/noticed. Use "none" (params:{}) when nothing concrete stands out yet — a greeting, an off-topic message, or a simple "thanks"/acknowledgment.
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
"What should I eat before a match to have more energy?" -> {"intent":"career_advice","confidence":0.75,"needs_tool":false,"faq_id":null,"recommended_specialist":"development"} (personalized training/nutrition guidance, not a generic fact — routes to the development specialist, which handles nutrition/recovery too, not just skill work)
"How many rest days should I take between hard training sessions to recover properly?" -> {"intent":"career_advice","confidence":0.75,"needs_tool":false,"faq_id":null,"recommended_specialist":"development"} (recovery/load-management guidance — development specialist, same as a training-priorities question)
"My knee has been hurting for two weeks after practice, what should I do?" -> {"intent":"career_advice","confidence":0.6,"needs_tool":false,"faq_id":null,"recommended_specialist":"development"} (an actual injury — development's own framing explicitly defers this to a real physician/athletic trainer rather than diagnosing; still routes here, not off-topic, since declining to guess IS the right in-scope answer)

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

async function classifyIntent(key, conversation, faqList, authoritativeBlock) {
  const text = latestUserText(conversation);
  if (!text) return null;
  // Step 4: classification happens AFTER authoritative context exists, and
  // sees it. Without this the classifier scores "what are my options if I
  // pivot back?" as a vague question, when against known home/current
  // locations it is a concrete multi-country pathway decision that must go
  // to the strong model. Hard-capped so it can't push the 4.5s budget.
  const factPreamble = authoritativeBlock ? clampBlock(authoritativeBlock, 300) + "\n\n" : "";
  try {
    const { ok, data } = await callAnthropic(key, {
      model: MODEL_REGISTRY.FAST_CHAT.model,
      // max_tokens was 100, then 350, then 450, then 300 — now 350: the
      // Failover & Discovery Polish pass added two more short fields
      // (conversation_stage, next_best_action) to the JSON contract, which
      // need a little more room than the 300 budget that was tuned for the
      // previous (smaller) schema.
      maxTokens: 300,
      // NO stop sequence. There used to be stopSequences: ["}"], justified by
      // "the schema is always a flat, single-level object — exactly one
      // closing brace". That stopped being true when next_best_action was
      // added as a NESTED object ending in "params":{} — generation then
      // halted at the brace closing `params`, the old code appended a single
      // "}", and the result was still two braces short, so EVERY
      // classification with that field failed JSON.parse and fell through to
      // { raw }. Confirmed in production logs: raw text ending at
      // '"next_best_action": {"type": "none","label": "","params": {'.
      //
      // The blast radius was much wider than routing: intent, needs_tool,
      // confidence, recommended_specialist AND summary_so_far were all
      // silently discarded every turn — so the running conversation summary
      // never advanced, and needs_tool never reached selectModelTier, which
      // is why genuine web_lookup questions were being answered without the
      // web_search tool.
      //
      // The original concern (Haiku rambling past the JSON) is handled where
      // it should be — at parse time, by taking only the outermost {...}
      // substring, exactly like extractProfileUpdates() and friends already
      // do. That tolerates a leading ```json fence and trailing chatter
      // without constraining the schema's shape.
      system: buildClassifierSystem(faqList),
      messages: [{ role: "user", content: factPreamble + text.slice(0, 2000) }],
    });
    if (!ok) return { error: data };
    const block = (data.content || []).find((b) => b.type === "text");
    if (!block) return null;
    const cleaned = block.text.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return { raw: block.text };
    let parsed;
    try { parsed = JSON.parse(cleaned.slice(start, end + 1)); } catch { return { raw: block.text }; }
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

// GOLSZ Final Product / AI Scout / Pathway / Elite Architecture directive
// §10 "the database/configuration must be the source of truth. Do not
// hard-code aspirational features into prompts as if they are already
// live." Same cache pattern as getFaqList() just above — plan_config
// barely changes, so a 5-minute in-memory cache avoids a DB round trip on
// every single Scout message while still letting an admin edit the table
// and have it take effect within minutes, no deploy required.
let planKnowledgeCache = null;
let planKnowledgeCacheAt = 0;
const PLAN_KNOWLEDGE_CACHE_TTL_MS = 5 * 60 * 1000;

async function getPlanKnowledge() {
  const now = Date.now();
  if (planKnowledgeCache && now - planKnowledgeCacheAt < PLAN_KNOWLEDGE_CACHE_TTL_MS) return planKnowledgeCache;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey) return planKnowledgeCache || "";
  try {
    const r = await fetch(`${supaUrl}/rest/v1/plan_config?select=plan_id,plan_name,tagline,price_usd,live_features&active=eq.true&order=display_order`, {
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
    });
    if (!r.ok) return planKnowledgeCache || "";
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return planKnowledgeCache || "";
    const text = rows.map((p) => `${p.plan_name} ($${p.price_usd}/mo, "${p.tagline}"): ${(p.live_features || []).join("; ")}`).join("\n");
    planKnowledgeCache = text;
    planKnowledgeCacheAt = now;
    return text;
  } catch {
    return planKnowledgeCache || "";
  }
}

// ============================================================
// Scout Intelligence Architecture — RETRIEVAL layer
// "Scout should RETRIEVE before it REASONS and REMEMBER after it LEARNS."
//
// Three stores, deliberately kept separate because they carry different
// trust levels and different privacy rules:
//
//   product_capabilities (099) — what GOLSZ can actually do. Global,
//     admin-curated. This is what lets Scout know that Discover and
//     user-to-user messaging were REMOVED from the product rather than
//     merely unmentioned, so it stops suggesting them.
//   golsz_knowledge (096) — GOLSZ Core: curated sport / eligibility /
//     pathway facts. Read through search_golsz_knowledge(), which returns
//     only rows whose verification_status is 'verified' or 'active' and
//     whose recheck_after hasn't passed. Model output NEVER writes here —
//     see persistMemoryWrites() below for why.
//   scout_memory (097) — this ONE athlete's durable memory, RLS'd to
//     owner-or-guardian, carrying an explicit type + source + confidence so
//     a thing the athlete SAID is never confused with a thing Scout GUESSED.
//
// Every read goes through the service key and is scoped by athlete_id, so
// one athlete's memory can never be assembled into another's prompt. These
// run inside the existing Promise.all / alongside the classifier rather than
// serially, so retrieval doesn't add a round trip to every message.
// ============================================================

// Every retrieved block is hard-capped. budgetGate() downgrades the model
// tier once estimated input cost gets too high, so an unbounded MEMORY or
// PRIOR RESEARCH block doesn't just cost tokens — past a threshold it
// silently drops the athlete from Sonnet to Haiku. Retrieval must never be
// able to spend the reply's own model quality. Budgets below total ~2,900
// chars (~725 tokens) worst case across all four blocks.
const RETRIEVAL_BUDGET = { capabilities: 1400, memory: 900, knowledge: 700, research: 900 };

function clampBlock(text, maxChars) {
  const t = String(text || "");
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const lastLine = cut.lastIndexOf("\n");
  return (lastLine > maxChars * 0.5 ? cut.slice(0, lastLine) : cut) + "\n…(truncated)";
}

let capabilityCache = null;
let capabilityCacheAt = 0;
const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;

// Mirrors getPlanKnowledge()'s shape exactly (cache + fail-soft to the last
// good value, never throw into the request path). Splits on `available`
// because the unavailable rows are the ones that actually change behavior —
// `notes` carries the "never suggest this" instruction the admin wrote.
async function getCapabilityKnowledge() {
  const now = Date.now();
  if (capabilityCache && now - capabilityCacheAt < CAPABILITY_CACHE_TTL_MS) return capabilityCache;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey) return capabilityCache || "";
  try {
    const r = await fetch(`${supaUrl}/rest/v1/product_capabilities?select=key,label,available,plan_min,notes&order=key`, {
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
    });
    if (!r.ok) return capabilityCache || "";
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return capabilityCache || "";
    const live = rows.filter((c) => c.available);
    const gone = rows.filter((c) => !c.available);
    let text = "";
    if (live.length) {
      text += "Available on GOLSZ today:\n" + live.map((c) => `- ${c.label}${c.plan_min ? ` (from the ${c.plan_min} plan)` : ""}${c.notes ? ` — ${c.notes}` : ""}`).join("\n");
    }
    if (gone.length) {
      text += `${text ? "\n" : ""}NOT part of GOLSZ — never suggest, imply, or offer these, and never tell an athlete to find or contact someone through them:\n` + gone.map((c) => `- ${c.label}${c.notes ? ` — ${c.notes}` : ""}`).join("\n");
    }
    capabilityCache = clampBlock(text, RETRIEVAL_BUDGET.capabilities);
    capabilityCacheAt = now;
    return capabilityCache;
  } catch {
    return capabilityCache || "";
  }
}

// GOLSZ Core lookup. Goes through the search_golsz_knowledge() RPC rather
// than selecting from golsz_knowledge directly, so the verification_status
// and recheck_after filtering lives in one place (the function) and can't
// drift between callers. Empty is a perfectly good answer — the table starts
// empty, and returning nothing is strictly better than inventing a rule.
async function getGolszKnowledge(sport, country, query) {
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey) return "";
  try {
    const r = await fetch(`${supaUrl}/rest/v1/rpc/search_golsz_knowledge`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        p_query: query && query.length > 2 ? query.slice(0, 200) : null,
        p_sport: sport || null,
        p_country: country || null,
        p_limit: 5,
      }),
    });
    if (!r.ok) return "";
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return "";
    return clampBlock(rows.map((k) => `- ${k.subject}: ${k.content}${k.source ? ` (source: ${k.source})` : ""}`).join("\n"), RETRIEVAL_BUDGET.knowledge);
  } catch {
    return "";
  }
}

// ============================================================
// Scout Intelligence Architecture — SCOUT CACHE (migration 098)
// "Don't research the same thing repeatedly."
//
// Spec ordering, implemented in the handler below:
//   1. Search GOLSZ Core        (getGolszKnowledge, above)
//   2. Search valid Scout Cache (getResearchCache, here)
//   3. Decide whether the athlete's circumstances materially changed
//      (athleteStateDigest — a cached finding computed for a Free-plan
//      athlete with no pathway is not automatically still right once they
//      have a goal and a pathway, so the entry is skipped, not served.)
//
// Both feed the prompt BEFORE the model reasons, so the saving is that the
// model doesn't need to run web search again — not that we skip the reply.
//
// PRIVACY DECISION: model-derived entries are only ever written at
// scope='athlete'. A scope='global' row is, by definition, served to other
// users, and the spec is explicit that free-text conversation content must
// never be automatically promoted into shared knowledge. Global rows stay
// admin-seeded, exactly like golsz_knowledge. Reads accept both, so seeded
// global research is used when it exists. Migration 098's CHECK constraint
// enforces the scope/athlete_id shape at the database level regardless.
// ============================================================

// Deliberately aggressive: word order, filler and punctuation shouldn't
// produce a cache miss for what is plainly the same question ("what are the
// NCAA eligibility rules" vs "NCAA rules for eligibility?"). Sorting the
// token set is what buys that. Not a security boundary — a collision just
// means Scout is handed prior research on a near-identical topic.
const TOPIC_STOPWORDS = new Set([
  "a","an","and","are","as","at","be","but","by","can","could","do","does","for","from","get","got","how","i","if","in","is","it","its","me","my","of","on","or","should","so","that","the","their","them","there","they","this","to","was","we","what","when","where","which","who","why","will","with","would","you","your","about","any","need","want","tell","know","much","many","some","just","like","really","please",
]);

function researchTopicKey(text, sport, country) {
  const tokens = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !TOPIC_STOPWORDS.has(w));
  const uniq = Array.from(new Set(tokens)).sort().slice(0, 12);
  if (!uniq.length) return null;
  return [String(sport || "any").toLowerCase(), String(country || "any").toLowerCase(), uniq.join("-")].join(":").slice(0, 400);
}

// A compact, READABLE digest rather than a hash — this lands in a text
// column an admin may well want to eyeball when a cache entry looks wrong,
// and it isn't a security value. Only material facts belong here: things
// that would genuinely change the answer to a research question.
function athleteStateDigest(state, plan, goalDefined) {
  return [
    String((state && state.sport) || "?"),
    String((state && state.country) || "?"),
    String(plan || "?"),
    goalDefined ? "goal" : "nogoal",
    state && state.pathwayCreated ? "pathway" : "nopathway",
    state && state.baselineComplete ? "baseline" : "nobaseline",
  ].join("|");
}

// Returns the cached summary text, or "" — never throws into the request
// path. Athlete-scoped rows whose stored state digest no longer matches are
// treated as stale and skipped (spec step 3). hit_count is bumped
// best-effort and deliberately not awaited into the critical path.
async function getResearchCache(userId, topicKey, stateDigest) {
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey || !topicKey) return "";
  const headers = { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" };
  try {
    const scopeFilter = userId ? `&or=(scope.eq.global,athlete_id.eq.${userId})` : "&scope=eq.global";
    const r = await fetch(
      `${supaUrl}/rest/v1/scout_research_cache?topic_key=eq.${encodeURIComponent(topicKey)}&valid_until=gte.${encodeURIComponent(new Date().toISOString())}${scopeFilter}&select=id,scope,summary,sources,confidence,athlete_state_hash,hit_count,created_at&order=scope.asc,created_at.desc&limit=4`,
      { headers },
    );
    if (!r.ok) return "";
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return "";
    // Prefer an athlete-scoped hit whose state still matches; otherwise fall
    // back to a global row, which by construction isn't athlete-specific.
    const usable = rows.find((c) => c.scope === "athlete" && c.athlete_state_hash === stateDigest) || rows.find((c) => c.scope === "global");
    if (!usable) return "";
    fetch(`${supaUrl}/rest/v1/scout_research_cache?id=eq.${usable.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ hit_count: (Number(usable.hit_count) || 0) + 1 }),
    }).catch(() => {});
    const srcs = Array.isArray(usable.sources) ? usable.sources.slice(0, 5).map((s) => s && s.url).filter(Boolean) : [];
    const age = Math.max(0, Math.round((Date.now() - new Date(usable.created_at).getTime()) / 86400000));
    return clampBlock(`${usable.summary}${srcs.length ? `\nSources: ${srcs.join(", ")}` : ""}\n(researched ${age} day${age === 1 ? "" : "s"} ago, confidence ${usable.confidence})`, RETRIEVAL_BUDGET.research);
  } catch {
    return "";
  }
}

// Only web search counts as "expensive research" worth caching — the GOLSZ
// player/event lookups are single indexed queries against our own database
// and are cheaper to redo than to cache.
function usedWebSearch(data) {
  return (data && Array.isArray(data.content) ? data.content : []).some(
    (b) => b && (b.type === "web_search_tool_result" || (b.type === "server_tool_use" && b.name === "web_search")),
  );
}

// Sources are read out of the ACTUAL tool-result blocks, never from the
// model's own account of what it read. Same provenance discipline as
// memory_writes: the model supplies the summary, the runtime supplies the
// evidence of where it came from.
function extractSearchSources(data) {
  const out = [];
  for (const b of (data && Array.isArray(data.content) ? data.content : [])) {
    if (!b || b.type !== "web_search_tool_result") continue;
    for (const r of (Array.isArray(b.content) ? b.content : [])) {
      if (r && typeof r.url === "string") out.push({ url: r.url.slice(0, 500), title: typeof r.title === "string" ? r.title.slice(0, 200) : null });
      if (out.length >= 8) return out;
    }
  }
  return out;
}

const RESEARCH_TTL_DEFAULT_DAYS = 14;

function extractResearchNote(data) {
  try {
    const raw = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("");
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = parseReplyObject(clean);
    const note = parsed && parsed.research_note;
    if (!note || typeof note !== "object") return null;
    const summary = typeof note.summary === "string" ? note.summary.trim().slice(0, 1200) : "";
    if (summary.length < 20) return null;
    let confidence = typeof note.confidence === "number" ? note.confidence : 0.6;
    if (!(confidence >= 0 && confidence <= 1)) confidence = 0.6;
    let validDays = Number.isInteger(note.valid_days) ? note.valid_days : RESEARCH_TTL_DEFAULT_DAYS;
    if (validDays < 1 || validDays > 90) validDays = RESEARCH_TTL_DEFAULT_DAYS;
    return { summary, confidence, validDays };
  } catch {
    return null;
  }
}

// GOLSZ Core candidate pipeline (migration 096's DISCOVERED state).
// golsz_knowledge started empty and nothing was filling it, so the Core
// retrieval built earlier had nothing to retrieve. This is the intake.
//
// The safety property that makes this acceptable at all: rows land as
// verification_status = 'discovered', and migration 096's RLS policy exposes
// ONLY 'verified'/'active'. search_golsz_knowledge() filters the same way. So
// a discovered row is invisible to every athlete and to Scout itself until an
// admin promotes it -- the spec's "UNVERIFIED MODEL OUTPUT IS NOT GLOBAL
// FACT" enforced structurally rather than by prompt.
//
// Only fires when the reply ACTUALLY ran web search and produced a research
// note whose summary is already written as standalone reference material (the
// prompt requires no "you"/"your" and no athlete-specific framing), and only
// with a source_url from a real tool-result block. Deduped on subject+sport
// so repeat research doesn't pile up duplicates for an admin to wade through.
const KNOWLEDGE_CATEGORY_BY_HINT = [
  [/eligibility|ncaa|naia|juco|amateur|clearinghouse/i, "eligibility"],
  [/transfer|portal|window|registration/i, "transfer_rules"],
  [/league|division|tier|pyramid|structure/i, "league_structure"],
  [/trial|combine|showcase|camp/i, "events"],
  [/visa|permit|passport|citizenship/i, "immigration"],
];

async function persistKnowledgeCandidate(topicKey, note, sources, sport, country) {
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey || !note || !note.summary) return;
  // No sources means no verifiable provenance, and an unverifiable candidate
  // is worse than none -- an admin would have nothing to check it against.
  if (!Array.isArray(sources) || !sources.length) return;
  const subject = String(topicKey || "").split(":").slice(2).join(":").replace(/-/g, " ").slice(0, 120);
  if (subject.length < 3) return;
  const blob = `${subject} ${note.summary}`;
  const category = (KNOWLEDGE_CATEGORY_BY_HINT.find(([re]) => re.test(blob)) || [null, "other"])[1];
  const headers = { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" };
  try {
    const dupe = await fetch(
      `${supaUrl}/rest/v1/golsz_knowledge?subject=eq.${encodeURIComponent(subject)}&sport=${sport ? "eq." + encodeURIComponent(sport) : "is.null"}&select=id&limit=1`,
      { headers },
    );
    const rows = dupe.ok ? await dupe.json() : [];
    if (Array.isArray(rows) && rows.length) return;
    const r = await fetch(`${supaUrl}/rest/v1/golsz_knowledge`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        subject,
        category,
        sport: sport || null,
        country: country || null,
        content: note.summary,
        source: "scout_research",
        source_url: sources[0] && sources[0].url ? sources[0].url : null,
        confidence: note.confidence,
        verification_status: "discovered",
        recheck_after: new Date(Date.now() + note.validDays * 86400000).toISOString(),
      }),
    });
    if (r.ok) console.log("GOLSZ knowledge candidate recorded:", subject, `(${category})`);
    else console.error("GOLSZ knowledge candidate failed:", r.status, await r.text());
  } catch (e) { console.error("GOLSZ knowledge candidate failed:", e); }
}

async function persistResearchCache(userId, topicKey, stateDigest, note, sources, modelUsed, sport, country) {
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey || !userId || !topicKey || !note) return;
  try {
    const r = await fetch(`${supaUrl}/rest/v1/scout_research_cache`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        topic_key: topicKey,
        scope: "athlete", // never 'global' from model output — see the block comment above
        athlete_id: userId,
        sport: sport || null,
        country: country || null,
        summary: note.summary,
        sources: sources || [],
        confidence: note.confidence,
        model_used: modelUsed || null,
        athlete_state_hash: stateDigest,
        valid_until: new Date(Date.now() + note.validDays * 86400000).toISOString(),
      }),
    });
    if (!r.ok) console.error("GOLSZ scout research cache write failed:", r.status, await r.text());
  } catch (e) { console.error("GOLSZ scout research cache write failed:", e); }
}

// ============================================================
// AUTHORITATIVE ATHLETE CONTEXT
//
// Before this existed, the athlete's biographical facts reached the model
// ONLY as client-built free text: golsz-app.html assembles
// "PROFILE SO FAR: {...}" and embeds it in the last user message. The server
// contributed product state (plan, pathway_created) but never identity. So
// the model was inferring who the athlete is from prose it was handed by the
// client, with anything older than the 6-turn window surviving only inside a
// Haiku-written summary. That is why Scout confused home with current
// location, re-asked answered questions, and invented history.
//
// This builds ONE server-side object from the database, before any model is
// called, and renders it as the single factual block every path shares. The
// client's PROFILE SO FAR is now redundant narration, not the source of
// truth — it is deliberately left in place for one release so client and
// server don't have to change in the same deploy.
//
// PRECEDENCE (highest first), enforced here in code rather than asked for in
// prose:
//   1. verified structured profile columns  (athletes/profiles)
//   2. explicit recent user correction      (newest athlete_stated memory)
//   3. durable Scout Memory                 (older athlete_stated)
//   4. older conversation context           (the summary, lowest-trust text)
//   5. model inference                      (ai_inferred memory — labelled,
//                                            never allowed to present as fact)
// A level-5 item can never overwrite 1-4: inferences are rendered in their
// own clearly-marked section and never merged into the fact list.
// ============================================================

// Canonical identity fields, in the order they should be read. Kept
// deliberately small: this is the set whose confusion actually produced
// wrong answers, not every column on the table.
const IDENTITY_FIELDS = [
  ["home_city", "home city (where they are FROM)"],
  ["home_country", "home country (where they are FROM)"],
  ["current_city", "current city (where they are NOW)"],
  ["country", "current country (where they are NOW)"],
  ["citizenship", "citizenship / passport"],
  ["sport", "sport"],
  ["position", "position"],
  ["secondary_position", "secondary position"],
  ["foot", "preferred foot/hand"],
  ["club_name", "current club / training environment"],
  ["recruiting_status", "current competition level / recruiting status"],
  ["grad_year", "graduation year"],
  ["education_level", "education level"],
  ["height_cm", "height (cm)"],
  ["weight_kg", "weight (kg)"],
  ["gpa", "GPA"],
];

// dob always wins; a bare "I'm 16" is aged forward from when it was said
// rather than believed verbatim forever.
function resolveAge(a) {
  if (!a) return null;
  if (a.dob) {
    const d = new Date(a.dob);
    if (!isNaN(d)) {
      const now = new Date();
      let age = now.getFullYear() - d.getFullYear();
      const m = now.getMonth() - d.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
      if (age >= 0 && age < 120) return { age, basis: "date of birth" };
    }
  }
  if (Number.isInteger(a.age_reported) && a.age_reported_at) {
    const said = new Date(a.age_reported_at);
    if (!isNaN(said)) {
      const years = Math.floor((Date.now() - said.getTime()) / (365.25 * 86400000));
      const age = a.age_reported + Math.max(0, years);
      return { age, basis: years > 0 ? `stated ${a.age_reported} on ${a.age_reported_at}` : "athlete stated" };
    }
  }
  if (Number.isInteger(a.age_reported)) return { age: a.age_reported, basis: "athlete stated" };
  return null;
}

// Conflict detection (Step 7). A durable athlete_stated memory whose subject
// names one of these concepts is compared against the authoritative column.
// If both exist and neither contains the other, that is a real contradiction
// and Scout is told to ask ONE clarification rather than silently pick a
// side or invent a reconciliation.
const CONFLICT_SUBJECTS = [
  [/home\s*(city|town)|hometown|from/i, "home_city"],
  [/home\s*country/i, "home_country"],
  [/current\s*(city|location)|living|based/i, "current_city"],
  [/current\s*country/i, "country"],
  [/citizenship|passport/i, "citizenship"],
  [/current\s*club|club|team|academy/i, "club_name"],
  [/position/i, "position"],
];

function detectConflicts(athlete, memories) {
  const out = [];
  for (const m of memories) {
    if (m.source !== "athlete_stated" || !m.active) continue;
    for (const [re, col] of CONFLICT_SUBJECTS) {
      if (!re.test(m.subject || "")) continue;
      const colVal = athlete && athlete[col];
      if (!colVal) break;
      const a = String(colVal).toLowerCase();
      const b = String(m.content || "").toLowerCase();
      if (a && b && !b.includes(a) && !a.includes(b)) {
        out.push(`${col}: profile says "${colVal}", but you were told "${m.content}"`);
      }
      break;
    }
  }
  return out.slice(0, 4);
}

async function buildAuthoritativeContext(userId) {
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey || !userId) return null;
  const headers = { apikey: serviceKey, Authorization: "Bearer " + serviceKey };
  try {
    const cols = "sport,position,secondary_position,foot,club_name,previous_clubs,recruiting_status,grad_year,education_level,height_cm,weight_kg,gpa,home_city,home_country,current_city,country,citizenship,dob,age_reported,age_reported_at,scout_context";
    const [aRes, mRes] = await Promise.all([
      fetch(`${supaUrl}/rest/v1/athletes?id=eq.${userId}&select=${cols}`, { headers }),
      fetch(`${supaUrl}/rest/v1/scout_memory?athlete_id=eq.${userId}&active=is.true&select=type,subject,content,confidence,source,importance,updated_at&order=importance.desc,updated_at.desc&limit=20`, { headers }),
    ]);
    const aRows = aRes.ok ? await aRes.json() : [];
    const mRows = mRes.ok ? await mRes.json() : [];
    const athlete = Array.isArray(aRows) && aRows[0] ? aRows[0] : null;
    const memories = (Array.isArray(mRows) ? mRows : []).map((m) => ({ ...m, active: true }));
    if (!athlete && !memories.length) return null;
    return { athlete, memories, conflicts: detectConflicts(athlete, memories), age: resolveAge(athlete) };
  } catch {
    return null;
  }
}

// Renders the object above into the one factual block every model path
// shares. Facts, inferences and unknowns are kept in SEPARATE sections on
// purpose — collapsing them into one list is precisely how an inference gets
// restated later as a fact.
function renderAuthoritativeContext(ctx) {
  if (!ctx) return "";
  const { athlete, memories, conflicts, age } = ctx;
  const facts = [];
  if (age) facts.push(`- age: ${age.age} (${age.basis})`);
  if (athlete) {
    for (const [col, label] of IDENTITY_FIELDS) {
      const v = athlete[col];
      if (v === null || v === undefined || v === "") continue;
      facts.push(`- ${label}: ${v}`);
    }
    if (Array.isArray(athlete.previous_clubs) && athlete.previous_clubs.length) {
      facts.push(`- previous clubs: ${athlete.previous_clubs.map((c) => c && c.name).filter(Boolean).join(", ")}`);
    }
  }
  // The soft qualification facts (migration 050). Already carry their own
  // source/confidence, so they slot straight into the fact/inference split
  // rather than needing a third category.
  const sc = (athlete && athlete.scout_context && typeof athlete.scout_context === "object") ? athlete.scout_context : {};
  const stated = [];
  const inferred = [];
  const unknowns = [];
  for (const [k, v] of Object.entries(sc)) {
    if (!v || typeof v !== "object" || v.value === undefined || v.value === null || v.value === "") continue;
    if (k === "ai_meta") continue;
    const line = `- ${k.replace(/_/g, " ")}: ${typeof v.value === "object" ? JSON.stringify(v.value) : v.value}`;
    if (v.source === "athlete_stated") stated.push(line);
    else inferred.push(`${line}${typeof v.confidence === "number" ? ` (confidence ${v.confidence})` : ""}`);
  }
  for (const m of memories) {
    if (m.type === "UNKNOWN" || m.type === "NEXT_DATA_NEEDED") unknowns.push(`- ${m.subject}: ${m.content}`);
    else if (m.source === "athlete_stated") stated.push(`- [${m.type}] ${m.subject}: ${m.content}`);
    else inferred.push(`- [${m.type}] ${m.subject}: ${m.content} (confidence ${m.confidence})`);
  }

  let out = "AUTHORITATIVE ATHLETE STATE — this is the record, loaded from the database this turn. It OUTRANKS anything you infer from the wording of the latest message, and it outranks the PROFILE SO FAR text in the message body. Never contradict it, never re-ask anything it already answers.";
  out += facts.length ? `\n\nVERIFIED PROFILE (highest authority):\n${facts.join("\n")}` : "\n\nVERIFIED PROFILE: nothing on file yet.";
  if (stated.length) out += `\n\nTHINGS THE ATHLETE HAS STATED (confirmed — treat as fact, never re-ask):\n${stated.join("\n")}`;
  if (inferred.length) out += `\n\nYOUR EARLIER INFERENCES (NOT facts — never assert these back as things they told you; confirm in passing if one matters):\n${inferred.join("\n")}`;
  if (unknowns.length) out += `\n\nKNOWN UNKNOWNS (ask about these before anything generic):\n${unknowns.join("\n")}`;
  if (conflicts.length) {
    out += `\n\nCONFLICTS — two authoritative sources disagree. Do NOT guess, do NOT silently pick one, do NOT invent a story that reconciles them. Ask ONE short clarifying question:\n${conflicts.map((c) => `- ${c}`).join("\n")}`;
  }
  // Deictic resolution (Step 2's worked example): "back" / "home" / "return"
  // are ambiguous only if you don't know both places. We do.
  if (athlete && (athlete.home_city || athlete.home_country) && (athlete.current_city || athlete.country)) {
    const home = [athlete.home_city, athlete.home_country].filter(Boolean).join(", ");
    const here = [athlete.current_city, athlete.country].filter(Boolean).join(", ");
    out += `\n\nRESOLVING "back"/"home"/"return"/"go there": the athlete is FROM ${home} and is CURRENTLY IN ${here}. Read "back"/"home"/"return" as ${home} unless the message clearly says otherwise. If genuinely ambiguous, ask ONE short question — never assume the wrong one and build advice on it.`;
  }
  return out;
}

// Step 3 — hard anti-hallucination rules. These are last in the prompt on
// purpose (recency) and are deliberately blunt. They are NOT the fix on
// their own; they sit on top of the structural work above.
const ANTI_HALLUCINATION_RULES = `NON-NEGOTIABLE FACT RULES:
1. Never invent a biographical fact. If it isn't in AUTHORITATIVE ATHLETE STATE or this conversation, you do not know it.
2. Never invent an agent, coach, club conversation, family situation, injury prognosis, offer, trial, scout interest, or historical event. If the athlete has not mentioned one, it does not exist.
3. Never convert an inference into a fact. Anything under YOUR EARLIER INFERENCES stays an inference until they confirm it.
4. If information is missing, say it is unknown, or ask. Do not fill the gap with something plausible.
5. If the athlete corrects a fact, the correction wins immediately — use it for the rest of this reply and record it.
6. Do not embellish emotion, stakes, or circumstances beyond what they actually said. No "you've bet everything on this".
7. Never claim a league, club, or pathway is higher or lower level than another without verified information. If you don't know, say so or look it up.
8. Never re-ask anything already answered in AUTHORITATIVE ATHLETE STATE.
9. Never invent a GOLSZ feature — GOLSZ CAPABILITIES is the complete list.
10. If current external facts are needed (dates, rules, rosters, deadlines), retrieve them. Never guess and never present a guess as current.

OUTPUT FORMAT — THIS OVERRIDES EVERYTHING ABOVE ABOUT TONE:
Your entire response must be a single valid JSON object matching the contract given earlier, starting with { and ending with }. Put the conversational text inside the "reply" field. Never write prose outside the JSON, never open with a sentence before the {, and never wrap it in markdown fences. "memory_writes" is required — use [] if nothing durable was learned.`;

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
  if (!url || !key || !userId) return { plan: "unknown", isAdmin: false, aiUnlimited: false, goalDefined: false, goalText: null };
  const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
  let plan = "starter";
  let isAdmin = false;
  let aiUnlimited = false;
  let goalDefined = false;
  let goalText = null;
  try {
    const p = await fetch(url + "/rest/v1/profiles?id=eq." + userId + "&select=plan,is_admin,ai_unlimited,goal_defined,goal_text", { headers });
    const rows = await p.json();
    if (Array.isArray(rows) && rows[0]) {
      plan = rows[0].plan || "starter";
      isAdmin = !!rows[0].is_admin;
      aiUnlimited = !!rows[0].ai_unlimited;
      goalDefined = !!rows[0].goal_defined;
      goalText = rows[0].goal_text || null;
    }
  } catch {}
  return { plan, isAdmin, aiUnlimited, goalDefined, goalText };
}

// GOLSZ Final Product / AI Scout / Pathway / Elite Architecture directive
// §11 "database-first state logic — do not ask the LLM to infer product
// state." profile_complete mirrors the exact same minimal heuristic the
// client already gates the whole app behind (golsz-app.html: "!!(athlete
// && athlete.sport)") — kept identical on purpose so the app and Scout
// never disagree about whether onboarding is done. pathway_created/
// baseline_complete come from a real pathway_plan row (migration 093);
// no row at all means both are false. Two small parallel queries, run
// alongside getProfileMeta() via Promise.all at the call site rather than
// serially, so this doesn't add real latency to every Scout message.
async function getAthleteState(userId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !userId) return { profileComplete: false, pathwayCreated: false, baselineComplete: false, sportSupportLevel: null, sport: null, country: null };
  const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
  let profileComplete = false;
  let sport = null;
  // Only used to scope the GOLSZ Core knowledge lookup below (eligibility and
  // pathway rules are country-specific). Never echoed back into a reply, and
  // never used to look up anyone but this athlete.
  let country = null;
  let pathwayCreated = false;
  let baselineComplete = false;
  let sportSupportLevel = null;
  try {
    const a = await fetch(url + "/rest/v1/athletes?id=eq." + userId + "&select=sport,country", { headers });
    const aRows = await a.json();
    sport = Array.isArray(aRows) && aRows[0] ? aRows[0].sport : null;
    country = Array.isArray(aRows) && aRows[0] ? aRows[0].country : null;
    profileComplete = !!sport;
  } catch {}
  try {
    const p = await fetch(url + "/rest/v1/pathway_plan?user_id=eq." + userId + "&select=baseline_complete", { headers });
    const pRows = await p.json();
    if (Array.isArray(pRows) && pRows[0]) {
      pathwayCreated = true;
      baselineComplete = !!pRows[0].baseline_complete;
    }
  } catch {}
  // Soft name lookup (not a foreign key — see migration 094) so an
  // athlete's free-text sport that doesn't match a seeded row just comes
  // back null, read as "secondary" by Scout, never an error.
  if (sport) {
    try {
      const s = await fetch(url + "/rest/v1/sports?name=ilike." + encodeURIComponent(sport) + "&select=support_level", { headers });
      const sRows = await s.json();
      sportSupportLevel = Array.isArray(sRows) && sRows[0] ? sRows[0].support_level : "secondary";
    } catch {}
  }
  return { profileComplete, pathwayCreated, baselineComplete, sportSupportLevel, sport, country };
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

// Lifetime counterpart to reserveScoutQuestion/releaseScoutQuestion above —
// same atomic RPC pattern (migration 068), but backed by
// profiles.free_ai_lifetime_used, which never resets. Only ever called for
// plan === 'free': "GOLSZ sells athlete progression, not AI questions" means
// the free plan is a bounded trial, not a daily allowance that runs forever.
async function reserveFreeAiQuestion(userId, limit) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !userId) return { allowed: true, used: 0, limit };
  try {
    const r = await fetch(url + "/rest/v1/rpc/reserve_free_ai_question", {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId, p_lifetime_limit: limit }),
    });
    const data = await r.json();
    return data && typeof data === "object" ? data : { allowed: true, used: 0, limit };
  } catch {
    return { allowed: true, used: 0, limit };
  }
}

async function releaseFreeAiQuestion(userId) {
  if (!userId) return;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return;
  try {
    await fetch(url + "/rest/v1/rpc/release_free_ai_question", {
      method: "POST",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId }),
    });
  } catch (e) { console.error("GOLSZ release_free_ai_question failed:", e); }
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
// A reply must never reach the athlete cut off mid-sentence. The output
// ceiling cannot simply be raised: with the cache-aware budget gate there is
// only ~780 output tokens of room before a Starter athlete is downgraded off
// the Sonnet tier, so a bigger ceiling would buy completeness by taking away
// reasoning quality. Instead, when a response stops because it hit the
// ceiling (stop_reason "max_tokens"), continue it.
//
// Uses assistant prefill: the partial text is handed back as the start of the
// assistant turn and the model carries on from exactly that point. The API
// rejects a prefill with trailing whitespace, hence the trim. Token usage is
// summed across the parts so cost accounting and the routing log stay honest,
// and the merged text is reassembled into a single text block so every
// downstream extractor sees one complete JSON object.
//
// Bounded: at most 2 continuations, and never started without real time left
// in the request budget — a truncated-but-salvageable reply beats a killed
// request. This is why salvageJsonValue() stays as the backstop.
// Joined with "" and NOT "\n". When a reply uses web search, the assistant
// text comes back as SEVERAL text blocks that are contiguous segments of one
// output stream, split at citation boundaries — not as separate lines. Joining
// them with a newline injects characters that were never generated, and a
// split landing inside a JSON string produces a literal newline in that
// string, which is invalid JSON. That corrupted our own payload and was being
// misread as truncation: strict parse failed, salvage fired, and on the haiku
// path the reply reached the extractors mangled even though the model had
// finished cleanly (stop_reason end_turn, not max_tokens). Reproduced
// directly: the same blocks joined with "\n" throw "Bad control character in
// string literal", joined with "" they parse.
function replyTextOf(data) {
  return ((data && data.content) || []).map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("");
}

function sumUsage(a, b) {
  const k = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
  const out = { ...(a || {}) };
  for (const key of k) out[key] = ((a && a[key]) || 0) + ((b && b[key]) || 0);
  return out;
}

async function continueIfTruncated(key, cfg, systemPrompt, systemDynamic, baseMessages, data, deadlineMs) {
  let out = data;
  for (let i = 0; i < 2; i += 1) {
    if (!out || out.stop_reason !== "max_tokens") break;
    if (deadlineMs && deadlineMs - Date.now() < 8000) {
      console.log("GOLSZ reply truncated but no budget left to continue; falling back to salvage");
      break;
    }
    // The API rejects a prefill ending in whitespace, so it has to be
    // trimmed — but that whitespace was real text. Dropping it fuses the last
    // word of part one onto the first word of part two ("first halfand the").
    // Keep it and re-insert on merge, unless the continuation already starts
    // with its own whitespace.
    const fullSoFar = replyTextOf(out);
    const partial = fullSoFar.replace(/\s+$/, "");
    const trimmedWs = fullSoFar.slice(partial.length);
    if (!partial) break;
    console.log("GOLSZ continuing truncated reply, part", i + 2);
    const cont = await callAnthropic(key, {
      model: cfg.model_name || MODEL_REGISTRY.DEEP_SCOUT.model,
      thinking: { type: "disabled" },
      system: systemPrompt,
      systemDynamic,
      messages: [...baseMessages, { role: "assistant", content: partial }],
      maxTokens: cfg.max_output_tokens,
    });
    if (!cont.ok) break;
    const contText = replyTextOf(cont.data);
    const joiner = /^\s/.test(contText) ? "" : trimmedWs;
    const merged = partial + joiner + contText;
    out = {
      ...cont.data,
      content: [{ type: "text", text: merged }],
      usage: sumUsage(out.usage, cont.data.usage),
    };
  }
  return out;
}

async function runDeepReply(key, deepTierConfig, systemPrompt, systemDynamic, baseConversation, deadlineMs) {
  const conversation = baseConversation.slice();
  const MAX_TOOL_TURNS = 4;
  // Surfaced to the caller so a reply that was cut short by the request
  // budget is logged as degraded rather than as a clean success.
  let toolBudgetExhausted = false;
  const budgetLeft = () => (deadlineMs ? deadlineMs - Date.now() : Infinity);
  let data;
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    // Stop looping once there isn't plausibly room for another search turn
    // plus the forced final answer below — see SCOUT_BUDGET_MS. Breaking
    // here (rather than starting a turn we can't finish) is what turns a
    // would-be killed request into a real, if less-researched, reply.
    if (turn > 0 && budgetLeft() < TOOL_TURN_MIN_MS) {
      console.log("GOLSZ scout tool loop stopping early, budget left ms:", budgetLeft());
      toolBudgetExhausted = true;
      break;
    }
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
      systemDynamic,
      messages: conversation,
      maxTokens: deepTierConfig.max_output_tokens,
      tools: [{ type: "web_search_20250305", name: "web_search" }, SEARCH_PLAYERS_TOOL, SEARCH_EVENTS_TOOL],
    });
    data = result.data;
    if (!result.ok) return { ok: false, data, toolBudgetExhausted };
    console.log("GOLSZ scout usage check:", JSON.stringify(data.usage));

    const searchCalls = (data.content || []).filter((b) => b.type === "tool_use" && (b.name === "search_golsz_players" || b.name === "search_golsz_events"));
    if (data.stop_reason !== "tool_use" || !searchCalls.length) return { ok: true, data, toolBudgetExhausted };

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
      systemDynamic,
      messages: conversation,
      maxTokens: deepTierConfig.max_output_tokens,
    });
    if (!result.ok) return { ok: false, data: result.data, toolBudgetExhausted };
    data = result.data;
  }
  return { ok: true, data, toolBudgetExhausted };
}

export default async function handler(req, res) {
  // Handler-entry timestamp for scout_routing_log.response_time_ms (082) —
  // measured from here rather than just around the model call, so it
  // reflects what an athlete actually waits (classification, auth/metering
  // checks, etc. all included), not just raw model latency.
  const handlerStartMs = Date.now();
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
  let requestId = null; // hoisted so logRouting() below can persist the same id already used for isDuplicateRequest() idempotency
  let userIsAdmin = false; // hoisted so the free-plan tool-block below can exempt admins, same reason userPlan is hoisted
  let userAiUnlimited = false;
  let dailyLimit = null;
  let questionsRemaining = null; // null = no usage info to show the client (unmetered deployment, or an unlimited/admin account)
  let reservedQuestion = false; // true once reserve_scout_question has counted this request — release it if we bail before a real answer
  let reservedFreeAi = false; // true once reserve_free_ai_question (068, lifetime, free plan only) has counted this request
  // Directive §11 "database-first state logic" — appended to systemPrompt
  // below once populated; empty string (no-op) for unauthenticated/dev-mode
  // requests, same fallback posture as userPlan/dailyLimit above.
  // Split deliberately: sharedBlock is identical for every athlete on this
  // language (product facts), so it stays in the cached system prefix.
  // athleteBlock is this athlete's own record and moves to a user turn.
  let sharedBlock = "";
  let athleteBlock = "";
  // Hoisted for the GOLSZ Core knowledge lookup, which runs alongside the
  // classifier below (outside this block) because it needs the athlete's
  // sport/country to scope eligibility and pathway rules.
  let athleteSport = null;
  let athleteCountry = null;
  // The single rendered factual block. Shared by the classifier, both answer
  // paths and the failover, so provider/tier can never change the facts.
  let authoritativeBlock = "";
  let hasConflicts = false;
  // Whether BOTH origin and current location are known — the precondition
  // for treating a "go back"-style question as a real relocation decision.
  let athleteHome = null;
  let athleteHere = null;
  const priorSummaryForPrompt = (body && typeof body.summary === "string") ? body.summary.trim() : "";
  // Step 8 telemetry, threaded into every logRouting() call below so a
  // degraded reply is never recorded as a clean one.
  let timeoutReason = "none";
  let fallbackUsed = "none";
  // Scout Cache: the athlete-state digest is computed once here (it needs
  // plan + goal + pathway state) and used both to select a still-valid
  // cache entry and to stamp any entry written this turn.
  let stateDigest = null;
  if (process.env.SUPABASE_URL) {
    userId = await getUserId(req.headers.authorization);
    if (!userId) return res.status(401).json({ error: "Sign in to use the Scout." });

    // Burst protection + duplicate-submission guard — see the comment above
    // isRateLimited()/isDuplicateRequest() for the honest limits of an
    // in-memory, single-instance check.
    if (isRateLimited(userId)) return res.status(429).json({ error: "Please wait a moment before sending another message." });
    requestId = body && typeof body.requestId === "string" ? body.requestId : null;
    if (isDuplicateRequest(requestId)) {
      // A repeat of a requestId we've already seen is usually a retry after
      // the CLIENT gave up (AbortSignal.timeout at 58s) on a request the
      // server actually finished. Returning 409 there made the athlete retype
      // a question that had already been answered and already been charged.
      // If the finished reply is still in the response cache, hand it back
      // instead. Only a request genuinely still in flight falls through to
      // the conflict.
      const replayed = await getCachedResponse(`req:${requestId}`);
      if (replayed) {
        console.log("GOLSZ scout replaying completed reply for requestId:", requestId);
        return res.status(200).json(replayed);
      }
      return res.status(409).json({ error: "That message is already being processed." });
    }

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
    // Scout Intelligence Architecture: retrieval joins the existing parallel
    // fan-out rather than adding round trips. buildAuthoritativeContext is
    // athlete-scoped (profile columns + Scout Memory in one pass);
    // getCapabilityKnowledge is global and cached. The GOLSZ Core lookup
    // can't run here because it needs athleteState.sport, so it runs
    // alongside the classifier below instead.
    const [{ plan, isAdmin, aiUnlimited, goalDefined, goalText }, athleteState, planKnowledge, authContext, capabilityKnowledge] = await Promise.all([
      getProfileMeta(userId),
      getAthleteState(userId),
      getPlanKnowledge(),
      buildAuthoritativeContext(userId),
      getCapabilityKnowledge(),
    ]);
    // Rendered once, here, and reused verbatim by every downstream path so no
    // model can receive a materially different version of the athlete's facts.
    authoritativeBlock = renderAuthoritativeContext(authContext);
    hasConflicts = !!(authContext && authContext.conflicts && authContext.conflicts.length);
    if (authContext && authContext.athlete) {
      const a = authContext.athlete;
      athleteHome = a.home_city || a.home_country || null;
      athleteHere = a.current_city || a.country || null;
    }
    athleteSport = athleteState.sport;
    athleteCountry = athleteState.country;
    stateDigest = athleteStateDigest(athleteState, plan, goalDefined);
    userPlan = plan;
    userIsAdmin = isAdmin;
    userAiUnlimited = aiUnlimited;
    // Directive §11 state machine — the EARLY gate only (profile_complete/
    // goal_defined/plan/pathway_created/baseline_complete). The FULLER
    // state machine (target/outreach/followup/benchmark due-ness) is
    // deliberately NOT computed here — it needs several more table scans
    // that matter for a dashboard nudge but not for every single chat
    // message, and the client already has that data loaded for Home's
    // own cards (see golsz-app.html computeNextMove()). Scout narrates
    // around this; it never decides it — see computeNextMove() comment.
    athleteBlock = `\n\nATHLETE STATE (app-computed from real data, not your own inference — ground your guidance in this, never contradict it or claim a different plan/stage): profile_complete=${athleteState.profileComplete}, goal_defined=${goalDefined}${goalText ? ` ("${goalText.slice(0, 200)}")` : ""}, plan=${plan}, pathway_created=${athleteState.pathwayCreated}, baseline_complete=${athleteState.baselineComplete}, sport_support_level=${athleteState.sportSupportLevel || "unknown"}.`;
    // Directive §10 "database is the source of truth, never hard-code
    // aspirational features into prompts as if live" — real, current plan
    // facts, not whatever this file's own hardcoded copy happens to say.
    if (planKnowledge) sharedBlock += `\n\nGOLSZ PLANS (real, current — never invent a feature, price, or restriction beyond this list):\n${planKnowledge}`;
    // Retrieved BEFORE the model reasons, so Scout opens already knowing this
    // athlete instead of rediscovering them. Both are omitted entirely when
    // empty rather than sent as an empty heading — a new athlete with no
    // memory yet should get no MEMORY section at all, not one saying "none".
    if (capabilityKnowledge) sharedBlock += `\n\nGOLSZ CAPABILITIES (real, current — the product does exactly this and nothing more):\n${capabilityKnowledge}`;
    if (authoritativeBlock) athleteBlock += `\n\n${authoritativeBlock}`;
    // Scout's own running note on the conversation. Labelled explicitly
    // because it used to be pasted into the USER message by the client, so
    // the model read it as something the athlete had just said — and in
    // production replied "that summary doesn't match what we've actually
    // discussed", arguing with a message nobody sent.
    if (priorSummaryForPrompt) {
      athleteBlock += `\n\nCONVERSATION SO FAR (YOUR OWN running note from earlier turns — context only. The athlete did NOT say this and cannot see it. Never quote it back, never argue with it, never treat it as their latest message):\n${clampBlock(priorSummaryForPrompt, 700)}`;
    }
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

      // Lifetime free AI budget (migration 068) — checked only for plan ===
      // 'free', only after the daily reservation succeeds (a request that
      // was never going to run today shouldn't burn lifetime budget either).
      // Distinct status code (403, not the daily-limit's 402) and error
      // shape so the client can show "upgrade to keep using Scout" instead
      // of "try again tomorrow" — those are different problems for the
      // athlete to solve. Model tier is already capped to Haiku-equivalent
      // for free plan by PLAN_MODEL_ACCESS below; this only bounds HOW MANY
      // of those cheap replies a free account ever gets, not just per day.
      if (plan === "free") {
        const freeLifetimeLimit = Number(process.env.FREE_LIFETIME_LIMIT || 40);
        const freeReservation = await reserveFreeAiQuestion(userId, freeLifetimeLimit);
        reservedFreeAi = true;
        if (!freeReservation.allowed) {
          await releaseScoutQuestion(userId);
          reservedQuestion = false;
          return res.status(403).json({
            error: "You've used all your free GOLSZ Scout questions. Upgrade to keep getting AI-powered guidance.",
            code: "free_ai_exhausted",
            scout_usage: { remaining: 0, limit: dailyLimit },
          });
        }
      }
    }
  }

  // ---- route (classify — with the FAQ list embedded — then decide the model) ----
  const conversation = messages.slice();
  const faqLang = LANG_NAMES[body && body.lang] ? body.lang : "en";

  try {
    const faqList = await getFaqList(faqLang);
    // 7s cap (4.5s before; 3.5s before that) — raised again after production
    // logs showed repeated "routing: null". A timeout is expensive twice
    // over: classification goes null, which both routes the request to the
    // dearer tier and loses summary_so_far, so the running conversation
    // summary silently stops advancing. Paired with a smaller output budget
    // and a shorter fact preamble so the call is genuinely quicker, not just
    // given longer to be slow.
    // Original note (was 3.5s — raised after real traffic showed the classifier
    // timing out often enough to matter for cost: adding summary_so_far/
    // missing_information/recommended_specialist this session made it do
    // more work per call, and every timeout falls through to a full Sonnet
    // reply as a safety net, which costs ~6x a Haiku reply for no reason
    // beyond the classifier being slow). If it still times out,
    // classification is null and shouldRouteToHaiku(null) safely falls
    // through to the proven Sonnet path below — this is a latency budget
    // increase, not a behavior change.
    // GOLSZ Core retrieval runs concurrently with the classifier so it costs
    // no added wall-clock time — the classifier's 4.5s cap dominates. It has
    // no timeout of its own because it's a single indexed RPC that fails soft
    // to "" rather than throwing.
    // Spec ordering, both concurrent with the classifier so neither costs
    // wall-clock time: (1) GOLSZ Core, (2) valid Scout Cache. The cache
    // lookup applies (3) "have circumstances materially changed" itself, by
    // rejecting athlete-scoped entries whose stored state digest has moved.
    const topicKey = researchTopicKey(latestUserText(conversation), athleteSport, athleteCountry);
    const [classification, golszKnowledge, priorResearch] = await Promise.all([
      withTimeout(classifyIntent(key, conversation, faqList, authoritativeBlock), 7000),
      getGolszKnowledge(athleteSport, athleteCountry, latestUserText(conversation)),
      getResearchCache(userId, topicKey, stateDigest),
    ]);
    if (priorResearch) console.log("GOLSZ scout research cache HIT:", topicKey);
    // withTimeout() resolves to null on expiry; classifyIntent() returns
    // {error}/{raw} for a provider or parse failure. Distinguishing them
    // matters: one is a latency problem, the other is a contract problem.
    if (classification === null) timeoutReason = "classifier_timeout";
    else if (classification && classification.error) timeoutReason = "provider_error";
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
    const knowledgeBlock = golszKnowledge
      ? `\n\nGOLSZ KNOWLEDGE (verified GOLSZ reference relevant to this athlete — prefer this over your own recollection):\n${golszKnowledge}`
      : "";
    const researchBlock = priorResearch
      ? `\n\nPRIOR RESEARCH (you already researched this exact question — answer from it instead of searching again unless it's old enough to have changed):\n${priorResearch}`
      : "";
    // STATIC prefix — identical for every athlete on this language+specialist,
    // so it caches once and is shared. Carries the cache breakpoint.
    const systemStatic = buildSystemPrompt(baseSystemPrompt, recommendedSpecialist) + sharedBlock;
    // PER-ATHLETE remainder, sent fresh. Order is unchanged from when this was
    // one string: athlete record, then knowledge, then prior research, then
    // the fact rules last (recency, and they reassert the JSON contract).
    const systemDynamic = [athleteBlock, knowledgeBlock, researchBlock].filter(Boolean).join("")
      + (authoritativeBlock ? `\n\n${ANTI_HALLUCINATION_RULES}` : "");
    // Concatenation of the two IS the old single string, byte for byte. Kept
    // for token estimation and anything that wants the whole prompt.
    const systemPrompt = systemStatic + systemDynamic;
    // REVERTED from the "context as a leading user turn" experiment. Moving
    // per-athlete state into the messages array made the model treat the
    // exchange as a free-flowing conversation and answer in PROSE, with no
    // JSON envelope at all (stop_reason end_turn, PARSE_FAILED on every
    // turn). That silently broke every structured extraction — memory_writes,
    // profile_updates, scout_context_updates, suggested_*, drafted_email —
    // which is why scout_memory never filled. Making the synthetic
    // acknowledgement valid JSON and restating the contract last both failed
    // to bring it back; the interaction SHAPE was the cause.
    //
    // Shared prompt caching across athletes is worth far less than structured
    // output working at all, so the per-athlete blocks go back into the
    // system prompt where they were. The cached prefix is per-athlete again;
    // that is the accepted cost.
    const conversationForModel = conversation;

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
        next_move: extractNextBestAction(classification),
      };
      await logRouting("database", classification, null, { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }, { plan: userPlan, specialist: recommendedSpecialist, requestId, responseTimeMs: Date.now() - handlerStartMs, timeoutReason, fallbackUsed });
      return res.status(200).json(payload);
    }
    await logFaqMiss(classification, latestUserText(conversation));

    // ---- Free-plan tool block (brief §12: "Do NOT permit FREE accounts to
    // perform: deep web research, large school searches... other high-cost
    // tool calls"). selectModelTier() below deliberately never caps a
    // tool-requiring question down by plan (that's a correctness need, not
    // a discretionary depth choice) — so without this check a free account
    // could still trigger a full-price web_lookup/db_lookup tool call.
    // Checked here, not inside selectModelTier(), so it can return a clear
    // 402 with an upgrade message instead of silently downgrading quality. ----
    if (userPlan === "free" && classification && classification.needs_tool && !userIsAdmin && !userAiUnlimited) {
      if (reservedQuestion) await releaseScoutQuestion(userId);
      if (reservedFreeAi) await releaseFreeAiQuestion(userId);
      return res.status(402).json({
        error: "Web and player-database search is a Starter+ feature. Upgrade to unlock deeper research from Scout.",
        code: "free_tool_blocked",
        scout_usage: { remaining: questionsRemaining, limit: dailyLimit },
      });
    }

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
    const complexity = complexityScore({
      text: latestText,
      classification,
      context: {
        twoLocationsKnown: !!(athleteHome && athleteHere),
        hasConflicts,
      },
    });
    let modelTier = selectModelTier({ plan: planForRouting, classification, score: complexity }).tier;
    if (modelTier === "premium" && !SCOUT_PREMIUM_ENABLED) modelTier = "advanced";
    // Split, not summed: the system prompt is the cache_control'd block and
    // is re-read at the cached rate on every turn after the first, while the
    // conversation messages are always fresh input. See estimateTierCost().
    const cachedInputTokens = Math.ceil(systemStatic.length / 4);
    const freshInputTokens = Math.ceil((systemDynamic.length + JSON.stringify(conversation).length) / 4);
    modelTier = await budgetGate(modelTier, planForRouting, freshInputTokens, cachedInputTokens);
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
        await logRouting("database", classification, null, { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }, { plan: userPlan, specialist: recommendedSpecialist, requestId, responseTimeMs: Date.now() - handlerStartMs, timeoutReason, fallbackUsed });
        cached.scout_summary = updatedSummary;
        if (reservedQuestion) cached.scout_usage = { remaining: questionsRemaining, limit: dailyLimit };
        cached.next_move = extractNextBestAction(classification);
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
      // `data` is reassigned by the truncation continuation below, so it
      // cannot be destructured as const.
      let { ok, data } = await adapter.generate({
        apiKey: key,
        model: tierConfig.model_name || MODEL_REGISTRY.FAST_CHAT.model,
        system: systemStatic,
        systemDynamic,
        messages: conversationForModel,
        maxTokens: tierConfig.max_output_tokens,
        tools: [{ type: "web_search_20250305", name: "web_search" }, SEARCH_PLAYERS_TOOL, SEARCH_EVENTS_TOOL],
      });
      if (ok && data.stop_reason === "max_tokens") {
        data = await continueIfTruncated(key, tierConfig, systemStatic, systemDynamic, conversationForModel, data, handlerStartMs + SCOUT_BUDGET_MS);
      }
      if (ok && data.stop_reason !== "tool_use") {
        console.log("GOLSZ scout usage check (haiku):", JSON.stringify(data.usage));
        const cost = estimateCost(tierConfig.model_name, data.usage);
        const profileUpdates = extractProfileUpdates(data);
        const scoutContextUpdates = extractScoutContextUpdates(data);
        await logRouting("haiku", classification, tierConfig.model_name, data.usage, { plan: userPlan, specialist: recommendedSpecialist, requestId, responseTimeMs: Date.now() - handlerStartMs, timeoutReason, fallbackUsed });
        await recordScoutUsageCost(userId, cost, data.usage && data.usage.input_tokens, data.usage && data.usage.output_tokens);
        await persistProfileUpdates(userId, profileUpdates);
        await persistScoutContext(userId, scoutContextUpdates);
        await persistMemoryWrites(userId, extractMemoryWrites(data));
        // Keyed by requestId so a client-side timeout retry can recover this
        // exact reply rather than re-asking the athlete (and re-charging them).
        // Short TTL: this is crash recovery, not a semantic cache.
        if (requestId) await setCachedResponse(`req:${requestId}`, "replay", "n/a", data);
        data.reply_text = deriveReplyText(data);
    data.scout_summary = updatedSummary;
        if (reservedQuestion) data.scout_usage = { remaining: questionsRemaining, limit: dailyLimit };
        // next_move is THIS request's own classification result, not a fact
        // about the shared cached answer — attached only after
        // setCachedResponse's JSON.stringify has already run (synchronously,
        // before its first await), so a personalized next-move suggestion
        // never gets baked into what a different user sees on a future cache
        // hit for the same generic simple_knowledge answer.
        if (cacheKey && !profileUpdates && !scoutContextUpdates) await setCachedResponse(cacheKey, classification.intent, modelTier, data);
        data.next_move = extractNextBestAction(classification);
        // Same cache-safety ordering as next_move above — these are
        // this-athlete-specific suggestions, attached only after the cache
        // write already happened.
        data.suggested_targets = extractSuggestedTargets(data);
        data.suggested_dev_items = extractSuggestedDevItems(data);
        data.suggested_pathway = userPlan === "free" ? null : extractSuggestedPathway(data);
        data.drafted_email = extractDraftedEmail(data);
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

    const scoutDeadline = handlerStartMs + SCOUT_BUDGET_MS;
    let sonnetResult = await runDeepReply(key, deepTierConfig, systemStatic, systemDynamic, conversationForModel, scoutDeadline);
    if (!sonnetResult.ok) {
      // Automatic failover, step 1: retry the WHOLE reply once, from a fresh
      // conversation copy (runDeepReply never mutates the caller's array) —
      // never resume mid-tool-exchange after a failure. Skipped when the
      // budget can't absorb a second full attempt, so we fall straight
      // through to the cheap no-tools Haiku fallback below instead of
      // starting a retry the platform would kill mid-flight (the original
      // "connection dropped" path).
      const retryRoom = scoutDeadline - Date.now();
      if (retryRoom >= TOOL_TURN_MIN_MS) {
        console.log("GOLSZ sonnet call failed, retrying once:", JSON.stringify(sonnetResult.data));
        if (timeoutReason === "none") timeoutReason = "provider_error";
        fallbackUsed = "sonnet_retry";
        sonnetResult = await runDeepReply(key, deepTierConfig, systemStatic, systemDynamic, conversationForModel, scoutDeadline);
      } else {
        console.log("GOLSZ sonnet call failed, skipping retry (budget left ms:", retryRoom, "):", JSON.stringify(sonnetResult.data));
        timeoutReason = "retry_skipped";
      }
    }

    if (!sonnetResult.ok) {
      // Automatic failover, step 2: cross-model fallback to a plain,
      // no-tools Haiku reply. Never invents search results/listings while
      // degraded — explicitly told to say so plainly instead (spec: "return
      // a transparent message rather than inventing current information").
      console.log("GOLSZ sonnet retry also failed, falling back to haiku:", JSON.stringify(sonnetResult.data));
      fallbackUsed = "haiku_cross_model";
      const fallbackSystem = systemDynamic + "\n\nNOTE: Live database/web search is temporarily unavailable. Give the best general guidance you can and say plainly that real-time GOLSZ search isn't available right now — never invent specific results, listings, or players.";
      const fastCfg = byTier.economy || ANTHROPIC_DEFAULTS.economy;
      const haikuFallback = await adapterFor(fastCfg.provider).generate({
        apiKey: key,
        model: fastCfg.model_name || MODEL_REGISTRY.FAST_CHAT.model,
        system: systemStatic,
        systemDynamic: fallbackSystem,
        messages: conversationForModel,
        maxTokens: fastCfg.max_output_tokens,
      });
      if (haikuFallback.ok) {
        const data = haikuFallback.data;
        console.log("GOLSZ scout usage check (haiku fallback):", JSON.stringify(data.usage));
        const cost = estimateCost(fastCfg.model_name, data.usage);
        await logRouting("haiku", classification, fastCfg.model_name, data.usage, { plan: userPlan, escalationReason: "sonnet_provider_failure", specialist: recommendedSpecialist, requestId, responseTimeMs: Date.now() - handlerStartMs, timeoutReason, fallbackUsed });
        await recordScoutUsageCost(userId, cost, data.usage && data.usage.input_tokens, data.usage && data.usage.output_tokens);
        await persistProfileUpdates(userId, extractProfileUpdates(data));
        await persistScoutContext(userId, extractScoutContextUpdates(data));
        await persistMemoryWrites(userId, extractMemoryWrites(data));
        // Keyed by requestId so a client-side timeout retry can recover this
        // exact reply rather than re-asking the athlete (and re-charging them).
        // Short TTL: this is crash recovery, not a semantic cache.
        if (requestId) await setCachedResponse(`req:${requestId}`, "replay", "n/a", data);
        data.reply_text = deriveReplyText(data);
    data.scout_summary = updatedSummary;
        if (reservedQuestion) data.scout_usage = { remaining: questionsRemaining, limit: dailyLimit };
        data.next_move = extractNextBestAction(classification);
        data.suggested_targets = extractSuggestedTargets(data);
        data.suggested_dev_items = extractSuggestedDevItems(data);
        data.suggested_pathway = userPlan === "free" ? null : extractSuggestedPathway(data);
        data.drafted_email = extractDraftedEmail(data);
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
      if (reservedFreeAi) await releaseFreeAiQuestion(userId);
      await logError("api/scout.js", "Both Sonnet and Haiku failed (automatic failover exhausted)", { detail: JSON.stringify({ sonnet: sonnetResult.data, haiku: haikuFallback.data }) });
      // Failover exhausted with no answer produced — still worth a
      // scout_routing_log row (082) so failure rate is visible in cost/
      // usage telemetry instead of only showing up in error_log.
      await logRouting("failed", classification, null, null, { plan: userPlan, specialist: recommendedSpecialist, requestId, responseTimeMs: Date.now() - handlerStartMs, success: false, timeoutReason, fallbackUsed });
      return res.status(503).json({ error: "Scout is temporarily unavailable. Please try again shortly." });
    }

    const data = await continueIfTruncated(key, deepTierConfig, systemStatic, systemDynamic, conversationForModel, sonnetResult.data, scoutDeadline);
    if (sonnetResult.toolBudgetExhausted && timeoutReason === "none") timeoutReason = "tool_budget_exhausted";
    const sonnetCost = estimateCost(deepTierConfig.model_name, data.usage);
    await logRouting("sonnet", classification, deepTierConfig.model_name, data.usage, { plan: userPlan, escalationReason: haikuFailureReason || escalationReason(classification), specialist: recommendedSpecialist, requestId, responseTimeMs: Date.now() - handlerStartMs, timeoutReason, fallbackUsed });
    await recordScoutUsageCost(userId, sonnetCost, data.usage && data.usage.input_tokens, data.usage && data.usage.output_tokens);
    await persistProfileUpdates(userId, extractProfileUpdates(data));
    await persistScoutContext(userId, extractScoutContextUpdates(data));
    await persistMemoryWrites(userId, extractMemoryWrites(data));
    // Scout Cache write. Gated on the reply having ACTUALLY run web search
    // (checked against the response's tool-result blocks, not the model's
    // word for it) — this is the only path with the web_search tool, and
    // caching a reply that did no research would just serve stale opinion
    // back later. Skipped entirely on a cache hit, so a served entry never
    // rewrites itself and resets its own TTL.
    const searched = usedWebSearch(data);
    const note = searched ? extractResearchNote(data) : null;
    if (!priorResearch && searched && note) {
      const searchSources = extractSearchSources(data);
      await persistResearchCache(userId, topicKey, stateDigest, note, searchSources, deepTierConfig.model_name, athleteSport, athleteCountry);
      console.log("GOLSZ scout research cached:", topicKey, "valid_days:", note.validDays);
      // Same finding promoted one level up: an athlete-scoped cache entry AND
      // a platform-wide candidate awaiting admin verification.
      await persistKnowledgeCandidate(topicKey, note, searchSources, athleteSport, athleteCountry);
    }
    // Keyed by requestId so a client-side timeout retry can recover this
    // exact reply rather than re-asking the athlete (and re-charging them).
    // Short TTL: this is crash recovery, not a semantic cache.
    if (requestId) await setCachedResponse(`req:${requestId}`, "replay", "n/a", data);
    data.reply_text = deriveReplyText(data);
    data.scout_summary = updatedSummary;
    if (reservedQuestion) data.scout_usage = { remaining: questionsRemaining, limit: dailyLimit };
    data.next_move = extractNextBestAction(classification);
    data.suggested_targets = extractSuggestedTargets(data);
    data.suggested_dev_items = extractSuggestedDevItems(data);
    data.suggested_pathway = userPlan === "free" ? null : extractSuggestedPathway(data);
    data.drafted_email = extractDraftedEmail(data);
    return res.status(200).json(data); // Anthropic-shaped { content: [...] } — client already parses this
  } catch (e) {
    if (reservedQuestion) await releaseScoutQuestion(userId);
    if (reservedFreeAi) await releaseFreeAiQuestion(userId);
    await logError("api/scout.js", "Upstream model call failed", { detail: String(e) });
    return res.status(502).json({ error: "Upstream model call failed", detail: String(e) });
  }
}
