-- ============================================================
-- 015 — Live message delivery (Realtime on the messages table)
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 +
-- 012 + 013 + 014.
--
-- Without this, Messages only ever refreshed on an explicit user action
-- (opening a thread, hitting send) — if you had a conversation open and
-- the other person replied, it wouldn't appear until you left and came
-- back. This adds the messages table to Supabase's realtime publication
-- so golsz-app.html can subscribe to new rows via postgres_changes and
-- have them appear immediately, same as any real chat product.
--
-- Realtime respects the existing messages_read RLS policy (sender_id =
-- auth.uid() or recipient_id = auth.uid()) — a client only ever receives
-- change events for rows it's already allowed to SELECT, so this doesn't
-- open up anything the REST API didn't already allow.
-- ============================================================

alter publication supabase_realtime add table messages;

-- ============================================================
-- Done. If this errors with "relation \"messages\" is already member of
-- publication" that's fine — it just means it's already enabled (e.g. via
-- Database -> Replication in the Dashboard) and there's nothing left to do.
-- ============================================================
