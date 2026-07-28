-- ============================================================
-- 019 — Admin: ban accounts, delete accounts, block events
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 +
-- 012 + 013 + 014 + 015 + 016 + 017 + 018.
--
-- Three new admin-panel actions:
-- 1) Ban an account — profiles.is_banned, enforced the same way
--    is_restricted_minor() already is: a banned athlete can't post
--    (posts_write) and disappears from Discover (athletes_read), and the
--    client force-signs them out on their next load (see Root() in
--    golsz-app.html). This does NOT disable their Supabase auth login
--    itself — that requires the Admin API with a service-role key, which
--    this project doesn't have a server endpoint for yet (same gap noted
--    for account deletion below). A banned user's session gets killed
--    client-side the moment the app checks profiles.is_banned; they could
--    only get back in by signing in again, which the client-side gate
--    also catches. Real, unconditional login-disabling needs a follow-up
--    serverless endpoint (pattern: api/scout.js) using
--    SUPABASE_SERVICE_KEY + supabase.auth.admin.updateUserById(id,
--    { ban_duration: '876000h' }).
-- 2) Delete an account — admin_delete_profile() RPC. Deletes the
--    athletes/coaches/agents/parent_links/scout_history rows for that
--    user explicitly (their cascade behavior isn't documented anywhere in
--    this schema's history — see the file-level warning at the top of
--    this repo's CLAUDE.md — so this doesn't rely on guessing it), then
--    deletes profiles itself, which *is* confirmed on delete cascade for
--    posts/post_likes/post_reports/blocks/follows/messages/
--    hidden_conversations/push_subscriptions. Like the ban above, this
--    does not remove the underlying auth.users row (needs the Admin API).
-- 3) Block an event — events.is_blocked. Hides it from everyone except
--    admins via events_read, without deleting it (reversible), for cases
--    where you want to pull a listing without losing its data.
-- ============================================================

alter table profiles add column if not exists is_banned boolean not null default false;
alter table events add column if not exists is_blocked boolean not null default false;

create or replace function is_banned(p_user uuid)
returns boolean language sql security definer set search_path to 'public' as $$
  select coalesce((select is_banned from profiles where id = p_user), false);
$$;

-- posts_write: extend the existing is_restricted_minor gate with the same
-- shape for banned accounts.
drop policy if exists posts_write on posts;
create policy posts_write on posts for insert with check (
  (author_id = auth.uid() and not is_restricted_minor(auth.uid()) and not is_banned(auth.uid()))
  or is_parent_of(author_id)
);

-- athletes_read: banned athletes keep seeing their own row (so the app can
-- still show them the ban message) but disappear from everyone else's
-- Discover, same visibility shape as restricted minors.
drop policy if exists athletes_read on athletes;
create policy athletes_read on athletes for select using (
  (not is_restricted_minor(id) or id = auth.uid() or is_parent_of(id) or is_admin())
  and (not is_banned(id) or id = auth.uid() or is_admin())
);

-- events_read: blocked events stay visible to admins only (so they can be
-- unblocked later) — everyone else, including the event's own creator,
-- loses visibility the same way a private event is scoped.
drop policy if exists events_read on events;
create policy events_read on events for select using (
  (visibility = 'public' or created_by = auth.uid() or is_admin())
  and (not is_blocked or is_admin())
);

-- Deletes a profile and everything not already covered by an "on delete
-- cascade" foreign key to profiles(id). security definer + the is_admin()
-- check inside (rather than relying on RLS) because this needs to delete
-- rows the calling admin doesn't own — ordinary RLS delete policies are
-- scoped to auth.uid() = owner, which doesn't fit "admin deletes someone
-- else's account."
create or replace function admin_delete_profile(p_target uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  if p_target = auth.uid() then
    raise exception 'cannot delete your own account';
  end if;
  delete from scout_history where user_id = p_target;
  delete from parent_links where athlete_id = p_target or parent_id = p_target;
  delete from athletes where id = p_target;
  delete from coaches where id = p_target;
  delete from agents where id = p_target;
  delete from profiles where id = p_target;
end;
$$;

grant execute on function admin_delete_profile(uuid) to authenticated;

-- ============================================================
-- Done.
-- ============================================================
