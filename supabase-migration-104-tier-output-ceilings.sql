-- Migration 104 — bring the Sonnet tiers' max_output_tokens down to reality
--
-- budgetGate() (api/scout.js) downgrades a request's model tier when the
-- tier's WORST-CASE cost exceeds the plan's per-request hard ceiling, and it
-- computes that worst case using max_output_tokens. Both Sonnet tiers were
-- seeded at 4096, which priced the output ceiling alone at
--
--     4096 tokens x $15/M = $0.0614
--
-- against hard ceilings of $0.01 free / $0.02 starter / $0.04 pro /
-- $0.08 elite. The output ceiling alone busted free, starter and pro before
-- a single input token was counted, and once input was added it busted elite
-- too -- so the advanced/premium tiers were unreachable on EVERY plan and
-- every request silently fell back to Haiku. The visible symptom: genuine
-- web_lookup questions were answered with no web_search tool at all, which
-- is also why scout_research_cache could never populate.
--
-- 4096 was never a realistic figure. Observed production output for real
-- Scout replies is 119-440 tokens; SYSTEM_PROMPT explicitly instructs "Ask
-- at most ONE question per reply. Keep replies tight."
--
-- New ceilings, with ~7,000 input tokens (system prompt + conversation):
--   advanced 1024 -> est $0.0364 -> reachable by pro and elite
--   premium  2048 -> est $0.0517 -> reachable by elite
-- which matches PLAN_MODEL_ACCESS, where premium is already elite-only.
--
-- NOT fixed by this change, and stated plainly: free ($0.01) and starter
-- ($0.02) still cannot reach the Sonnet tiers, because input alone at the
-- full $3/M rate costs ~$0.021 for a 7,000-token prompt -- more than the
-- entire starter ceiling before any output. Lowering an output ceiling
-- cannot fix an input-side overrun. Raising those ceilings, or teaching
-- budgetGate to price cache reads at the cached rate (the
-- cached_input_cost_per_million column is seeded but never read by
-- estimateTierCost, even though prompt caching is active and the real
-- post-hoc estimateCost DOES account for it), are separate decisions.
--
-- This is a data-only change to a runtime-editable config table; no schema
-- change and nothing to roll back beyond restoring the old numbers.

update scout_model_config set max_output_tokens = 1024, updated_at = now()
where model_tier = 'advanced' and max_output_tokens <> 1024;

update scout_model_config set max_output_tokens = 2048, updated_at = now()
where model_tier = 'premium' and max_output_tokens <> 2048;
