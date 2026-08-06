-- ============================================================
-- 061 — Trust-based messaging rate limit
-- Golsz Trust & Safety Moderation System (approved plan).
--
-- message_requests (an original-schema table) already gates the FIRST
-- message between two users behind mutual accept — but places no limit
-- on how many DIFFERENT people a brand-new or low-trust account can
-- message-request in a day (a real mass-messaging/spam vector).
-- check_message_request_limit() uses the same atomic reserve pattern as
-- reserve_scout_question (this session's AI Scout work) — one
-- insert-on-conflict statement, row-locked by Postgres, no
-- check-then-act race. It's called from INSIDE ensure_message_request()
-- (not exposed to the client directly) so the limit can't be bypassed by
-- simply not calling it — both functions run under the same
-- security-definer execution context, so the internal call works
-- without needing a client-facing grant.
-- ============================================================

create table if not exists message_request_daily_usage (
  user_id uuid not null references profiles(id) on delete cascade,
  usage_date date not null default current_date,
  requests_sent int not null default 0,
  primary key (user_id, usage_date)
);

alter table message_request_daily_usage enable row level security;

create or replace function check_message_request_limit(p_user uuid, p_daily_limit int)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare
  v_used int;
begin
  insert into message_request_daily_usage (user_id, usage_date, requests_sent)
  values (p_user, current_date, 1)
  on conflict (user_id, usage_date) do update
    set requests_sent = case when message_request_daily_usage.requests_sent < p_daily_limit
                              then message_request_daily_usage.requests_sent + 1
                              else message_request_daily_usage.requests_sent end
  returning requests_sent into v_used;
  return v_used <= p_daily_limit;
end;
$$;

revoke all on function check_message_request_limit(uuid, int) from public, authenticated, anon;
grant execute on function check_message_request_limit(uuid, int) to service_role;

-- Extends ensure_message_request() (an original-schema function) with the
-- trust-based check. Only a genuinely NEW request (no prior thread with
-- this recipient — the existing early-return above already covers "already
-- talking to them") counts against the limit. Only low-trust (<30) or
-- brand-new (<7 days old) accounts are capped; established accounts are
-- unlimited at this layer — the mutual-accept friction remains the primary
-- defense for everyone.
create or replace function ensure_message_request(p_recipient uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_trust int;
  v_created timestamptz;
  v_daily_limit int := 10;
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

  select trust_score, created_at into v_trust, v_created from profiles where id = auth.uid();
  if coalesce(v_trust, 50) < 30 or v_created > now() - interval '7 days' then
    if not check_message_request_limit(auth.uid(), v_daily_limit) then
      raise exception 'Daily message-request limit reached for new/low-trust accounts';
    end if;
  end if;

  insert into message_requests (sender_id, recipient_id, status)
  values (auth.uid(), p_recipient, 'pending');
end;
$$;

grant execute on function ensure_message_request(uuid) to authenticated;
