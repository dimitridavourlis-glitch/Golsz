-- ============================================================
-- 013 — Delete a whole conversation (hide it from your own list)
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 + 012.
--
-- Deliberately NOT a real destructive delete of the messages table: the
-- existing messages_delete RLS only lets you delete rows you sent
-- (sender_id = auth.uid()), so a true "delete conversation" would either
-- (a) only remove your half of it and leave the other person's messages
-- behind, or (b) require letting either participant delete the other's
-- messages too, which would silently wipe the thread for both people.
-- Instead this is a "delete for me" hide: a row here just means "don't
-- show me this conversation" as of hidden_at — it reappears automatically
-- the moment a new message arrives after that point, same as most DM
-- apps' archive/delete-thread behavior. Nothing is destroyed, and the
-- other participant's view is completely unaffected.
-- ============================================================

create table if not exists hidden_conversations (
  user_id    uuid not null references profiles(id) on delete cascade,
  other_id   uuid not null references profiles(id) on delete cascade,
  hidden_at  timestamptz not null default now(),
  primary key (user_id, other_id)
);
alter table hidden_conversations enable row level security;

drop policy if exists hidden_conversations_rw on hidden_conversations;
create policy hidden_conversations_rw on hidden_conversations for all using (
  user_id = auth.uid()
) with check (
  user_id = auth.uid()
);

-- ============================================================
-- Done.
-- ============================================================
