-- ============================================================
-- 115 — Admin review queue for discovered knowledge (P1-9)
--
-- persistKnowledgeCandidate() in api/scout.js writes research findings into
-- golsz_knowledge as verification_status = 'discovered'. Migration 096's RLS
-- deliberately exposes only 'verified'/'active' to clients, which is the
-- structural guarantee behind "unverified model output is not global fact."
--
-- The gap: nothing could ever promote a row. No admin RPC, no UI, and the
-- read policy blocks an admin from even SEEING a discovered row through the
-- client. So GOLSZ Core could only ever be empty, every eligibility question
-- re-ran a paid web search, and candidates accumulated invisibly.
--
-- Two security-definer, is_admin()-gated functions close it. Both bypass the
-- read policy on purpose — that is the entire point of the review queue —
-- and neither is reachable without is_admin(), which is checked inside the
-- function body rather than relied on from the client.
--
-- Nothing here promotes anything automatically. A candidate becomes GOLSZ
-- knowledge only when a human reads it, sees its source URL, and says yes.
-- ============================================================

create or replace function admin_list_knowledge_candidates(p_limit int default 50)
returns table (
  id uuid, subject text, category text, sport text, country text,
  content text, source text, source_url text, confidence numeric,
  verification_status text, discovered_at timestamptz, recheck_after timestamptz
) language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  return query
    select k.id, k.subject, k.category, k.sport, k.country,
           k.content, k.source, k.source_url, k.confidence,
           k.verification_status, k.discovered_at, k.recheck_after
      from golsz_knowledge k
     where k.verification_status in ('discovered', 'candidate')
     order by k.discovered_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200));
end;
$$;

-- Approve -> 'verified' (immediately readable by Scout and athletes).
-- Reject  -> 'rejected' (kept, never shown; the record of what was refused
--            is worth more than the row is worth deleting).
create or replace function admin_review_knowledge(p_id uuid, p_approve boolean, p_notes text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare
  v_subject text;
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  select subject into v_subject from golsz_knowledge where id = p_id;
  if v_subject is null then
    raise exception 'candidate not found';
  end if;
  update golsz_knowledge
     set verification_status = case when p_approve then 'verified' else 'rejected' end,
         verified_at = case when p_approve then now() else null end,
         last_checked = now(),
         updated_at = now()
   where id = p_id;
  -- Append-only audit trail, same as every other admin action. Promoting a
  -- fact into something every athlete is told is a consequential act and
  -- should be attributable.
  insert into admin_action_log (admin_id, action, target_id, detail)
  values (auth.uid(),
          case when p_approve then 'knowledge_verified' else 'knowledge_rejected' end,
          p_id,
          jsonb_build_object('subject', v_subject, 'notes', p_notes));
end;
$$;

revoke execute on function admin_list_knowledge_candidates(int) from public, anon;
revoke execute on function admin_review_knowledge(uuid, boolean, text) from public, anon;
grant execute on function admin_list_knowledge_candidates(int) to authenticated;
grant execute on function admin_review_knowledge(uuid, boolean, text) to authenticated;

-- Verification:
--   select * from admin_list_knowledge_candidates(5);   -- as an admin
--   select admin_list_knowledge_candidates(5);          -- as a non-admin -> 'not authorized'
