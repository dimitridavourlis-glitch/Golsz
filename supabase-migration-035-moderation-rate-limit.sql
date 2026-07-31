-- ============================================================
-- 035 — Rate limit api/moderate.js
-- Additive on top of 002 + 004 + ... + 034.
--
-- Found during a full app audit: api/moderate.js required being signed
-- in but had no call-frequency cap of its own, unlike api/scout.js
-- (real per-plan daily limits via increment_scout_usage). A signed-in
-- account could script repeated direct calls to it outside the app's
-- UI to run up the Anthropic bill. This adds the same shape of
-- protection Scout already has: a per-user daily counter, incremented
-- and checked before the (paid) classifier call happens at all.
--
-- Same trust shape as increment_scout_usage: increment_moderation_usage
-- is granted only to `service_role`, never `authenticated` — a client
-- can't call it directly with someone else's user id to falsely max
-- out their daily count (a denial-of-service on that person's own
-- moderation checks). api/moderate.js resolves the real caller's id
-- itself from their verified JWT, then calls this via the service key.
-- ============================================================

create table if not exists moderation_check_usage (
  user_id uuid not null references profiles(id) on delete cascade,
  usage_date date not null default current_date,
  calls int not null default 0,
  primary key (user_id, usage_date)
);

alter table moderation_check_usage enable row level security;
-- Deliberately no policy for `authenticated` at all — only service_role
-- (via the RPC below, which is itself service_role-only) ever touches
-- this table.

create or replace function increment_moderation_usage(p_user uuid)
returns int language plpgsql security definer set search_path to 'public' as $$
declare v int;
begin
  insert into moderation_check_usage (user_id, usage_date, calls)
  values (p_user, current_date, 1)
  on conflict (user_id, usage_date) do update set calls = moderation_check_usage.calls + 1
  returning calls into v;
  return v;
end $$;

revoke all on function increment_moderation_usage(uuid) from public, authenticated, anon;
grant execute on function increment_moderation_usage(uuid) to service_role;

-- ============================================================
-- Done.
-- ============================================================
