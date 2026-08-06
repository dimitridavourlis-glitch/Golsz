-- ============================================================
-- 058 — Verification workflow
-- Golsz Trust & Safety Moderation System (approved plan).
--
-- Revives a real self-service identity/occupation verification design
-- that was drafted once (~migration 024) and explicitly dropped before
-- shipping. `verified_tier` (migration 025) is a SUBSCRIPTION badge
-- (auto-synced from profiles.plan) — this is a genuinely separate
-- concept: `identity_verified` means "an admin actually looked at proof
-- this account is who it claims to be," independent of what they pay.
-- Scoped to the occupations that already exist as real profiles on
-- GOLSZ (Player/Coach/Scout/Agent/Physio) — not club/university/
-- federation entities, since those aren't real profile types here today.
--
-- Also extends protect_profile_columns() (last defined for migration
-- 048) so a signed-in user can't just PATCH their own trust_score or
-- identity_verified directly — same lockdown as is_admin/is_banned/
-- verified_tier already get.
-- ============================================================

alter table profiles add column if not exists identity_verified boolean not null default false;

create table if not exists verification_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  occupation text,
  proof_url text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  admin_notes text,
  reviewed_by uuid references profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists verification_requests_pending_idx on verification_requests (created_at) where status = 'pending';

alter table verification_requests enable row level security;

drop policy if exists verification_requests_own_read on verification_requests;
create policy verification_requests_own_read on verification_requests for select using (
  user_id = auth.uid() or is_admin()
);

drop policy if exists verification_requests_own_insert on verification_requests;
create policy verification_requests_own_insert on verification_requests for insert with check (
  user_id = auth.uid()
);

create or replace function admin_review_verification(p_id uuid, p_approve boolean, p_notes text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_user uuid;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select user_id into v_user from verification_requests where id = p_id;
  if v_user is null then
    raise exception 'request not found';
  end if;
  update verification_requests
    set status = case when p_approve then 'approved' else 'denied' end,
        admin_notes = p_notes, reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_id;
  if p_approve then
    update profiles set identity_verified = true where id = v_user;
  end if;
  perform recompute_trust_score(v_user);
end;
$$;

grant execute on function admin_review_verification(uuid, boolean, text) to authenticated;

create or replace function protect_profile_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if not (auth.role() is null or auth.role() = 'service_role' or is_admin()) then
    new.is_admin := old.is_admin;
    new.is_banned := old.is_banned;
    new.verified_tier := old.verified_tier;
    new.stripe_customer_id := old.stripe_customer_id;
    new.identity_verified := old.identity_verified;
    new.trust_score := old.trust_score;
    if new.plan is distinct from old.plan and new.plan <> 'free' then
      new.plan := old.plan;
    end if;
  end if;

  if new.plan is distinct from old.plan then
    new.verified_tier := case new.plan when 'elite' then 'elite' when 'pro' then 'pro' else 'none' end;
  end if;

  return new;
end;
$$;
