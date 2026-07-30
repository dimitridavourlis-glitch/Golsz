-- ============================================================
-- 027 — Real auth-layer ban/delete, plus coaches/agents RLS
-- Additive on top of 002 + 004 + ... + 026.
--
-- Part 1: ban/delete now reach auth.users, not just profiles.
-- ------------------------------------------------------------
-- Until now, an admin banning or deleting someone only ever touched
-- `profiles` (is_banned) and the app-level tables (via
-- admin_delete_profile) — the real Supabase Auth credential in
-- auth.users was untouched, so a banned/deleted account's actual login
-- still worked at the auth layer even though the app locked/removed
-- everything else. Doing the real thing requires the Supabase Admin
-- API, which needs the service role key — something only a server can
-- hold — so this is now driven by api/admin-user-action.js instead of
-- a client-callable RPC.
--
-- admin_delete_profile(uuid) (migration 019/020) is dropped and
-- replaced by admin_delete_profile_data(uuid): same cleanup ordering
-- (scout_history / parent_links / athletes / coaches / agents deleted
-- explicitly, since those don't cascade from profiles), but WITHOUT the
-- final `delete from profiles` line and WITHOUT its own is_admin()
-- check — the real authorization now happens once, up front, in
-- api/admin-user-action.js (it verifies the caller's JWT and checks
-- profiles.is_admin itself before ever reaching this function), and
-- `profiles` itself is left for auth.users' own cascade to remove, once
-- api/admin-user-action.js deletes the real auth user via the Admin API.
-- That's also why this function is granted to service_role only, not
-- `authenticated` — unlike the old RPC, this one has no internal
-- authorization check of its own, so it must never be directly callable
-- by a regular client.
-- ============================================================

drop function if exists admin_delete_profile(uuid);

create or replace function admin_delete_profile_data(p_target uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  delete from scout_history where user_id = p_target;
  delete from parent_links where athlete_id = p_target or parent_id = p_target;
  delete from athletes where id = p_target;
  delete from coaches where id = p_target;
  delete from agents where id = p_target;
end;
$$;

revoke all on function admin_delete_profile_data(uuid) from public, authenticated, anon;
grant execute on function admin_delete_profile_data(uuid) to service_role;

-- ============================================================
-- Part 2: coaches/agents RLS — currently enabled with zero policies,
-- meaning fully locked even to their own owner. Nothing signs anyone up
-- with a populated row in either table yet (the app currently reuses
-- `athletes` for every occupation's extra fields — see ProfileEditor in
-- golsz-app.html), so this doesn't change any current behavior; it just
-- means these tables are actually usable, owner-only, the moment
-- something starts writing to them, instead of silently rejecting every
-- read/write forever. Same simple owner-only shape push_subscriptions
-- (migration 014) uses, since both tables are keyed 1:1 by
-- `id = profiles.id`, not a separate `user_id` column.
-- ============================================================

drop policy if exists coaches_rw on coaches;
create policy coaches_rw on coaches for all using (
  id = auth.uid()
) with check (
  id = auth.uid()
);

drop policy if exists agents_rw on agents;
create policy agents_rw on agents for all using (
  id = auth.uid()
) with check (
  id = auth.uid()
);

-- ============================================================
-- Done.
-- ============================================================
