-- ============================================================
-- 025 — Verification request/review workflow, gated to Pro/Elite
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 +
-- 012 + 013 + 014 + 015 + 016 + 017 + 018 + 019 + 020 + 021 + 022 + 023 +
-- 024.
--
-- Migration 024 gave admins a manual Verify/Unverify toggle, but nothing
-- let an athlete/coach/scout/agent actually ASK to be verified, and
-- nothing showed the admin who's asking. This adds that as its own table
-- (not just a status column on profiles) so there's a real request
-- history — who asked, when, what they said about themselves, who
-- reviewed it and when.
--
-- New rule this migration also adds: verification is only for Pro/Elite —
-- Starter accounts can't request it, and is_verified can never be true
-- while plan is 'starter'. That's enforced three separate ways, not just
-- one, because there are three different ways is_verified or a request
-- can come into existence:
--   1. verification_requests_insert's WITH CHECK blocks a Starter account
--      from even creating a pending request.
--   2. admin_review_verification_request() re-checks the plan before
--      approving — covers the case where someone requests while on
--      Pro/Elite, then downgrades before an admin gets to review it.
--   3. protect_profile_columns() (migration 023/024) now also resets
--      is_verified to false any time a row's plan isn't pro/elite,
--      unconditionally — including for service_role. That last part
--      matters: api/stripe-webhook.js's subscription.deleted handler sets
--      plan back to 'starter' using the service-role key on a real
--      Stripe cancellation, and until now service_role sailed through
--      protect_profile_columns() untouched. A previously-verified Pro
--      user whose subscription lapses needs to silently lose that badge
--      as part of the same event, not keep looking verified with no
--      subscription behind it.
-- A CHECK constraint backs all three up — it should never actually fire
-- given the above, but if any future code path forgets to account for
-- this rule, the constraint is what stops a bad row from being written
-- rather than a silent design gap.
--
-- The insert policy also pins status to 'pending' and doesn't allow the
-- client to set reviewed_at/reviewed_by at all — those only ever get set
-- by admin_review_verification_request(), which checks is_admin() itself
-- (security definer, same pattern as admin_delete_profile).
-- ============================================================

alter table profiles add constraint is_verified_requires_paid_plan
  check (not is_verified or plan in ('pro', 'elite'));

create or replace function protect_profile_columns()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if not (auth.role() is null or auth.role() = 'service_role' or is_admin()) then
    new.is_admin := old.is_admin;
    new.is_banned := old.is_banned;
    new.is_verified := old.is_verified;
    new.stripe_customer_id := old.stripe_customer_id;
    if new.plan is distinct from old.plan and new.plan <> 'starter' then
      new.plan := old.plan;
    end if;
  end if;

  -- Universal invariant, regardless of caller (including admins and
  -- service_role): verified status requires a paid plan right now, not
  -- just at the moment it was granted.
  if new.plan not in ('pro', 'elite') then
    new.is_verified := false;
  end if;

  return new;
end;
$$;

create table if not exists verification_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  note text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references profiles(id) on delete set null
);

create index if not exists verification_requests_user_idx on verification_requests (user_id, created_at desc);

-- only one open request per person at a time — the UI hides the "Request
-- verification" button while one is pending anyway, this is the backstop
create unique index if not exists verification_requests_one_pending_per_user
  on verification_requests (user_id) where (status = 'pending');

alter table verification_requests enable row level security;

drop policy if exists verification_requests_select on verification_requests;
create policy verification_requests_select on verification_requests for select using (
  user_id = auth.uid() or is_admin()
);

drop policy if exists verification_requests_insert on verification_requests;
create policy verification_requests_insert on verification_requests for insert with check (
  user_id = auth.uid()
  and status = 'pending'
  and exists (select 1 from profiles p where p.id = auth.uid() and p.plan in ('pro', 'elite'))
);

drop policy if exists verification_requests_delete on verification_requests;
create policy verification_requests_delete on verification_requests for delete using (
  (user_id = auth.uid() and status = 'pending') or is_admin()
);

-- Approve/deny in one call: updates the request AND, on approval,
-- profiles.is_verified — security definer + its own is_admin() check
-- (not just RLS) because this needs to touch a row (profiles) the calling
-- admin doesn't own, same reasoning admin_delete_profile already uses.
create or replace function admin_review_verification_request(p_request_id uuid, p_approve boolean)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_user_id uuid;
  v_plan text;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;

  select user_id into v_user_id from verification_requests where id = p_request_id and status = 'pending';
  if v_user_id is null then
    raise exception 'request not found or already reviewed';
  end if;

  if p_approve then
    select plan into v_plan from profiles where id = v_user_id;
    if v_plan not in ('pro', 'elite') then
      raise exception 'this account is not on Pro or Elite — they need to upgrade before they can be verified';
    end if;
  end if;

  update verification_requests
  set status = case when p_approve then 'approved' else 'denied' end,
      reviewed_at = now(),
      reviewed_by = auth.uid()
  where id = p_request_id;

  if p_approve then
    update profiles set is_verified = true where id = v_user_id;
  end if;
end;
$$;

grant execute on function admin_review_verification_request(uuid, boolean) to authenticated;

-- ============================================================
-- Done.
-- ============================================================
