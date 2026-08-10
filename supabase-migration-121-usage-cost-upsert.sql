-- ============================================================
-- 121 — record_scout_usage_cost() can no longer lose a cost  [BUG FIX]
--
-- Found by the full audit, empirically: one real Scout message was sent
-- through the live app, and afterwards production showed
--
--   scout_daily_usage rows today ... 0
--   cost today ..................... 0
--   latest usage_date .............. yesterday
--
-- ROOT CAUSE
-- api/scout.js gates the quota reservation on the caller not being an admin:
--
--     if (!isAdmin && !aiUnlimited) { await reserveScoutQuestion(...) }
--
-- and reserve_scout_question() is what CREATES the day's scout_daily_usage
-- row. record_scout_usage_cost() was UPDATE-only. So for any admin or
-- ai_unlimited account there was no row to update and the cost write was a
-- silent no-op: Anthropic bills the call, GOLSZ records zero.
--
-- Today that is one account. The moment ai_unlimited is handed to testers,
-- partners or a promo cohort, the Admin Panel's margin card — the single
-- number the whole cost-control system exists to protect — starts
-- under-reporting with no signal that it is doing so.
--
-- FIX
-- Make the write an upsert on the existing unique index
-- scout_daily_usage_user_id_usage_date_key (user_id, usage_date), so cost is
-- recorded independently of whether a quota was ever reserved.
--
-- questions_used is deliberately NOT incremented here, and deliberately
-- inserted as 0: an admin/unlimited call genuinely consumed no quota. Cost
-- accounting and quota accounting stay separate, which is the distinction
-- that was accidentally coupled before. On conflict the existing row's
-- questions_used is left exactly as reserve_scout_question set it.
--
-- Accumulation semantics are preserved: the previous body added to the
-- running totals, and the DO UPDATE branch still adds.
--
-- Signature, security definer, search_path and grants are unchanged, so this
-- replaces the function rather than overloading it.
--
-- NO ENTITLEMENT CHANGES. Telemetry only. Nothing here gates a request,
-- grants a plan, or alters a limit.
-- ============================================================

create or replace function record_scout_usage_cost(
  p_user uuid,
  p_cost numeric,
  p_input_tokens integer,
  p_output_tokens integer
)
returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  insert into scout_daily_usage (user_id, usage_date, questions_used, input_tokens, output_tokens, total_cost)
  values (p_user, current_date, 0, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0), coalesce(p_cost, 0))
  on conflict (user_id, usage_date) do update
    set input_tokens  = scout_daily_usage.input_tokens  + coalesce(excluded.input_tokens, 0),
        output_tokens = scout_daily_usage.output_tokens + coalesce(excluded.output_tokens, 0),
        total_cost    = scout_daily_usage.total_cost    + coalesce(excluded.total_cost, 0);
end;
$$;

-- Verification (rolled back — proves a row is CREATED for a user who never
-- reserved a question today, which is the exact case that silently lost cost):
--   begin;
--     select record_scout_usage_cost('<ADMIN-UUID>'::uuid, 0.0123, 100, 50);
--     select user_id, usage_date, questions_used, input_tokens, output_tokens, total_cost
--       from scout_daily_usage where usage_date = current_date;
--     -- expect one row, questions_used = 0, total_cost = 0.0123
--     select record_scout_usage_cost('<ADMIN-UUID>'::uuid, 0.0100, 10, 5);
--     -- expect the SAME row, total_cost now 0.0223 (accumulates, no duplicate)
--   rollback;
