-- 140 — request_parent_link was an account-existence oracle.
--
-- It returned FALSE when no auth.users row matched the email and TRUE when one
-- did, so any signed-in account could test addresses one at a time and learn
-- which belong to GOLSZ users. On a platform whose users are children, "does
-- this child have an account here" is exactly the question not to answer.
--
-- The return value now says only whether the REQUEST was accepted, which is
-- all the caller legitimately needs: it does not report whether a matching
-- account exists. The insert stays conditional, so a request for an address
-- nobody owns still creates nothing.
--
-- The caller's copy has to match. golsz-app.html now shows the same
-- "if that account exists, we've sent a request" message either way — a
-- message that varies by outcome rebuilds the oracle in the UI.
--
-- WHAT IS NOT CHANGED, deliberately:
--   * a pending row is still created without the child's consent. That is what
--     PENDING means here, and the child approves or denies it — parent_links
--     _approve already restricts approval to athlete_id = auth.uid(), and
--     parent_links_delete lets the child deny. Removing the pending row would
--     remove the mechanism, not the problem.
--   * self-linking is still refused.
--   * a nonexistent email still inserts nothing.
--
-- Idempotent. Safe to re-run.
create or replace function request_parent_link(p_child_email text, p_relationship text default null)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare v_child uuid;
begin
  if auth.uid() is null then return false; end if;

  select id into v_child from auth.users where email = p_child_email;

  -- Conditional insert, unconditional answer. The caller learns that their
  -- request was taken, never whether the address matched an account.
  if v_child is not null and v_child <> auth.uid() then
    insert into parent_links (parent_id, athlete_id, relationship)
    values (auth.uid(), v_child, p_relationship)
    on conflict (parent_id, athlete_id) do nothing;
  end if;

  return true;
end $$;

revoke all on function request_parent_link(text, text) from public;
grant execute on function request_parent_link(text, text) to authenticated;
