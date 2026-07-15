-- ============================================================
-- 010 — Scout conversation threads (New chat + History, like Claude/ChatGPT)
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009.
--
-- scout_history was previously one flat, ever-growing transcript per user
-- (every turn since the beginning, all flattened into one chat on load —
-- no concept of "a conversation"). This adds conversation_id so turns can
-- be grouped into distinct threads: the client starts a fresh uuid on
-- "New chat", keeps logging turns under it, and can list/reopen past ones.
-- ============================================================

alter table scout_history add column if not exists conversation_id uuid;

-- group each user's pre-existing (pre-feature) turns into one legacy
-- conversation per user, rather than fragmenting every historical row
-- into its own separate "conversation" of one message.
with legacy as (
  select user_id, gen_random_uuid() as cid
  from scout_history
  where conversation_id is null
  group by user_id
)
update scout_history sh
set conversation_id = legacy.cid
from legacy
where sh.user_id = legacy.user_id and sh.conversation_id is null;

alter table scout_history alter column conversation_id set default gen_random_uuid();
alter table scout_history alter column conversation_id set not null;

create index if not exists scout_history_conversation_idx on scout_history (conversation_id, created_at);
create index if not exists scout_history_user_idx on scout_history (user_id, created_at desc);

-- ============================================================
-- Done. No RLS changes — scout_history's existing owner-scoped policies
-- already cover this column since it's just an additional field on the
-- same row.
-- ============================================================
