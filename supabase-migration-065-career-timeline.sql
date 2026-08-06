-- ============================================================
-- 065 — Career timeline on Passport
-- Passport's "CAREER TIMELINE" card was demo-only (hardcoded sample
-- data, never shown on a real account — see the old `{!real && (...)}`
-- guard in golsz-app.html). This makes it real: a self-service, jsonb
-- list on athletes, same proven pattern as athletes.highlights (added
-- pre-session) — no new table, protected by the existing athletes_rw
-- policy (id = auth.uid() or is_parent_of(id)), same as highlights.
-- ============================================================

alter table athletes add column if not exists timeline jsonb not null default '[]'::jsonb;
