-- ============================================================
-- 037 — Instagram-style message requests
-- Additive on top of 002 + 004 + ... + 036.
--
-- Previously, can_message(a, b) required a's follow relationship with b
-- to exist first (migration 007) — you could not message anyone you
-- didn't already follow or who didn't follow you. The founder asked for
-- Instagram's actual model instead: anyone can send someone a first
-- message, but it's a "request" until the recipient explicitly accepts
-- it — only then does it become a normal, freely-flowing conversation.
-- Declining (or never accepting) stops it there; the recipient never
-- has to see more from that sender unless they change their mind.
--
-- message_requests tracks exactly one thing per (sender, recipient)
-- pair: has the recipient accepted messages from this specific sender.
-- No direct `authenticated` insert/update policy at all — the only ways
-- a row can be created or changed are the two functions below, both
-- security definer:
--   - ensure_message_request(p_recipient) — called right before the
--     client's very first message to someone new. Idempotent (a
--     second call for the same pair is a no-op), always stamps
--     sender_id as auth.uid() itself, never something the client
--     could claim about who's requesting.
--   - respond_to_message_request(p_sender, p_accept) — only the real
--     recipient (auth.uid()) can accept or decline a request addressed
--     to them; p_sender only selects *which* pending request, it can
--     never be used to approve a request on someone else's behalf.
--
-- can_message(a, b) is redefined (same name/signature, so
-- messages_write's existing RLS text needs zero changes) to allow a
-- message from a to b when: they aren't blocked, AND either
--   (a originally requested b, status pending or accepted — the
--    original requester can keep sending while waiting, matching real
--    Instagram behavior), OR
--   (b originally requested a, and a has accepted it — once accepted,
--    either side can message freely).
-- Critically, if no message_requests row exists yet between a and b at
-- all, can_message returns false — the client MUST call
-- ensure_message_request() before the first messages insert, or RLS
-- rejects it. This is what actually prevents someone from bypassing
-- the request system by inserting into messages directly.
--
-- Everything else about messages (RLS read/update, restricted-minor
-- checks, blocks) is unchanged — this migration only changes *who
-- needs a request first*, not any of the existing safety gates around
-- minors or blocked accounts.
-- ============================================================

create table if not exists message_requests (
  sender_id uuid not null references profiles(id) on delete cascade,
  recipient_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  primary key (sender_id, recipient_id),
  check (sender_id <> recipient_id)
);

create index if not exists message_requests_recipient_idx on message_requests (recipient_id, status);

alter table message_requests enable row level security;

drop policy if exists message_requests_read on message_requests;
create policy message_requests_read on message_requests for select using (
  sender_id = auth.uid() or recipient_id = auth.uid()
);

create or replace function ensure_message_request(p_recipient uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null or p_recipient is null or p_recipient = auth.uid() then
    return;
  end if;
  if exists (
    select 1 from message_requests
    where (sender_id = auth.uid() and recipient_id = p_recipient)
       or (sender_id = p_recipient and recipient_id = auth.uid())
  ) then
    return;
  end if;
  insert into message_requests (sender_id, recipient_id, status)
  values (auth.uid(), p_recipient, 'pending');
end;
$$;

grant execute on function ensure_message_request(uuid) to authenticated;

create or replace function respond_to_message_request(p_sender uuid, p_accept boolean)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update message_requests
  set status = case when p_accept then 'accepted' else 'declined' end,
      responded_at = now()
  where sender_id = p_sender and recipient_id = auth.uid() and status = 'pending';
end;
$$;

grant execute on function respond_to_message_request(uuid, boolean) to authenticated;

create or replace function can_message(a uuid, b uuid)
returns boolean language sql security definer set search_path to 'public' as $$
  select
    not exists (
      select 1 from blocks
      where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)
    )
    and (
      exists (
        select 1 from message_requests
        where sender_id = a and recipient_id = b and status in ('pending', 'accepted')
      )
      or exists (
        select 1 from message_requests
        where sender_id = b and recipient_id = a and status = 'accepted'
      )
    );
$$;

-- ============================================================
-- Done.
-- ============================================================
