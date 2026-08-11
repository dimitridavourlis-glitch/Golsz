-- ============================================================
-- 125 — Let the athlete edit the few scout_context fields that are theirs.
--
-- WHY
-- The Plan redesign needs an athlete to be able to state a backup plan, and
-- to answer "Scout thinks NCAA might be a backup for you — is that right?"
-- with one tap. Both are writes to athletes.scout_context.
--
-- The client cannot do that today, by design. merge_scout_context() (migration
-- 050) is revoked from anon, authenticated AND public, granted only to
-- service_role, and its comment states "api/scout.js is the only writer". That
-- single-writer rule is worth keeping: it is what makes the
-- {value, source, confidence} discipline mean anything. A client that could
-- merge arbitrary jsonb into scout_context could write source:'athlete_stated'
-- onto a field the athlete never saw.
--
-- Adding an API route instead is not available: api/ is at exactly 12 of the
-- 12 functions a Vercel Hobby project may deploy.
--
-- So this adds a NARROW second writer rather than widening the existing one.
--
-- WHAT IT ALLOWS, AND NOTHING ELSE
--   • one field per call, from a hardcoded allowlist of athlete-authored
--     fields — not arbitrary jsonb, so no path to ai_meta, confidence, or any
--     field Scout infers
--   • only for the caller's own row, or a child whose parent link is APPROVED
--     (is_parent_of(), migration 086 — approved_at is not null; a
--     self-reported pending link grants nothing)
--   • source is FORCED to 'athlete_stated' server-side. It is never taken from
--     the caller. A client bug cannot write 'ai_inferred', and a malicious
--     client cannot launder an inference into a statement.
--   • an empty or null value DELETES the key rather than storing an empty
--     string, so "not set" stays a real absence rather than a blank that
--     renders as content.
--
-- WHY 'secondary_goal_declined' IS A FIELD
-- The brief's "No" answer must not merely clear the inference — Scout would
-- re-infer it next conversation and ask again. Clearing says "no value";
-- declining says "asked and answered". They are different facts and the UI
-- needs to tell them apart, which is the same distinction this codebase has
-- had to make repeatedly today (unknown vs empty vs false).
--
-- No existing behaviour changes. merge_scout_context() keeps its grants; this
-- is additive.
-- ============================================================

create or replace function set_athlete_context_field(
  p_athlete uuid,
  p_field   text,
  p_value   text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- Own row, or an APPROVED parent link. is_parent_of() carries the
  -- approved_at gate; do not reimplement that predicate here.
  if p_athlete <> auth.uid() and not is_parent_of(p_athlete) then
    raise exception 'not authorized for this athlete';
  end if;

  -- Allowlist. Deliberately tiny. Adding a field here is a decision that the
  -- athlete authors it directly, not that Scout infers it.
  if p_field not in ('secondary_goal', 'secondary_goal_pathway', 'secondary_goal_declined') then
    raise exception 'field % is not athlete-editable', p_field;
  end if;

  if p_value is null or btrim(p_value) = '' then
    -- Absence, not an empty string.
    update athletes
       set scout_context = coalesce(scout_context, '{}'::jsonb) - p_field
     where id = p_athlete;
  else
    update athletes
       set scout_context = coalesce(scout_context, '{}'::jsonb) || jsonb_build_object(
             p_field,
             jsonb_build_object(
               'value', btrim(p_value),
               -- NOT taken from the caller. This is the whole point.
               'source', 'athlete_stated',
               'confidence', 1,
               'updated_at', now()
             )
           )
     where id = p_athlete;
  end if;
end;
$$;

revoke execute on function set_athlete_context_field(uuid, text, text) from anon;
revoke execute on function set_athlete_context_field(uuid, text, text) from public;
grant  execute on function set_athlete_context_field(uuid, text, text) to authenticated;

comment on function set_athlete_context_field(uuid, text, text) is
  'Athlete-authored scout_context fields only. Allowlisted field names, own row or approved parent link, source always athlete_stated. merge_scout_context() remains service-role-only for everything Scout writes.';

-- Verification:
--   -- as an authenticated athlete, on their own row:
--   select set_athlete_context_field(auth.uid(), 'secondary_goal', 'finish my degree and play semi-pro');
--   select scout_context->'secondary_goal' from athletes where id = auth.uid();
--   -- expect {"value":"finish my degree and play semi-pro","source":"athlete_stated",...}
--
--   -- must fail:
--   select set_athlete_context_field(auth.uid(), 'dream_outcome', 'x');   -- not athlete-editable
--   select set_athlete_context_field('<someone else>', 'secondary_goal', 'x'); -- not authorized
--
--   -- clearing:
--   select set_athlete_context_field(auth.uid(), 'secondary_goal', null);
--   select scout_context ? 'secondary_goal' from athletes where id = auth.uid();  -- false
