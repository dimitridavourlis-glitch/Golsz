-- ============================================================
-- 053 — Atomic daily-usage reservation
-- Golsz Multi-Model AI Scout & Cost-Control System (approved plan).
--
-- Fixes a real race condition in increment_scout_usage() (migration
-- ~008): that function inserts a scout_history marker row
-- UNCONDITIONALLY, then counts same-day markers — the actual limit
-- check (`calls > limit`) happens afterward, in api/scout.js. Two
-- concurrent requests near a plan's daily limit (e.g. two browser
-- tabs) can each insert their own marker and each read a count that
-- doesn't yet reflect the other's insert, letting both through when
-- only one slot remained.
--
-- scout_daily_usage is one row per (user_id, usage_date, UTC).
-- reserve_scout_question() does the increment-and-check as a single
-- atomic statement (INSERT ... ON CONFLICT ... DO UPDATE) — Postgres
-- row-locks the (user_id, usage_date) row for the duration, so a
-- concurrent second call genuinely waits for the first to commit
-- before it sees (and acts on) the current count. No check-then-act
-- window exists.
--
-- release_scout_question() gives the slot back when a reservation
-- succeeded but the request failed before any model was actually
-- called (e.g. a config error) — "retries caused by provider
-- failures must not count as additional user questions."
--
-- record_scout_usage_cost() adds the real token/cost numbers to the
-- same day's row once a reply actually completes — reservation and
-- cost-recording are separate calls because the cost isn't known
-- until after the model responds.
--
-- Server-role only (service key), same access pattern as
-- increment_scout_usage; the old function is left in place unused
-- (only api/scout.js's meter() called it, and that call site is being
-- replaced) rather than dropped, to avoid touching anything else that
-- might reference it.
-- ============================================================

create table if not exists scout_daily_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  usage_date date not null,
  questions_used int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  total_cost numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, usage_date)
);

create index if not exists scout_daily_usage_date_idx on scout_daily_usage (usage_date);

alter table scout_daily_usage enable row level security;

create policy scout_daily_usage_read on scout_daily_usage
  for select using (auth.uid() = user_id);

create or replace function reserve_scout_question(p_user uuid, p_plan_limit int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_used int;
begin
  insert into scout_daily_usage (user_id, usage_date, questions_used)
  values (p_user, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, usage_date) do update
    set questions_used = case when scout_daily_usage.questions_used < p_plan_limit
                               then scout_daily_usage.questions_used + 1
                               else scout_daily_usage.questions_used end,
        updated_at = now()
  returning questions_used into v_used;

  return jsonb_build_object('allowed', v_used <= p_plan_limit, 'used', v_used, 'limit', p_plan_limit);
end;
$$;

create or replace function release_scout_question(p_user uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update scout_daily_usage
  set questions_used = greatest(questions_used - 1, 0), updated_at = now()
  where user_id = p_user and usage_date = (now() at time zone 'utc')::date;
end;
$$;

create or replace function record_scout_usage_cost(p_user uuid, p_cost numeric, p_input_tokens int, p_output_tokens int)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update scout_daily_usage
  set total_cost = total_cost + coalesce(p_cost, 0),
      input_tokens = input_tokens + coalesce(p_input_tokens, 0),
      output_tokens = output_tokens + coalesce(p_output_tokens, 0),
      updated_at = now()
  where user_id = p_user and usage_date = (now() at time zone 'utc')::date;
end;
$$;

revoke execute on function reserve_scout_question(uuid, int) from anon;
revoke execute on function reserve_scout_question(uuid, int) from authenticated;
revoke execute on function reserve_scout_question(uuid, int) from public;
grant execute on function reserve_scout_question(uuid, int) to service_role;

revoke execute on function release_scout_question(uuid) from anon;
revoke execute on function release_scout_question(uuid) from authenticated;
revoke execute on function release_scout_question(uuid) from public;
grant execute on function release_scout_question(uuid) to service_role;

revoke execute on function record_scout_usage_cost(uuid, numeric, int, int) from anon;
revoke execute on function record_scout_usage_cost(uuid, numeric, int, int) from authenticated;
revoke execute on function record_scout_usage_cost(uuid, numeric, int, int) from public;
grant execute on function record_scout_usage_cost(uuid, numeric, int, int) to service_role;
