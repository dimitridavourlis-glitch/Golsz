-- ============================================================
-- 021 — Non-player Passport fields (license, looking for players)
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 +
-- 012 + 013 + 014 + 015 + 016 + 017 + 018 + 019 + 020.
--
-- profiles.occupation (migration 020) distinguishes a Player from a
-- Scout/Agent/Coach/Physio/Other, but golsz-app.html's Passport still
-- showed the same sport/position/grad-year fields to everyone — those
-- don't mean anything for a scout or a physio. Non-player accounts now
-- get their own two fields instead: what license(s) they hold, and
-- whether they're currently looking for players. Both live on `athletes`
-- (not a new table) since every profile already gets an athletes row via
-- handle_new_user(), regardless of occupation — same reasoning migration
-- 020 used for reusing athletes.club_name as a non-player's "which team"
-- field instead of adding a parallel column.
-- ============================================================

alter table athletes add column if not exists license text;
alter table athletes add column if not exists looking_for_players boolean;

-- ============================================================
-- Done. No RLS changes — both are just additional columns on the
-- existing athletes table, already covered by the pre-existing
-- owner/parent write policy and the athletes_read policy from migration
-- 019 (which already accounts for is_restricted_minor/is_banned).
-- ============================================================
