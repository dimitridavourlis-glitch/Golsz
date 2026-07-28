-- ============================================================
-- 018 — Add athletes.education_level (High School / University / Other)
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 +
-- 012 + 013 + 014 + 015 + 016 + 017.
--
-- Passport had no way to show whether an athlete is currently in high
-- school, university, or something else — grad_year alone doesn't convey
-- that. Plain text column rather than an enum since the three options are
-- enforced client-side (ProfileEditor's <select>), same pattern already
-- used for athletes.foot and athletes.recruiting_status.
-- ============================================================

alter table athletes add column if not exists education_level text;

-- ============================================================
-- Done.
-- ============================================================
