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
//   STARTER_DAILY_LIMIT      Scout calls/day on Basic (EUR 6/mo, default 8)
//   PRO_DAILY_LIMIT          Scout calls/day on Pro (EUR 15/mo, default 15)
//   ELITE_DAILY_LIMIT        Scout calls/day on Elite (EUR 30/mo, default 20)
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

// P0-4: parent-managed under-16 athletes. Scout accepts an athleteId in the
// request body so a parent can talk to Scout on their child's behalf — and
// that id is verified against parent_links here, server-side, before it is
// used for anything. See api/_acting-for.js for the full rule set. The
// underscore prefix keeps Vercel from treating it as its own Serverless
// Function (this project is on the Hobby plan's 12-function cap).
import { resolveActingAthlete } from "./_acting-for.js";
// The app's own deterministic diagnosis (the five Passport Strength
// sub-scores Home renders) and the one authoritative feature->plan mapping.
// Both are shared modules rather than re-derived here so Scout cannot
// disagree with what the athlete is looking at, or name a tier the UI does
// not actually gate on. See each file's header for why they are copies of
// golsz-app.html rather than imports of it.
// Aliased: READINESS_DIMENSIONS is already taken further down by the (not
// yet shipped) goal-relative readiness ENGINE vocabulary, which is a
// different six-dimension concept. These five are the Passport Strength
// sub-scores the athlete actually sees on Home today.
import { computeReadiness, DIMENSION_LABEL, READINESS_DIMENSIONS as PASSPORT_STRENGTH_DIMENSIONS } from "./_readiness.js";
import { evaluateEntitlements, hasFeature, planDisplayName, FEATURE_LABEL } from "./_entitlements.js";

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

// The emergency provider's per-1M rates. Env-driven because only the
// operator knows which vendor they signed up with. If the fallback model
// isn't in PRICING and these aren't set, cost estimation would silently bill
// it at Sonnet rates (the old default), quietly corrupting the margin
// dashboards. Defaults match grok-4.20-0309-non-reasoning's sub-200k-context
// tier ($1.25 in / $2.50 out per 1M, xAI published pricing, checked
// 2026-08-09) so an operator who sets only a key still gets accurate numbers.
// NOTE: xAI charges double above a 200k-token context. GOLSZ prompts run
// ~10k, so the lower tier is the correct one here — revisit only if the
// context budget ever grows by an order of magnitude.
function fallbackPricing() {
  return {
    input: Number(process.env.SCOUT_FALLBACK_INPUT_COST || 1.25),
    output: Number(process.env.SCOUT_FALLBACK_OUTPUT_COST || 2.5),
  };
}

function estimateCost(model, usage) {
  if (!usage) return null;
  const fb = fallbackProviderConfig();
  const price = PRICING[model]
    || (fb && model === fb.model ? fallbackPricing() : null)
    || PRICING["claude-sonnet-5"];
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
// advanced/premium max_output_tokens are 1024/2048, NOT the API's real
// ceiling of 4096 — this is the pre-flight budgeting estimate migration 104
// already reasoned through: 4096 x $15/M = $0.0614 for the output ceiling
// ALONE exceeds every plan's HARD_MAX_COST_PER_REQUEST except elite's, so
// budgetGate() silently downgraded advanced/premium to Haiku on every
// request for free/starter/pro, regardless of actual complexity.
//
// This is the FALLBACK used whenever scout_model_config has no row for a
// tier (including an empty table, which is the state that shipped the bug
// live: migration 104 was a bare UPDATE against zero rows, a silent no-op,
// so this stale 4096 default was the only value actually in effect). Kept
// in permanent sync with migration 110, which seeds the DB with the same
// numbers — fixed in both places on purpose, so the DB being empty, wiped,
// or never seeded in a fresh environment can never silently regress this
// again.
const ANTHROPIC_DEFAULTS = {
  economy: { provider: "anthropic", model_name: "claude-haiku-4-5", input_cost_per_million: 1, output_cost_per_million: 5, max_output_tokens: 1024 },
  standard: { provider: "anthropic", model_name: "claude-haiku-4-5", input_cost_per_million: 1, output_cost_per_million: 5, max_output_tokens: 2048 },
  advanced: { provider: "anthropic", model_name: "claude-sonnet-5", input_cost_per_million: 3, output_cost_per_million: 15, max_output_tokens: 1024 },
  premium: { provider: "anthropic", model_name: "claude-sonnet-5", input_cost_per_million: 3, output_cost_per_million: 15, max_output_tokens: 2048 },
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
// free/starter were 0.02 until 2026-08-09 — found live, via the diagnostic
// added while chasing the migration-110 bug above: a real mid-conversation
// advanced reply (2801 fresh + 5260 cached input tokens, 1024 output tokens)
// costs ~$0.0253, already over $0.02 before the conversation grows at all.
// Migration 104's reasoning ("keep the 1024-token output ceiling alone under
// the cap") only budgeted ~$0.0046 of headroom for input, but this app's
// per-request AUTHORITATIVE CONTEXT is rebuilt fresh from the DB every call
// (it reflects live athlete state, so it can't sit behind Anthropic's prompt
// cache like the static system prompt does) — so a routine message's fresh
// input alone regularly exceeds that headroom by itself. Net effect: the
// "advanced" ceiling PLAN_MODEL_ACCESS grants free/starter was unreachable
// in practice, on top of (not instead of) the empty-table bug fixed above.
// Raised to 0.03 — clears a typical advanced reply with real margin for the
// conversation to grow, while staying below pro's 0.04 so plan tiers still
// differ in how long a conversation can sustain Sonnet before downgrading.
const HARD_MAX_COST_PER_REQUEST = {
  free: Number(process.env.SCOUT_HARD_MAX_COST_FREE || 0.03),
  starter: Number(process.env.SCOUT_HARD_MAX_COST_STARTER || 0.03),
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
    // systemDynamic was destructured here but never forwarded — a real bug
    // found 2026-08-09 while adding the second provider. Every caller that
    // went through the adapter (rather than calling callAnthropic directly)
    // silently lost the per-athlete half of the system prompt. The worst
    // case was the cross-model fallback, which passes the athlete state AND
    // the "live search is unavailable, don't invent results" notice through
    // this field: a degraded reply was answering with no athlete context and
    // without being told it was degraded.
    return callAnthropic(apiKey, { model, system, systemDynamic, messages, tools, thinking, maxTokens, stopSequences });
  },
};

// ---- Second provider: OpenAI-compatible chat/completions ----
//
// Deliberately built against the OpenAI /chat/completions WIRE FORMAT rather
// than one named vendor. That shape is a de-facto standard — OpenAI, Groq,
// Together, Fireworks, DeepSeek, Mistral and xAI all speak it — so a single
// adapter lets the operator pick (or switch) the emergency provider with two
// env vars and no code change. Which vendor to pay for is a business
// decision, not one to hard-code here.
//
// Master Architecture Non-Negotiable #2: "GOLSZ must not depend on a single
// AI provider." Until now every model in MODEL_REGISTRY was Anthropic and the
// only "failover" was Sonnet -> Haiku, which does nothing in an
// Anthropic-wide outage. This is the path that keeps Scout answering.
//
// THE CRITICAL CONTRACT: this returns an ANTHROPIC-SHAPED response. Every
// downstream consumer — deriveReplyText, extractProfileUpdates,
// extractMemoryWrites, estimateCost, logRouting, the salvage parser — reads
// data.content[].text / data.usage.input_tokens / data.stop_reason.
// Normalising here is what keeps routing, cost telemetry, memory writes,
// safety rules and the athlete's experience identical no matter who answered.
// Accepts either a full endpoint or a base URL. Vendors publish their base
// ("https://api.x.ai/v1") far more often than the full path, and configuring
// the base by mistake would POST to /v1 and 404 — a misconfiguration that
// only ever surfaces during an outage, i.e. the worst possible time to
// discover it. Normalising here makes both forms work.
function openaiCompatEndpoint() {
  let raw = (process.env.SCOUT_FALLBACK_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  // FORCE https. Found live 2026-08-09: the env var had been saved as
  // "http://api.x.ai/v1", and every request failed with xAI's
  // "unauthenticated:no-credentials" — because the Authorization header is
  // dropped when a cleartext request is redirected to TLS. Two problems in
  // one: the fallback silently never worked, AND the API key plus the
  // athlete's personal context were being put on the wire in cleartext.
  // Upgrading here means a mistyped scheme can never do either again.
  raw = raw.replace(/^http:\/\//i, "https://");
  if (!/^https:\/\//i.test(raw)) raw = "https://" + raw.replace(/^\/+/, "");
  return /\/chat\/completions$/.test(raw) ? raw : raw + "/chat/completions";
}

function toOpenAiMessages(system, systemDynamic, messages) {
  // Anthropic takes system separately; OpenAI-compatible APIs take it as the
  // first message. The two system blocks are concatenated in the SAME order
  // the model would have received them, so the prompt is byte-equivalent in
  // content even though the transport differs.
  const sys = [system, systemDynamic].filter(Boolean).join("\n\n");
  const out = sys ? [{ role: "system", content: sys }] : [];
  for (const m of messages || []) {
    // Anthropic content can be a string or an array of blocks; flatten to the
    // plain text these APIs expect, dropping tool/image blocks (the fallback
    // path is text-only by design — see the no-tools note below).
    const content = typeof m.content === "string"
      ? m.content
      : (Array.isArray(m.content) ? m.content.map((b) => (b && b.type === "text" ? b.text : "")).filter(Boolean).join("\n") : "");
    if (content) out.push({ role: m.role === "assistant" ? "assistant" : "user", content });
  }
  return out;
}

const openaiCompatibleAdapter = {
  provider: "openai_compatible",
  // No `tools` parameter on purpose. This adapter only ever serves the
  // emergency no-tools reply, so it can never claim to have run a web or
  // database search. The caller pairs it with the same "say plainly that
  // live search is unavailable" notice used by the Haiku fallback.
  async generate({ apiKey, model, system, systemDynamic, messages, maxTokens }) {
    const r = await fetch(openaiCompatEndpoint(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens || 1024,
        messages: toOpenAiMessages(system, systemDynamic, messages),
      }),
    });
    const raw = await r.json();
    if (!r.ok) return { ok: false, status: r.status, data: raw };
    return { ok: true, status: r.status, data: normalizeOpenAiResponse(raw) };
  },
};

// Maps an OpenAI-compatible response onto the Anthropic shape the rest of the
// file already understands. Exported-by-position for tests: this is the single
// riskiest function in the fallback, because a wrong shape here would fail
// LATER (empty reply, null cost, lost memory writes) rather than loudly.
function normalizeOpenAiResponse(raw) {
  const choice = raw && Array.isArray(raw.choices) ? raw.choices[0] : null;
  const text = (choice && choice.message && typeof choice.message.content === "string") ? choice.message.content : "";
  const u = (raw && raw.usage) || {};
  return {
    id: raw && raw.id ? raw.id : "fallback",
    content: [{ type: "text", text }],
    // "length" is this format's max_tokens stop; map it so continueIfTruncated
    // and the existing max_tokens handling read it the same way.
    stop_reason: choice && choice.finish_reason === "length" ? "max_tokens" : "end_turn",
    usage: {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
      // These APIs have no equivalent of Anthropic's explicit cache accounting.
      // Reported as 0 rather than omitted so estimateCost() and the cost
      // dashboards do arithmetic on real zeros instead of undefined.
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

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
  openai: openaiCompatibleAdapter,
  openai_compatible: openaiCompatibleAdapter,
  google: unconfiguredAdapter("google"),
  xai: unconfiguredAdapter("xai"),
};
function adapterFor(provider) {
  return PROVIDER_ADAPTERS[provider] || anthropicAdapter;
}

// The emergency provider is configured entirely by env, and is INERT unless
// both vars are set — no key means fallbackProviderConfig() returns null and
// the failover chain behaves exactly as it does today. Nothing about the
// normal path changes when this is unconfigured.
// Configured provider: xAI (Grok), reached through the OpenAI-compatible
// adapter above. Model default is grok-4.20-0309-non-reasoning, chosen
// deliberately for THIS job rather than for raw capability:
//
//   - NON-REASONING is the decisive property. This path runs with a ~1024
//     output cap under the existing SCOUT_BUDGET_MS wall clock, during an
//     outage. A reasoning model can spend that entire budget on internal
//     thinking and return truncated or empty content — a catastrophic
//     failure mode for the one path whose whole purpose is to prevent a
//     total outage. Non-reasoning returns usable text immediately.
//   - Mid-tier price ($1.25/$2.50 per 1M), not the flagship. grok-4.5 is
//     "most intelligent and fastest" per xAI but costs $6/1M output — 2.4x
//     more for a degraded emergency reply nobody should be relying on.
//   - 1M context, far beyond the ~10k this prompt needs, so the athlete's
//     full context can never be truncated on the fallback path.
//   - grok-build-0.1 is cheaper ($1/$2) but xAI documents no intended use
//     for it and the name implies build/agentic work; an undocumented model
//     is the wrong risk to take on the emergency path specifically.
//
// Every value stays env-overridable — this default is a sensible starting
// point, not a lock-in.
function fallbackProviderConfig() {
  const apiKey = process.env.SCOUT_FALLBACK_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    model: process.env.SCOUT_FALLBACK_MODEL || "grok-4.20-0309-non-reasoning",
    provider: process.env.SCOUT_FALLBACK_PROVIDER || "openai_compatible",
    maxOutputTokens: Number(process.env.SCOUT_FALLBACK_MAX_TOKENS || 1024),
  };
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

// EVERY INPUT THAT CAN CHANGE THE ANSWER MUST BE IN THE KEY.
//
// The cache is meant for simple_knowledge only — questions with no athlete
// in them. In production that assumption broke: "Which GOLSZ plan do I
// actually need?" classified as simple_knowledge, and the model answered it
// from the athlete's live record anyway. The reply was cached under
// intent+lang+tier+text, so after the account moved to Elite the SAME
// question replayed the Free-era answer, opening with "You're on Free right
// now". Personalized advice served under a subscription state that no
// longer existed.
//
// The fingerprint below carries the athlete state that can change such an
// answer: plan first, then the goal wording, the Plan's real completeness,
// whether anything is being tracked or contacted, and the Passport Strength
// score. Change any of them and the key changes, so the old reply is simply
// never found. Nothing is invalidated or deleted — stale entries just stop
// matching and expire on their existing TTL.
//
// Kept SEPARATE from athleteStateDigest(), which invalidates conversation
// summaries. That belongs to the memory architecture and is not touched.
function responseCacheFingerprint(plan, goalText, state) {
  const rd = state && state.readiness;
  return [
    String(plan || "free"),
    String(goalText || "").trim().toLowerCase().slice(0, 60),
    state && state.pathwayComplete ? "plan1" : "plan0",
    String((state && state.pathwayType) || "-"),
    (state && state.targetsCount) ? "t1" : "t0",
    rd && rd.performance && rd.performance.metricsTracked ? "b1" : "b0",
    rd && rd.development && rd.development.total ? "d1" : "d0",
    rd ? String(rd.composite) : "-",
  ].join("|");
}

function cacheKeyFor(intent, text, lang, tier, fingerprint) {
  return `${intent}:${lang}:${tier}:${fingerprint || "anon"}:${String(text || "").trim().toLowerCase().slice(0, 300)}`;
}

// A LAST LINE OF DEFENCE. Any reply naming a plan tier is, by definition,
// specific to the tier the athlete was on when it was written. Those are
// never shared, whatever the key says.
function replyIsPlanSpecific(data) {
  const t = (data && typeof data.reply_text === "string") ? data.reply_text : "";
  return /\b(Free|Basic|Pro|Elite)\b/.test(t);
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
// Migration 123. The two counts the cost audit could not produce: how often
// a call actually searched, and how many server tools it issued. Taken from
// block types already present in the response, so this costs nothing.
// Separating "issued a tool call" from "got search results back" is what
// distinguishes a wasted search from a useful one.
function countServerTools(data) {
  const blocks = (data && Array.isArray(data.content)) ? data.content : [];
  return {
    webSearchCount: blocks.filter((b) => b && b.type === "web_search_tool_result").length,
    serverToolCalls: blocks.filter((b) => b && b.type === "server_tool_use").length,
  };
}

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
        // Explicit integers, never null: history is null because it predates
        // migration 123, so a null appearing in NEW data means capture broke.
        web_search_count: (extra && typeof extra.webSearchCount === "number") ? extra.webSearchCount : 0,
        server_tool_calls: (extra && typeof extra.serverToolCalls === "number") ? extra.serverToolCalls : 0,
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
  // `level` REMOVED 2026-08-09. It mapped competition level into
  // athletes.recruiting_status — a different concept the athlete sets
  // themselves from a controlled dropdown (Open to offers / In contact /
  // Committed / Signed). Scout emitting level:"NCAA D2" would have
  // overwritten their own recruiting state with a competition level.
  // Latent only: a production check found all stored values valid, so no
  // rows were corrupted and no backfill is needed. Competition level now
  // lives in scout_context.current_level, which resolveCurrentLevel()
  // already reads and validates against SPORT_SCHEMA.
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
  if (patches.profiles.goal_text) {
    patches.profiles.goal_defined = true;
    // Migration 113. Everything reaching persistProfileUpdates() came from
    // model extraction or the safety net, never from the athlete's own
    // editor (that writes directly from the client), so this is always
    // 'scout_captured' here. Stamping it is what makes the protection in
    // applyGoalAuthorship() meaningful for the NEXT write.
    patches.profiles.goal_source = "scout_captured";
    patches.profiles.goal_updated_at = new Date().toISOString();
  }

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
      let r = await fetch(`${supaUrl}/rest/v1/${table}?id=eq.${userId}`, {
        method: "PATCH", headers, body: JSON.stringify(patches[table]),
      });
      // Migration 113 adds goal_source/goal_updated_at. Until it is applied,
      // a PATCH naming them is rejected WHOLESALE — so a goal Scout finally
      // captured would be thrown away over two bookkeeping columns. Retry
      // with the authorship fields stripped: the goal reaches the Passport,
      // and it is simply not marked as Scout-captured until 113 lands.
      if (!r.ok && table === "profiles" && patches.profiles.goal_source) {
        const { goal_source, goal_updated_at, ...withoutAuthorship } = patches.profiles;
        console.warn("GOLSZ goal authorship columns missing (migration 113 not applied) — retrying without them.");
        r = await fetch(`${supaUrl}/rest/v1/${table}?id=eq.${userId}`, {
          method: "PATCH", headers, body: JSON.stringify(withoutAuthorship),
        });
      }
      // A non-OK PATCH used to pass silently: fetch only throws on network
      // failure, so a 4xx from PostgREST looked identical to success. Scout
      // meanwhile may have told the athlete their goal was saved. Logged
      // loudly so a failed write is visible rather than inferred later from
      // a column that mysteriously stayed empty.
      if (!r.ok) console.error(`GOLSZ profile-update persist (${table}) rejected:`, r.status, await r.text());
      else if (patches[table].goal_text) console.log("GOLSZ goal captured:", JSON.stringify({ goal_text: patches[table].goal_text, goal_defined: patches[table].goal_defined }));
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
  // Competition level. Lives here rather than as a Passport column so it
  // carries source/confidence like every other soft fact, and so it can
  // never again be written into recruiting_status.
  "current_level",
]);

// ============================================================
// TRIAGE READINESS (Prompt #1 — Scout Triage Stabilization)
//
// Three pure functions, no I/O, no model call, no new storage. They answer
// exactly one question: does GOLSZ know enough about this athlete to give a
// preliminary assessment instead of continuing to ask intake questions?
//
// Deliberately NOT a stored state machine. profiles.scout_state /
// scout_profile_ready are dead remnants of an earlier attempt at that and
// are not read anywhere; this is recomputed from authoritative data per
// request, so it can never drift out of sync with the athlete's real record.
// ============================================================

// Free-text goal -> pathway_plan.pathway_type enum (migration 093's own
// 11-value vocabulary, reused rather than inventing a second taxonomy).
//
// Exists because the ONLY normalized goal in the schema lives on
// pathway_plan, which is paywalled at Basic — so a free athlete in triage,
// the exact population this feature serves, has nothing but free-text
// profiles.goal_text. This bridges that gap without a migration.
//
// Conservative by design: it returns null unless the text is unambiguous.
// Two DIFFERENT categories matching means the athlete's stated goal is
// genuinely ambiguous, and Master Architecture §18 is explicit that
// "I want to play college soccer" is exactly the case GOLSZ must clarify
// rather than assume. Guessing here would silently pick a pathway and
// weight the athlete's whole assessment against it. A null falls through
// to DEFAULT, which is the safe, generic behaviour.
const GOAL_TEXT_PATTERNS = [
  ["ncaa", /\b(ncaa|d1|d2|d3|division\s*(1|2|3|i{1,3}))\b/i],
  ["naia", /\bnaia\b/i],
  ["juco", /\b(juco|junior\s+college)\b/i],
  ["canadian_university", /\b(u\s*sports|usports|canadian\s+(university|college)|cis)\b/i],
  ["academy", /\bacademy\b/i],
  ["european_club", /\b(europe|european)\b/i],
  // \bpro\b won't match "program"/"progress" (word boundary), and
  // "professional" is listed separately rather than relying on a prefix.
  ["professional", /\b(pro|professional|turn\s+pro|go\s+pro|sign\s+(a\s+)?contract)\b/i],
];

function classifyGoalText(goalText) {
  if (!goalText || typeof goalText !== "string") return null;
  const matched = new Set();
  for (const [type, re] of GOAL_TEXT_PATTERNS) if (re.test(goalText)) matched.add(type);
  // Ambiguous (or nothing recognised) -> null, never a guess.
  return matched.size === 1 ? [...matched][0] : null;
}

// ============================================================
// B — GOAL vs PATHWAY RECONCILIATION (2026-08-10)
//
// The athlete's goal lives in profiles.goal_text (free text, and often
// THEIRS — goal_source='athlete_edited'). The normalized pathway category
// lives in pathway_plan.pathway_type. Nothing kept them in step, so editing
// a goal left the old pathway behind: production held goal_text "play for a
// top European club" against pathway_type 'juco'.
//
// THE RULE THAT MATTERS: the athlete's written goal is never touched here.
// Not rewritten, not normalized, not "cleaned up". Only the DERIVED
// classification is ever in question.
//
// Two outcomes, and which one applies is deterministic:
//
//   safeAutoFix  — the classifier is unambiguous AND the stored pathway has
//                  ZERO milestones. An empty pathway is a shell; correcting
//                  its label destroys no athlete work, so it is safe to do
//                  silently. This is the case that was breaking people.
//
//   conflict     — the classifier is unambiguous, it disagrees with the
//                  stored type, and there ARE milestones. Real work exists;
//                  rebuilding it is the athlete's call, so we only FLAG it
//                  and Scout raises it in conversation.
//
// An ambiguous goal (classifier returns null) is never a conflict. "I want
// to play college soccer" matching both ncaa and juco means we genuinely do
// not know, and guessing is what caused this bug in the first place.
function reconcileGoalWithPathway(goalText, pathwayType, milestoneCount) {
  const derived = classifyGoalText(goalText);
  if (!derived) return { derived: null, conflict: false, safeAutoFix: false };
  if (!pathwayType) return { derived, conflict: false, safeAutoFix: false };
  if (derived === pathwayType) return { derived, conflict: false, safeAutoFix: false };
  const empty = !milestoneCount || milestoneCount < 1;
  return { derived, conflict: !empty, safeAutoFix: empty, storedType: pathwayType };
}

// Applies ONLY the derived pathway_type. Never writes goal_text, never
// touches milestones, timeline or notes. Best-effort: a failure here leaves
// the conflict flag in place and Scout still raises it conversationally.
async function autoFixPathwayType(userId, derivedType) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !userId || !derivedType) return false;
  if (!PATHWAY_TYPE_SET.has(derivedType)) return false;
  try {
    const r = await fetch(url + "/rest/v1/pathway_plan?user_id=eq." + userId, {
      method: "PATCH",
      headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ pathway_type: derivedType }),
    });
    if (r.ok) console.log("GOLSZ pathway_type auto-corrected from goal:", JSON.stringify({ userId, derivedType }));
    return r.ok;
  } catch (e) { console.error("GOLSZ autoFixPathwayType failed:", e); return false; }
}

