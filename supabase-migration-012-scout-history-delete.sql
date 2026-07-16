-- ============================================================
-- 012 — Allow deleting your own Scout conversations
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011.
--
-- scout_history predates this migration series (base table, RLS policies
-- undocumented/unconfirmed — see supabase-schema.sql's header warning).
-- Rather than guess at and possibly clash with an existing policy name,
-- this just adds a new, uniquely-named delete policy — RLS policies for
-- the same command are OR'd together, so this is safe to run regardless
-- of whatever already exists on the table.
-- ============================================================

drop policy if exists scout_history_delete on scout_history;
create policy scout_history_delete on scout_history for delete using (
  user_id = auth.uid()
);

-- ============================================================
-- Done.
-- ============================================================
