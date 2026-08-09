-- ============================================================
-- 112 — Sport support level must match what GOLSZ can actually back (P0-6)
--
-- Migration 094 seeded ten sports as support_level 'core'. SPORT_SCHEMAS in
-- api/scout.js contains exactly two: soccer and basketball. Scout's system
-- prompt treats "core" as "GOLSZ has real depth here", so for the other
-- eight it was told GOLSZ had built-out pathway/benchmark intelligence while
-- renderSportContext() correctly handed it nothing — the exact setup in
-- which a model fills the gap by inventing position groups, competition
-- ladders and eligibility requirements.
--
-- The real guarantee is in code: resolveSportSupportLevel() caps the declared
-- level at what sportSchemaFor() can substantiate, so 'core' is unreachable
-- for a schema-less sport regardless of what any row here says. This
-- migration is hygiene — the stored data should not assert something false
-- either, and an admin reading this table should see the truth.
--
-- These sports remain fully usable. 'supported' is not a downgrade in what
-- an athlete can do; it is an accurate statement about GOLSZ's structured
-- knowledge, which the prompt already knows how to handle honestly.
--
-- Reversal, once a schema is added for (say) volleyball: add it to
-- SPORT_SCHEMAS first, then set that row back to 'core'. Doing it in that
-- order keeps the claim true at every moment.
-- ============================================================

update sports
   set support_level = 'supported'
 where support_level = 'core'
   and id not in ('soccer', 'basketball');

-- Benchmarks stay disabled for anything without a schema: benchmarks_enabled
-- advertises a comparison vocabulary that only SPORT_SCHEMAS provides. (This
-- is independent of BENCHMARK_BANDS, which remains empty for every sport —
-- no reference data has been imported for soccer or basketball either.)
update sports
   set benchmarks_enabled = false
 where id not in ('soccer', 'basketball')
   and benchmarks_enabled = true;

-- Verification:
--   select id, support_level, pathway_enabled, benchmarks_enabled
--     from sports where support_level = 'core';
--   -- must return exactly soccer and basketball