// ---- CHANNEL 3, STRUCTURALLY -------------------------------------------
// The running conversation note used to be one undivided lump of model-
// authored prose, carried forward and rewritten every turn. That is the
// worst possible container for a goal: nothing in the format distinguishes
// "what they are aiming at NOW" from "what we discussed in March", so a
// superseded goal simply keeps getting restated, and after enough turns it
// reads as current again. Overruling it with a prompt sentence worked, but
// it depended on obedience — the model had to choose to believe the
// override over the paragraph directly above it.
//
// This removes the choice. The block is now composed server-side, section
// by section, and the five CURRENT sections are rendered from live
// structured state on every single turn. They are not carried forward and
// the model never writes them, so a stale goal cannot occupy them no matter
// how long the conversation runs or what the previous note said.
//
// The model still authors narrative — that is genuinely valuable and this
// does not try to replace it — but it lands in USEFUL CONVERSATION HISTORY,
// underneath the current state, where it is clearly context rather than
// fact. Any sentence in it that declares a DIFFERENT direction than the
// current goal is moved to HISTORICAL, not deleted, so Scout can still say
// "you previously considered the CPL route" and cannot say it is the plan.
function splitNarrativeByGoal(narrative, currentGoalType) {
  const current = [];
  const historical = [];
  if (typeof narrative !== "string" || !narrative.trim()) return { current, historical };
  for (const s of narrative.split(/(?<=[.!?])\s+/)) {
    const line = s.trim();
    if (!line) continue;
    const t = currentGoalType ? classifyGoalText(line) : null;
    if (t && t !== currentGoalType) historical.push(line);
    else current.push(line);
  }
  return { current, historical };
}

// Renders the seven-section note. Everything above HISTORICAL is derived
// from this turn's structured reads; nothing above HISTORICAL survives from
// a previous turn.
function composeStructuredSummary({ goalText, goalSource, athleteState, narrative, entLocked, entUpgradeName }) {
  const rd = athleteState && athleteState.readiness;
  const currentGoalType = classifyGoalText(goalText);
  const { current, historical } = splitNarrativeByGoal(narrative, currentGoalType);
  const L = [];
  L.push("CONVERSATION NOTE — rebuilt from their live record this turn. The CURRENT sections below are regenerated from the database every message and are the only description of where this athlete stands. Nothing carried over from an earlier turn can contradict them.");

  L.push(`\nCURRENT GOAL / CURRENT DIRECTION:\n- ${goalText ? `"${String(goalText).slice(0, 200)}"` : "not set yet — establishing it is the priority"}${goalSource === "athlete_edited" ? " (written by the athlete themselves — never reword it)" : ""}`);

  const st = [];
  if (athleteState) {
    st.push(`sport: ${athleteState.sport || "unknown"}`);
    st.push(`Passport complete: ${athleteState.profileComplete ? "yes" : "no"}`);
    if (rd) { st.push(`Passport Strength: ${rd.composite}/100`); st.push(`weakest area: ${DIMENSION_LABEL[rd.weakest]}`); }
  }
  L.push(`\nCURRENT ATHLETE STATE:\n- ${st.length ? st.join("; ") : "nothing on file yet"}`);

  L.push(`\nCURRENT PLAN:\n- ${athleteState && athleteState.pathwayCreated
    ? `${athleteState.pathwayType || "no category"}${athleteState.pathwayTimeline ? `, timeline ${athleteState.pathwayTimeline}` : ""}, ${athleteState.milestonesDone}/${athleteState.milestoneCount} milestones done${athleteState.pathwayComplete ? "" : " — a shell, nothing to act on yet"}`
    : "no Plan built yet"}`);

  const gaps = [];
  if (rd && rd.quality && rd.quality.missing && rd.quality.missing.length) gaps.push(`Passport missing: ${rd.quality.missing.join(", ")}`);
  if (rd && rd.performance && rd.performance.metricsTracked === 0) gaps.push("no benchmarks recorded");
  if (rd && rd.development && rd.development.total === 0) gaps.push("no development plan");
  if (athleteState && !athleteState.targetsCount) gaps.push("no targets being contacted");
  if (entLocked && entLocked.length && entUpgradeName) gaps.push(`needs beyond their plan: ${entLocked.join("; ")} (lowest plan covering these: ${entUpgradeName})`);
  L.push(`\nCURRENT NEEDS / GAPS:\n- ${gaps.length ? gaps.join("\n- ") : "nothing outstanding in their record"}`);

  const facts = [];
  if (athleteState && athleteState.benchmarks && athleteState.benchmarks.length) {
    facts.push(`benchmarks: ${athleteState.benchmarks.map((b) => `${b.metric} ${b.value}${b.unit || ""}`).join("; ")}`);
  }
  if (athleteState && athleteState.devItems && athleteState.devItems.length) facts.push(`development items: ${athleteState.devItems.length}`);
  if (athleteState && athleteState.targetsCount) facts.push(`targets: ${athleteState.targetsCount}`);
  L.push(`\nCONFIRMED CURRENT FACTS:\n- ${facts.length ? facts.join("\n- ") : "none recorded yet"}`);

  L.push(`\nHISTORICAL GOALS / SUPERSEDED INFORMATION (true EARLIER, not now):\n${historical.length ? historical.map((h) => `- ${h}`).join("\n") : "- none"}`);
  if (historical.length) {
    L.push(`These describe directions the athlete has moved on from. Refer to them as history when it is genuinely useful ("you previously looked at that route") — never as what they are working toward. Their direction is the CURRENT GOAL section above, and only an explicit new statement from them changes it.`);
  }

  L.push(`\nUSEFUL CONVERSATION HISTORY (your own note from earlier turns — context only; the athlete did not say this and cannot see it):\n${current.length ? current.map((c) => `- ${c}`).join("\n") : "- nothing yet"}`);
  return L.join("\n");
}

// The daily Scout message ceiling per plan. ONE definition, used both to
// meter and to reason about volume pressure, so the two can never disagree.
// Values unchanged: Free 3, Basic 8, Pro 15, Elite 20.
function planDailyLimit(plan) {
  return plan === "elite" ? Number(process.env.ELITE_DAILY_LIMIT || 20)
    : plan === "pro" ? Number(process.env.PRO_DAILY_LIMIT || 15)
    : plan === "starter" ? Number(process.env.STARTER_DAILY_LIMIT || 8)
    : Number(process.env.FREE_DAILY_LIMIT || 3);
}

// VOLUME IS THE ONLY REAL ELITE DIFFERENTIATOR.
// Nothing in FEATURE_MIN_PLAN requires Elite — every gated capability tops
// out at Pro — so a feature-based Pro->Elite pitch would be manufactured.
// The honest trigger is an athlete actually running out of messages. Fires
// only at 80% of their own ceiling, from metered usage, never from a guess.
const NEXT_TIER_FOR_VOLUME = { free: "starter", starter: "pro", pro: "elite" };
function deriveVolumeNeed(plan, questionsUsedToday, dailyLimit) {
  const limit = Number(dailyLimit) || 0;
  const used = Number(questionsUsedToday) || 0;
  const next = NEXT_TIER_FOR_VOLUME[plan || "free"];
  if (!next || !limit) return { pressured: false, nextPlan: null };
  return { pressured: used >= Math.ceil(limit * 0.8), nextPlan: next, used, limit };
}

