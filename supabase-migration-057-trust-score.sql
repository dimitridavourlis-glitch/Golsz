-- ============================================================
-- 057 — Trust score
-- Golsz Trust & Safety Moderation System (approved plan).
--
-- A computed 0-100 trust signal on profiles, built entirely from data
-- that already exists (moderation_queue history, post_reports against
-- the user, account age, is_banned, and the new identity_verified flag
-- from migration 058) rather than a new tracking system. Recomputed at
-- the moment something relevant changes (a moderation item gets
-- resolved, a report comes in, a ban/unban happens, a verification gets
-- approved) via recompute_trust_score() — not a cron job, since GOLSZ
-- has no scheduled-job infra today and every event that should move the
-- score is already a real, single mutation point.
--
-- Gates (wired in later migrations/code, not here): posting/messaging
-- rate limits for low-trust accounts, review priority in the moderation
-- queue, verification eligibility.
-- ============================================================

alter table profiles add column if not exists trust_score int not null default 50 check (trust_score between 0 and 100);

create or replace function recompute_trust_score(p_user uuid)
returns int language plpgsql security definer set search_path to 'public' as $$
declare
  v_score int := 50;
  v_created timestamptz;
  v_banned boolean;
  v_identity_verified boolean;
  v_violations int;
  v_reporters int;
  v_age_days int;
begin
  select created_at, is_banned, coalesce(identity_verified, false)
    into v_created, v_banned, v_identity_verified
  from profiles where id = p_user;

  if v_created is null then
    return v_score;
  end if;

  v_age_days := extract(day from (now() - v_created));
  v_score := v_score + least(20, (v_age_days / 90) * 5);

  if v_identity_verified then
    v_score := v_score + 10;
  end if;

  select count(*) into v_violations
  from moderation_queue
  where author_id = p_user and decision in ('block', 'review') and resolved_at is not null;
  v_score := v_score - least(45, v_violations * 15);

  select count(distinct reporter_id) into v_reporters
  from post_reports pr join posts p on p.id = pr.post_id
  where p.author_id = p_user;
  v_score := v_score - least(25, v_reporters * 5);

  if v_banned then
    v_score := v_score - 30;
  end if;

  v_score := greatest(0, least(100, v_score));
  update profiles set trust_score = v_score where id = p_user;
  return v_score;
end;
$$;

grant execute on function recompute_trust_score(uuid) to authenticated;
