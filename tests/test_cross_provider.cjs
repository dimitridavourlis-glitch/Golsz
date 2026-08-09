// Second AI provider / cross-provider failover (api/scout.js).
//
// Why this exists: every model GOLSZ could call was Anthropic, and the
// "automatic failover" chain was Sonnet -> Sonnet retry -> Haiku — all one
// vendor. An Anthropic-wide outage exhausted the entire chain and Scout went
// dark, violating Master Architecture Non-Negotiable #2.
//
// The riskiest part is NOT the network call, it's the response normalisation:
// everything downstream (deriveReplyText, extractProfileUpdates,
// extractMemoryWrites, estimateCost, logRouting) reads the Anthropic shape.
// A wrong shape here fails LATE and quietly — an empty reply, a null cost, a
// lost memory write — rather than throwing. So most assertions below are on
// the shape contract.
//
// Per tests/README.md everything is extracted from the source at run time.

const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const SRC = fs.readFileSync(REPO + "/api/scout.js", "utf8");
const slice = (from, to) => SRC.slice(SRC.indexOf(from), SRC.indexOf(to));

// Pull the adapter layer + pricing. PRICING/OPENAI_COMPAT_URL are consts, so
// they come out through an appended extractor (direct eval leaks functions,
// not const/let — same pattern as test_budget_gate.cjs).
eval(slice("const PRICING = {", "\nfunction estimateCost") +
  "\nfunction __extractPricing() { return { PRICING }; }");
const { PRICING } = __extractPricing();
// anthropicAdapter delegates to callAnthropic, so that has to come along too
// or the regression assertion at the bottom hits a ReferenceError at call
// time rather than at eval time.
eval('const ANTHROPIC_URL = ' + JSON.stringify(
  SRC.match(/^const ANTHROPIC_URL = "([^"]+)"/m)[1]) + ';' +
  slice("async function callAnthropic", "\n// $ per 1M tokens"));
// The adapters themselves are consts (they don't leak from a direct eval);
// the helpers around them are function declarations (they do). Extractor
// appended for the consts — same pattern as test_budget_gate.cjs.
eval(slice("const anthropicAdapter = {", "\n// Emergency kill switches") +
  "\nfunction __extractAdapters() { return { anthropicAdapter, openaiCompatibleAdapter, PROVIDER_ADAPTERS }; }");
const { anthropicAdapter, openaiCompatibleAdapter, PROVIDER_ADAPTERS } = __extractAdapters();

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

console.log("-- the fallback is INERT until an operator configures a key --");
delete process.env.SCOUT_FALLBACK_API_KEY;
ck("no key -> no fallback config (chain behaves exactly as before)", fallbackProviderConfig(), null);
process.env.SCOUT_FALLBACK_API_KEY = "sk-test-fallback";
const cfg = fallbackProviderConfig();
ck("a key alone is enough to arm it", !!cfg, true);
// xAI Grok, non-reasoning variant: a reasoning model under a 1024-token cap
// can burn the whole budget thinking and return nothing — unacceptable for
// the one path that exists to survive an outage.
ck("...defaulting to the chosen xAI model", cfg.model, "grok-4.20-0309-non-reasoning");
ck("...which is deliberately NOT the flagship grok-4.5", cfg.model !== "grok-4.5", true);
ck("...and a default provider that resolves to a real adapter", cfg.provider, "openai_compatible");
ck("...and a bounded output budget", cfg.maxOutputTokens, 1024);
process.env.SCOUT_FALLBACK_MODEL = "llama-3.3-70b-versatile";
ck("model is operator-overridable (vendor choice is theirs, not ours)",
   fallbackProviderConfig().model, "llama-3.3-70b-versatile");
delete process.env.SCOUT_FALLBACK_MODEL;

