-- ============================================================
-- 068 — Lifetime free AI budget (distinct from the recurring daily cap)
-- scout_daily_usage (053) resets every UTC day forever — a free-plan
-- account gets FREE_DAILY_LIMIT questions every single day, indefinitely.
-- The product brief's philosophy is "GOLSZ sells athlete progression, not
-- AI questions" — the free plan should be a bounded trial that pushes
-- toward a paid plan once the athlete has gotten real value, not an
-- unlimited-duration free tier. This adds a second, separate, NEVER-
-- resetting counter on profiles that only applies to plan = 'free';
-- paid plans (starter/pro/elite) are governed purely by their existing
-- daily caps and never touch this column.
--
-- reserve_free_ai_question()/release_free_ai_question() mirror
-- reserve_scout_question()/release_scout_question() (053) exactly —
-- same atomic UPDATE...RETURNING row-lock pattern, same reserve-before-
-- call / release-on-failure contract, same server-role-only access.
-- ============================================================

alter table profiles add column if not exists free_ai_lifetime_used int not null default 0;

create or replace function reserve_free_ai_question(p_user uuid, p_lifetime_limit int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_used int;
begin
  update profiles
  set free_ai_lifetime_used = case when free_ai_lifetime_used < p_lifetime_limit
                                    then free_ai_lifetime_used + 1
                                    else free_ai_lifetime_used end
  where id = p_user
  returning free_ai_lifetime_used into v_used;

  return jsonb_build_object('allowed', v_used <= p_lifetime_limit, 'used', v_used, 'limit', p_lifetime_limit);
end;
$$;

create or replace function release_free_ai_question(p_user uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update profiles
  set free_ai_lifetime_used = greatest(free_ai_lifetime_used - 1, 0)
  where id = p_user;
end;
$$;

revoke execute on function reserve_free_ai_question(uuid, int) from anon;
revoke execute on function reserve_free_ai_question(uuid, int) from authenticated;
revoke execute on function reserve_free_ai_question(uuid, int) from public;
grant execute on function reserve_free_ai_question(uuid, int) to service_role;

revoke execute on function release_free_ai_question(uuid) from anon;
revoke execute on function release_free_ai_question(uuid) from authenticated;
revoke execute on function release_free_ai_question(uuid) from public;
grant execute on function release_free_ai_question(uuid) to service_role;
