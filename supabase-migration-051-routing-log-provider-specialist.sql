-- ============================================================
-- 051 — scout_routing_log: provider + specialist columns
-- Phase 2c/2f of the AI Scout architecture plan (approved).
--
-- provider is hardcoded "anthropic" by api/scout.js for now (every model
-- it calls today is Anthropic's) — becomes meaningful once Phase 3 wires
-- up a second real provider behind the Phase 2e model registry.
-- specialist records the classifier's recommended_specialist for that
-- turn (college/pro_pathway/development/eligibility, or null for the
-- default Scout persona — see Phase 2d). Both additive/nullable, so
-- existing rows are unaffected.
-- ============================================================

alter table scout_routing_log add column if not exists provider text;
alter table scout_routing_log add column if not exists specialist text;
