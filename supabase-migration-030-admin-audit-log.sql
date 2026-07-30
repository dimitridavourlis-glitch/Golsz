-- ============================================================
-- 030 — Admin action audit log
-- Additive on top of 002 + 004 + ... + 029.
--
-- Every admin action so far (ban, delete, plan changes, verified_tier
-- changes, moderation, event management) happened with no record of who
-- did it or when — if an admin account were ever compromised or misused,
-- there'd be nothing to review afterward. This adds a real log, and
-- makes it tamper-resistant from the very accounts it's auditing:
--
--   - No insert/update/delete policy exists for `authenticated` at all —
--     the only ways a row can ever get written are (a) service_role
--     (api/admin-user-action.js, which bypasses RLS entirely) or
--     (b) log_admin_action(), a security definer RPC that always sets
--     admin_id to auth.uid() itself, ignoring anything the caller
--     passes — so a compromised admin session can log real actions
--     under their own name, but can never forge an entry claiming
--     someone else did something, or blank out their own trail.
--   - Only admins can read it (is_admin()), same as everything else
--     admin-only in this schema.
-- ============================================================

create table if not exists admin_action_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references profiles(id) on delete set null,
  action text not null,
  target_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists admin_action_log_created_idx on admin_action_log (created_at desc);

alter table admin_action_log enable row level security;

drop policy if exists admin_action_log_read on admin_action_log;
create policy admin_action_log_read on admin_action_log for select using (
  is_admin()
);

create or replace function log_admin_action(p_action text, p_target_id uuid, p_detail jsonb default null)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  insert into admin_action_log (admin_id, action, target_id, detail)
  values (auth.uid(), p_action, p_target_id, p_detail);
end;
$$;

grant execute on function log_admin_action(text, uuid, jsonb) to authenticated;

-- ============================================================
-- Done.
-- ============================================================
