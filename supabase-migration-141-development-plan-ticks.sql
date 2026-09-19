-- 141 — a tick per habit per day. Applied to production 2026-09-19.
--
-- WHAT ALREADY EXISTS AND WHY NONE OF IT FITS (checked before writing this):
--   * daily_activity (031) is (user_id, activity_date, minutes). Per day, but
--     it has no idea which habit — it answers "were they here", not "did they
--     sleep eight hours".
--   * development_plan_items.status (075) is 'active' | 'done' | 'paused' —
--     ONE lifetime status per habit. Ticking "Get 8 hours of sleep" done today
--     currently marks it finished forever, which is the opposite of a habit.
--   * athlete_diary_entries (095) is per day but has FIXED columns
--     (nutrition_check, hydration_check, sleep_hours...). It cannot hold a tick
--     for a habit the athlete wrote themselves. It is also a schema-only shell:
--     no client code reads or writes it, by 095's own stated intent.
--
-- So: one row per (habit, day). Presence IS the tick — no boolean to get out of
-- sync, and un-ticking is a delete.
create table if not exists development_plan_ticks (
  item_id uuid not null references development_plan_items(id) on delete cascade,
  -- Denormalised from the item so RLS is a column comparison rather than a
  -- subquery on every row read. The FK above keeps it honest, and the insert
  -- policy below checks BOTH, so a forged user_id cannot be written.
  user_id uuid not null references profiles(id) on delete cascade,
  tick_date date not null default current_date,
  created_at timestamptz not null default now(),
  primary key (item_id, tick_date)
);

create index if not exists development_plan_ticks_user_date_idx
  on development_plan_ticks (user_id, tick_date desc);

alter table development_plan_ticks enable row level security;

-- Self-service only, same as development_plan_items and pathway_plan. NO admin
-- read policy: this is personal health-adjacent data about a minor, and 075
-- deliberately withheld admin visibility from the parent table for the same
-- reason. Self-only, with no parent branch: parent accounts were turned off
-- in 144, and a policy granting access nobody should have is not worth keeping
-- warm for a feature that may come back differently.
drop policy if exists development_plan_ticks_own on development_plan_ticks;
create policy development_plan_ticks_own on development_plan_ticks
  for select to authenticated using (user_id = auth.uid());

drop policy if exists development_plan_ticks_insert on development_plan_ticks;
create policy development_plan_ticks_insert on development_plan_ticks
  for insert to authenticated with check (
    user_id = auth.uid()
    -- The habit must be theirs too. Without this, a valid user_id plus someone
    -- else's item_id would attach a tick to a stranger's habit.
    and exists (select 1 from development_plan_items d
                 where d.id = item_id and d.user_id = auth.uid())
  );

drop policy if exists development_plan_ticks_delete on development_plan_ticks;
create policy development_plan_ticks_delete on development_plan_ticks
  for delete to authenticated using (user_id = auth.uid());

comment on table development_plan_ticks is
  'One row per habit per day; presence is the tick, un-ticking is a delete. development_plan_items.status stays what it always was — the habit lifecycle (active/paused/retired) — and is NOT a daily state.';
