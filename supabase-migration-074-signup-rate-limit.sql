-- ============================================================
-- 074 — Signup rate limiting (IP-based)
-- The brief's launch-blocker list flagged that the honeypot (migration 063)
-- is client-only — a script calling Supabase's signup API directly skips
-- Auth() entirely and never touches it. This adds a real server-side gate:
-- api/signup-guard.js reads the caller's IP from Vercel's x-forwarded-for
-- header (never trusted from the client body — a bot could put anything
-- there) and calls reserve_signup_attempt() before Auth's submit() ever
-- calls sb.auth.signUp(). Same atomic reserve-then-check idiom as
-- reserve_scout_question (053) / reserve_free_ai_question (068).
--
-- No RLS read/write grants to anon/authenticated at all — signup_attempts
-- is written exclusively through this security-definer RPC, called only
-- from the service-role signup-guard endpoint. A bot has no path to read
-- or forge its own counter down.
-- ============================================================

create table if not exists signup_attempts (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  attempt_date date not null,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(ip, attempt_date)
);

create index if not exists signup_attempts_date_idx on signup_attempts (attempt_date);

alter table signup_attempts enable row level security;
-- Deliberately zero policies — this table has no anon/authenticated access
-- path at all, only the security-definer RPC below (called with the
-- service-role key from api/signup-guard.js).

create or replace function reserve_signup_attempt(p_ip text, p_daily_limit int)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_count int;
begin
  if p_ip is null or p_ip = '' then
    -- No usable IP (e.g. a dev environment without x-forwarded-for) — fail
    -- open rather than blocking every signup from an unusual deployment.
    return jsonb_build_object('allowed', true, 'attempts', 0);
  end if;

  insert into signup_attempts (ip, attempt_date, attempts)
  values (p_ip, (now() at time zone 'utc')::date, 1)
  on conflict (ip, attempt_date) do update
    set attempts = signup_attempts.attempts + 1, updated_at = now()
  returning attempts into v_count;

  return jsonb_build_object('allowed', v_count <= p_daily_limit, 'attempts', v_count);
end;
$$;

-- Postgres auto-grants EXECUTE to PUBLIC on newly created functions, which
-- would let a bot call this RPC directly (via the Supabase REST API, with
-- just the anon key) and pass any forged p_ip it likes — completely
-- defeating the point, since the real IP must come from the server-side
-- x-forwarded-for header, never from the client. Revoke explicitly so only
-- the service role (used server-side by api/signup-guard.js) can call it.
revoke execute on function reserve_signup_attempt(text, int) from public, anon, authenticated;