console.log("\n-- endpoint accepts a BASE url or a full one (xAI publishes the base) --");
// Configuring "https://api.x.ai/v1" would POST to /v1 and 404 — a
// misconfiguration that only surfaces mid-outage, the worst possible moment.
delete process.env.SCOUT_FALLBACK_URL;
ck("unset -> a complete default endpoint", openaiCompatEndpoint(), "https://api.openai.com/v1/chat/completions");
process.env.SCOUT_FALLBACK_URL = "https://api.x.ai/v1";
ck("xAI base url gets /chat/completions appended",
   openaiCompatEndpoint(), "https://api.x.ai/v1/chat/completions");
process.env.SCOUT_FALLBACK_URL = "https://api.x.ai/v1/";
ck("...trailing slash tolerated", openaiCompatEndpoint(), "https://api.x.ai/v1/chat/completions");
process.env.SCOUT_FALLBACK_URL = "https://api.x.ai/v1/chat/completions";
ck("...a full endpoint is left exactly as given",
   openaiCompatEndpoint(), "https://api.x.ai/v1/chat/completions");
ck("...and is never double-suffixed",
   (openaiCompatEndpoint().match(/chat\/completions/g) || []).length, 1);

console.log("   -- and TLS is forced, never optional --");
// Found live: the env var was saved as http://. xAI answered
// "unauthenticated:no-credentials" because the Authorization header is
// dropped on a cleartext->TLS redirect, so the fallback silently never
// worked — while also putting the API key and the athlete's personal
// context on the wire unencrypted.
process.env.SCOUT_FALLBACK_URL = "http://api.x.ai/v1";
ck("a http:// base is upgraded to https://",
   openaiCompatEndpoint(), "https://api.x.ai/v1/chat/completions");
