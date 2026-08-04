-- ============================================================
-- 045 — Admin override: grant a specific athlete unlimited Scout access
-- Additive on top of 002 + ... + 044.
--
-- A real, ad-hoc admin need — a VIP, a tester, or someone with a
-- complaint shouldn't need a plan change just to lift their daily Scout
-- cap. Separate from `is_admin` (that grants the whole Admin Panel, this
-- grants nothing but a higher Scout ceiling) and separate from `plan`
-- (this can be flipped on for a Starter athlete without touching their
-- billing at all). Covered by the existing profiles_admin_write policy
-- (migration 023) — no new RLS policy needed, it already lets any admin
-- update any column on profiles.
-- ============================================================

alter table profiles add column if not exists ai_unlimited boolean not null default false;

-- ============================================================
-- Done.
-- ============================================================
