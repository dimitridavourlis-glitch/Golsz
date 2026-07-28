-- ============================================================
-- 022 — search_players() for AI Scout's real-player search
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 +
-- 012 + 013 + 014 + 015 + 016 + 017 + 018 + 019 + 020 + 021.
--
-- Backs a new custom tool (search_golsz_players) that api/scout.js gives
-- the model so a Coach/Agent/Scout can ask Scout to find real athletes on
-- GOLSZ, not just search the open web. api/scout.js calls this RPC with
-- the SUPABASE_SERVICE_KEY, which bypasses RLS entirely — so this
-- function has to re-apply the same visibility rules athletes_read (RLS)
-- already enforces for everyone else, by hand, using the same
-- is_restricted_minor()/is_banned() helpers migrations 005/019 defined.
-- Getting this wrong would mean Scout's search tool could surface a
-- restricted minor (or a banned account) that Discover itself would never
-- show — this function is the only thing standing between the service key
-- and that leak, since there's no RLS to fall back on here.
--
-- Also scoped to occupation = 'Player' (or unset, from before migration
-- 020 added occupation) — every profile gets an athletes row regardless
-- of occupation (see handle_new_user()), so without this a search for
-- "strikers born 2008" could return a Coach or Physio's mostly-empty
-- athletes row just because they happen to have a sport set too.
-- ============================================================

create or replace function search_players(
  p_sport text default null,
  p_position text default null,
  p_country text default null,
  p_grad_year int default null,
  p_gender text default null,
  p_recruiting_status text default null,
  p_limit int default 10
)
returns table (
  id uuid,
  full_name text,
  sport text,
  position text,
  country text,
  club_name text,
  grad_year int,
  gender text,
  recruiting_status text
)
language sql security definer set search_path to 'public' as $$
  select p.id, p.full_name, a.sport, a.position, a.country, a.club_name, a.grad_year, a.gender, a.recruiting_status
  from athletes a
  join profiles p on p.id = a.id
  where a.sport is not null
    and (p.occupation is null or p.occupation = 'Player')
    and not is_restricted_minor(a.id)
    and not is_banned(a.id)
    and (p_sport is null or a.sport ilike p_sport)
    and (p_position is null or a.position ilike '%' || p_position || '%')
    and (p_country is null or a.country ilike p_country)
    and (p_grad_year is null or a.grad_year = p_grad_year)
    and (p_gender is null or a.gender = p_gender)
    and (p_recruiting_status is null or a.recruiting_status = p_recruiting_status)
  order by a.created_at desc nulls last
  limit least(coalesce(p_limit, 10), 25);
$$;

-- Not called by the browser client at all (only api/scout.js, via the
-- service-role key, which bypasses grants) — granted to authenticated
-- anyway so it fails safely (an authorized-but-unexpected caller still
-- only gets the same publicly-visible slice Discover already exposes)
-- rather than depending on a grant nobody would think to check.
grant execute on function search_players(text, text, text, int, text, text, int) to authenticated;

-- ============================================================
-- Done.
-- ============================================================