process.env.SCOUT_FALLBACK_URL = "HTTP://API.X.AI/v1";
ck("...case-insensitively", /^https:\/\//.test(openaiCompatEndpoint()), true);
process.env.SCOUT_FALLBACK_URL = "api.x.ai/v1";
ck("a scheme-less base still gets https, never plaintext",
   openaiCompatEndpoint(), "https://api.x.ai/v1/chat/completions");
process.env.SCOUT_FALLBACK_URL = "https://api.x.ai/v1";
ck("an https base is left alone", openaiCompatEndpoint(), "https://api.x.ai/v1/chat/completions");
ck("NO configuration can ever produce a cleartext endpoint",
   ["http://api.x.ai/v1", "api.x.ai/v1", "https://api.x.ai/v1", "//api.x.ai/v1"].every((u) => {
     process.env.SCOUT_FALLBACK_URL = u;
     return openaiCompatEndpoint().startsWith("https://");
   }), true);
process.env.SCOUT_FALLBACK_URL = "https://api.x.ai/v1";

console.log("\n-- adapter registry resolves without branching on vendor --");
ck("anthropic still resolves to the anthropic adapter", adapterFor("anthropic").provider, "anthropic");
ck("openai resolves to the compatible adapter", adapterFor("openai").provider, "openai_compatible");
ck("openai_compatible resolves too (Groq/Together/DeepSeek/etc.)",
   adapterFor("openai_compatible").provider, "openai_compatible");
ck("an unknown provider falls back to anthropic rather than throwing",
   adapterFor("wat").provider, "anthropic");
// (the "unconfigured provider rejects" case is async — asserted in the async
// block below, since generate() is async and rejects rather than throwing)

console.log("\n-- THE CONTRACT: an OpenAI-shaped reply becomes an Anthropic-shaped one --");
const RAW = {
  id: "chatcmpl-1",
  choices: [{ message: { role: "assistant", content: '{"reply":"Here is your answer."}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1200, completion_tokens: 300 },
};
const norm = normalizeOpenAiResponse(RAW);
ck("content is an Anthropic text-block array", norm.content, [{ type: "text", text: '{"reply":"Here is your answer."}' }]);
ck("stop_reason is normalised", norm.stop_reason, "end_turn");
ck("prompt_tokens -> input_tokens", norm.usage.input_tokens, 1200);
ck("completion_tokens -> output_tokens", norm.usage.output_tokens, 300);
ck("cache fields are real zeros, not undefined (cost maths must not NaN)",
   [norm.usage.cache_read_input_tokens, norm.usage.cache_creation_input_tokens], [0, 0]);
ck("a length-capped finish maps to max_tokens so truncation handling still fires",
   normalizeOpenAiResponse({ choices: [{ message: { content: "x" }, finish_reason: "length" }] }).stop_reason,
   "max_tokens");

console.log("   -- and degrades safely on malformed provider output --");
ck("empty response does not throw", normalizeOpenAiResponse({}).content, [{ type: "text", text: "" }]);
ck("null response does not throw", normalizeOpenAiResponse(null).content, [{ type: "text", text: "" }]);
ck("missing choices does not throw", normalizeOpenAiResponse({ usage: {} }).usage.input_tokens, 0);
ck("non-string content is not passed through as an object",
   normalizeOpenAiResponse({ choices: [{ message: { content: { bad: 1 } } }] }).content, [{ type: "text", text: "" }]);

console.log("\n-- the real downstream readers accept the normalised shape --");
// The whole point of normalising: these are the actual functions the handler
// runs after a reply, unchanged, with no idea which vendor answered.
// Starts at parseReplyObject because deriveReplyText calls it — extracting the
// caller alone gives a ReferenceError at run time, not at eval time.
// End-marker chosen from AFTER deriveReplyText: slice() uses indexOf, so a
// marker that also appears earlier in the file silently yields an empty slice.
eval(slice("function parseReplyObject", "\n// Scout kept ending EVERY reply with a question"));
const withJson = normalizeOpenAiResponse({
  choices: [{ message: { content: '{"reply":"Straight answer.","memory_writes":[]}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
ck("deriveReplyText reads a cross-provider reply", deriveReplyText(withJson), "Straight answer.");

console.log("\n-- prompt transport: same content, different envelope --");
const msgs = toOpenAiMessages("STATIC", "DYNAMIC", [{ role: "user", content: "hi" }]);
ck("both system blocks are merged into one leading system message",
   msgs[0], { role: "system", content: "STATIC\n\nDYNAMIC" });
ck("...in the same order the model would have received them",
   msgs[0].content.indexOf("STATIC") < msgs[0].content.indexOf("DYNAMIC"), true);
ck("user turns are preserved", msgs[1], { role: "user", content: "hi" });
ck("Anthropic block-array content is flattened to text",
   toOpenAiMessages("S", null, [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }])[1],
   { role: "user", content: "a\nb" });
ck("non-text blocks (tool/image) are dropped rather than serialised as junk",
   toOpenAiMessages("S", null, [{ role: "user", content: [{ type: "tool_use", id: "t" }, { type: "text", text: "keep" }] }])[1],
   { role: "user", content: "keep" });
ck("an empty turn is skipped, never sent as empty content",
   toOpenAiMessages("S", null, [{ role: "user", content: "" }]).length, 1);
ck("assistant role is preserved; anything else normalises to user",
   toOpenAiMessages(null, null, [{ role: "assistant", content: "a" }, { role: "system", content: "b" }]).map((m) => m.role),
   ["assistant", "user"]);
ck("no system text at all -> no system message",
   toOpenAiMessages(null, null, [{ role: "user", content: "x" }]).length, 1);

console.log("\n-- cost telemetry stays honest across providers --");
eval(slice("function estimateCost", "\n// Deterministic recovery for the goal-capture"));
const GROK = "grok-4.20-0309-non-reasoning";
const fbCost = estimateCost(GROK, { input_tokens: 1e6, output_tokens: 1e6 });
ck("the fallback model is NOT billed at Sonnet rates", fbCost !== (3 + 15), true);
// xAI published pricing for this model's sub-200k tier, checked 2026-08-09.
ck("...it uses xAI's real published rates ($1.25 in / $2.50 out per 1M)",
   Number(fbCost.toFixed(4)), Number((1.25 + 2.5).toFixed(4)));
ck("...input alone prices at $1.25/1M",
   Number(estimateCost(GROK, { input_tokens: 1e6, output_tokens: 0 }).toFixed(4)), 1.25);
ck("...output alone prices at $2.50/1M",
   Number(estimateCost(GROK, { input_tokens: 0, output_tokens: 1e6 }).toFixed(4)), 2.5);
process.env.SCOUT_FALLBACK_INPUT_COST = "1";
process.env.SCOUT_FALLBACK_OUTPUT_COST = "2";
ck("...which the operator can override (xAI's >200k tier, or another vendor)",
   Number(estimateCost(GROK, { input_tokens: 1e6, output_tokens: 1e6 }).toFixed(4)), 3);
delete process.env.SCOUT_FALLBACK_INPUT_COST;
delete process.env.SCOUT_FALLBACK_OUTPUT_COST;
ck("Anthropic pricing is untouched by any of this",
   Number(estimateCost("claude-sonnet-5", { input_tokens: 1e6, output_tokens: 1e6 }).toFixed(4)), 18);
ck("an unknown model still defaults to Sonnet rates (unchanged behaviour)",
   Number(estimateCost("who-knows", { input_tokens: 1e6, output_tokens: 0 }).toFixed(4)), 3);

console.log("\n-- the adapter's own request shape --");
(async () => {
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body), headers: opts.headers };
    return { ok: true, status: 200, json: async () => RAW };
  };
  const res = await openaiCompatibleAdapter.generate({
    apiKey: "sk-x", model: "m1", system: "S", systemDynamic: "D",
    messages: [{ role: "user", content: "q" }], maxTokens: 512,
  });
  ck("returns ok with an already-normalised body", res.ok && res.data.content[0].type, "text");
  ck("authenticates with a bearer token", captured.headers.authorization, "Bearer sk-x");
  ck("sends the configured model", captured.body.model, "m1");
  ck("honours the output cap", captured.body.max_tokens, 512);
  // Non-negotiable: this path must never be able to claim it searched.
  ck("NEVER sends tools — a degraded reply must not imply it ran a search",
     captured.body.tools === undefined, true);

  // A provider erroring must surface as ok:false, never as a thrown 500 or a
  // fake success — the handler decides what to do, the adapter just reports.
  global.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: "overloaded" }) });
  const bad = await openaiCompatibleAdapter.generate({ apiKey: "k", model: "m", messages: [] });
  ck("a provider 5xx reports ok:false", bad.ok, false);
  ck("...preserving the status for logs", bad.status, 503);
  ck("...and does not pretend to have content", bad.data.error, "overloaded");

  // Async because generate() is async: an unconfigured provider REJECTS, it
  // does not throw synchronously. The handler wraps the cross-provider call in
  // try/catch precisely so this can never become a 500.
  const unconfigured = await adapterFor("google").generate().then(() => "resolved", (e) => e.message);
  ck("a still-unconfigured provider rejects rather than silently no-op'ing",
     /no configured API key/.test(unconfigured), true);

  console.log("\n-- regression: the anthropic adapter must forward systemDynamic --");
  // It destructured systemDynamic and dropped it. The cross-model fallback
  // passes the athlete state AND the "search unavailable, don't invent
  // results" notice through that field, so a degraded reply was answering
  // with no athlete context and unaware it was degraded.
  let anthropicBody = null;
  global.fetch = async (url, opts) => {
    anthropicBody = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "{}" }] }) };
  };
  await anthropicAdapter.generate({
    apiKey: "k", model: "claude-haiku-4-5", system: "STATIC", systemDynamic: "ATHLETE-STATE",
    messages: [{ role: "user", content: "q" }], maxTokens: 100,
  });
  ck("systemDynamic reaches the API as a second system block",
     anthropicBody.system.map((b) => b.text), ["STATIC", "ATHLETE-STATE"]);
  ck("...and only the static block carries the cache breakpoint",
     [!!anthropicBody.system[0].cache_control, !!anthropicBody.system[1].cache_control], [true, false]);

  console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})();