// SAFEGUARD — the athlete said no.
// Read from their OWN words, not from the model's read of the room. Once
// they have declined, refused, or said they cannot afford it, the plan
// block is suppressed for the rest of the conversation: repeating a pitch
// someone has already turned down is the single fastest way to make Scout
// feel like a salesman rather than an agent.
const UPGRADE_DECLINE_PATTERNS = [
  /\b(can'?t|cannot|can not) afford\b/i,
  /\b(too expensive|no money|out of my budget|not in my budget)\b/i,
  /\b(no thanks|not interested|don'?t want to (pay|upgrade)|won'?t be upgrading|not upgrading)\b/i,
  /\b(i'?m|i am|we'?re|we are) (staying|sticking) (on|with)\b/i,
  /\bstop (asking|pitching|selling)\b/i,
  /\bnot (paying|buying)\b/i,
];
function athleteDeclinedUpgrade(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((m) => m && m.role === "user" && typeof m.content === "string"
    && UPGRADE_DECLINE_PATTERNS.some((re) => re.test(m.content)));
}

// ---- 5 / RECOMMEND -------------------------------------------------------
// Which GATED features this athlete's CURRENT state actually calls for.
//
// Deterministic and state-driven on purpose. The failure mode being designed
// out is a model that decides on its own that now is a good moment to
// mention Elite. Every entry below is an observable gap in their record — an
// empty Pathway, nothing being tracked, nobody being contacted — so if their
// record is in good shape this returns [] and there is nothing to raise.
// Never keyed off message count, conversation length or sentiment.
//
// Order is by how early it blocks progress, and only matters for reading;
// the plan chosen from these is the LOWEST that covers them all, never the
// highest (see lowestPlanUnlocking in api/_entitlements.js).
function deriveEntitlementNeeds(athleteState) {
  const needs = [];
  if (!athleteState) return needs;
  // A goal with no route to it. Includes the "shell" case: a row exists but
  // carries no milestones, which is not a Pathway the athlete can act on.
  if (!athleteState.pathwayComplete) needs.push("pathway_plan");
  // Nothing measured means no way to show progress to anyone.
  const rd = athleteState.readiness;
  if (rd && rd.performance && rd.performance.metricsTracked === 0) needs.push("benchmarks");
  // No one being contacted — the goal cannot advance on training alone.
  if (!athleteState.targetsCount) needs.push("targets");
  // No structured work on the weaknesses they have already named.
  if (rd && rd.development && rd.development.total === 0) needs.push("development_plan");
  return needs;
}

// ============================================================
// SPORT_SCHEMA V1 — the authoritative sport-context layer
//
// Master Architecture §7. Two sports are defined to production quality
// (soccer, basketball) rather than eleven at surface quality: two is the
// minimum that proves the abstraction generalises across BOTH axes (sport
// and pathway), and one would have proved nothing.
//
// STRUCTURE — the whole point of this file:
//   SPORT_CORE     concepts true of every athlete in every sport.
//   SPORT_SCHEMAS  per-sport modules holding ONLY what differs.
// Adding a third sport means adding one entry to SPORT_SCHEMAS. It must
// never require touching SPORT_CORE, the athletes table, isAssessmentReady(),
// the prompt builder, or any routing logic — that constraint is asserted in
// tests/test_sport_schema.cjs, not just stated here.
//
// Deliberately a code module, not a table. Same reasoning as
// PATHWAY_FIELD_PRIORITY: scout_model_config shipped EMPTY to production and
// silently broke model routing for months. Reference data that changes rarely
// and has no admin editor belongs in version control, where it cannot be
// empty and deploys atomically with the code that reads it.
//
// NON-NEGOTIABLE: this layer never guesses. An unrecognised sport, position
// or level resolves to an explicit unknown, never to a plausible-looking
// default. Fabricating an athlete's position would be worse than admitting
// GOLSZ doesn't know it.
// ============================================================

// Concepts that are genuinely sport-agnostic. Nothing soccer-shaped here.
const SPORT_CORE = {
  // Where an athlete is in their development arc. Age bands are indicative
  // and never override a real stated age — resolveAge() remains authoritative.
  stages: [
    { id: "foundation", label: "Foundation", typical_ages: [8, 12] },
    { id: "development", label: "Development", typical_ages: [12, 15] },
    { id: "specialization", label: "Specialization", typical_ages: [15, 18] },
    { id: "transition", label: "Transition", typical_ages: [18, 21] },
    { id: "performance", label: "Performance", typical_ages: [21, 99] },
  ],
  // Every sport develops along these; sports ADD to this list, never replace it.
  development_dimensions: [
    { id: "physical", label: "Physical" },
    { id: "technical", label: "Technical" },
    { id: "tactical", label: "Tactical" },
    { id: "mental", label: "Mental / competitive" },
    { id: "academic", label: "Academic" },
    { id: "exposure", label: "Exposure / visibility" },
  ],
  // Goal vocabulary shared with pathway_plan.pathway_type (migration 093) so
  // SPORT_SCHEMA and the Pathway feature can never drift into two taxonomies.
  goal_types: [
    "ncaa", "naia", "juco", "canadian_university", "academy",
    "european_club", "professional", "development",
    "agent_representation", "trainer_performance", "other",
  ],
  // Ordered weakest -> strongest. Consumed later by Goal-relative Readiness;
  // defined here so evidence quality has ONE definition platform-wide.
  evidence_tiers: [
    "ai_inferred", "athlete_stated", "parent_stated", "coach_evaluation",
    "measured_test", "official_competition_result", "verified_third_party",
  ],
};

const SPORT_SCHEMAS = {
  soccer: {
    id: "soccer",
    label: "Soccer",
    team_or_individual: "team",
    positions: [
      { id: "gk", label: "Goalkeeper", group: "goalkeeper" },
      { id: "cb", label: "Centre Back", group: "defence" },
      { id: "rb", label: "Right Back", group: "defence" },
      { id: "lb", label: "Left Back", group: "defence" },
      { id: "rwb", label: "Right Wing Back", group: "defence" },
      { id: "lwb", label: "Left Wing Back", group: "defence" },
      { id: "cdm", label: "Defensive Midfielder", group: "midfield" },
      { id: "cm", label: "Central Midfielder", group: "midfield" },
      { id: "cam", label: "Attacking Midfielder", group: "midfield" },
      { id: "rm", label: "Right Midfielder", group: "midfield" },
      { id: "lm", label: "Left Midfielder", group: "midfield" },
      { id: "rw", label: "Right Winger", group: "attack" },
      { id: "lw", label: "Left Winger", group: "attack" },
      { id: "st", label: "Striker", group: "attack" },
      { id: "cf", label: "Centre Forward", group: "attack" },
    ],
    // Sport-relevant athlete attributes beyond the universal Passport fields.
    attributes: ["dominant_foot", "height_cm", "weight_kg"],
    performance_indicators: [
      { key: "sprint_10m", label: "10m sprint", unit: "s", higher_is_better: false },
      { key: "sprint_40m", label: "40m sprint", unit: "s", higher_is_better: false },
      { key: "vertical_jump", label: "Vertical jump", unit: "cm", higher_is_better: true },
      { key: "yo_yo", label: "Yo-Yo intermittent recovery", unit: "level", higher_is_better: true },
      { key: "match_minutes", label: "Competitive minutes this season", unit: "min", higher_is_better: true },
      { key: "goals", label: "Goals", unit: "count", higher_is_better: true },
      { key: "assists", label: "Assists", unit: "count", higher_is_better: true },
      { key: "clean_sheets", label: "Clean sheets", unit: "count", higher_is_better: true, positions: ["gk", "cb", "rb", "lb"] },
    ],
    development_dimensions: [{ id: "set_pieces", label: "Set pieces" }],
    levels: [
      { id: "recreational", label: "Recreational", rank: 1 },
      { id: "school", label: "School", rank: 2 },
      { id: "club_youth", label: "Youth club", rank: 3 },
      { id: "academy", label: "Academy", rank: 5 },
      { id: "juco", label: "JUCO", rank: 5 },
      { id: "ncaa_d3", label: "NCAA Division III", rank: 6 },
      { id: "naia", label: "NAIA", rank: 6 },
      { id: "canadian_university", label: "U Sports", rank: 6 },
      { id: "ncaa_d2", label: "NCAA Division II", rank: 7 },
      { id: "ncaa_d1", label: "NCAA Division I", rank: 8 },
      { id: "semi_professional", label: "Semi-professional", rank: 8 },
      { id: "professional_lower", label: "Lower-division professional", rank: 9 },
      { id: "professional_top", label: "Top-division professional", rank: 10 },
    ],
    pathways: [
      { id: "ncaa", goal_type: "ncaa", label: "US college soccer (NCAA)", levels: ["ncaa_d3", "ncaa_d2", "ncaa_d1"],
        key_evidence: ["grad_year", "gpa", "match_minutes", "film", "exposure"] },
      { id: "naia", goal_type: "naia", label: "NAIA college soccer", levels: ["naia"],
        key_evidence: ["grad_year", "gpa", "film"] },
      { id: "juco", goal_type: "juco", label: "Junior college", levels: ["juco"],
        key_evidence: ["grad_year", "film"] },
      { id: "canadian_university", goal_type: "canadian_university", label: "Canadian university (U Sports)", levels: ["canadian_university"],
        key_evidence: ["grad_year", "gpa", "film"] },
      { id: "academy", goal_type: "academy", label: "Academy progression", levels: ["club_youth", "academy"],
        key_evidence: ["match_minutes", "level", "coach_evaluation"] },
      // goal_type "professional": soccer distinguishes semi-pro from pro as a
      // real pathway, but the shared vocabulary (and pathway_plan's enum) does
      // not. Declaring the mapping keeps the sport's own precision without
      // forking the taxonomy.
      { id: "semi_professional", goal_type: "professional", label: "Semi-professional", levels: ["semi_professional"],
        key_evidence: ["match_minutes", "film", "level"] },
      { id: "professional", goal_type: "professional", label: "Professional", levels: ["professional_lower", "professional_top"],
        key_evidence: ["match_minutes", "level", "film", "trial_history"] },
      { id: "european_club", goal_type: "european_club", label: "European club pathway", levels: ["academy", "professional_lower"],
        key_evidence: ["citizenship", "match_minutes", "film"] },
    ],
    terminology: {
      trial: "trial", showcase: "ID camp / showcase", film: "highlight reel + full match",
      governing_examples: ["NCAA", "NAIA", "NJCAA", "U Sports", "FIFA"],
    },
  },

  basketball: {
    id: "basketball",
    label: "Basketball",
    team_or_individual: "team",
    positions: [
      { id: "pg", label: "Point Guard", group: "guard" },
      { id: "sg", label: "Shooting Guard", group: "guard" },
      { id: "sf", label: "Small Forward", group: "wing" },
      { id: "pf", label: "Power Forward", group: "frontcourt" },
      { id: "c", label: "Center", group: "frontcourt" },
    ],
    // Wingspan/standing reach matter enormously here and are meaningless in
    // soccer — exactly the kind of thing that must NOT live in the core model.
    attributes: ["height_cm", "weight_kg", "wingspan_cm", "standing_reach_cm", "dominant_hand"],
    performance_indicators: [
      { key: "vertical_jump", label: "Max vertical", unit: "cm", higher_is_better: true },
      { key: "lane_agility", label: "Lane agility drill", unit: "s", higher_is_better: false },
      { key: "three_quarter_sprint", label: "3/4 court sprint", unit: "s", higher_is_better: false },
      { key: "ppg", label: "Points per game", unit: "pts", higher_is_better: true },
      { key: "rpg", label: "Rebounds per game", unit: "reb", higher_is_better: true },
      { key: "apg", label: "Assists per game", unit: "ast", higher_is_better: true },
      { key: "fg_pct", label: "Field goal %", unit: "%", higher_is_better: true },
      { key: "three_pt_pct", label: "Three-point %", unit: "%", higher_is_better: true },
      { key: "ft_pct", label: "Free throw %", unit: "%", higher_is_better: true },
    ],
    development_dimensions: [{ id: "shooting", label: "Shooting mechanics" }],
    levels: [
      { id: "recreational", label: "Recreational", rank: 1 },
      { id: "school", label: "School team", rank: 3 },
      { id: "aau", label: "AAU / club circuit", rank: 4 },
      { id: "prep", label: "Prep school", rank: 5 },
      { id: "juco", label: "JUCO", rank: 5 },
      { id: "ncaa_d3", label: "NCAA Division III", rank: 6 },
      { id: "naia", label: "NAIA", rank: 6 },
      { id: "canadian_university", label: "U Sports", rank: 6 },
      { id: "ncaa_d2", label: "NCAA Division II", rank: 7 },
      { id: "ncaa_d1", label: "NCAA Division I", rank: 9 },
      { id: "professional", label: "Professional", rank: 10 },
    ],
    pathways: [
      { id: "ncaa", goal_type: "ncaa", label: "US college basketball (NCAA)", levels: ["ncaa_d3", "ncaa_d2", "ncaa_d1"],
        key_evidence: ["grad_year", "gpa", "ppg", "film", "aau_exposure"] },
      { id: "naia", goal_type: "naia", label: "NAIA college basketball", levels: ["naia"],
        key_evidence: ["grad_year", "gpa", "film"] },
      { id: "juco", goal_type: "juco", label: "Junior college", levels: ["juco"],
        key_evidence: ["grad_year", "film"] },
      { id: "canadian_university", goal_type: "canadian_university", label: "Canadian university (U Sports)", levels: ["canadian_university"],
        key_evidence: ["grad_year", "gpa", "film"] },
      { id: "development", goal_type: "development", label: "School / prep development", levels: ["school", "prep", "aau"],
        key_evidence: ["level", "coach_evaluation", "ppg"] },
      { id: "professional", goal_type: "professional", label: "Professional", levels: ["professional"],
        key_evidence: ["level", "film", "ppg"] },
    ],
    terminology: {
      trial: "open run / tryout", showcase: "AAU circuit / exposure camp", film: "game film + highlight mix",
      governing_examples: ["NCAA", "NAIA", "NJCAA", "U Sports", "FIBA"],
    },
  },
};

// Resolves a free-text sport (athletes.sport is user-entered) to a schema.
// Returns null for anything unrecognised — the caller then treats the athlete
// as sport-unknown rather than being handed a fabricated default. This is the
// single most important behaviour in this module.
function sportSchemaFor(sport) {
  if (!sport || typeof sport !== "string") return null;
  return SPORT_SCHEMAS[sport.trim().toLowerCase()] || null;
}

function knownSportIds() { return Object.keys(SPORT_SCHEMAS); }

// P0-6. The `sports` table (migration 094) declares ten sports as
// support_level 'core', but SPORT_SCHEMAS only actually contains soccer and
// basketball. Scout's prompt says "core means real depth" -- so for eight
// sports it was being told GOLSZ had built-out intelligence while
// renderSportContext() correctly handed it nothing. That combination is the
// precise condition under which a model invents position groups, competition
// ladders and eligibility requirements.
//
// The database expresses intent; only the code can substantiate it. This caps
// the declared level at what SPORT_SCHEMAS can actually back, so 'core' is
// unreachable for a sport with no schema no matter what any row says. The
// accompanying migration corrects the rows too -- this cap is the guarantee,
// the migration is hygiene.
const SPORT_SUPPORT_LEVELS = ["core", "supported", "secondary"];

function hasStructuredSportKnowledge(sport) { return !!sportSchemaFor(sport); }

function resolveSportSupportLevel(sport, declaredLevel) {
  const declared = SPORT_SUPPORT_LEVELS.includes(declaredLevel) ? declaredLevel : "secondary";
  if (hasStructuredSportKnowledge(sport)) return declared;
  return declared === "core" ? "supported" : declared;
}

// Matches a free-text position against a sport's own vocabulary, by id or
// label, case-insensitively. Returns null when it doesn't belong to THIS
// sport — including when it is a perfectly valid position in another sport.
// Cross-sport contamination is the failure this exists to prevent.
function resolvePosition(sport, position) {
  const schema = sportSchemaFor(sport);
  if (!schema || !position || typeof position !== "string") return null;
  const p = position.trim().toLowerCase();
  return schema.positions.find((x) => x.id === p || x.label.toLowerCase() === p) || null;
}

function resolveLevel(sport, level) {
  const schema = sportSchemaFor(sport);
  if (!schema || !level || typeof level !== "string") return null;
  const l = level.trim().toLowerCase();
  return schema.levels.find((x) => x.id === l || x.label.toLowerCase() === l) || null;
}

// Pathways this sport actually supports, for a goal type from the shared
// vocabulary. Empty array (not null, not a guess) when the sport does not
// support that pathway — e.g. soccer has semi_professional, basketball does not.
// Matched on goal_type, not id: a sport's pathways may be finer-grained than
// the shared vocabulary (soccer distinguishes semi-professional from
// professional; the pathway_plan enum does not), so each pathway declares
// which shared goal type it serves. That keeps the taxonomies linked without
// forcing every sport to flatten its own real distinctions.
function pathwaysFor(sport, goalType) {
  const schema = sportSchemaFor(sport);
  if (!schema) return [];
  if (!goalType) return schema.pathways;
  return schema.pathways.filter((x) => x.goal_type === goalType);
}

// Renders the sport-context block Scout receives. Every unknown is stated
// plainly as unknown — Master Architecture §33. Returns "" when the sport
// isn't in SPORT_SCHEMA at all, so Scout falls back to its existing honest
// "GOLSZ has no built-out data for your sport" behaviour rather than being
// handed an empty scaffold that looks like knowledge.
function renderSportContext(sport, position, goalType) {
  const schema = sportSchemaFor(sport);
  if (!schema) return "";
  const pos = resolvePosition(sport, position);
  const paths = pathwaysFor(sport, goalType);
  const lines = [
    `SPORT CONTEXT — ${schema.label} (GOLSZ has a built-out schema for this sport):`,
    `- positions in this sport: ${schema.positions.map((x) => x.label).join(", ")}`,
    pos
      ? `- this athlete's position: ${pos.label} (${pos.group})`
      : (position
        ? `- this athlete's recorded position ("${String(position).slice(0, 40)}") is not one this schema recognises — treat it as unconfirmed and ask, do not reinterpret it`
        : `- this athlete's position: NOT ON RECORD — ask, never assume one`),
    `- measurable indicators that matter here: ${schema.performance_indicators.map((x) => `${x.label} (${x.unit})`).join(", ")}`,
    `- competition levels, weakest to strongest: ${schema.levels.map((x) => x.label).join(" < ")}`,
    `- development dimensions: ${[...SPORT_CORE.development_dimensions, ...(schema.development_dimensions || [])].map((d) => d.label).join(", ")}`,
    // Branches on whether a goal was actually CLASSIFIED, not on whether the
    // filter returned rows — with no goal, pathwaysFor() returns everything,
    // and reporting that as "in scope" would imply GOLSZ had picked a pathway
    // for an athlete who has not chosen one.
    (goalType && paths.length)
      ? `- pathway(s) in scope for their stated goal: ${paths.map((x) => `${x.label} [key evidence: ${x.key_evidence.join(", ")}]`).join(" | ")}`
      : `- no pathway selected yet — GOLSZ supports these for this sport: ${schema.pathways.map((x) => x.label).join(", ")}. Do not pick one for them.`,
    `- terminology to use: trial = "${schema.terminology.trial}", showcase = "${schema.terminology.showcase}", film = "${schema.terminology.film}"`,
  ];
  return lines.join("\n");
}

// ============================================================
// GOAL-RELATIVE READINESS — FOUNDATION ONLY
//
// This is the substrate the readiness ENGINE will later consume. No score is
// computed here and no weight is chosen. Everything below either resolves
// real athlete data onto SPORT_SCHEMA's vocabulary, or declares a shape that
// still needs sourced content.
//
// The governing constraint, from Master Architecture §35 and §17: GOLSZ must
// never manufacture certainty. That has a concrete engineering consequence
// here — an unmappable metric, an unknown level and an absent reference band
// are all FIRST-CLASS STATES, not gaps to paper over with a plausible guess.
// ============================================================

// ---- 1. Canonical benchmark mapping -------------------------------------
//
// athlete_benchmarks.metric is free text an athlete typed ("40 yard dash",
// "10m", "vert"). performance_indicators[].key is canonical. This bridges the
// two WITHOUT ever overwriting what the athlete entered — the original string
// is always preserved and returned alongside the resolution.
//
// Aliases are per-sport on purpose. "vertical" means the same thing in both
// sports so it appears in both, but a soccer alias can never resolve to a
// basketball indicator: the lookup is scoped by sport before it begins.
const BENCHMARK_ALIASES = {
  soccer: {
    sprint_10m: ["10m", "10 m", "10m sprint", "10 metre sprint", "10 meter sprint", "10m dash"],
    sprint_40m: ["40m", "40 m", "40m sprint", "40 metre sprint", "40 meter sprint"],
    vertical_jump: ["vertical", "vert", "vertical jump", "max vertical", "cmj"],
    yo_yo: ["yo-yo", "yoyo", "yo yo", "yo-yo test", "beep test", "bleep test"],
    match_minutes: ["minutes", "match minutes", "mins played", "playing time"],
    goals: ["goals", "goals scored"],
    assists: ["assists"],
    clean_sheets: ["clean sheets", "shutouts"],
  },
  basketball: {
    vertical_jump: ["vertical", "vert", "vertical jump", "max vertical", "standing vertical"],
    lane_agility: ["lane agility", "agility drill", "lane agility drill"],
    three_quarter_sprint: ["3/4 court sprint", "three quarter sprint", "3/4 sprint", "court sprint"],
    ppg: ["ppg", "points per game", "points"],
    rpg: ["rpg", "rebounds per game", "rebounds"],
    apg: ["apg", "assists per game", "assists"],
    fg_pct: ["fg%", "fg pct", "field goal %", "field goal percentage"],
    three_pt_pct: ["3p%", "3pt%", "three point %", "three point percentage"],
    ft_pct: ["ft%", "free throw %", "free throw percentage"],
  },
};

// AMBIGUOUS strings that must NEVER auto-resolve, even though they look
// close to something. "sprint" alone could be 10m or 40m; "%" could be any of
// three shooting percentages. Guessing here would silently attach an
// athlete's number to the wrong metric and then reason about it as fact.
const AMBIGUOUS_METRICS = ["sprint", "speed", "time", "jump", "%", "percentage", "test", "score", "pb", "best"];

// Returns EITHER a confident resolution or an explicit unresolved marker.
// Never throws, never guesses, never mutates the athlete's own text.
function resolveBenchmarkMetric(sport, rawMetric) {
  const raw = typeof rawMetric === "string" ? rawMetric.trim() : "";
  const base = { raw: rawMetric, resolved: false, key: null, indicator: null, unit: null, reason: null };
  if (!raw) return { ...base, reason: "empty" };
  const schema = sportSchemaFor(sport);
  if (!schema) return { ...base, reason: "unknown_sport" };
  const norm = raw.toLowerCase().replace(/\s+/g, " ");
  if (AMBIGUOUS_METRICS.includes(norm)) return { ...base, reason: "ambiguous" };
  const aliases = BENCHMARK_ALIASES[schema.id] || {};
  let key = null;
  for (const [k, list] of Object.entries(aliases)) {
    if (k === norm || list.includes(norm)) { key = k; break; }
  }
  if (!key) return { ...base, reason: "no_match" };
  const indicator = schema.performance_indicators.find((x) => x.key === key) || null;
  // An alias pointing at an indicator this sport doesn't define is a config
  // error, not something to paper over.
  if (!indicator) return { ...base, reason: "indicator_missing_from_schema" };
  return { raw: rawMetric, resolved: true, key, indicator, unit: indicator.unit, reason: null };
}

// Unit-safety gate. Two benchmark values may only be compared when they are
// the SAME canonical metric in the SAME sport with the SAME unit. Comparing
// seconds to centimetres, or one athlete's "vertical" in inches against
// another's in cm, would produce confident nonsense.
function canCompareBenchmarks(a, b) {
  if (!a || !b || !a.resolved || !b.resolved) return { ok: false, reason: "unresolved" };
  if (a.key !== b.key) return { ok: false, reason: "different_metric" };
  if (a.unit !== b.unit) return { ok: false, reason: "unit_mismatch" };
  return { ok: true, reason: null };
}

// ---- 2. Benchmark reference bands ---------------------------------------
//
// DELIBERATELY EMPTY. The architecture is defined; the numbers are not,
// because GOLSZ does not yet have sourced reference data and inventing
// "a D1 right back runs 10m in 1.75s" would be exactly the fabricated
// certainty §35 forbids — with the added danger that an athlete would train
// against a number nobody verified.
//
// Required shape for every future entry:
//   { sport, metric, unit, position_group|null, stage|null, target_level,
//     direction: "higher_is_better"|"lower_is_better"|"contextual",
//     bands: [{ label, min, max }],
//     source, source_url, source_date, evidence_quality, confidence }
// evidence_quality must be one of SPORT_CORE.evidence_tiers.
//
// ---- Source hierarchy -------------------------------------------------
// Tier A primary/official · Tier B sports-science · Tier C institutional.
// Anything not traceable to one of these is not admissible. Recruiting
// sites, blogs, social posts, forum numbers and AI-generated estimates are
// excluded by policy, not by preference.
//
// These are VERIFIED SOURCE LOCATIONS, not extracted data. Registering the
// source is the cheap half; extracting distributions from it, with sample
// sizes and protocols attached, is the expensive half and is not done yet.
const BENCHMARK_SOURCES = [
  {
    id: "nba_combine_strength_agility", tier: "A", sport: "basketball",
    name: "NBA Draft Combine — Strength & Agility (official)",
    url: "https://www.nba.com/stats/draft/combine-strength-agility",
    covers: ["vertical_jump", "lane_agility", "three_quarter_sprint"],
    population: "NBA Draft Combine invitees (elite, pre-professional, predominantly male)",
    // The distinction that makes this data safe to use at all.
    reference_type: "observed_distribution",
    caution: "Describes NBA Combine participants ONLY. Must never be presented as an NCAA requirement or a recruiting threshold.",
    status: "source_verified_data_not_extracted",
  },
  {
    id: "nba_combine_anthro", tier: "A", sport: "basketball",
    name: "NBA Draft Combine — Anthropometric (official)",
    url: "https://www.nba.com/stats/draft/combine-anthro",
    covers: ["wingspan_cm", "standing_reach_cm", "height_cm", "weight_kg"],
    population: "NBA Draft Combine invitees",
    reference_type: "observed_distribution",
    caution: "Same population caveat as the agility dataset.",
    status: "source_verified_data_not_extracted",
  },
  {
    id: "mann_2010_hand_vs_electronic", tier: "B", sport: null,
    name: "Comparison between hand and electronic timing of 40-yd dash performance in college football players (J Strength Cond Res)",
    url: "https://pubmed.ncbi.nlm.nih.gov/20072055/",
    covers: ["measurement_protocol"],
    population: "College football players",
    reference_type: "published_standard",
    caution: "Protocol evidence, not an athlete benchmark.",
    status: "verified_and_encoded", // the only source whose finding is actually used below
  },
  {
    id: "hetzler_hand_vs_electronic", tier: "B", sport: null,
    name: "Validity and reliability of hand and electronic timing for 40-yd sprint in college football players (J Strength Cond Res)",
    url: "https://www.ncbi.nlm.nih.gov/pubmed/25785707",
    covers: ["measurement_protocol"],
    population: "College football players; experienced vs novice timers",
    reference_type: "published_standard",
    caution: "Protocol evidence, not an athlete benchmark.",
    status: "verified_and_encoded",
  },
];

// ---- Reference types ----------------------------------------------------
// The single most important distinction in this whole layer. An observed
// average is NOT a requirement. Conflating the two is how a platform ends up
// telling a 16-year-old they "need" a number nobody ever required.
const REFERENCE_TYPES = [
  "observed_distribution",   // what a measured population actually did
  "population_reference",    // normative data for a defined population
  "official_requirement",    // a governing body genuinely requires this
  "published_standard",      // a published testing/protocol standard
  "derived_reference_band",  // GOLSZ-derived FROM the above; must cite its parent
];
// Only these may ever be phrased to an athlete as something they must hit.
const REQUIREMENT_TYPES = ["official_requirement"];

// ---- Protocol compatibility --------------------------------------------
// Two numbers are comparable only when their measurement protocols are
// compatible. Encoded from the peer-reviewed sources above: hand timing is
// materially FASTER than electronic over 40yd — 0.31 ± 0.07 s in Mann et al.,
// and 0.22 ± 0.07 (experienced) / 0.26 ± 0.08 (novice) in Hetzler et al.
//
// GOLSZ deliberately does NOT auto-apply a correction. The published deltas
// disagree with each other, they are distance- and population-specific, and
// silently adding 0.24 s to a 10m youth soccer time would be inventing data
// under the appearance of rigour. The rule is to REFUSE the comparison and
// say why.
const PROTOCOL_DIMENSIONS = ["timing_method", "distance_m", "start_type", "surface", "jump_protocol", "test_variant", "sex", "age_group"];

const PROTOCOL_INCOMPATIBILITIES = [
  { dimension: "timing_method", a: "hand", b: "electronic",
    severity: "material",
    magnitude_note: "Hand timing is faster by roughly 0.22-0.31 s over 40yd (Mann et al. 2010; Hetzler et al.). Distance- and population-specific.",
    sources: ["mann_2010_hand_vs_electronic", "hetzler_hand_vs_electronic"],
    auto_normalize: false },
  { dimension: "start_type", a: "standing", b: "flying",
    severity: "material",
    magnitude_note: "A running/flying start removes acceleration time; not comparable to a standing start.",
    sources: [], auto_normalize: false },
  { dimension: "jump_protocol", a: "standing_vertical", b: "max_vertical",
    severity: "material",
    magnitude_note: "Max (approach) vertical exceeds standing vertical; the NBA Combine reports them as separate measures.",
    sources: ["nba_combine_strength_agility"], auto_normalize: false },
];

// Returns whether two measurements may be compared, and if not, why.
// Unknown protocol metadata is NOT treated as compatible — absence of
// evidence about how something was measured is not evidence it matches.
function protocolCompatible(a, b) {
  const pa = (a && a.protocol) || {}, pb = (b && b.protocol) || {};
  const issues = [];
  for (const dim of PROTOCOL_DIMENSIONS) {
    const va = pa[dim], vb = pb[dim];
    if (va == null || vb == null) {
      if (va != null || vb != null) issues.push({ dimension: dim, reason: "unknown_on_one_side" });
      continue;
    }
    if (va === vb) continue;
    const rule = PROTOCOL_INCOMPATIBILITIES.find((r) =>
      r.dimension === dim && ((r.a === va && r.b === vb) || (r.a === vb && r.b === va)));
    issues.push(rule
      ? { dimension: dim, reason: "known_incompatible", severity: rule.severity, magnitude_note: rule.magnitude_note, sources: rule.sources }
      : { dimension: dim, reason: "differs", a: va, b: vb });
  }
  // Two distinct outcomes, deliberately. A KNOWN incompatibility (hand vs
  // electronic timing) is disqualifying: no arithmetic makes those numbers
  // comparable. An UNKNOWN dimension is merely uncertainty — the brief's rule
  // is that uncertainty reduces comparability rather than causing a guess, so
  // it is surfaced as a caveat but does not by itself block a comparison.
  // Treating unknown as disqualifying would block virtually every real
  // comparison, since an athlete rarely records every dimension a study did.
  const blocking = issues.some((i) => i.reason === "known_incompatible" || i.reason === "differs");
  return { compatible: issues.length === 0, blocking, issues };
}

// ---- Reference bands ----------------------------------------------------
//
// STILL EMPTY, and that is the honest state. Tier A sources are verified and
// registered above, but no distribution has been EXTRACTED from them with the
// sample size, sex, age group and protocol metadata a defensible band needs.
// Publishing a band without those would reproduce exactly the problem this
// whole layer exists to prevent.
//
// Every future entry must satisfy validateBenchmarkBand() below.
const BENCHMARK_BANDS = [];

// Structural gate for any band added later. Rejects the four failure modes
// that would matter most: missing provenance, an unknown reference type, an
// observed distribution mislabelled as a requirement, and absent sample size
// silently reading as zero rather than as unknown.
function validateBenchmarkBand(b) {
  const errors = [];
  const required = ["sport", "metric", "unit", "target_level", "reference_type", "direction",
    "bands", "source_name", "source_url", "source_date", "evidence_quality", "confidence",
    "sample_size", "sex", "measurement_protocol"];
  for (const k of required) if (b[k] === undefined) errors.push(`missing:${k}`);
  if (b.reference_type && !REFERENCE_TYPES.includes(b.reference_type)) errors.push("bad:reference_type");
  if (b.evidence_quality && !SPORT_CORE.evidence_tiers.includes(b.evidence_quality)) errors.push("bad:evidence_quality");
  if (b.direction && !["higher_is_better", "lower_is_better", "contextual"].includes(b.direction)) errors.push("bad:direction");
  // Unknown must be explicit — null would be indistinguishable from "not set".
  if (b.sample_size !== undefined && b.sample_size !== "unknown" && typeof b.sample_size !== "number") errors.push("bad:sample_size");
  return { valid: errors.length === 0, errors };
}

// May this band be phrased to an athlete as something they MUST achieve?
// Almost always no. Only a genuine governing-body requirement qualifies.
function isRequirement(band) {
  return !!(band && REQUIREMENT_TYPES.includes(band.reference_type));
}

// ---- Specificity ---------------------------------------------------------
//
// A reference population describes WHO was measured. Every dimension may be
// null, meaning "this source did not break the data down that way" — which is
// different from, and must never be silently upgraded to, "this applies to
// everyone". A study of elite U17 males with no position split is a genuine
// elite-U17-male reference; it is NOT a winger standard.
//
// Ordered most-general -> most-specific. The weights only rank candidates
// against each other; they are not scores and never reach an athlete.
const SPECIFICITY_DIMENSIONS = [
  { id: "sport", weight: 1 },
  { id: "sex", weight: 2 },
  { id: "competition_level", weight: 4 },
  { id: "development_stage", weight: 8 },
  { id: "age_range", weight: 16 },   // age_min/age_max treated as one dimension
  { id: "position_group", weight: 32 },
];

function makeSpecificity(o = {}) {
  // Explicit nulls, never absent keys — an absent key reads as "forgot to
  // consider it", a null reads as "the source genuinely does not say".
  return {
    sport: o.sport ?? null,
    sex: o.sex ?? null,                         // "male" | "female" | "mixed" | null
    age_min: o.age_min ?? null,
    age_max: o.age_max ?? null,
    development_stage: o.development_stage ?? null,
    competition_level: o.competition_level ?? null,
    position_group: o.position_group ?? null,   // null === ALL, deliberately
  };
}

// Does this population legitimately describe this athlete? A null dimension
// on the POPULATION side is permissive (the source didn't split by it). A
// null on the ATHLETE side is NOT — we cannot claim a female-specific
// reference applies to an athlete whose sex we do not know.
function specificityMatches(pop, athlete) {
  const p = makeSpecificity(pop), a = makeSpecificity(athlete);
  if (p.sport && a.sport && p.sport !== a.sport) return { match: false, reason: "sport_mismatch" };
  if (p.sport && !a.sport) return { match: false, reason: "athlete_sport_unknown" };
  for (const dim of ["sex", "development_stage", "competition_level", "position_group"]) {
    if (p[dim] == null) continue;                       // population not split by it
    if (a[dim] == null) return { match: false, reason: `athlete_${dim}_unknown` };
    if (p[dim] !== a[dim]) return { match: false, reason: `${dim}_mismatch` };
  }
  if (p.age_min != null || p.age_max != null) {
    if (a.age_min == null) return { match: false, reason: "athlete_age_unknown" };
    if (p.age_min != null && a.age_min < p.age_min) return { match: false, reason: "age_below_range" };
    if (p.age_max != null && a.age_min > p.age_max) return { match: false, reason: "age_above_range" };
  }
  return { match: true, reason: null };
}

function specificityScore(pop) {
  const p = makeSpecificity(pop);
  let s = 0;
  for (const d of SPECIFICITY_DIMENSIONS) {
    if (d.id === "age_range") { if (p.age_min != null || p.age_max != null) s += d.weight; continue; }
    if (p[d.id] != null) s += d.weight;
  }
  return s;
}

// Human-readable statement of exactly how specific a match is, so an athlete
// is never shown a comparison whose scope they cannot see.
function specificityLabel(pop) {
  const p = makeSpecificity(pop);
  const parts = [];
  if (p.sex) parts.push(p.sex);
  if (p.age_min != null || p.age_max != null) parts.push(`age ${p.age_min ?? "?"}-${p.age_max ?? "?"}`);
  if (p.development_stage) parts.push(p.development_stage);
  if (p.competition_level) parts.push(p.competition_level);
  parts.push(p.position_group ? p.position_group : "all positions");
  return parts.join(", ");
}

// Deterministic selection: every compatible population, most specific first,
// ties broken by larger sample then newer data. Returns the candidates too so
// a caller can explain what was rejected and why.
function selectReferencePopulation(candidates, athlete) {
  const evaluated = (candidates || []).map((c) => ({ population: c, ...specificityMatches(c.specificity, athlete) }));
  const compatible = evaluated.filter((e) => e.match);
  compatible.sort((a, b) => {
    const d = specificityScore(b.population.specificity) - specificityScore(a.population.specificity);
    if (d !== 0) return d;
    const na = typeof a.population.sample_size === "number" ? a.population.sample_size : -1;
    const nb = typeof b.population.sample_size === "number" ? b.population.sample_size : -1;
    if (nb !== na) return nb - na;
    return String(b.population.source_date || "").localeCompare(String(a.population.source_date || ""));
  });
  return { selected: compatible[0] ? compatible[0].population : null, compatible: compatible.map((c) => c.population), rejected: evaluated.filter((e) => !e.match) };
}

// ---- Sample-size protection ---------------------------------------------
//
// PROVISIONAL. These thresholds are engineering defaults chosen to be
// conservative, NOT established scientific cut-offs. They exist so the system
// fails safe before real data arrives, and they must be reviewed by someone
// with sports-science standing before anything athlete-facing ships.
// Env-overridable so a review can change them without a code change.
const SAMPLE_SIZE_GATES = {
  descriptive_only: Number(process.env.BENCH_MIN_DESCRIPTIVE || 30),
  percentile_eligible: Number(process.env.BENCH_MIN_PERCENTILE || 100),
  strong_reference: Number(process.env.BENCH_MIN_STRONG || 500),
  _provisional: true,
  _review_note: "Provisional engineering defaults, not validated scientific thresholds. Review before launch.",
};

// Below descriptive_only nothing is published at all; between there and
// percentile_eligible a population may be described but NEVER expressed as a
// precise percentile, which is the specific failure mode this guards.
function sampleSizeTier(n) {
  if (n === "unknown" || n == null) return "insufficient_sample";
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "insufficient_sample";
  if (n >= SAMPLE_SIZE_GATES.strong_reference) return "strong_reference";
  if (n >= SAMPLE_SIZE_GATES.percentile_eligible) return "percentile_eligible";
  if (n >= SAMPLE_SIZE_GATES.descriptive_only) return "descriptive_only";
  return "insufficient_sample";
}
function percentilesAllowed(n) {
  const t = sampleSizeTier(n);
  return t === "percentile_eligible" || t === "strong_reference";
}

// ---- Unit normalisation --------------------------------------------------
//
// Only EXACT, dimensionally-valid conversions. A protocol difference is not a
// unit difference and is never handled here: no amount of arithmetic turns a
// hand-timed sprint into an electronically-timed one.
const UNIT_CONVERSIONS = {
  "in->cm": (v) => v * 2.54,
  "cm->in": (v) => v / 2.54,
  "kg->lb": (v) => v * 2.2046226218,
  "lb->kg": (v) => v / 2.2046226218,
  "ms->s": (v) => v / 1000,
  "s->ms": (v) => v * 1000,
};
function convertUnit(value, from, to) {
  if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, reason: "non_numeric" };
  if (from === to) return { ok: true, value, converted: false };
  const fn = UNIT_CONVERSIONS[`${from}->${to}`];
  if (!fn) return { ok: false, reason: "no_conversion", from, to };
  return { ok: true, value: fn(value), converted: true, from, to };
}

