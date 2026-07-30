-- ============================================================
-- 028 — Admin analytics aggregate counts
-- Additive on top of 002 + 004 + ... + 027.
--
-- The Admin Panel's new Analytics tab (replacing the old standalone
-- Events tab — event management moved into a collapsed sub-view within
-- it) needs numbers from `messages` and `scout_history`, both of which
-- store real private content (DM text, AI Scout conversations) and are
-- intentionally NOT admin-readable at the row level (messages_read is
-- sender/recipient-only; scout_history has no admin-read policy at
-- all). Rather than loosening either of those, this adds one
-- `security definer` function that returns only pre-aggregated counts
-- — never raw rows, never message/conversation content — same
-- is_admin()-gated pattern already used throughout this schema.
--
-- Everything else the Analytics tab needs (signups over time, plan/
-- occupation/verification mix, follows for the top-followed
-- leaderboard) is already readable by an admin directly via existing
-- policies (profiles_admin_read, posts_read, follows_read), so no
-- other new database objects are needed for this feature.
-- ============================================================

create or replace function admin_analytics_counts()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  result jsonb;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select jsonb_build_object(
    'messages_total', (select count(*) from messages),
    'messages_7d', (select count(*) from messages where created_at > now() - interval '7 days'),
    'scout_conversations_total', (select count(*) from scout_history),
    'scout_users_total', (select count(distinct user_id) from scout_history),
    'push_subscribers_total', (select count(distinct user_id) from push_subscriptions)
  ) into result;
  return result;
end;
$$;

grant execute on function admin_analytics_counts() to authenticated;

-- ============================================================
-- Done.
-- ============================================================
