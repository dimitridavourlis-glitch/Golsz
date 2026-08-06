-- ============================================================
-- 070 — Self-service dismiss for "My Next Move"
-- next_best_action (068's typed-CTA follow-up) lives inside
-- athletes.scout_context.ai_meta, which only the service role can write
-- via merge_scout_context() (revoked from anon/authenticated/public,
-- migration ~050). A "mark done" click needs to clear just that one field
-- from the client, without a service-role round trip and without racing
-- the server's own ai_meta overwrites on the next real Scout turn — same
-- jsonb || merge-one-key pattern persistAiMeta() already uses server-side,
-- just auth.uid()-scoped instead of service-role.
-- ============================================================

create or replace function dismiss_next_move()
returns void language sql security definer set search_path to 'public' as $$
  update athletes
  set scout_context = coalesce(scout_context, '{}'::jsonb) || jsonb_build_object(
    'ai_meta', coalesce(scout_context->'ai_meta', '{}'::jsonb) || jsonb_build_object('next_best_action', null)
  )
  where id = auth.uid();
$$;

grant execute on function dismiss_next_move() to authenticated;
