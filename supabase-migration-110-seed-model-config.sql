-- Migration 110 — scout_model_config was empty; migration 104's fix never
-- actually landed
--
-- Found live in production while testing Scout end-to-end: a starter-plan
-- account asking a genuine career-advice question got routed to Haiku, even
-- though the classifier correctly returned intent="career_advice" (not a
-- Haiku-eligible intent) and selectModelTier() correctly picked "advanced".
--
-- Root cause traced to two compounding bugs, both real, both live:
--
--   1. scout_model_config has ZERO rows in production right now. Migration
--      104 ("bring the Sonnet tiers' max_output_tokens down to reality")
--      was an UPDATE against this table — an UPDATE with no matching rows
--      is a silent no-op. Whatever seeded this table originally never ran,
--      or its rows were removed since; either way the fix migration 104
--      documented never actually took effect.
--
--   2. getModelConfigByTier() falls back to the code constant
--      ANTHROPIC_DEFAULTS when the table is empty — and ANTHROPIC_DEFAULTS
--      still has the ORIGINAL broken value migration 104 was written to
--      fix: advanced/premium max_output_tokens=4096, pricing the OUTPUT
--      CEILING ALONE at 4096 x $15/M = $0.0614 before a single input token
--      is counted. That number alone exceeds every plan's
--      HARD_MAX_COST_PER_REQUEST except elite's $0.08, so budgetGate()
--      silently downgraded advanced/premium to Haiku for free, starter and
--      pro on every single request, regardless of the actual question.
--
-- This migration fixes (1) by actually inserting the rows migration 104
-- intended to update, using its already-reasoned numbers (1024/2048).
-- api/scout.js's ANTHROPIC_DEFAULTS is fixed in the same commit to carry the
-- same corrected numbers, so the fallback path can never silently regress
-- back to 4096 again regardless of what happens to this table.
--
-- economy/standard (Haiku) rows are seeded too, at their existing correct
-- values (1024/2048 output, $1/$5 per M) — they were never the bug (Haiku's
-- own worst-case output cost clears every plan's hard cap comfortably), but
-- leaving them unseeded means a partially-empty table where two tiers
-- silently depend on the code fallback and two don't, which is exactly the
-- kind of half-migrated state that caused this bug in the first place.
--
-- ON CONFLICT on the table's own (provider, model_name, model_tier)
-- constraint — safe to re-run, and safe if a future admin edit already
-- exists (their priority/enabled changes are preserved; only the pricing/
-- ceiling columns are refreshed to the corrected values).

insert into scout_model_config
  (provider, model_name, model_tier, input_cost_per_million, output_cost_per_million, cached_input_cost_per_million, max_output_tokens, enabled, priority)
values
  ('anthropic', 'claude-haiku-4-5', 'economy',  1, 5, 0.1, 1024, true, 100),
  ('anthropic', 'claude-haiku-4-5', 'standard', 1, 5, 0.1, 2048, true, 100),
  ('anthropic', 'claude-sonnet-5',  'advanced', 3, 15, 0.3, 1024, true, 100),
  ('anthropic', 'claude-sonnet-5',  'premium',  3, 15, 0.3, 2048, true, 100)
on conflict (provider, model_name, model_tier) do update set
  input_cost_per_million = excluded.input_cost_per_million,
  output_cost_per_million = excluded.output_cost_per_million,
  cached_input_cost_per_million = excluded.cached_input_cost_per_million,
  max_output_tokens = excluded.max_output_tokens,
  updated_at = now();
