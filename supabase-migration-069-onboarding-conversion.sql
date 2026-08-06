-- ============================================================
-- 069 — One-time "we've learned enough about you" conversion nudge
-- Tracks whether a free-plan account has already been shown the guided-
-- onboarding conversion screen (ConversionScreen in golsz-app.html),
-- shown once real Scout usage exists (free_ai_lifetime_used >= 3, see
-- migration 068) rather than immediately on first profile save. Self-
-- service like passport_public (047) — no RLS/trigger change needed,
-- protect_profile_columns() only locks admin/billing-sensitive columns.
-- ============================================================

alter table profiles add column if not exists onboarding_conversion_shown boolean not null default false;
