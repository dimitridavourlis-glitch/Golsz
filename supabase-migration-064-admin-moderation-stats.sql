-- ============================================================
-- 064 — Admin moderation analytics
-- Golsz Trust & Safety Moderation System (approved plan).
--
-- One RPC following the exact admin_scout_model_mix()/
-- admin_analytics_counts() pattern already used by the Analytics tab —
-- extends that existing dashboard rather than adding a new one. Reason
-- codes (SPAM, RECRUITING_FRAUD) come from api/moderate.js's own
-- documented reason-code list, so these counts stay in sync with
-- whatever the classifier is actually allowed to emit.
-- ============================================================

create or replace function admin_moderation_stats()
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  result jsonb;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select jsonb_build_object(
    'moderation_items_today', (select count(*) from moderation_queue where created_at >= current_date),
    'blocked_today', (select count(*) from moderation_queue where decision = 'block' and created_at >= current_date),
    'spam_blocked_total', (select count(*) from moderation_queue where decision = 'block' and reason_codes @> array['SPAM']),
    'scam_blocked_total', (select count(*) from moderation_queue where decision = 'block' and reason_codes @> array['RECRUITING_FRAUD']),
    'avg_resolution_minutes', (
      select round(avg(extract(epoch from (resolved_at - created_at)) / 60)::numeric, 1)
      from moderation_queue where resolved_at is not null
    ),
    'appeals_pending', (select count(*) from moderation_appeals where status = 'pending'),
    'appeals_upheld', (select count(*) from moderation_appeals where status = 'upheld'),
    'appeals_overturned', (select count(*) from moderation_appeals where status = 'overturned'),
    'verification_pending', (select count(*) from verification_requests where status = 'pending'),
    'verification_approved', (select count(*) from verification_requests where status = 'approved'),
    'events_flagged_total', (select count(*) from events where is_blocked = true),
    'trust_score_buckets', (
      select coalesce(jsonb_object_agg(bucket, n), '{}'::jsonb)
      from (
        select
          case
            when trust_score < 20 then '0-19'
            when trust_score < 40 then '20-39'
            when trust_score < 60 then '40-59'
            when trust_score < 80 then '60-79'
            else '80-100'
          end as bucket,
          count(*) as n
        from profiles
        group by 1
      ) b
    )
  ) into result;
  return result;
end;
$$;

grant execute on function admin_moderation_stats() to authenticated;
