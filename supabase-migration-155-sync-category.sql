-- ============================================================
-- 155 — sync_athlete_actions() seeds a category ON INSERT ONLY
--
-- *** APPLIED 2026-10-14. Verified on live data: a step whose category had
--     been set to "film" by hand kept it across a real tick and un-tick from
--     the app, while status moved open -> completed -> open. ***
--
-- Scout can now propose what KIND of work a step is, validated server-side
-- against migration 144's CHECK before it ever reaches storage. That value
-- rides the jsonb step as `category`, and this teaches the sync to use it when
-- it first creates the row.
--
-- ON INSERT ONLY, AND THAT IS THE WHOLE DESIGN. The category appears in the
-- INSERT column list and NOT in the DO UPDATE SET. So:
--   * a new step is created with the kind Scout proposed, rather than "other";
--   * an athlete who then changes it in the step editor is never overruled,
--     no matter how many times the sync runs afterwards;
--   * a step that already exists keeps whatever it has.
-- Putting category in the update clause instead would mean every tick of a
-- step quietly reverted a correction the athlete had made, which is the kind
-- of bug nobody reports because it looks like they misremembered.
--
-- Unrecognised or absent degrades to 'other', which is a real category rather
-- than a guess about the athlete's work.
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
           coalesce((m->>'done')::boolean, false)             as done,
           -- Validated here too. The client validates, Scout validates, and
           -- this is the last gate before the CHECK constraint itself.
           case when m->>'category' in ('training','recovery','testing','film','outreach',
                                        'academic','recruiting','application','competition',
                                        'profile','other')
                then m->>'category' else 'other' end          as category
    from pathway_plan p,
         lateral jsonb_array_elements(coalesce(p.milestones, '[]'::jsonb)) m
    where p.user_id = uid
      and nullif(m->>'id', '') is not null
  ),
  upserted as (
    insert into athlete_actions
      (user_id, title, due_on, due_src, stage_id, status, completed_at, legacy_milestone_id, category)
    select uid, s.title, s.due_on, s.due_src, s.stage_id,
           case when s.done then 'completed' else 'open' end,
           case when s.done then now() else null end,
           s.sid, s.category
    from steps s
    on conflict (user_id, legacy_milestone_id) where legacy_milestone_id is not null
    do update set
      title        = excluded.title,
      due_on       = excluded.due_on,
      due_src      = excluded.due_src,
      stage_id     = excluded.stage_id,
      status       = excluded.status,
      completed_at = case when excluded.status = 'completed'
                          then coalesce(athlete_actions.completed_at, excluded.completed_at)
                          else null end,
      updated_at   = now()
    -- category is DELIBERATELY ABSENT from this list. See the header.
    returning 1
  ),
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

-- ============================================================
-- VERIFY AFTER APPLYING
--   select * from sync_athlete_actions();   -- as a signed-in athlete, twice
--   -- second call must report the same synced count and dropped = 0
--   select title, category from athlete_actions;
--   -- a category an athlete set by hand must be unchanged after the call
-- ============================================================
