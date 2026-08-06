-- ============================================================
-- 059 — Appeals
-- Golsz Trust & Safety Moderation System (approved plan).
--
-- Ties to two real decision points: a moderation_queue item (dispute a
-- "review"/"block" classification) and a ban (profiles.is_banned). On
-- overturn: a moderation_queue-linked appeal has nothing to "restore"
-- for a block decision (blocked content was never saved in the first
-- place — resubmitting is the real remedy), so overturning just marks
-- the appeal resolved and recomputes trust; a ban-linked appeal flips
-- profiles.is_banned back to false at the SQL level.
--
-- IMPORTANT, deliberately not hidden: this does NOT clear the parallel
-- real Supabase Auth ban_duration set via the Admin API in
-- api/admin-user-action.js's "ban" action — a pure SQL function can't
-- call an external HTTP API, so a full unban still needs that
-- endpoint's "unban" action run too. Flagging this limitation rather
-- than pretending the SQL-level flip is the whole story.
-- ============================================================

create table if not exists moderation_appeals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  moderation_queue_id uuid references moderation_queue(id) on delete set null,
  ban_related boolean not null default false,
  reason text not null,
  status text not null default 'pending' check (status in ('pending', 'upheld', 'overturned')),
  admin_notes text,
  reviewed_by uuid references profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists moderation_appeals_pending_idx on moderation_appeals (created_at) where status = 'pending';

alter table moderation_appeals enable row level security;

drop policy if exists moderation_appeals_own_read on moderation_appeals;
create policy moderation_appeals_own_read on moderation_appeals for select using (
  user_id = auth.uid() or is_admin()
);

drop policy if exists moderation_appeals_own_insert on moderation_appeals;
create policy moderation_appeals_own_insert on moderation_appeals for insert with check (
  user_id = auth.uid()
);

create or replace function admin_review_appeal(p_id uuid, p_overturn boolean, p_notes text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_user uuid;
  v_ban_related boolean;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select user_id, ban_related into v_user, v_ban_related from moderation_appeals where id = p_id;
  if v_user is null then
    raise exception 'appeal not found';
  end if;
  update moderation_appeals
    set status = case when p_overturn then 'overturned' else 'upheld' end,
        admin_notes = p_notes, reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_id;
  if p_overturn and v_ban_related then
    update profiles set is_banned = false where id = v_user;
  end if;
  perform recompute_trust_score(v_user);
end;
$$;

grant execute on function admin_review_appeal(uuid, boolean, text) to authenticated;