// ---- Import pipeline -----------------------------------------------------
//
// The contract for a supplied dataset. Every column is required — including
// the ones people most want to skip (sample_size, protocol, source_url),
// because a band without them cannot be defended to an athlete later.
const BENCHMARK_IMPORT_COLUMNS = [
  "sport", "metric", "unit", "sex", "age_min", "age_max", "development_stage",
  "competition_level", "position_group", "reference_type", "direction",
  "n", "mean", "sd", "p10", "p25", "p50", "p75", "p90",
  // measurement_protocol is the human-readable description and is always
  // required. The protocol_* columns are the STRUCTURED form used for
  // compatibility checks — optional, because not every source reports every
  // dimension, and an unreported dimension must stay unknown rather than be
  // inferred from the prose.
  "measurement_protocol", "protocol_timing_method", "protocol_start_type",
  "protocol_jump_protocol", "protocol_distance_m", "protocol_surface",
  "source_name", "source_url", "source_date",
  "publication_date", "population_description", "evidence_quality", "confidence", "notes",
];

// Validates and normalises ONE supplied row. Never repairs questionable data —
// a row either meets the contract or is rejected with reasons.
function importBenchmarkRecord(row) {
  const errors = [];
  const r = row || {};
  const schema = sportSchemaFor(r.sport);
  if (!schema) errors.push("unsupported_sport");
  const resolved = schema ? resolveBenchmarkMetric(r.sport, r.metric) : { resolved: false, reason: "unsupported_sport" };
  if (!resolved.resolved) errors.push(`unresolved_metric:${resolved.reason}`);
  if (resolved.resolved && r.unit && r.unit !== resolved.unit) {
    // A supplied unit that differs from the canonical one is only acceptable
    // if an exact conversion exists; otherwise the row is rejected rather
    // than coerced.
    const conv = convertUnit(1, r.unit, resolved.unit);
    if (!conv.ok) errors.push(`unit_incompatible:${r.unit}->${resolved.unit}`);
  }
  if (!REFERENCE_TYPES.includes(r.reference_type)) errors.push("bad_reference_type");
  if (!["higher_is_better", "lower_is_better", "contextual"].includes(r.direction)) errors.push("bad_direction");
  if (!SPORT_CORE.evidence_tiers.includes(r.evidence_quality)) errors.push("bad_evidence_quality");
  for (const k of ["source_name", "source_url", "source_date", "population_description", "measurement_protocol"]) {
    if (r[k] == null || r[k] === "") errors.push(`missing:${k}`);
  }
  const n = r.n === "unknown" ? "unknown" : (r.n == null || r.n === "" ? "unknown" : Number(r.n));
  if (n !== "unknown" && (!Number.isFinite(n) || n < 0)) errors.push("bad_sample_size");
  if (errors.length) return { ok: false, errors, raw: row };

  const specificity = makeSpecificity({
    sport: schema.id, sex: r.sex || null,
    age_min: r.age_min === "" || r.age_min == null ? null : Number(r.age_min),
    age_max: r.age_max === "" || r.age_max == null ? null : Number(r.age_max),
    development_stage: r.development_stage || null,
    competition_level: r.competition_level || null,
    position_group: r.position_group || null,
  });
  const tier = sampleSizeTier(n);
  const stats = {};
  for (const k of ["mean", "sd", "p10", "p25", "p50", "p75", "p90"]) {
    if (r[k] == null || r[k] === "") { stats[k] = null; continue; }
    const v = Number(r[k]);
    if (!Number.isFinite(v)) { stats[k] = null; continue; }
    const conv = r.unit && r.unit !== resolved.unit ? convertUnit(v, r.unit, resolved.unit) : { ok: true, value: v };
    stats[k] = conv.ok ? conv.value : null;
  }
  return {
    ok: true,
    record: {
      sport: schema.id, metric: resolved.key, unit: resolved.unit,
      specificity, reference_type: r.reference_type, direction: r.direction,
      sample_size: n, sample_tier: tier, percentiles_allowed: percentilesAllowed(n),
      stats,
      // Raw is preserved verbatim, always. If a conversion or a judgement
      // later proves wrong, the original supplied row is still recoverable.
      raw: row,
      provenance: {
        source_name: r.source_name, source_url: r.source_url, source_date: r.source_date,
        publication_date: r.publication_date || null, population_description: r.population_description,
        measurement_protocol: r.measurement_protocol,
        // Structured counterpart. Only dimensions the source actually
        // reported are present; the rest stay absent so protocolCompatible()
        // flags them as unknown instead of assuming a match.
        protocol_structured: (() => {
          const o = {};
          if (r.protocol_timing_method) o.timing_method = r.protocol_timing_method;
          if (r.protocol_start_type) o.start_type = r.protocol_start_type;
          if (r.protocol_jump_protocol) o.jump_protocol = r.protocol_jump_protocol;
          if (r.protocol_distance_m !== undefined && r.protocol_distance_m !== null && r.protocol_distance_m !== "") o.distance_m = Number(r.protocol_distance_m);
          if (r.protocol_surface) o.surface = r.protocol_surface;
          if (r.sex) o.sex = r.sex;
          return o;
        })(),
        evidence_quality: r.evidence_quality,
        confidence: r.confidence == null || r.confidence === "" ? null : Number(r.confidence),
        notes: r.notes || null,
      },
    },
  };
}

// Batch import with a real report. Duplicates are detected on the natural key
// (sport+metric+full specificity+source) and rejected rather than merged —
// silently deduplicating supplied research would hide a data problem.
function importBenchmarkDataset(rows) {
  const accepted = [], rejected = [], seen = new Set();
  for (let i = 0; i < (rows || []).length; i += 1) {
    const res = importBenchmarkRecord(rows[i]);
    if (!res.ok) { rejected.push({ row: i, errors: res.errors, raw: res.raw }); continue; }
    const s = res.record.specificity;
    const key = [res.record.sport, res.record.metric, s.sex, s.age_min, s.age_max,
      s.development_stage, s.competition_level, s.position_group,
      res.record.provenance.source_url].join("|");
    if (seen.has(key)) { rejected.push({ row: i, errors: ["duplicate_record"], raw: rows[i] }); continue; }
    seen.add(key);
    accepted.push(res.record);
  }
  const byTier = {};
  for (const a of accepted) byTier[a.sample_tier] = (byTier[a.sample_tier] || 0) + 1;
  return {
    total: (rows || []).length, accepted_count: accepted.length, rejected_count: rejected.length,
    by_sample_tier: byTier,
    percentile_eligible_count: accepted.filter((a) => a.percentiles_allowed).length,
    accepted, rejected,
  };
}

// ---- Comparison engine (NOT scoring) ------------------------------------
//
// Returns a described comparison or an honest refusal. It never produces a
// rating, a grade, or anything that could be read as "how good is this
// athlete" — that is readiness's job and readiness is still locked.
function compareToReference({ sport, metric, value, unit, athlete, protocol, populations }) {
  const resolved = resolveBenchmarkMetric(sport, metric);
  if (!resolved.resolved) return { status: "unresolved_metric", reason: resolved.reason };
  const pool = (populations || BENCHMARK_BANDS).filter((b) => b.sport === sportSchemaFor(sport)?.id && b.metric === resolved.key);
  if (!pool.length) return { status: "no_reference_data", metric: resolved.key };
  const { selected, rejected } = selectReferencePopulation(pool, { ...athlete, sport: sportSchemaFor(sport)?.id });
  if (!selected) return { status: "no_compatible_population", metric: resolved.key, rejected_reasons: rejected.map((r) => r.reason) };

  const compat = protocolCompatible({ protocol }, { protocol: selected.provenance.protocol_structured || {} });
  const conv = unit && unit !== selected.unit ? convertUnit(value, unit, selected.unit) : { ok: true, value };
  if (!conv.ok) return { status: "unit_incompatible", metric: resolved.key, from: unit, to: selected.unit };

  return {
    status: "ok",
    metric: resolved.key, unit: selected.unit, athlete_value: conv.value,
    // A percentile is offered ONLY when the population is large enough AND
    // the protocols are compatible. Either failing downgrades to a described
    // comparison with the caveat attached, never to a confident number.
    // Gated on `blocking`, not `compatible`: a known protocol conflict
    // withholds the percentile outright, while unreported protocol detail
    // leaves it available but flagged in protocol_compatibility.issues.
    percentile_available: selected.percentiles_allowed && !compat.blocking,
    population: {
      description: selected.provenance.population_description,
      specificity: selected.specificity, specificity_label: specificityLabel(selected.specificity),
      sample_size: selected.sample_size, sample_tier: selected.sample_tier,
      reference_type: selected.reference_type, is_requirement: isRequirement(selected),
    },
    protocol_compatibility: compat,
    evidence_quality: selected.provenance.evidence_quality,
    // Full traceability: source -> population -> metric -> protocol -> N -> date -> tier.
    provenance: selected.provenance,
    caution: isRequirement(selected)
      ? null
      : "This is a descriptive reference population, not a requirement. It describes what a measured group did, not what an athlete must achieve.",
  };
}

// Explicit status object rather than null, so a caller can distinguish
// "we looked and have no reference data" from "something went wrong".
// Until BENCHMARK_BANDS is populated this ALWAYS returns no_reference_data,
// which is the honest answer and must stay visible rather than being smoothed
// into a default band.
function benchmarkBandFor({ sport, metric, positionGroup, stage, targetLevel }) {
  const schema = sportSchemaFor(sport);
  if (!schema) return { status: "unknown_sport", band: null };
  const resolved = resolveBenchmarkMetric(sport, metric);
  if (!resolved.resolved) return { status: "unresolved_metric", band: null, reason: resolved.reason };
  const match = BENCHMARK_BANDS.find((b) =>
    b.sport === schema.id && b.metric === resolved.key &&
    (b.position_group == null || b.position_group === positionGroup) &&
    (b.stage == null || b.stage === stage) &&
    (b.target_level == null || b.target_level === targetLevel));
  if (!match) return { status: "no_reference_data", band: null, metric: resolved.key, unit: resolved.unit };
  return { status: "ok", band: match, metric: resolved.key, unit: resolved.unit };
}

// ---- 3. Current competitive level ---------------------------------------
//
// Stored in scout_context (jsonb) rather than a new column: no migration, no
// risk to existing rows, and it inherits the source/confidence tagging every
// other soft fact already carries.
//
// NEVER inferred. A club name, a country, an age or the athlete's own
// enthusiasm are not evidence of competitive level — "I play for Omonia"
// could mean the first team or an under-13 side. Only an explicit stored
// value that resolves against THIS sport's level list counts.
function resolveCurrentLevel(sport, scoutContext) {
  const entry = scoutContext && scoutContext.current_level;
  const rawVal = entry && typeof entry === "object" ? entry.value : entry;
  if (!rawVal) return { known: false, level: null, source: null, reason: "not_on_record" };
  const level = resolveLevel(sport, String(rawVal));
  if (!level) return { known: false, level: null, source: null, reason: "unrecognised_for_sport", raw: rawVal };
  return {
    known: true, level,
    source: (entry && typeof entry === "object" && entry.source) || "athlete_stated",
    confidence: (entry && typeof entry === "object" && typeof entry.confidence === "number") ? entry.confidence : null,
  };
}

// ---- 4. Readiness dimensions + configurable weighting -------------------
//
// The dimensions the future engine will evaluate. Declared here so the engine
// consumes a shared vocabulary rather than inventing one.
const READINESS_DIMENSIONS = [
  { id: "athletic_fit", label: "Athletic / performance fit", needs: ["benchmarks", "reference_bands"] },
  { id: "level_fit", label: "Competitive-level fit", needs: ["current_level", "target_level"] },
  { id: "development_fit", label: "Development fit", needs: ["stage", "development_plan"] },
  { id: "evidence_strength", label: "Evidence / profile strength", needs: ["evidence_tiers"] },
  { id: "exposure_readiness", label: "Exposure / recruiting readiness", needs: ["film", "outreach"] },
  { id: "pathway_requirements", label: "Pathway-specific requirements", needs: ["pathway_key_evidence"] },
];

// Weights are INTENTIONALLY null. The architecture supports per-sport and
// per-pathway variation — academics matter enormously for NCAA and barely at
// all for a pro trial — but choosing the actual numbers requires validation
// GOLSZ has not done. A null weight means "not yet decided" and the engine
// must refuse to score rather than substitute a default.
const READINESS_WEIGHTS = {
  DEFAULT: Object.fromEntries(READINESS_DIMENSIONS.map((d) => [d.id, null])),
  "soccer:ncaa": Object.fromEntries(READINESS_DIMENSIONS.map((d) => [d.id, null])),
  "soccer:professional": Object.fromEntries(READINESS_DIMENSIONS.map((d) => [d.id, null])),
  "basketball:ncaa": Object.fromEntries(READINESS_DIMENSIONS.map((d) => [d.id, null])),
};

function readinessWeightsFor(sport, goalType) {
  const schema = sportSchemaFor(sport);
  const key = schema && goalType ? `${schema.id}:${goalType}` : null;
  return (key && READINESS_WEIGHTS[key]) || READINESS_WEIGHTS.DEFAULT;
}

// The gate that keeps a half-built engine from shipping a number. Returns
// false while any weight is unset or no reference bands exist.
function readinessScoringReady(sport, goalType) {
  const w = readinessWeightsFor(sport, goalType);
  const weighted = Object.values(w).every((v) => typeof v === "number");
  return { ready: weighted && BENCHMARK_BANDS.length > 0,
    weights_configured: weighted, reference_bands: BENCHMARK_BANDS.length };
}

// Deterministic recovery for the goal-capture failure found 2026-08-09.
//
// Audit finding: across all 13 production athletes, profiles.goal_text was
// EMPTY while scout_context.dream_outcome held real, athlete-stated goals
// ("CPL professional contract", "turn pro in soccer"). Scout recognises goals
// correctly; it just writes them to the scout_context channel instead of the
// profile_updates one, because dream_outcome is the better-signposted key and
// the `goal` instruction was purely discouraging. The prompt is fixed too, but
// a prompt is a request — this makes the outcome structural.
//
// Strictly a promotion of the athlete's OWN words, never an inference:
//   - only fires when goal_text is genuinely empty (never overwrites)
//   - only for source === "athlete_stated" (an ai_inferred dream_outcome is
//     Scout's reading between the lines, and §18 forbids assuming a goal)
//   - never overrides an explicit profile_updates.goal the model did send
// persistProfileUpdates() flips goal_defined=true off the same write, so the
// derived flag stays deterministic rather than model-reported.
// Reads BOTH this turn's dream_outcome and the one already on file. The
// first version watched only the incoming updates and was therefore
// structurally dead: the model does not re-send a dream_outcome it has
// already recorded, so the net never fired for the athletes whose goals were
// already stranded — the entire population it existed for. Verified live:
// an athlete said "lock that in as my goal", Scout replied "goal locked in",
// and goal_text stayed NULL because nothing new was emitted to promote.
//
// Reading the stored value makes this self-healing per athlete on their next
// interaction. It is NOT a backfill: nothing is written until that athlete
// talks to Scout again, and the value promoted is one they stated themselves.
function pickStatedGoal(scoutContext) {
  const d = scoutContext && scoutContext.dream_outcome;
  // Only an object carries a source; a bare string has no provenance, and
  // provenance is the whole basis for trusting this as the athlete's own word.
  if (!d || typeof d !== "object" || d.source !== "athlete_stated") return null;
  const v = typeof d.value === "string" ? d.value.trim() : "";
  return v || null;
}

