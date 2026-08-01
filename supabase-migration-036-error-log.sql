-- ============================================================
-- 036 — Application error log (general monitoring, not just security)
-- Additive on top of 002 + 004 + ... + 035.
--
-- Distinct from the security alerts in migration-adjacent api/*.js
-- changes (those push-alert on two specific security signals). This is
-- broader: a place to actually see when something in the app just
-- breaks — an uncaught client-side JS error, or a real 500 from any
-- of the serverless functions — without needing a third-party service
-- like Sentry. Surfaced in a new Admin Panel "Errors" tab.
--
-- Same trust shape as moderation_queue/admin_action_log: no
-- `authenticated` UPDATE policy at all — only resolve_error_log_item()
-- (security definer, admin-gated) can mark something resolved. INSERT
-- is intentionally open to `anon` + `authenticated` (via
-- log_client_error()) since a real crash can happen before someone's
-- even signed in (e.g. on the signup screen) — a real, known trade-off
-- (a bad actor could spam junk rows) accepted for now given this is an
-- internal debugging tool at pre-launch scale, not hardened against
-- abuse yet. Server-side errors are written directly by the service
-- role from within each api/*.js file's own catch block.
-- ============================================================

create table if not exists error_log (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  message text not null,
  detail jsonb,
  url text,
  user_id uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references profiles(id) on delete set null
);

create index if not exists error_log_created_idx on error_log (created_at desc);
create index if not exists error_log_unresolved_idx on error_log (resolved_at) where resolved_at is null;

alter table error_log enable row level security;

drop policy if exists error_log_admin_read on error_log;
create policy error_log_admin_read on error_log for select using (
  is_admin()
);

-- Client-side crash reporting — callable by anon (errors can happen
-- before sign-in) as well as authenticated users. Always stamps
-- user_id from auth.uid() itself (null for anon), never trusting
-- whatever the client might claim about who they are.
create or replace function log_client_error(p_message text, p_detail jsonb default null, p_url text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  insert into error_log (source, message, detail, url, user_id)
  values ('client', left(coalesce(p_message, 'Unknown error'), 2000), p_detail, left(p_url, 500), auth.uid());
end;
$$;

grant execute on function log_client_error(text, jsonb, text) to authenticated, anon;

create or replace function resolve_error_log_item(p_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  update error_log set resolved_at = now(), resolved_by = auth.uid() where id = p_id;
end;
$$;

grant execute on function resolve_error_log_item(uuid) to authenticated;

-- ============================================================
-- Done.
-- ============================================================
