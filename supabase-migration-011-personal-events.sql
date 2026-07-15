-- ============================================================
-- 011 — Personal opportunities (save a post/message/manual entry to
-- your own private events list, distinct from the public events directory)
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010.
--
-- Reuses the existing events table rather than a parallel one — a
-- personal "add this trial to my events" entry and a public combine
-- listing are the same shape, just different visibility. events_write/
-- update/delete already scope to created_by = auth.uid() (or is_admin()),
-- so only events_read needs to change: private rows are now only visible
-- to their owner (and admins), where before every row was fully public.
-- ============================================================

alter table events add column if not exists visibility text not null default 'public' check (visibility in ('public','private'));
alter table events add column if not exists notes text;

drop policy if exists events_read on events;
create policy events_read on events for select using (
  visibility = 'public' or created_by = auth.uid() or is_admin()
);

-- ============================================================
-- Done.
-- ============================================================