function applyGoalSafetyNet(profileUpdates, scoutContextUpdates, existingGoalText, storedScoutContext) {
  if (existingGoalText && String(existingGoalText).trim()) return profileUpdates;
  if (profileUpdates && profileUpdates.goal) return profileUpdates;
  // This turn's statement first — it is the most current thing they said.
  // Falls back to what is already on file, which is the self-heal path.
  const goal = pickStatedGoal(scoutContextUpdates) || pickStatedGoal(storedScoutContext);
  if (!goal) return profileUpdates;
  return { ...(profileUpdates || {}), goal };
}

// P0-5 counterpart to the safety net above. The net exists to get a goal ONTO
// the Passport when there isn't one; this exists to stop model extraction
// silently REPLACING one the athlete wrote themselves.
//
// Master Architecture §42. Once an athlete types their goal into the Plan
// editor, that sentence is theirs. Scout hearing something it reads as a
// different aim is not evidence the athlete changed their mind — it is far
// more often Scout over-reading a passing remark ("I'd take JUCO if D1
// doesn't happen" is not a new goal). Overwriting on that basis rewrites the
// athlete's own words behind their back, and they would have no way to tell
// it happened.
//
// So: athlete-authored goals are dropped from the update, and Scout is told
// separately (goal_authored_by_athlete in ATHLETE STATE) to raise a genuine
// change conversationally instead. A Scout-captured goal stays freely
// updatable by Scout — that path is what got goals recorded at all.
//
// Comparison is deliberately loose: case, surrounding whitespace and
// punctuation should not count as a "material" change, or a re-statement of
// the same goal with a full stop on the end would trip the guard.
function normalizeGoalForComparison(goal) {
  return String(goal || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function applyGoalAuthorship(profileUpdates, existingGoalText, existingGoalSource) {
  if (!profileUpdates || !profileUpdates.goal) return profileUpdates;
  if (existingGoalSource !== "athlete_edited") return profileUpdates;
  const incoming = normalizeGoalForComparison(profileUpdates.goal);
  const existing = normalizeGoalForComparison(existingGoalText);
  // Same goal restated — nothing to protect, and dropping it is harmless.
  // Materially different — protected, and the athlete must be the one to
  // change it.
  if (incoming && existing && incoming === existing) {
    const { goal, ...rest } = profileUpdates;
    return rest;
  }
  const { goal, ...rest } = profileUpdates;
  console.log("GOLSZ goal overwrite BLOCKED (athlete-authored):", JSON.stringify({
    kept: String(existingGoalText || "").slice(0, 120),
    rejected: String(goal).slice(0, 120),
  }));
  return rest;
}

// The deliberate FIRST SLICE of a future SPORT_SCHEMA — not the whole thing.
// Kept as a code constant rather than a table on purpose: scout_model_config
// shipped empty to production while the code assumed rows existed, silently
// breaking model routing for months (found 2026-08-09 only by sending a real
// message and reading logs). A constant cannot be empty and deploys
// atomically with the code that reads it. Move this to a table when there is
// an admin editor for it, not before.
//
// Field names reference REAL athlete columns and REAL scout_context keys
// only — nothing invented. "age" is the one derived field (dob OR
// age_reported), resolved in fieldPresent() below.
//
// DEFAULT is the COMMON path, not the fallback edge case: ~11 sports are
// offered and two are configured here, and a free athlete with no classified
// goal lands here too. It must always produce something sensible.
// target_level is USEFUL, never CRITICAL. It was critical in the first cut,
// and a 2026-08-09 audit showed why that was wrong on both counts: it was
// populated for only 1 of 13 athletes, and it is redundant with the goal —
// "NCAA D1 soccer" as a goal already establishes the intended level. Keeping
// both critical meant blocking readiness on a second field that asks the
// athlete the same question twice, so a stated goal would still leave them
// stuck. The goal itself remains mandatory (enforced separately below).
const PATHWAY_FIELD_PRIORITY = {
  "soccer:ncaa": {
    critical: ["sport", "age", "position", "club_name", "grad_year", "gpa"],
    useful: ["target_level", "height_cm", "perceived_strengths", "perceived_weaknesses", "timeline", "exposure_need"],
    deprioritized: [],
  },
  "soccer:professional": {
    // Academics are not what a pro pathway turns on — grad_year/gpa are
    // explicitly deprioritized so triage stops treating them as blockers.
    critical: ["sport", "age", "position", "club_name", "timeline"],
    useful: ["target_level", "height_cm", "perceived_strengths", "perceived_weaknesses", "main_gap"],
    deprioritized: ["gpa", "grad_year"],
  },
  "basketball:ncaa": {
    critical: ["sport", "age", "position", "club_name", "grad_year", "gpa"],
    useful: ["target_level", "height_cm", "perceived_strengths", "perceived_weaknesses", "timeline", "exposure_need"],
    deprioritized: [],
  },
  "basketball:professional": {
    critical: ["sport", "age", "position", "club_name", "timeline"],
    useful: ["target_level", "height_cm", "perceived_strengths", "perceived_weaknesses", "main_gap"],
    deprioritized: ["gpa", "grad_year"],
  },
  // Sport-agnostic, goal-agnostic baseline. Mirrors Master Architecture §Part 3's
  // universal triage list, minus anything only meaningful for a known pathway.
  DEFAULT: {
    critical: ["sport", "age", "position", "club_name"],
    useful: ["target_level", "timeline", "perceived_strengths", "perceived_weaknesses", "main_gap", "grad_year"],
    deprioritized: [],
  },
};

function pathwayPriorityFor(sport, pathwayType) {
  const key = `${String(sport || "").toLowerCase().trim()}:${pathwayType || ""}`;
  return PATHWAY_FIELD_PRIORITY[key] || PATHWAY_FIELD_PRIORITY.DEFAULT;
}

// Is this field actually known? Hard Passport columns outrank scout_context,
// same precedence renderAuthoritativeContext() already applies. A
// scout_context entry counts as present only when it has a real value —
// the model writes {value, source, confidence} objects, and an empty value
// is the same as never having asked.
function fieldPresent(field, athlete, scoutContext, goalText) {
  const a = athlete || {};
  const sc = scoutContext || {};
  if (field === "age") return !!(a.dob || a.age_reported);
  if (field === "goal") return !!(goalText && String(goalText).trim());
  if (a[field] !== undefined && a[field] !== null && a[field] !== "") return true;
  const entry = sc[field];
  if (entry && typeof entry === "object") return entry.value !== undefined && entry.value !== null && entry.value !== "";
  return entry !== undefined && entry !== null && entry !== "";
}

// THE canonical "do we know enough to stop interviewing and start assessing"
// signal. Both the Scout recap and the free->paid conversion moment read
// this one function, so the server and the client can never disagree about
// whether an athlete is ready.
//
// Returns no percentage on purpose: three overlapping completeness numbers
// already exist (Readiness' profile_quality sub-score being one), and a
// fourth soft metric would be noise. confidence is DERIVED from the counts
// below, never free-form and never model-authored.
function isAssessmentReady(ctx) {
  const athlete = (ctx && ctx.athlete) || null;
  const scoutContext = (athlete && athlete.scout_context) || (ctx && ctx.scoutContext) || {};
  const goalText = (ctx && ctx.goalText) || null;
  const pathwayType = (ctx && ctx.pathwayType) || classifyGoalText(goalText);
  const priority = pathwayPriorityFor(athlete && athlete.sport, pathwayType);

  const missing_critical = priority.critical.filter((f) => !fieldPresent(f, athlete, scoutContext, goalText));
  const missing_useful = priority.useful.filter((f) => !fieldPresent(f, athlete, scoutContext, goalText));

  // A stated goal is non-negotiable regardless of sport or pathway: without
  // one there is nothing to be ready RELATIVE TO. Master Architecture §18.
  const hasGoal = fieldPresent("goal", athlete, scoutContext, goalText);
  if (!hasGoal) missing_critical.push("goal");

  const sufficient = missing_critical.length === 0;
  const confidence = !sufficient ? "low" : (missing_useful.length <= 1 ? "high" : missing_useful.length <= 3 ? "moderate" : "low");

  return { sufficient_for_preliminary_assessment: sufficient, missing_critical, missing_useful, confidence };
}

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

// ---- 2 / THE SCOUT -> PLAN HANDOFF --------------------------------------
// extractSuggestedPathway() above can only return what the MODEL chose to
// emit, and in production the model simply declined. Tested 2026-08-10
// against four escalating, unambiguous instructions ("build it now", "go
// ahead and build it", "that is genuinely my new goal, build the Plan"):
// four times it described a complete Pathway in prose — pathway category,
// timeline, dated milestones — and four times emitted no structured object,
// so nothing ever reached the Plan tab. The athlete is told a plan exists
// and then finds an empty screen.
//
// Emission cannot stay a model decision. Below: a deterministic read of the
// ATHLETE'S OWN words for approval, and an app-built Pathway when approval
// is given and the model still produced nothing. The model is preferred
// when it does emit (richer, sport-specific content); the app guarantees
// that an approved Plan always lands.
//
// Approval is read from the athlete's message, never from the model's
// claim that the athlete agreed — that would hand the decision straight
// back to the thing that failed.
const PATHWAY_APPROVAL_PATTERNS = [
  /\b(yes|yep|yeah|ok|okay|sure|please|confirmed?)\b[^.?!]{0,60}\b(build|rebuild|make|create|set\s?up)\b/i,
  /\b(go ahead|do it|build it|build my|build the|build that|rebuild it|rebuild my|rebuild the|set it up|lock it in|let'?s do it)\b/i,
];
// Anything that turns an apparent instruction back into a question, a
// refusal or a "later". Checked FIRST so "should you build it?" and "don't
// build it yet" can never read as approval.
const PATHWAY_APPROVAL_BLOCKERS = [
  /\b(should|can|could|would|will|shall)\s+(you|i|we)\b/i,
  /\bdon'?t\b/i,
  /\b(not yet|hold off|wait until|let'?s wait|maybe later)\b/i,
  /^\s*(no|nope)\b/i,
];
function athleteApprovedPathwayBuild(message) {
  if (typeof message !== "string" || !message.trim()) return false;
  const m = message.trim();
  if (PATHWAY_APPROVAL_BLOCKERS.some((re) => re.test(m))) return false;
  return PATHWAY_APPROVAL_PATTERNS.some((re) => re.test(m));
}

// The app's own Pathway, built with no model involvement at all.
//
// Every milestone is a real, named gap in this athlete's record — the same
// readiness figures Home shows them — so this is honest and specific rather
// than filler. It deliberately does NOT invent sport-specific tactical
// steps: the app does not know those, and a plausible-sounding invented
// milestone an athlete trains against for months is a worse outcome than a
// plain one.
//
// Writes nothing about the goal. The athlete's wording is untouchable here
// exactly as it is in autoFixPathwayType().
function synthesizePathwayFromState({ pathwayType, readiness }) {
  if (!pathwayType || !PATHWAY_TYPE_SET.has(pathwayType)) return null;
  const rd = readiness;
  const milestones = [];
  if (rd && rd.quality && Array.isArray(rd.quality.missing) && rd.quality.missing.length) {
    milestones.push({ label: `Complete your Passport: add ${rd.quality.missing.slice(0, 3).join(", ")}`, done: false });
  }
  if (rd && rd.performance) {
    if (rd.performance.metricsTracked === 0) milestones.push({ label: "Record your first set of benchmark results", done: false });
    else if (rd.performance.metricsRetested === 0) milestones.push({ label: "Retest your benchmarks so progression is on record", done: false });
  }
  if (rd && rd.pathway && !rd.pathway.targetsCount) {
    milestones.push({ label: "Build a target list of clubs or programmes to approach", done: false });
  }
  if (rd && rd.development && rd.development.total === 0) {
    milestones.push({ label: "Set up a development plan for your weakest area", done: false });
  }
  if (rd && rd.verification && rd.verification.status === "none") {
    milestones.push({ label: "Request identity verification on your Passport", done: false });
  }
  if (!milestones.length) return null;
  return { pathway_type: pathwayType, target_timeline: null, milestones: milestones.slice(0, 6) };
}

// The guarantee. Model first, app second, never nothing when the athlete
// has actually said yes and the state supports building one.
//
// Plan gating is unchanged and is checked FIRST: Pathway is not part of
// Free, and nothing here may hand a Free athlete a paid object.
function resolveSuggestedPathway({ modelPathway, approved, plan, goalDefined, pathwayType, readiness, goalText }) {
  if (!hasFeature(plan, "pathway_plan")) return { pathway: null, source: "gated" };
  // A model-built Pathway must agree with the goal the athlete WROTE.
  //
  // The prompt already says "never send one that contradicts their written
  // goal" and in production it did exactly that: the athlete's goal read
  // "earn an NCAA Division 1 scholarship" and the emitted Pathway came back
  // as a CPL professional route, assembled from older conversation memory.
  // Accepting it would have written a Plan pointing somewhere the athlete
  // had not asked to go — the precedence rule broken at the one moment it
  // matters most, because this one persists.
  //
  // Only fires when the goal classifies unambiguously; a goal the classifier
  // cannot read yields null and imposes nothing. Falls through to the app's
  // own build, which derives its category from that same written goal.
  if (modelPathway) {
    const derived = classifyGoalText(goalText);
    if (derived && modelPathway.pathway_type !== derived) {
      console.warn("GOLSZ rejected a suggested Plan that contradicted the athlete's written goal:", JSON.stringify({ emitted: modelPathway.pathway_type, goalPointsAt: derived }));
    } else {
      return { pathway: modelPathway, source: "model" };
    }
  }
  if (!approved) return { pathway: null, source: "not_requested" };
  // No goal on record means there is nothing to build a route toward, and
  // inventing one would be exactly the silent-overwrite this forbids.
  if (!goalDefined) return { pathway: null, source: "no_goal" };
  const synth = synthesizePathwayFromState({ pathwayType, readiness });
  if (!synth) return { pathway: null, source: "insufficient_state" };
  return { pathway: synth, source: "app" };
}

// One call the four response paths share, so the guarantee cannot be wired
// into three of them and forgotten in the fourth.
//
// ctx is null when there is no authenticated athlete state to reason about
// (no Supabase env, unauthenticated caller). That path keeps the exact
// pre-existing behaviour rather than silently changing what an
// unauthenticated request returns.
function finalizeSuggestedPathway(data, ctx, incomingText, userPlan) {
  const modelPathway = extractSuggestedPathway(data);
  if (!ctx) return { pathway: userPlan === "free" ? null : modelPathway, source: modelPathway ? "model" : "not_requested" };
  const resolved = resolveSuggestedPathway({
    modelPathway,
    approved: athleteApprovedPathwayBuild(incomingText),
    plan: ctx.plan,
    goalDefined: ctx.goalDefined,
    pathwayType: ctx.pathwayType,
    readiness: ctx.readiness,
    goalText: ctx.goalText,
  });
  if (resolved.source === "app") {
    console.log("GOLSZ Plan assembled by the app after athlete approval — model emitted none:", JSON.stringify({ pathway_type: resolved.pathway.pathway_type, milestones: resolved.pathway.milestones.length }));
  }
  return resolved;
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
  if (open !== "[" && open !== "{") {
    // Literal: true / false / null / a number. Only strings, arrays and
    // objects were salvageable before, so a boolean field in a truncated
    // reply was silently lost even though it is trivially recoverable.
    const lit = /^(true|false|null|-?\d+(?:\.\d+)?)/.exec(raw.slice(i));
    if (!lit) return undefined;
    try { return JSON.parse(lit[1]); } catch { return undefined; }
  }
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
  const blocks = (data && data.content) || [];
  const raw = blocks.map((b) => (b.type === "text" ? b.text : "")).filter(Boolean).join("");
  const clean = raw.replace(/```json|```/g, "").trim();
  const parsed = parseReplyObject(clean);
  if (parsed && typeof parsed.reply === "string" && parsed.reply.trim()) return sanitizeReplyText(parsed.reply);
  const salvaged = salvageJsonValue(clean, "reply");
  if (typeof salvaged === "string" && salvaged.trim()) return sanitizeReplyText(salvaged);
  // TOOL-USE RESPONSES HAVE NO USABLE PROSE FALLBACK.
  //
  // When Scout runs web searches the response comes back as many interleaved
  // blocks — server_tool_use, web_search_tool_result, and the model's own
  // between-search notes to itself. If it then runs out of output budget
  // before writing the envelope, joining every text block yields its private
  // scratchpad, and the fallback below happily shipped it. Observed in
  // production on 2026-08-11 after five searches, sent to a real athlete,
  // discussing him in the third person:
  //
  //   "Good, that confirms the U-21 cutoff detail I need to flag. Now to
  //    answer directly using the record I already have... Now let me write
  //    the reply."
  //
  // Commentary between tool calls is never the answer. Returning null puts
  // the client on its honest "that didn't come through, retry" path, which
  // is the correct outcome for a genuinely incomplete generation.
  //
  // The prose fallback below stays for the case it was written for: a
  // single-shot reply where the model wrote plain prose instead of JSON.
  if (blocks.some((b) => b && (b.type === "server_tool_use" || b.type === "tool_use"))) return null;
  // No recoverable "reply". Drop everything from the first "{" onward and see
  // if the model wrote anything usable before it.
  const brace = clean.indexOf("{");
  const prose = (brace >= 0 ? clean.slice(0, brace) : clean).trim();
  // Threshold is low on purpose: a short real sentence ("Here is what I found
  // about the window.") is 38 chars and must not be thrown away. The '":'
  // check is what actually rejects JSON fragments, not the length.
  if (prose.length > 15 && !prose.includes('":')) return sanitizeReplyText(prose);
  return null;
}

// ---- 6 / NEVER EXPOSE INTERNAL TERMINOLOGY -------------------------------
// The prompt forbids this, and the prompt was not enough. Observed in
// production on 2026-08-10, verbatim, to a real athlete:
//
//   "I'm holding the suggested_pathway build for one more message"
//
// A prompt rule is a request; this is the guarantee. Every athlete-facing
// string goes through here (deriveReplyText is the single choke point all
// four response paths share).
//
// Substitutions, not deletions: removing the word would leave a sentence
// with a hole in it. Each internal identifier maps to what a human would
// have said, so the sentence survives ("I'm holding the Plan build for one
// more message").
//
// Word-boundary anchored and case-insensitive. Deliberately conservative —
// it only rewrites tokens that are unmistakably ours. "pathway" and "plan"
// on their own are ordinary English an athlete should absolutely hear, so
// only the snake_case/CAPS forms are touched.
const INTERNAL_TERM_REPLACEMENTS = [
  [/\bsuggested_pathway\b/gi, "Plan"],
  [/\bpathway_type\b/gi, "pathway"],
  [/\bpathway_plan\b/gi, "Plan"],
  [/\bpathway_complete\b/gi, "whether your Plan is finished"],
  [/\btarget_timeline\b/gi, "target timeline"],
  [/\bgoal_text\b/gi, "your goal"],
  [/\bgoal_defined\b/gi, "whether your goal is set"],
  [/\bgoal_authored_by_athlete\b/gi, "whether you wrote the goal yourself"],
  [/\bgoal_source\b/gi, "where your goal came from"],
  [/\bprofile_updates\b/gi, "your Passport details"],
  [/\bmemory_writes\b/gi, "my notes"],
  [/\bscout_context(_updates)?\b/gi, "what I know about you"],
  [/\bathlete_benchmarks\b/gi, "your benchmarks"],
  [/\bdevelopment_plan_items\b/gi, "your development plan"],
  [/\boutreach_targets\b/gi, "your target list"],
  [/\bsuggested_targets\b/gi, "target suggestions"],
  [/\bsuggested_dev_items\b/gi, "development suggestions"],
  [/\bbaseline_complete\b/gi, "your baseline"],
  [/\bassessment_ready\b/gi, "whether I know enough yet"],
  [/\bstill_missing\b/gi, "what's still missing"],
  [/\bprofile_complete\b/gi, "how complete your Passport is"],
  [/\bprofile_quality\b/gi, "how complete your Passport is"],
  [/\bmilestones_?done\b/gi, "milestones done"],
  [/\bATHLETE STATE\b/g, "your record"],
  [/\bPLAN FIT\b/g, "your plan"],
  [/\bSCOUT MEMORY\b/g, "my notes"],
  [/\bdrafted_email\b/gi, "the draft email"],
  [/\breply_text\b/gi, "my reply"],
];
function stripInternalTerminology(text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [re, replacement] of INTERNAL_TERM_REPLACEMENTS) out = out.replace(re, replacement);
  // Loud, because a hit means the prompt rule was ignored and the wording
  // around the substitution may still read oddly. Logs the term, never the
  // athlete's message.
  if (out !== text) console.warn("GOLSZ internal terminology leaked into a reply and was rewritten");
  return out;
}

// ---- META-COMMENTARY -----------------------------------------------------
// The other half of the same problem. Terminology substitution cannot help
// when the model writes its working-out INSIDE the reply value, which it
// does, in production, to real athletes:
//
//   "The search results for CPL preseason are about cricket and general
//    MLS/Premier League info, not Canadian Premier League soccer."
//   "Confirmed: Tusculum is NCAA Division II, so his currently written goal
//    would actually mean transferring. Now let me write the reply."
//
// Two tells, both fatal to the illusion that an agent is talking to you:
// narration of the machinery (searches, tools, "now I'll answer"), and the
// third person — an athlete being discussed rather than addressed.
//
// Removal is by SENTENCE, not by whole reply: the surrounding advice is
// usually fine and throwing it away would cost the athlete a real answer.
// Paragraph structure is preserved so what is left still reads naturally.
const META_COMMENTARY_PATTERNS = [
  // Narrating the tools.
  /\bsearch results?\b/i,
  /\bweb search(?:es)?\b/i,
  /\bI (?:just |already )?(?:ran|did|performed|tried) (?:a |another )?search\b/i,
  /\bsearching (?:the web|online|for)\b/i,
  /\bthe search (?:for|came back|returned|didn'?t)\b/i,
  /\btool (?:call|result)s?\b/i,
  // Narrating its own process.
  /\bnow (?:I'?ll|I will|let me|to) (?:write|answer|give|draft|respond|reply)\b/i,
  /\blet me (?:write|draft|put together)\b[^.!?]*\b(?:reply|answer|response)\b/i,
  // "Let me look that up for you." — announcing the lookup instead of doing
  // it. The athlete wants the answer, not a status update.
  /\blet me (?:look|check|see|find|dig|pull|go)\b/i,
  /\bI'?ll (?:look|check) (?:that|this|it) up\b/i,
  /\bone (?:sec|second|moment)\b/i,
  /\bI'?ll write the (?:actual |full |real )?(?:reply|answer|response)\b/i,
  /\bthis (?:confirms|settles) (?:it|that|the)\b/i,
  /\bI (?:have|now have) (?:what I need|enough|everything I need|plenty to work with)\b/i,
  /\bgrounded in the\b[^.!?]*\brecord\b/i,
  /\bnow I have (?:what I need|enough|everything)\b/i,
  // Talking ABOUT the athlete instead of TO them. Scoped to GOLSZ objects
  // that can only be the athlete's own, so an athlete discussing a teammate
  // ("his goal this season was 20 assists") is not caught by accident.
  // Case-insensitive: the give-away often opens a sentence ("Her Plan is a
  // shell"). Anchored to GOLSZ objects only, so "his touch under pressure"
  // — an athlete talking about a team-mate — is untouched.
  /\b(?:his|her) (?:currently |newly |recently )?(?:written |stated |current )?(?:goal|plan|passport|record|benchmarks|situation)\b/i,
  /\bthe athlete(?:'s)?\b/i,
  /\bthe user(?:'s)?\b/i,
];
function stripMetaCommentary(text) {
  if (typeof text !== "string" || !text) return text;
  const paragraphs = text.split(/\n{2,}/);
  const keptParagraphs = [];
  let dropped = 0;
  for (const para of paragraphs) {
    // Split on sentence boundaries, keeping the terminator with its sentence.
    const sentences = para.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter((s) => {
      if (!s.trim()) return false;
      const isMeta = META_COMMENTARY_PATTERNS.some((re) => re.test(s));
      if (isMeta) dropped++;
      return !isMeta;
    });
    if (kept.length) keptParagraphs.push(kept.join(" ").trim());
  }
  const out = keptParagraphs.join("\n\n").trim();
  if (dropped) console.warn("GOLSZ meta-commentary removed from a reply:", JSON.stringify({ sentencesDropped: dropped, survivedChars: out.length }));
  return out;
}

// Both sanitizers, in the one order that makes sense: rewrite the internal
// identifiers first (so a sentence is judged on its final wording), then
// drop whole sentences that are machinery rather than advice.
//
// Returns null ONLY when nothing survives — a reply that was ENTIRELY
// scratchpad is not a reply, and the client's honest retry path is the right
// outcome.
//
// No minimum length here. "Yes." and "ok" are complete, legitimate replies;
// an earlier version of this imposed a 15-character floor and turned every
// short answer into a failed message. The one length rule that exists lives
// where it belongs — on the prose fallback in deriveReplyText, which is
// guessing at whether stray text was ever meant to be a reply at all.
function sanitizeReplyText(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const out = stripMetaCommentary(stripInternalTerminology(text));
  return out && out.trim() ? out.trim() : null;
}

// Scout kept ending EVERY reply with a question — four, five in a row reads
// like an intake form rather than a conversation. The prompt rule was ignored,
// so this enforces it instead of asking: a question is only removed when the
// PREVIOUS reply also ended in one. A single question is normal human
// back-and-forth and is always left alone.
function endsWithQuestion(text) {
  return /\?["')\]]*\s*$/.test(String(text || "").trim());
}

// Drops the trailing question sentence(s) only. Bails out rather than
// mangling: a reply that is ONE sentence, or that would be gutted to a stub,
// keeps its question — better a second question than a truncated answer.
function stripTrailingQuestion(text) {
  const t = String(text || "").trimEnd();
  if (!endsWithQuestion(t)) return text;
  const parts = t.match(/[^.!?]+[.!?]+[\s]*/g);
  if (!parts || parts.length < 2) return text;
  const kept = parts.slice();
  while (kept.length > 1 && endsWithQuestion(kept[kept.length - 1])) kept.pop();
  const joined = kept.join("").trimEnd();
  return joined.length >= 80 ? joined : text;
}

// conversation is the real transcript (client sends the recent window), so the
// previous assistant turn is the right thing to check.
function softenQuestionStreak(replyText, conversation) {
  if (!replyText || !endsWithQuestion(replyText)) return replyText;
  const priorAssistant = [...(conversation || [])].reverse()
    .find((m) => m && m.role === "assistant" && typeof m.content === "string");
  if (!priorAssistant || !endsWithQuestion(priorAssistant.content)) return replyText;
  const stripped = stripTrailingQuestion(replyText);
  if (stripped !== replyText) console.log("GOLSZ dropped a back-to-back closing question");
  return stripped;
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
async function persistAiMeta(userId, classification, assessmentReady) {
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
    // Written here so the client's free->paid conversion moment can read the
    // SAME readiness value the server just used for the Scout recap, rather
    // than reimplementing isAssessmentReady() in golsz-app.html and drifting
    // from it. One implementation, two consumers.
    assessment_ready: !!(assessmentReady && assessmentReady.sufficient_for_preliminary_assessment),
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

const SYSTEM_PROMPT = `You are GOLSZ Scout, an AI sports advisor. Your job: help athletes understand who they are, what they want, and how to get there.

CORE BEHAVIORS (in this order, every time)

1. LISTEN
Anything the athlete just said becomes current truth. If they say "I play at Lakeshore," that's now what you know. If they say "I have video," update your understanding immediately. Don't re-explain what they already told you last message or last week. New information moves the conversation forward, not backward.

2. DON'T PRETEND TO KNOW
When you don't know something specific, a club's level, a league's structure, a pathway rule, a scholarship deadline, say so plainly. "Which Lakeshore?" is better than inventing which one it is. "I'm not sure if they went up this season, let me check" is better than guessing. Asking a clarifying question costs you nothing. Confidently wrong costs the athlete months of training toward the wrong target.

3. MOVE FORWARD
Each message should advance the conversation. Learn one thing, update what you understand, then ask the next useful question or give the next useful answer. Don't repeat the same diagnosis three times. Don't re-explain what you've already covered. This is a conversation, not a report.

4. MATCH RESPONSE SIZE TO THE QUESTION
"I have video" doesn't need a paragraph. "Build me a 12-month plan to D1" does. Simple question = a few sentences. Complex problem = detailed answer. Never pad to fill space.

HOW TO HELP ATHLETES

An athlete talks to you because they want to know: where am I now, where do I want to go, how do I get there?

Start by understanding what they actually want. Their stated goal is the anchor. If you genuinely don't know what they're aiming at, finding that out IS the reply. Don't guess.

The goal is theirs. The Pathway bends to it, never the reverse. Never reword their stated goal to fit a pathway; if they disagree with what the Pathway shows, that's a real conflict to surface and resolve with them, not something to fix by changing their words.

Then diagnose honestly. What's standing between them and the goal? Be specific: "no one's seen your film yet" or "the pathway timing doesn't match the college calendar" or "you haven't played at that level yet." Not vague coaching cliches.

Then advise. Say what you actually think they should do. Have an opinion. Agents commit to a view, then say when they might be wrong.

Then plan. What's the next concrete action? In what order? By when?

EPISTEMIC RULES, KNOW THE DIFFERENCE

What you KNOW vs what you GUESS is everything.

A FACT you can trust: something the athlete told you this conversation, something in their GOLSZ Passport/profile, something you looked up and confirmed, something in past conversations you're clearly remembering.

A GUESS is: anything you inferred from their age, their club name, their ambition level, what "sounds" realistic, or what you remember from similar athletes. Never lead with a guess.

When you're unsure, say "I'm not sure" and do one of these:
Ask a clarifying question.
Search online to find out.
Say what you'd check and why it matters.

If sources disagree, say so once. "Different sources say different things; the official rule is..."

BE HONEST BEFORE YOU'RE ENCOURAGING. If something is unrealistic, say so kindly and show the real path.

WHEN TO SEARCH

Search when you need current, specific facts:
League structures, eligibility rules, transfer windows (these change).
Club/program information, rosters, recent results.
Scholarship deadlines, tryout dates, recruitment timelines.
Specific rankings or performance benchmarks you're not sure about.

Don't search for general knowledge you're confident about (how to improve at your position, what D1 means, how to train for speed).

When you search, use what you find. Don't narrate that you searched or talk about the results. Just use them naturally.

TALKING TO DIFFERENT PEOPLE

With a player (or unset occupation): be their personal advisor. Learn who they are as an athlete. Push them to think it through themselves. "What do you think it'll actually take?" "What's stopping you right now?" "What are you doing about it today?"

With a coach/scout/agent: help them think through what they're looking for, then offer to search for real GOLSZ athletes who match (via search_golsz_players if available). Before suggesting external programs, check search_golsz_events for real GOLSZ listings. Never invent a player or program.

With a physio: general sports-performance guidance is your job. Injury prevention, training structure, recovery, fueling. For actual injuries, pain, or medical questions, name the right professional (physician, physio, registered dietitian) in one natural sentence and move on. You can still help with the parts you can.

HEALTH AND SAFETY, EVERY REPLY

Never give weight-cutting, dehydration, calorie-restriction, or "making weight" instructions, not a plan, not a shortcut, not "what some athletes do." Never prescribe return-to-play timelines or clearance. Never recommend, dose, or counsel on medication or supplements for an individual. Many GOLSZ athletes are minors, and unsafe cuts and medication missteps are documented harms in youth sport. If weight, return-to-play, or supplementation comes up, name the right professional (registered dietitian, physician) in one natural sentence and move on, then help with what's left.

This applies to every reply, to every athlete, whoever you are talking to and however the question is framed.

SPORTS KNOWLEDGE

You have general sports knowledge and can help any athlete with any sport.

If GOLSZ has built structured data for their sport (positions, competition ladder, benchmarks, pathways), it's there and use it.

If GOLSZ hasn't built that yet, that's fine. General knowledge and web search still help. Just be clear about what's GOLSZ guidance vs. general knowledge. "I don't have GOLSZ's structured data for handball yet, so this is general knowledge" is honest and useful.

Never invent a position structure, competition level, or eligibility rule. If you don't know it, search or ask.

GOLSZ SPORT SCHEMAS

When GOLSZ has built structured data for a sport (positions, competition ladder, benchmarks, pathways), use it as the record.

When GOLSZ has not built that yet, there is no schema, it means: no position structure, no competition ladder, no pathway list, no benchmark vocabulary, no eligibility data. None of it, not partial. A sport's support_level never overrides this. In those sports, use general knowledge and web search, and be clear about what's GOLSZ guidance vs. what isn't.

GOLSZ PLATFORM LIMITS

GOLSZ doesn't have: live coaching, video analysis, medical diagnosis, weight-loss programs, contract negotiation, agent representation.

When something falls outside GOLSZ, say plainly what GOLSZ doesn't do and point them to the real way to get help (a coach, a physio, a lawyer, an agent).

RESPONSE STYLE

Write like you're talking to someone, not filing a report.

Plain sentences. Contractions. Second person. No dashes, use commas, periods, colons. No markdown formatting. No asterisks or hyphens at the start of lines.

Default to 120-180 words. Longer only when they asked for a full breakdown.

Have an opinion. When there's a choice, say which one you'd pick and why. Then give alternatives a line. Never do balanced "Option A / Option B" and leave them to choose, that's what someone with no view does. You're their advisor.

Lead with the answer, not a recap. They know their own story.

Be especially careful with small clubs, youth leagues, and lower divisions, your recall is weakest there. When you're not sure, search or ask rather than guess confidently about structure or level.

Don't end every message with a question. Ask only when their answer would actually change your advice. Several replies in a row with no question is normal and good.

React like a person. "Two weeks of pain and still sore, that's worth getting checked out" is warmth. Never perform sympathy or invent feelings they didn't express.

MINORS AND PARENTS

If someone seems to be a minor, remind them once to involve a parent or guardian.

Never generate sexual, romantic, 18+, or inappropriate content, regardless of how it's framed. Decline briefly, warmly, steer back to sports.

THINGS YOU NEVER DO

Never name the underlying AI model or company (Claude, ChatGPT, Anthropic, OpenAI, etc.). You are GOLSZ Scout, built by GOLSZ.

Never mention internal fields, flags, or JSON keys that appear in server responses (assessment_ready, memory_writes, profile_updates, scout_context, pathway_type, ATHLETE STATE, PLAN FIT, etc.). Talk plainly: "your goal," "your Passport," "your plan."

Never narrate your process. Don't say "I searched and found," "this confirms," "let me look that up." Just use what you found.

Never assert something changed on their Passport/profile. You don't save, the app does. You request. If the app's save fails, you won't know. So say "got it, CPL contract" (what they told you), not "I've saved that" (false if it fails). Let their Passport show what actually stored.

Never use false urgency, fake scarcity, or guaranteed outcomes ("guaranteed scholarship," "guaranteed pro contract"). Many GOLSZ athletes are minors and a parent is paying. Be straight.

Never tell them to find someone or contact someone through GOLSZ if GOLSZ doesn't support that yet.

WHEN PLAN/PRICING COMES UP

GOLSZ has tiers. Only mention them when they've actually hit something locked.

Name what they need in plain words ("A Pathway would lay this out as steps you can track"), say what it opens, name the plan once, carry on. Never bolt a pitch onto the end of a reply.

Only ever point upward. Never suggest a cheaper plan.

Name the plan PLAN FIT computed, never a more expensive tier even if it would also solve the problem, and never name a plan PLAN FIT did not name.

If nothing they raised points to a locked feature, say nothing about plans.

Be concrete: "A Pathway would lay this out as dated steps instead of us deciding it every conversation" beats "upgrade for more features."

Answer the question first, always. A pitch in place of an answer is how you lose them.

STRUCTURED OUTPUT SCHEMA

Output as valid JSON only:

{
  "reply": "conversational text to the athlete",
  "memory_writes": [
    {
      "type": "FACT|USER_STATED|SCOUT_INFERENCE|GOAL|PREFERENCE|CONCERN|UNKNOWN|NEXT_DATA_NEEDED|ASSESSMENT|DECISION|PATHWAY_CONSIDERED|PATHWAY_REJECTED|PATHWAY_ACTIVE|MILESTONE",
      "subject": "stable label (reused if this thing changes later)",
      "content": "the fact or note",
      "source": "athlete_stated|ai_inferred",
      "confidence": 0-1,
      "importance": 1-5
    }
  ],
  "research_note": {
    "summary": "standalone facts useful for a different athlete asking the same question",
    "confidence": 0-1,
    "valid_days": 7-90
  },
  "profile_updates": {
    "name": null,
    "age": null,
    "dob": "YYYY-MM-DD or null",
    "occupation": null,
    "sport": null,
    "position": null,
    "secondary_position": null,
    "home_city": null,
    "home_country": null,
    "current_city": null,
    "current_country": null,
    "citizenship": null,
    "club": null,
    "previous_clubs": [{"name":"","from":"","to":"","level":""}],
    "grad_year": null,
    "gpa": null,
    "license": null,
    "looking_for_players": null,
    "education_level": null,
    "goal": null
  },
  "scout_context_updates": {
    "dream_outcome": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "target_level": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "target_country": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "timeline": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "perceived_strengths": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "perceived_weaknesses": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "main_gap": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "urgency": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "confidence": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "professional_interest": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "college_interest": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "trial_interest": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "secondary_goal": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "secondary_gaps": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "scholarship_interest": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "transfer_interest": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "exposure_need": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "budget": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1},
    "current_level": {"value": null, "source": "athlete_stated|ai_inferred", "confidence": 0-1}
  },
  "suggested_targets": [
    {
      "name": "program or school name",
      "reasoning": "one sentence tied to this athlete's profile"
    }
  ],
  "suggested_dev_items": [
    {
      "focus_area": "training|strength|speed|conditioning|recovery|sleep|hydration|nutrition|other",
      "goal": "specific development goal"
    }
  ],
  "suggested_pathway": {
    "pathway_type": "ncaa|naia|juco|canadian_university|academy|european_club|professional|development|agent_representation|trainer_performance|other",
    "target_timeline": "description",
    "milestones": [
      {
        "label": "milestone label",
        "done": false
      }
    ]
  },
  "drafted_email": "full email text if this reply IS a drafted outreach email, else null"
}

Only set fields that actually changed this reply. Use null for unchanged fields. memory_writes must always be present (empty array [] if nothing new). Everything else is optional and may be null or omitted.`;

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
    const headers = { apikey: serviceKey, Authorization: "Bearer " + serviceKey };
    const base = `${supaUrl}/rest/v1/plan_config?select=plan_id,plan_name,tagline,`;
    const tail = `,live_features&active=eq.true&order=display_order`;
    // Migration 120 renames plan_config.price_usd -> price_eur. Code and
    // migration never land in the same instant, and PostgREST rejects the
    // WHOLE select for one unknown column, so try the new name and fall back
    // to the old one. Same tolerance pattern as the goal_source select below.
    let r = await fetch(base + "price_eur" + tail, { headers });
    let priceKey = "price_eur";
    if (!r.ok) {
      console.warn("GOLSZ plan_config select failed (migration 120 not applied?) — retrying with price_usd.");
      r = await fetch(base + "price_usd" + tail, { headers });
      priceKey = "price_usd";
    }
    if (!r.ok) return planKnowledgeCache || "";
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return planKnowledgeCache || "";
    const text = rows.map((p) => `${p.plan_name} (\u20AC${p[priceKey]}/mo, "${p.tagline}"): ${(p.live_features || []).join("; ")}`).join("\n");
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
// capabilities raised 1400 -> 2600 after checking the REAL production rows:
// 19 capabilities overflowed 1400 and the manifest was being cut mid-list,
// which silently dropped whichever section came last. It lands in the CACHED
// system prefix, so the marginal cost is ~0.1x input on a few hundred tokens
// — far cheaper than Scout misdescribing what GOLSZ sells.
const RETRIEVAL_BUDGET = { capabilities: 2600, memory: 900, knowledge: 700, research: 900 };

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

// Two buckets: available / not available. Mirrors getPlanKnowledge()'s shape
// exactly (cache + fail-soft to the last good value, never throw into the
// request path). `notes` on an unavailable row carries the "never suggest
// this" instruction the admin wrote.
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
  ["recruiting_status", "recruiting status (their own Passport setting: Open to offers / In contact / Committed / Signed)"],
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
    const cols = "sport,position,secondary_position,foot,club_name,previous_clubs,recruiting_status,grad_year,education_level,height_cm,weight_kg,gpa,home_city,home_country,current_city,country,citizenship,dob,age_reported,age_reported_at,scout_context,bio";
    // profiles.dob is fetched alongside because DOB lives in TWO places and
    // only one of them is ever populated. Found 2026-08-09 auditing why
    // isAssessmentReady() reported nobody ready: date of birth is collected
    // from every athlete at signup and written to profiles.dob (10/13 rows
    // filled), but athletes.dob — added by a later migration, and the column
    // everything downstream actually read — was 0/13. Net effect: Scout has
    // never known any athlete's age, and resolveAge() has returned null for
    // everyone since the column split.
    //
    // Deliberately a READ-side join, not a copy into athletes.dob. Duplicating
    // the value would create two rows of record that can silently diverge,
    // which is the same class of bug being fixed here.
    const [aRes, mRes, pRes] = await Promise.all([
      fetch(`${supaUrl}/rest/v1/athletes?id=eq.${userId}&select=${cols}`, { headers }),
      fetch(`${supaUrl}/rest/v1/scout_memory?athlete_id=eq.${userId}&active=is.true&select=type,subject,content,confidence,source,importance,updated_at&order=importance.desc,updated_at.desc&limit=20`, { headers }),
      fetch(`${supaUrl}/rest/v1/profiles?id=eq.${userId}&select=dob`, { headers }),
    ]);
    const aRows = aRes.ok ? await aRes.json() : [];
    const mRows = mRes.ok ? await mRes.json() : [];
    const pRows = pRes.ok ? await pRes.json() : [];
    const profileDob = (Array.isArray(pRows) && pRows[0] && pRows[0].dob) || null;
    // profiles.dob WINS over athletes.dob: it is the date the athlete (or
    // their parent) typed at signup, and it is the value the minor /
    // parent-managed safeguarding logic already keys on. athletes.dob is only
    // ever written by model extraction from conversation (PROFILE_FIELD_MAP),
    // so letting a mis-heard date override a form-entered, safeguarding-
    // relevant one would be the wrong precedence. It stays as the fallback.
    const rawAthlete = Array.isArray(aRows) && aRows[0] ? aRows[0] : null;
    const athlete = rawAthlete
      ? { ...rawAthlete, dob: profileDob || rawAthlete.dob || null }
      : (profileDob ? { dob: profileDob } : null);
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
function renderAuthoritativeContext(ctx, goalText) {
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
  // The current goal, classified once and reused for both loops below.
  // Declared here because scout_context is rendered BEFORE memories and its
  // goal-shaped fields need the same treatment — dream_outcome lives here,
  // not in scout_memory, and it was the field actually saying "CPL
  // professional contract" while the athlete's written goal said NCAA.
  const currentGoalType = classifyGoalText(goalText);
  const superseded = [];
  for (const [k, v] of Object.entries(sc)) {
    if (!v || typeof v !== "object" || v.value === undefined || v.value === null || v.value === "") continue;
    if (k === "ai_meta") continue;
    const line = `- ${k.replace(/_/g, " ")}: ${typeof v.value === "object" ? JSON.stringify(v.value) : v.value}`;
    // Same rule as memories: a stored field that DECLARES a direction other
    // than the current goal is history, not a current fact. Anything the
    // classifier cannot read (height, budget, biggest gap) is untouched.
    const scType = typeof v.value === "string" ? classifyGoalText(`${k.replace(/_/g, " ")} ${v.value}`) : null;
    if (currentGoalType && scType && scType !== currentGoalType) { superseded.push(line); continue; }
    if (v.source === "athlete_stated") stated.push(line);
    else inferred.push(`${line}${typeof v.confidence === "number" ? ` (confidence ${v.confidence})` : ""}`);
  }
  // PRECEDENCE, ENFORCED AT RENDER TIME.
  //
  // A prompt rule saying "the live record outranks memory" was not enough.
  // Observed in production: the athlete's written goal read "earn an NCAA
  // Division 1 scholarship" and Scout kept advising toward CPL, because 35
  // memory rows all said CPL and one field said NCAA. Rank is a weak signal
  // when the volume is that lopsided.
  //
  // So a memory that disagrees with the CURRENT goal is no longer presented
  // as a peer fact — it is relabelled, in place, as history. It is never
  // deleted: "we looked at CPL before you switched" is genuinely useful
  // context and Scout should still be able to refer to it. It simply stops
  // being sayable as the athlete's present aim.
  //
  // Detection is deterministic and reuses the shipped classifier: a memory is
  // superseded only when its text points at a DIFFERENT pathway than the
  // current goal does. A memory the classifier cannot read, or one that
  // agrees, is left exactly as it was.
  for (const m of memories) {
    const memType = classifyGoalText(`${m.subject || ""} ${m.content || ""}`);
    const isSuperseded = !!(currentGoalType && memType && memType !== currentGoalType);
    if (isSuperseded) { superseded.push(`- [${m.type}] ${m.subject}: ${m.content}`); continue; }
    if (m.type === "UNKNOWN" || m.type === "NEXT_DATA_NEEDED") unknowns.push(`- ${m.subject}: ${m.content}`);
    else if (m.source === "athlete_stated") stated.push(`- [${m.type}] ${m.subject}: ${m.content}`);
    else inferred.push(`- [${m.type}] ${m.subject}: ${m.content} (confidence ${m.confidence})`);
  }

  let out = "AUTHORITATIVE ATHLETE STATE — this is the record, loaded from the database this turn. It OUTRANKS anything you infer from the wording of the latest message, and it outranks the PROFILE SO FAR text in the message body. Never contradict it, never re-ask anything it already answers.";
  out += facts.length ? `\n\nVERIFIED PROFILE (highest authority):\n${facts.join("\n")}` : "\n\nVERIFIED PROFILE: nothing on file yet.";
  // The athlete's own Passport bio — free text in their own words, capped at
  // 600 chars client-side. Rendered as its own paragraph rather than folded
  // into the bullet facts above: it is prose self-description (how they'd
  // introduce themselves), not a discrete fact, and deserves to be read that
  // way rather than mined for individual data points.
  if (athlete && athlete.bio && athlete.bio.trim()) {
    out += `\n\nTHEIR OWN PASSPORT BIO (in their own words — read for who they are, not just facts to extract):\n"${athlete.bio.trim().slice(0, 600)}"`;
  }
  if (stated.length) out += `\n\nTHINGS THE ATHLETE HAS STATED (confirmed — treat as fact, never re-ask):\n${stated.join("\n")}`;
  if (inferred.length) out += `\n\nYOUR EARLIER INFERENCES (NOT facts — never assert these back as things they told you; confirm in passing if one matters):\n${inferred.join("\n")}`;
  if (unknowns.length) out += `\n\nKNOWN UNKNOWNS (ask about these before anything generic):\n${unknowns.join("\n")}`;
  if (superseded.length) {
    out += `\n\nHISTORY — SUPERSEDED BY THEIR CURRENT GOAL (this is NOT what they are aiming at now):\n${superseded.join("\n")}\n`;
    out += `Their goal now reads "${String(goalText).slice(0, 160)}". Everything in this section was true EARLIER and is now out of date, however many entries there are and however confident they sound — volume is not authority. You may refer to it as history ("when we were looking at that route..."), and you should, because the reasoning still matters. What you must not do is treat any of it as their present aim. Every diagnosis, every piece of advice, every next step and every plan recommendation in this reply must serve the goal quoted above. Do not ask them to re-confirm the change, do not hedge between the two, and do not describe their current goal as a "mismatch" with these entries — the entries are simply older. Only an explicit new statement from them changes direction again.`;
  }
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
  if (!url || !key || !userId) return { plan: "unknown", isAdmin: false, aiUnlimited: false, goalDefined: false, goalText: null, goalSource: null };
  const headers = { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" };
  let plan = "starter";
  let isAdmin = false;
  let aiUnlimited = false;
  let goalDefined = false;
  let goalText = null;
  let goalSource = null;
  try {
    // goal_source arrives with migration 113. Migrations here are applied by
    // hand, so this code can be live before the column exists — and PostgREST
    // rejects the ENTIRE select for one unknown column, which would drop
    // `plan` too and silently meter an Elite athlete as Starter. Retry
    // without it rather than losing the whole row.
    let p = await fetch(url + "/rest/v1/profiles?id=eq." + userId + "&select=plan,is_admin,ai_unlimited,goal_defined,goal_text,goal_source", { headers });
    if (!p.ok) {
      console.warn("GOLSZ profile select failed (migration 113 not applied?) — retrying without goal_source.");
      p = await fetch(url + "/rest/v1/profiles?id=eq." + userId + "&select=plan,is_admin,ai_unlimited,goal_defined,goal_text", { headers });
    }
    const rows = await p.json();
    if (Array.isArray(rows) && rows[0]) {
      plan = rows[0].plan || "starter";
      isAdmin = !!rows[0].is_admin;
      aiUnlimited = !!rows[0].ai_unlimited;
      goalDefined = !!rows[0].goal_defined;
      goalText = rows[0].goal_text || null;
      goalSource = rows[0].goal_source || null;
    }
  } catch {}
  return { plan, isAdmin, aiUnlimited, goalDefined, goalText, goalSource };
}

// GOLSZ Final Product / AI Scout / Pathway / Elite Architecture directive
// §11 "database-first state logic — do not ask the LLM to infer product
// state." profile_complete mirrors the exact same minimal heuristic the
// client already gates the whole app behind (golsz-app.html: "!!(athlete
// && athlete.sport)") — kept identical on purpose so the app and Scout
// never disagree about whether onboarding is done. pathway_created/
// baseline_complete come from a real pathway_plan row (migration 093);
// no row at all means both are false.
//
// LIVE PRODUCT STATE, NOT REMEMBERED STATE (2026-08-10).
// This used to select ONE column from pathway_plan (baseline_complete), so
// the only thing Scout ever knew about the athlete's Plan was that a row
// existed. It could not see pathway_type, milestones, targets, development
// items or a single benchmark. In production that produced exactly the
// failure you would predict: an athlete whose goal read "play for a top
// European club" had pathway_type='juco' on screen, asked Scout to correct
// it, and Scout answered "I can't change what's listed on your Plan" —
// because it had genuinely never seen the word JUCO.
//
// Anything that exists as structured live product data is now READ, not
// recalled from scout_memory. Memory is for things the athlete SAID; this
// is for what the product actually holds. When the two disagree the record
// wins, and Scout is told so explicitly.
//
// Five small parallel queries (one round of Promise.all, not serial), run
// alongside getProfileMeta() at the call site, so this does not add real
// latency per message. Every one fails soft: a table that errors returns
// its empty value and Scout simply knows less, never breaks.
async function getAthleteState(userId) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !userId) return { profileComplete: false, pathwayCreated: false, baselineComplete: false, sportSupportLevel: null, sport: null, country: null, structuredSportKnowledge: false, pathwayType: null, pathwayTimeline: null, milestoneCount: 0, milestonesDone: 0, pathwayComplete: false, devItems: [], targets: [], benchmarks: [], readiness: null, questionsUsedToday: 0 };
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
  let pathwayType = null;
  let pathwayTimeline = null;
  let milestones = [];
  let devItems = [];
  let targets = [];
  let benchmarks = [];
  // Readiness inputs. These are the UNTRUNCATED rows the score is computed
  // from, kept separate from the capped prompt-facing lists above: a score
  // derived from the first 8 development items is a different (wrong) score.
  let athleteRow = null;
  let profileRow = null;
  let allDevItems = [];
  let allBenchmarks = [];
  let targetsCount = 0;
  let hasPendingVerification = false;
  let pathwayRow = null;
  let questionsUsedToday = 0;
  try {
    // Selects every field computeProfileQuality() checks — the same list
    // HomeTab fetches, so the two cannot score different things.
    const a = await fetch(url + "/rest/v1/athletes?id=eq." + userId + "&select=sport,country,position,club_name,grad_year,recruiting_status,bio,highlights,timeline", { headers });
    const aRows = await a.json();
    athleteRow = Array.isArray(aRows) && aRows[0] ? aRows[0] : null;
    sport = athleteRow ? athleteRow.sport : null;
    country = athleteRow ? athleteRow.country : null;
    profileComplete = !!sport;
  } catch {}
  try {
    const pr = await fetch(url + "/rest/v1/profiles?id=eq." + userId + "&select=occupation,avatar_url,identity_verified", { headers });
    const prRows = await pr.json();
    profileRow = Array.isArray(prRows) && prRows[0] ? prRows[0] : null;
  } catch {}
  // Newest request only, matching HomeTab: a previously denied request must
  // not keep scoring 50 forever.
  // Today's Scout usage. The ONLY thing that genuinely separates Elite from
  // Pro is daily message volume — no feature in FEATURE_MIN_PLAN requires
  // Elite — so an athlete actually running out of messages is the one
  // honest Pro->Elite trigger. Read here rather than inferred, and it stays
  // 0 on any failure so a metering hiccup can never invent a reason to sell.
  try {
    const today = new Date().toISOString().slice(0, 10);
    const u = await fetch(url + "/rest/v1/scout_daily_usage?user_id=eq." + userId + "&usage_date=eq." + today + "&select=questions_used", { headers });
    const uRows = await u.json();
    questionsUsedToday = (Array.isArray(uRows) && uRows[0] && Number(uRows[0].questions_used)) || 0;
  } catch {}
  try {
    const v = await fetch(url + "/rest/v1/verification_requests?user_id=eq." + userId + "&select=status&order=created_at.desc&limit=1", { headers });
    const vRows = await v.json();
    hasPendingVerification = !!(Array.isArray(vRows) && vRows[0] && vRows[0].status === "pending");
  } catch {}
  // The Plan, in full. milestones is jsonb; each entry is {label, done}.
  try {
    const p = await fetch(url + "/rest/v1/pathway_plan?user_id=eq." + userId + "&select=pathway_type,target_timeline,milestones,baseline_complete", { headers });
    const pRows = await p.json();
    if (Array.isArray(pRows) && pRows[0]) {
      pathwayRow = pRows[0];
      pathwayCreated = true;
      baselineComplete = !!pRows[0].baseline_complete;
      pathwayType = pRows[0].pathway_type || null;
      pathwayTimeline = pRows[0].target_timeline || null;
      milestones = Array.isArray(pRows[0].milestones) ? pRows[0].milestones : [];
    }
  } catch {}
  // Development plan, target list and Passport benchmarks. Capped hard —
  // these feed a prompt, not a report, and an athlete with 200 benchmarks
  // must not blow the context budget.
  //
  // Two consumers, two shapes, ONE fetch. The readiness score needs every
  // row (a "30% done" computed over a truncated page is simply a wrong
  // number, and it would disagree with Home); the prompt needs a short list.
  // So each query pulls the full set and the capped slice is taken after.
  // 500 is a ceiling against a pathological account, not a page size.
  try {
    const d = await fetch(url + "/rest/v1/development_plan_items?user_id=eq." + userId + "&select=focus_area,goal,status&order=created_at.desc&limit=500", { headers });
    const dRows = await d.json();
    if (Array.isArray(dRows)) { allDevItems = dRows; devItems = dRows.slice(0, 8); }
  } catch {}
  try {
    const t = await fetch(url + "/rest/v1/outreach_targets?user_id=eq." + userId + "&select=name,status&order=created_at.desc&limit=500", { headers });
    const tRows = await t.json();
    if (Array.isArray(tRows)) { targetsCount = tRows.length; targets = tRows.slice(0, 10); }
  } catch {}
  // Passport performance data. Newest first, then de-duplicated per metric
  // below so Scout sees each metric's CURRENT value rather than a history —
  // "your 10m is 2.0s" must reflect the latest retest, not the first entry.
  try {
    const b = await fetch(url + "/rest/v1/athlete_benchmarks?user_id=eq." + userId + "&select=metric,value,unit,recorded_date&order=recorded_date.desc&limit=500", { headers });
    const bRows = await b.json();
    if (Array.isArray(bRows)) {
      // Full history feeds the performance sub-score, which counts metrics
      // RETESTED (>= 2 entries) — de-duplicating first would zero that out.
      allBenchmarks = bRows;
      const seen = new Set();
      for (const row of bRows) {
        if (!row || !row.metric || seen.has(row.metric)) continue;
        seen.add(row.metric);
        benchmarks.push(row);
        if (benchmarks.length >= 12) break;
      }
    }
  } catch {}
  // Soft name lookup (not a foreign key — see migration 094) so an
  // athlete's free-text sport that doesn't match a seeded row just comes
  // back null, read as "secondary" by Scout, never an error.
  if (sport) {
    try {
      const s = await fetch(url + "/rest/v1/sports?name=ilike." + encodeURIComponent(sport) + "&select=support_level", { headers });
      const sRows = await s.json();
      const declared = Array.isArray(sRows) && sRows[0] ? sRows[0].support_level : "secondary";
      sportSupportLevel = resolveSportSupportLevel(sport, declared);
    } catch { sportSupportLevel = resolveSportSupportLevel(sport, "secondary"); }
  }
  const milestoneCount = milestones.length;
  const milestonesDone = milestones.filter((m) => m && m.done).length;
  // The app's own diagnosis, computed from the same rows Home uses and by
  // the same functions. Scout is handed the RESULT, not the ingredients, so
  // it reports the athlete's score rather than forming a second opinion.
  // Fails soft to null: an athlete with no athletes row still gets a reply.
  let readiness = null;
  try {
    readiness = computeReadiness({
      athlete: athleteRow,
      profile: profileRow,
      benchmarks: allBenchmarks,
      devItems: allDevItems,
      pathway: pathwayRow,
      targetsCount,
      identityVerified: profileRow ? profileRow.identity_verified : false,
      hasPendingVerification,
    });
  } catch (e) { console.error("GOLSZ readiness compute failed:", e && e.message); }
  return {
    profileComplete, pathwayCreated, baselineComplete, sportSupportLevel, sport, country,
    structuredSportKnowledge: hasStructuredSportKnowledge(sport),
    pathwayType, pathwayTimeline, milestoneCount, milestonesDone,
    // D — a Pathway with no milestones is a shell, not a Pathway. One flag,
    // computed once here, so Home, Plan and Scout cannot disagree about it.
    pathwayComplete: pathwayCreated && milestoneCount > 0,
    devItems, targets, benchmarks, targetsCount, readiness, questionsUsedToday,
  };
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
  // 2 — everything finalizeSuggestedPathway() needs to guarantee an approved
  // Plan reaches the Plan tab. Populated once below, after the goal/pathway
  // reconciliation has settled pathwayType, and read by all four response
  // paths. Stays null when there is no athlete state to reason about.
  let pathwayBuildCtx = null;
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
  // Declared out here, NOT inside the `if (process.env.SUPABASE_URL)` block
  // that assigns it — it's read further down by persistAiMeta() and the
  // ATHLETE STATE block. A const/let scoped to that if-block and read
  // outside it is precisely the 2026-08-08 `storedAssessment` outage
  // (node --check passes; the ReferenceError only appears at runtime, after
  // the model has already been billed). Defaults to a not-ready shape so
  // every downstream reader is safe when there is no signed-in athlete.
  let assessmentReady = { sufficient_for_preliminary_assessment: false, missing_critical: [], missing_useful: [], confidence: "low" };
  // Same hoisting reason as assessmentReady above. The goal safety net runs at
  // the three persist sites, which sit OUTSIDE the `if (SUPABASE_URL)` block
  // where getProfileMeta()'s destructured goalText is scoped — reading that
  // binding down there is a ReferenceError, not a syntax error, so
  // node --check would pass and it would only fail in production.
  let currentGoalText = null;
  // Who authored that goal (migration 113). Hoisted for the identical reason
  // as currentGoalText above — the persist sites are outside the block where
  // getProfileMeta()'s destructuring is scoped.
  let currentGoalSource = null;
  // The athlete's ALREADY-STORED scout_context, hoisted for the same reason.
  // The goal safety net has to read this, not just the incoming updates: the
  // model won't re-send a dream_outcome it has already recorded ("don't repeat
  // known fields"), which is the very mechanism that stranded goal_text empty
  // in the first place. Watching only the incoming payload made the net
  // structurally unable to fire for exactly the athletes it exists to rescue.
  let storedScoutContext = null;
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
  let cacheFingerprint = null; // athlete state the response cache must key on
  if (process.env.SUPABASE_URL) {
    // The athlete this conversation is ABOUT — normally the caller, or a
    // linked under-16 child when a parent is managing them. body.athleteId is
    // a request, never a grant: resolveActingAthlete re-derives the caller
    // from the token and requires an APPROVED parent_links row before it
    // returns anything other than the caller's own id. A rejected request is
    // a 403 and nothing else runs, so an unrelated child's data is never
    // read, never sent to a model, and never written.
    const acting = await resolveActingAthlete(
      req.headers.authorization,
      body && typeof body.athleteId === "string" ? body.athleteId : null,
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
    );
    if (!acting.ok && acting.reason === "unauthenticated") {
      return res.status(401).json({ error: "Sign in to use the Scout." });
    }
    if (!acting.ok) {
      console.warn("GOLSZ acting-for REJECTED:", JSON.stringify({ caller: acting.callerId, reason: acting.reason }));
      return res.status(403).json({ error: "You don't have access to that athlete." });
    }
    userId = acting.athleteId;
    // Metering, burst protection and duplicate detection stay keyed to the
    // ATHLETE, not the parent: a child's daily Scout allowance is the child's,
    // and a parent managing two athletes should get each one's full allowance
    // rather than one shared pool.
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
    const [{ plan, isAdmin, aiUnlimited, goalDefined, goalText, goalSource }, athleteState, planKnowledge, authContext, capabilityKnowledge] = await Promise.all([
      getProfileMeta(userId),
      getAthleteState(userId),
      getPlanKnowledge(),
      buildAuthoritativeContext(userId),
      getCapabilityKnowledge(),
    ]);
    // Rendered once, here, and reused verbatim by every downstream path so no
    // model can receive a materially different version of the athlete's facts.
    authoritativeBlock = renderAuthoritativeContext(authContext, goalText);
    // THE canonical readiness signal, computed once here off the same
    // authContext every downstream path already uses. Read by the recap
    // instruction in ATHLETE STATE below AND persisted into ai_meta so the
    // client's free->paid conversion moment reads this exact value instead
    // of its own weaker profile_complete test.
    currentGoalText = goalText;
    currentGoalSource = goalSource;
    storedScoutContext = (authContext && authContext.athlete && authContext.athlete.scout_context) || null;
    assessmentReady = isAssessmentReady({ athlete: authContext && authContext.athlete, goalText });
    hasConflicts = !!(authContext && authContext.conflicts && authContext.conflicts.length);
    if (authContext && authContext.athlete) {
      const a = authContext.athlete;
      athleteHome = a.home_city || a.home_country || null;
      athleteHere = a.current_city || a.country || null;
    }
    athleteSport = athleteState.sport;
    athleteCountry = athleteState.country;
    stateDigest = athleteStateDigest(athleteState, plan, goalDefined);
    cacheFingerprint = responseCacheFingerprint(plan, goalText, athleteState);
    userPlan = plan;
    userIsAdmin = isAdmin;
    userAiUnlimited = aiUnlimited;
    // Directive §11 "database-first state logic" — profile_complete/
    // goal_defined/plan/pathway_created/baseline_complete, all real data, not
    // model self-report. The FULLER state machine (target/outreach/followup/
    // benchmark due-ness) is deliberately NOT computed here — it needs
    // several more table scans that matter for a dashboard nudge but not for
    // every single chat message, and the client already has that data loaded
    // for Home's own cards (see golsz-app.html computeNextMove()). Scout
    // narrates around this; it never decides it — see computeNextMove()
    // comment.
    // A/B/D — the athlete's LIVE record, read from the product's own tables
    // every message. Everything below is current state, not recollection:
    // if it disagrees with SCOUT MEMORY, this wins.
    const recon = reconcileGoalWithPathway(goalText, athleteState.pathwayType, athleteState.milestoneCount);
    // Safe deterministic correction: unambiguous goal + empty pathway. The
    // athlete's written goal is untouched; only the derived label moves.
    if (recon.safeAutoFix && recon.derived) {
      const fixed = await autoFixPathwayType(userId, recon.derived);
      if (fixed) athleteState.pathwayType = recon.derived;
    }
    // Captured AFTER the reconciliation so a Plan built from here uses the
    // corrected category, not the stale one. recon.derived covers the case
    // where the conflict was left standing for the athlete to resolve but
    // they have now said "yes, rebuild it".
    pathwayBuildCtx = {
      plan,
      goalDefined,
      goalText,
      pathwayType: athleteState.pathwayType || recon.derived || null,
      readiness: athleteState.readiness,
    };
    athleteBlock = `\n\nATHLETE STATE (app-computed from real data, not your own inference — ground your guidance in this, never contradict it or claim a different plan/stage): profile_complete=${athleteState.profileComplete}, goal_defined=${goalDefined}${goalText ? ` ("${goalText.slice(0, 200)}")` : ""}, plan=${plan}, pathway_created=${athleteState.pathwayCreated}, baseline_complete=${athleteState.baselineComplete}, sport_support_level=${athleteState.sportSupportLevel || "unknown"}, golsz_structured_sport_knowledge=${athleteState.structuredSportKnowledge ? "yes" : "no"}, goal_authored_by_athlete=${goalSource === "athlete_edited" ? "yes" : "no"}, assessment_ready=${assessmentReady.sufficient_for_preliminary_assessment}${assessmentReady.missing_critical.length ? `, still_missing=${assessmentReady.missing_critical.join("/")}` : ""}.`;

    // THEIR PLAN — the actual contents of the Plan tab. Scout used to see
    // only pathway_created=true here and was therefore unable to answer
    // "fix what my plan says".
    athleteBlock += `\n\nTHEIR PLAN (the Plan tab, live): pathway_type=${athleteState.pathwayType || "none"}, target_timeline=${athleteState.pathwayTimeline || "none"}, milestones=${athleteState.milestonesDone}/${athleteState.milestoneCount} done, pathway_complete=${athleteState.pathwayComplete ? "yes" : "no"}.`;
    if (athleteState.pathwayCreated && !athleteState.pathwayComplete) {
      athleteBlock += ` This Pathway has NO milestones — it is a shell, not a finished Pathway. Do not describe it as built, done or in place. Offer to fill it in.`;
    }
    if (recon.conflict) {
      athleteBlock += `\n\nPATHWAY CONFLICTS WITH THEIR GOAL: their written goal reads "${String(goalText).slice(0, 160)}", which points at ${recon.derived}, but the Pathway on file is set to ${recon.storedType} and already has ${athleteState.milestoneCount} milestone(s) in it. Raise this plainly, say which two things disagree, and ask whether they want the Pathway rebuilt around ${recon.derived}. Their written goal is theirs — never propose changing the wording of it to match the Pathway; propose changing the Pathway to match the goal.`;
    }
    if (recon.safeAutoFix && recon.derived) {
      athleteBlock += ` (Their Pathway category was just corrected to ${recon.derived} to match their stated goal — it held no milestones, so nothing of theirs was overwritten. Mention it in one short clause if it is relevant; do not make a announcement of it.)`;
    }

    // THEIR PASSPORT / DEVELOPMENT / TARGETS — structured live data. Scout
    // must read these rather than recall them from memory, so a benchmark
    // edited in the Passport is visible on the very next message.
    if (athleteState.benchmarks && athleteState.benchmarks.length) {
      athleteBlock += `\n\nTHEIR BENCHMARKS (Passport, current value per metric — newer retests already replace older ones): ${athleteState.benchmarks.map((b) => `${b.metric} ${b.value}${b.unit ? b.unit : ""}${b.recorded_date ? ` (${String(b.recorded_date).slice(0, 10)})` : ""}`).join("; ")}. These are the record. If your memory of a number disagrees with this list, this list is right.`;
    }
    if (athleteState.devItems && athleteState.devItems.length) {
      athleteBlock += `\n\nTHEIR DEVELOPMENT PLAN (live): ${athleteState.devItems.map((d) => `${d.focus_area}${d.goal ? ` — ${d.goal}` : ""}${d.status ? ` [${d.status}]` : ""}`).join("; ")}. Never re-suggest an item already on this list.`;
    }
    if (athleteState.targets && athleteState.targets.length) {
      athleteBlock += `\n\nTHEIR TARGET LIST (live): ${athleteState.targets.map((t) => `${t.name}${t.status ? ` [${t.status}]` : ""}`).join("; ")}. Never re-suggest a target already on this list.`;
    }

    // 1 — THE APP'S OWN DIAGNOSIS. Before this, Home computed five readiness
    // sub-scores and Scout computed a separate prose opinion, with nothing
    // reconciling them: an athlete could read "Performance 40" on Home and be
    // told something else by Scout in the same minute. api/_readiness.js is
    // now the single implementation and this hands Scout the RESULT, so the
    // diagnosis is reported rather than re-formed.
    const rd = athleteState.readiness;
    if (rd) {
      const dims = PASSPORT_STRENGTH_DIMENSIONS.map((d) => `${DIMENSION_LABEL[d]} ${rd.subScores[d]}`).join(", ");
      athleteBlock += `\n\nTHEIR PASSPORT STRENGTH (the exact figures on their Home screen right now — computed by the app, not by you): overall ${rd.composite} out of 100. ${dims}. Weakest area: ${DIMENSION_LABEL[rd.weakest]}.`;
      if (rd.quality && rd.quality.missing && rd.quality.missing.length) {
        athleteBlock += ` Still missing from their Passport: ${rd.quality.missing.join(", ")}.`;
      }
      athleteBlock += ` Supporting counts: ${rd.performance.metricsTracked} benchmark metric(s) tracked and ${rd.performance.metricsRetested} retested; ${rd.development.done}/${rd.development.total} development items done; ${rd.pathway.milestonesDone}/${rd.pathway.milestonesTotal} milestones done; ${rd.pathway.targetsCount} target(s); identity ${rd.verification.status}.`;
      athleteBlock += ` These numbers are authoritative. Never state a score that is not in this block, never invent a sixth category, and never describe their Passport in a way that contradicts these figures. When you talk about the weakest area, use the plain-language name above and say what would actually raise it.`;
    }

    // 3 — PRECEDENCE. Scout was observed telling an athlete "your goal on
    // file is CPL professional contract" while the goal they had actually
    // written read "a top European club": 35 memory rows outvoted one live
    // field. Memory is continuity, not authority, and the order is explicit
    // rather than left to the model to intuit.
    athleteBlock += `\n\nWHEN SOURCES DISAGREE, THIS IS THE ORDER OF AUTHORITY — highest first, and it is not negotiable:
1. What the athlete has written themselves (their goal wording above when goal_authored_by_athlete=yes). Highest authority. Never overwrite it, never restate it as something else, never treat an older version of it as still current.
2. Their live record in the blocks above — Passport, Plan, benchmarks, development items, targets, Passport Strength. This is what the product actually holds right now.
3. Something they told you earlier in THIS conversation.
4. SCOUT MEMORY from previous conversations. Lowest authority.
A newer source always beats an older one at the same level. If memory says one thing and the live record above says another, the live record is right and the memory is stale — follow the record silently and do not argue with yourself out loud or announce that your notes were out of date. If the athlete's written goal has changed since you last spoke, the new wording is the goal; do not keep advising toward the old one.`;

    // 4 + 5 / RECOMMEND — the entitlement answer is COMPUTED here from
    // api/_entitlements.js (the same mapping golsz-app.html gates the UI on)
    // rather than inferred by the model from a prose capabilities list. Two
    // things this fixes: Scout can no longer name a tier the UI does not
    // actually enforce, and it can no longer reach for the most expensive
    // plan — lowestPlanUnlocking() returns the cheapest tier that covers the
    // identified gaps, and the prompt is told that ceiling explicitly.
    const entNeeds = deriveEntitlementNeeds(athleteState);
    const ent = evaluateEntitlements(plan, entNeeds);
    const volume = deriveVolumeNeed(plan, athleteState.questionsUsedToday, planDailyLimit(plan));
    // SAFEGUARD: they have already said no. Nothing about plans reaches the
    // model for the rest of this conversation.
    const declined = athleteDeclinedUpgrade(messages);
    if (declined) {
      athleteBlock += `\n\nPLAN FIT: they have already told you they do not want to upgrade, or cannot. Do not mention plans, pricing, upgrading or locked features again in this conversation, in any form, however the topic comes up. Help them with what they have. If they raise it themselves, answer plainly and briefly and move on.`;
    } else if (ent.locked.length && ent.upgradeToName) {
      athleteBlock += `\n\nPLAN FIT (computed by the app — do not do this arithmetic yourself): they are on ${ent.currentPlanName}.`;
      if (ent.coveredLabels.length) athleteBlock += ` Already included on their plan: ${ent.coveredLabels.join("; ")}.`;
      athleteBlock += ` NOT included on their plan, and their current situation points at it: ${ent.lockedLabels.join("; ")}. The lowest plan that covers all of that is ${ent.upgradeToName}.`;
      athleteBlock += ` ${ent.upgradeToName} is the ONLY plan you may name. Never name a more expensive one, never imply a more expensive one would be better, and never list tiers. Raise it at most once, only after you have actually answered them, and only if what they raised genuinely needs one of those items — if this reply is about something else, say nothing about plans at all.`;
    } else {
      athleteBlock += `\n\nPLAN FIT (computed by the app): they are on ${ent.currentPlanName} and nothing their current situation needs is locked. Do not mention plans, pricing or upgrading in this reply at all.`;
      // Volume is the one honest reason to raise a tier when no feature is
      // locked — and the only route to Elite, which gates no feature at all.
      if (volume.pressured && volume.nextPlan) {
        athleteBlock += ` One exception: they have used ${volume.used} of their ${volume.limit} Scout messages today. If — and only if — that limit is actually getting in their way right now, you may note once that ${planDisplayName(volume.nextPlan)} raises it. Never raise it otherwise.`;
      }
    }
    // Names the exact contradiction that caused goal_text to sit empty for
    // every athlete: a goal recorded ONLY as dream_outcome renders under
    // "THINGS THE ATHLETE HAS STATED (confirmed — never re-ask)" while
    // goal_defined stays false, so the model saw the goal as both already
    // known and not needing writing. Surfacing the mismatch turns an invisible
    // conflict into a specific instruction.
    if (!goalDefined && authContext && authContext.athlete) {
      const dream = authContext.athlete.scout_context && authContext.athlete.scout_context.dream_outcome;
      const dreamVal = dream && typeof dream === "object" ? dream.value : dream;
      if (dreamVal) {
        athleteBlock += `\n\nGOAL NOT YET ON RECORD: you have previously noted their aim as "${String(dreamVal).slice(0, 200)}", but it has never been written to their Passport, so goal_defined is still false and no Pathway can be built. Confirm it back to them in one short sentence ("so the goal is X — right?") and, the moment they confirm or restate it, send it as profile_updates.goal. Do not treat it as already recorded, and do not silently assume it.`;
      }
    }
    // Directive §10 "database is the source of truth, never hard-code
    // aspirational features into prompts as if live" — real, current plan
    // facts, not whatever this file's own hardcoded copy happens to say.
    if (planKnowledge) sharedBlock += `\n\nGOLSZ PLANS (real, current — never invent a feature, price, or restriction beyond this list):\n${planKnowledge}`;
    // Retrieved BEFORE the model reasons, so Scout opens already knowing this
    // athlete instead of rediscovering them. Both are omitted entirely when
    // empty rather than sent as an empty heading — a new athlete with no
    // memory yet should get no MEMORY section at all, not one saying "none".
    if (authoritativeBlock) athleteBlock += `\n\n${authoritativeBlock}`;
    // SPORT_SCHEMA V1. Appended only when GOLSZ genuinely has a schema for
    // this athlete's sport — an unrecognised sport yields "" and Scout keeps
    // its existing honest "no built-out data for your sport" behaviour rather
    // than receiving an empty scaffold that looks like knowledge.
    // Goal type is derived from the athlete's own stated goal via the same
    // conservative classifier the readiness layer uses; an ambiguous goal
    // yields null and Scout is shown every pathway the sport supports instead
    // of one picked for them.
    const sportContext = renderSportContext(
      athleteState.sport,
      authContext && authContext.athlete ? authContext.athlete.position : null,
      classifyGoalText(goalText),
    );
    if (sportContext) athleteBlock += `\n\n${sportContext}`;
    if (capabilityKnowledge) sharedBlock += `\n\nGOLSZ CAPABILITIES (real, current — the product does exactly this and nothing more):\n${capabilityKnowledge}`;
    // Scout's own running note on the conversation. Labelled explicitly
    // because it used to be pasted into the USER message by the client, so
    // the model read it as something the athlete had just said — and in
    // production replied "that summary doesn't match what we've actually
    // discussed", arguing with a message nobody sent.
    // Gated on there BEING carried-forward context, which is exactly when a
    // stale goal can survive. On the first message of a conversation there
    // is no note to go stale and ATHLETE STATE above already says all of it.
    if (priorSummaryForPrompt) {
      athleteBlock += `\n\n${composeStructuredSummary({
        goalText, goalSource, athleteState,
        narrative: clampBlock(priorSummaryForPrompt, 700),
        entLocked: ent.lockedLabels, entUpgradeName: ent.upgradeToName,
      })}`;
    }

    dailyLimit = planDailyLimit(plan);

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
    await persistAiMeta(userId, classification, assessmentReady);
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
      cacheKey = cacheKeyFor(classification.intent, latestText, faqLang, modelTier, cacheFingerprint);
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
        const scoutContextUpdates = extractScoutContextUpdates(data);
        const profileUpdates = applyGoalAuthorship(applyGoalSafetyNet(extractProfileUpdates(data), scoutContextUpdates, currentGoalText, storedScoutContext), currentGoalText, currentGoalSource);
        await logRouting("haiku", classification, tierConfig.model_name, data.usage, { plan: userPlan, ...countServerTools(data), specialist: recommendedSpecialist, requestId, responseTimeMs: Date.now() - handlerStartMs, timeoutReason, fallbackUsed });
        await recordScoutUsageCost(userId, cost, data.usage && data.usage.input_tokens, data.usage && data.usage.output_tokens);
        await persistProfileUpdates(userId, profileUpdates);
        await persistScoutContext(userId, scoutContextUpdates);
        await persistMemoryWrites(userId, extractMemoryWrites(data));
        // Keyed by requestId so a client-side timeout retry can recover this
        // exact reply rather than re-asking the athlete (and re-charging them).
        // Short TTL: this is crash recovery, not a semantic cache.
        if (requestId) await setCachedResponse(`req:${requestId}`, "replay", "n/a", data);
        data.reply_text = softenQuestionStreak(deriveReplyText(data), conversationForModel);
    data.scout_summary = updatedSummary;
        if (reservedQuestion) data.scout_usage = { remaining: questionsRemaining, limit: dailyLimit };
        // next_move is THIS request's own classification result, not a fact
        // about the shared cached answer — attached only after
        // setCachedResponse's JSON.stringify has already run (synchronously,
        // before its first await), so a personalized next-move suggestion
        // never gets baked into what a different user sees on a future cache
        // hit for the same generic simple_knowledge answer.
        if (cacheKey && !profileUpdates && !scoutContextUpdates && !replyIsPlanSpecific(data)) await setCachedResponse(cacheKey, classification.intent, modelTier, data);
        data.next_move = extractNextBestAction(classification);
        // Same cache-safety ordering as next_move above — these are
        // this-athlete-specific suggestions, attached only after the cache
        // write already happened.
        data.suggested_targets = extractSuggestedTargets(data);
        data.suggested_dev_items = extractSuggestedDevItems(data);
        { const pw = finalizeSuggestedPathway(data, pathwayBuildCtx, incomingText, userPlan); data.suggested_pathway = pw.pathway; data.suggested_pathway_source = pw.source; }
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
        await logRouting("haiku", classification, fastCfg.model_name, data.usage, { plan: userPlan, ...countServerTools(data), escalationReason: "sonnet_provider_failure", specialist: recommendedSpecialist, requestId, responseTimeMs: Date.now() - handlerStartMs, timeoutReason, fallbackUsed });
        await recordScoutUsageCost(userId, cost, data.usage && data.usage.input_tokens, data.usage && data.usage.output_tokens);
        await persistProfileUpdates(userId, applyGoalAuthorship(applyGoalSafetyNet(extractProfileUpdates(data), extractScoutContextUpdates(data), currentGoalText, storedScoutContext), currentGoalText, currentGoalSource));
        await persistScoutContext(userId, extractScoutContextUpdates(data));
        await persistMemoryWrites(userId, extractMemoryWrites(data));
        // Keyed by requestId so a client-side timeout retry can recover this
        // exact reply rather than re-asking the athlete (and re-charging them).
        // Short TTL: this is crash recovery, not a semantic cache.
        if (requestId) await setCachedResponse(`req:${requestId}`, "replay", "n/a", data);
        data.reply_text = softenQuestionStreak(deriveReplyText(data), conversationForModel);
    data.scout_summary = updatedSummary;
        if (reservedQuestion) data.scout_usage = { remaining: questionsRemaining, limit: dailyLimit };
        data.next_move = extractNextBestAction(classification);
        data.suggested_targets = extractSuggestedTargets(data);
        data.suggested_dev_items = extractSuggestedDevItems(data);
        { const pw = finalizeSuggestedPathway(data, pathwayBuildCtx, incomingText, userPlan); data.suggested_pathway = pw.pathway; data.suggested_pathway_source = pw.source; }
        data.drafted_email = extractDraftedEmail(data);
        // Deliberately never cached — a degraded, apologetic reply shouldn't
        // get served back to a different athlete once things recover.
        return res.status(200).json(data);
      }

      // Automatic failover, step 3: CROSS-PROVIDER. Steps 1 and 2 are both
      // Anthropic, so an Anthropic-wide outage exhausts them together and
      // Scout used to go dark entirely — the exact single-provider dependency
      // Non-Negotiable #2 forbids. This is the only step that survives that.
      //
      // Inert unless SCOUT_FALLBACK_API_KEY is set: with no key configured
      // this block is skipped and behaviour is byte-identical to before.
      const fb = fallbackProviderConfig();
      if (fb) {
        console.log("GOLSZ both Anthropic models failed, trying cross-provider fallback:", fb.provider, fb.model);
        try {
          const crossProvider = await adapterFor(fb.provider).generate({
            apiKey: fb.apiKey,
            model: fb.model,
            system: systemStatic,
            // Same degraded-mode notice the Haiku fallback uses, so a
            // different provider can never imply it ran a search either.
            systemDynamic: fallbackSystem,
            messages: conversationForModel,
            maxTokens: fb.maxOutputTokens,
          });
          if (crossProvider.ok) {
            const data = crossProvider.data;
            fallbackUsed = "cross_provider";
            console.log("GOLSZ scout usage check (cross-provider):", JSON.stringify(data.usage));
            // Everything below is the SAME pipeline the Anthropic paths run —
            // cost, routing telemetry, usage metering, profile/context/memory
            // persistence. normalizeOpenAiResponse() shaped the response so
            // none of it needs to know which provider answered.
            const cost = estimateCost(fb.model, data.usage);
            await logRouting("cross_provider", classification, fb.model, data.usage, { plan: userPlan, ...countServerTools(data), escalationReason: "anthropic_outage", specialist: recommendedSpecialist, requestId, responseTimeMs: Date.now() - handlerStartMs, timeoutReason, fallbackUsed });
            await recordScoutUsageCost(userId, cost, data.usage && data.usage.input_tokens, data.usage && data.usage.output_tokens);
            await persistProfileUpdates(userId, applyGoalAuthorship(applyGoalSafetyNet(extractProfileUpdates(data), extractScoutContextUpdates(data), currentGoalText, storedScoutContext), currentGoalText, currentGoalSource));
            await persistScoutContext(userId, extractScoutContextUpdates(data));
            await persistMemoryWrites(userId, extractMemoryWrites(data));
            data.reply_text = softenQuestionStreak(deriveReplyText(data), conversationForModel);
            data.scout_summary = updatedSummary;
            if (reservedQuestion) data.scout_usage = { remaining: questionsRemaining, limit: dailyLimit };
            data.next_move = extractNextBestAction(classification);
            data.suggested_targets = extractSuggestedTargets(data);
            data.suggested_dev_items = extractSuggestedDevItems(data);
            { const pw = finalizeSuggestedPathway(data, pathwayBuildCtx, incomingText, userPlan); data.suggested_pathway = pw.pathway; data.suggested_pathway_source = pw.source; }
            data.drafted_email = extractDraftedEmail(data);
            // Never cached, same reasoning as the Haiku fallback: a degraded
            // reply must not be served back to a different athlete later.
            return res.status(200).json(data);
          }
          console.log("GOLSZ cross-provider fallback failed:", JSON.stringify(crossProvider.data));
        } catch (e) {
          // A throwing adapter (misconfigured provider name, network error)
          // must not turn a degraded request into a 500 — fall through to the
          // graceful message below exactly as if it had returned not-ok.
          console.error("GOLSZ cross-provider fallback threw:", e);
        }
      }

      // Automatic failover, step 4 (every provider down): stop here — never
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
    await logRouting("sonnet", classification, deepTierConfig.model_name, data.usage, { plan: userPlan, ...countServerTools(data), escalationReason: haikuFailureReason || escalationReason(classification), specialist: recommendedSpecialist, requestId, responseTimeMs: Date.now() - handlerStartMs, timeoutReason, fallbackUsed });
    await recordScoutUsageCost(userId, sonnetCost, data.usage && data.usage.input_tokens, data.usage && data.usage.output_tokens);
    await persistProfileUpdates(userId, applyGoalAuthorship(applyGoalSafetyNet(extractProfileUpdates(data), extractScoutContextUpdates(data), currentGoalText, storedScoutContext), currentGoalText, currentGoalSource));
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
    data.reply_text = softenQuestionStreak(deriveReplyText(data), conversationForModel);
    data.scout_summary = updatedSummary;
    if (reservedQuestion) data.scout_usage = { remaining: questionsRemaining, limit: dailyLimit };
    data.next_move = extractNextBestAction(classification);
    data.suggested_targets = extractSuggestedTargets(data);
    data.suggested_dev_items = extractSuggestedDevItems(data);
    { const pw = finalizeSuggestedPathway(data, pathwayBuildCtx, incomingText, userPlan); data.suggested_pathway = pw.pathway; data.suggested_pathway_source = pw.source; }
    data.drafted_email = extractDraftedEmail(data);
    return res.status(200).json(data); // Anthropic-shaped { content: [...] } — client already parses this
  } catch (e) {
    if (reservedQuestion) await releaseScoutQuestion(userId);
    if (reservedFreeAi) await releaseFreeAiQuestion(userId);
    await logError("api/scout.js", "Upstream model call failed", { detail: String(e) });
    return res.status(502).json({ error: "Upstream model call failed", detail: String(e) });
  }
}
