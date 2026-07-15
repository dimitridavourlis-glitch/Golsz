-- ============================================================
-- 007 — Direct messages between profiles that follow each other
-- Additive on top of 002 + 004 + 005 + 006.
-- ============================================================

create table if not exists messages (
  id            uuid primary key default gen_random_uuid(),
  sender_id     uuid not null references profiles(id) on delete cascade,
  recipient_id  uuid not null references profiles(id) on delete cascade,
  body          text not null check (char_length(trim(body)) between 1 and 2000),
  created_at    timestamptz not null default now(),
  read_at       timestamptz,
  check (sender_id <> recipient_id)
);
create index if not exists messages_thread_idx  on messages (sender_id, recipient_id, created_at);
create index if not exists messages_thread_idx2 on messages (recipient_id, sender_id, created_at);
alter table messages enable row level security;

-- Two profiles can message each other once there's a follow relationship
-- in either direction, and neither has blocked the other. Mirrors "message
-- anyone you follow, or who follows you" rather than requiring mutual follow.
create or replace function can_message(a uuid, b uuid)
returns boolean language sql security definer set search_path to 'public' as $$
  select exists (
    select 1 from follows
    where (follower_id = a and followed_id = b) or (follower_id = b and followed_id = a)
  ) and not exists (
    select 1 from blocks
    where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
  );
$$;

drop policy if exists messages_read on messages;
create policy messages_read on messages for select using (
  sender_id = auth.uid() or recipient_id = auth.uid()
);

-- restricted minors (see is_restricted_minor() in migration 005) can't send
-- or receive DMs either, same posture as posts/Discover visibility
drop policy if exists messages_write on messages;
create policy messages_write on messages for insert with check (
  sender_id = auth.uid()
  and not is_restricted_minor(auth.uid())
  and not is_restricted_minor(recipient_id)
  and can_message(auth.uid(), recipient_id)
);

-- recipient marks their own inbound messages read
drop policy if exists messages_update on messages;
create policy messages_update on messages for update using (
  recipient_id = auth.uid()
) with check (
  recipient_id = auth.uid()
);

-- sender can unsend/delete their own messages
drop policy if exists messages_delete on messages;
create policy messages_delete on messages for delete using (
  sender_id = auth.uid()
);

-- ============================================================
-- Done. This is the first real backend for the Messages tab — it was a
-- hardcoded THREADS demo array with no insert/read path at all before.
-- ============================================================
