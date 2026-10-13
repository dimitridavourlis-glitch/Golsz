-- ============================================================
-- 152 — sync_athlete_actions(): mirror the jsonb into the table, atomically
--
-- *** NOT YET APPLIED *** — shown for approval.
--
-- WHY A FUNCTION AND NOT CLIENT CODE.
--
-- The obvious dual-write is: on every pathway_plan write, also write the
-- matching athlete_actions rows from the browser. That was designed in full
-- and then rejected, by two independent adversarial reviews that converged on
-- the same defect. The client cannot do this atomically — it is one select
-- plus N updates plus an insert plus a drop-update — so it needs a fingerprint
-- cache to avoid re-diffing on every save, and the moment a pass fails
-- half-way the fingerprint names a state the table no longer holds. The next
-- write that returns to that state is then skipped entirely. Returning to a
-- previous state is not exotic on this screen: it is tick/untick, and
-- delete/undo, which splices the identical item back.
--
-- Every bit of that machinery exists to simulate a transaction. Postgres
-- already has transactions. One statement, one round trip, no cache, no
-- queue, no partial states, and calling it twice is a no-op.
--
-- IT ALSO SOLVES TWO THINGS THE CLIENT VERSION COULD NOT:
--
--   * completed_at survives. coalesce(existing, new) keeps the FIRST
--     completion moment instead of overwriting it with the time of whatever
--     write happened to run next. The client design admitted it could not do
--     this; the completed_coherent CHECK forces a drop to null the column, so
--     only a server-side coalesce can carry real history back.
--   * A step with no id cannot cause a drop. Rows are keyed by the step's own
--     id, so an id-less step simply never produces a row — and the drop pass
--     only touches rows that HAVE a legacy id and are absent from the array.
--     In the client design, a step the row-builder skipped was still counted
--     as gone, which marked a LIVE step's row dropped.
--
-- NOTE ON 151: this makes migration 151 optional rather than required. The
-- ON CONFLICT below is raw SQL and CAN name the partial index's predicate;
-- it was PostgREST's on_conflict, which only takes column names, that could
-- not. 151 is still worth applying as hygiene, but nothing here waits on it.
--
-- SECURITY. security definer so it can write athlete_actions in one
-- statement, but it reads auth.uid() and writes ONLY that athlete's rows.
-- It takes no arguments at all: there is no user_id parameter to forge.
-- search_path is pinned so a caller cannot shadow a referenced object.
-- ============================================================

create or replace function public.sync_athlete_actions()
returns table (synced integer, dropped integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  n_synced integer := 0;
  n_dropped integer := 0;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  with steps as (
    select nullif(m->>'id', '')                               as sid,
           left(coalesce(m->>'label', ''), 120)               as title,
           nullif(m->>'due', '')::date                        as due_on,
           nullif(m->>'due_src', '')                          as due_src,
           nullif(m->>'stage', '')                            as stage_id,
           coalesce((m->>'done')::boolean, false)             as done
    from pathway_plan p,
         lateral jsonb_array_elements(coalesce(p.milestones, '[]'::jsonb)) m
    where p.user_id = uid
      and nullif(m->>'id', '') is not null
  ),
  -- One row per step the athlete actually has. The predicate on ON CONFLICT
  -- is REQUIRED: athlete_actions_legacy_idx is partial, and Postgres will not
  -- infer a partial unique index without it (42P10). Harmless if 151 has
  -- replaced it with a plain constraint — a matching predicate still infers.
  upserted as (
    insert into athlete_actions
      (user_id, title, due_on, due_src, stage_id, status, completed_at, legacy_milestone_id)
    select uid, s.title, s.due_on, s.due_src, s.stage_id,
           case when s.done then 'completed' else 'open' end,
           case when s.done then now() else null end,
           s.sid
    from steps s
    on conflict (user_id, legacy_milestone_id) where legacy_milestone_id is not null
    do update set
      title        = excluded.title,
      due_on       = excluded.due_on,
      due_src      = excluded.due_src,
      stage_id     = excluded.stage_id,
      status       = excluded.status,
      -- THE FIRST completion moment wins. Overwriting it with now() on every
      -- later save would turn a real date into "whenever the athlete last
      -- touched anything", which is worse than having no date.
      completed_at = case when excluded.status = 'completed'
                          then coalesce(athlete_actions.completed_at, excluded.completed_at)
                          else null end,
      updated_at   = now()
    returning 1
  ),
  -- Marked, never deleted: the row keeps its id and its history. Only rows
  -- that came from a step (legacy id present) and are no longer in the array.
  -- A row with no legacy id was created directly in the table and is none of
  -- this function's business.
  gone as (
    update athlete_actions a
       set status = 'dropped', completed_at = null, updated_at = now()
     where a.user_id = uid
       and a.legacy_milestone_id is not null
       and a.status <> 'dropped'
       and not exists (select 1 from steps s where s.sid = a.legacy_milestone_id)
    returning 1
  )
  select (select count(*) from upserted), (select count(*) from gone)
    into n_synced, n_dropped;

  return query select n_synced, n_dropped;
end;
$$;

revoke all on function public.sync_athlete_actions() from public, anon;
grant execute on function public.sync_athlete_actions() to authenticated;

comment on function public.sync_athlete_actions() is
  'Reconciles athlete_actions with pathway_plan.milestones for the CALLING athlete only. Atomic, idempotent, takes no arguments so there is no user_id to forge. Keeps the first completed_at. Marks vanished steps dropped rather than deleting them.';

-- ============================================================
-- VERIFY AFTER APPLYING
--   select * from sync_athlete_actions();          -- as a signed-in athlete
--   -- expect synced = the number of steps with ids, dropped = 0 on a tree
--   -- that is already in sync. Run it twice: the second call must report the
--   -- same synced count and dropped = 0, because it is a no-op.
--   select count(*) from athlete_actions;          -- expect 2, unchanged
--   select proname, prosecdef from pg_proc where proname = 'sync_athlete_actions';
--   -- expect prosecdef = true
-- ============================================================
