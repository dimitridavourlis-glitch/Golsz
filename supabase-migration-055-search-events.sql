-- ============================================================
-- 055 — search_events(): database-first opportunity search
-- Golsz Multi-Model AI Scout & Cost-Control System (approved plan).
--
-- Mirrors search_players() (migration 022) exactly, for the events
-- table instead of athletes. Before this, "show me football trials in
-- Cyprus" had no database-first path at all — events already holds
-- real trials/camps/combines (used today only by the Admin Panel's
-- event manager), but Scout had no way to query it; the question would
-- fall through to general web_search (unverified) or a generic answer.
-- Wired into api/scout.js as a second tool alongside search_golsz_players
-- so Scout can only ever report real, verified GOLSZ events — never
-- invent a listing. Excludes blocked events, same as the public feed.
-- ============================================================

create or replace function search_events(
  p_sport text default null,
  p_location text default null,
  p_level text default null,
  p_after_date date default null,
  p_limit int default 10
)
returns table (
  id uuid,
  title text,
  sport text,
  location text,
  level text,
  event_date date,
  spots_available int
)
language sql security definer set search_path to 'public' as $$
  select e.id, e.title, e.sport, e.location, e.level, e.event_date, e.spots_available
  from events e
  where not e.is_blocked
    and e.event_date >= coalesce(p_after_date, current_date)
    and (p_sport is null or e.sport ilike p_sport)
    and (p_location is null or e.location ilike '%' || p_location || '%')
    and (p_level is null or e.level ilike p_level)
  order by e.event_date asc
  limit least(coalesce(p_limit, 10), 25);
$$;

grant execute on function search_events(text, text, text, date, int) to authenticated;
