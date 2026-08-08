-- 100 — ATHLETE VISIBILITY: explicit, per-athlete scout-visibility control
-- Closes a REAL gap found in the audit, not a hypothetical one: before this
-- migration there was no visibility control anywhere in the schema (no
-- scout_visible / profile_visibility / is_public column existed), so every
-- athlete with a sport set was discoverable by every Scout user via
-- search_players. The spec requires "explicit visibility controls" for
-- public athlete information — a prompt rule cannot provide that, only the
-- query can.
--
-- Default TRUE preserves current behaviour exactly (no athlete silently
-- disappears from search on deploy), while giving every athlete a real
-- switch. search_players is rewritten below to honour it, so the control is
-- enforced server-side in the query itself — never client-side.
-- ============================================================

alter table athletes add column if not exists scout_visible boolean not null default true;
alter table athletes add column if not exists show_club boolean not null default true;
alter table athletes add column if not exists show_country boolean not null default true;

create index if not exists athletes_scout_visible_idx on athletes (sport) where scout_visible;

-- Rewritten search_players: same signature and same non-sensitive field set
-- (no dob, GPA, bio, height/weight — unchanged), now additionally
-- respecting each athlete's own visibility choices. Club/country are
-- blanked per-athlete rather than excluding the whole row, so an athlete can
-- stay discoverable while keeping their club private.
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
  id uuid, full_name text, sport text, "position" text, country text,
  club_name text, grad_year int, gender text, recruiting_status text
)
language sql security definer set search_path to 'public' as $$
  select p.id, p.full_name, a.sport, a.position,
         case when a.show_country then a.country else null end,
         case when a.show_club then a.club_name else null end,
         a.grad_year, a.gender, a.recruiting_status
  from athletes a
  join profiles p on p.id = a.id
  where a.sport is not null
    and a.scout_visible                                  -- the new gate
    and (p.occupation is null or p.occupation = 'Player')
    and not is_restricted_minor(a.id)
    and not is_banned(a.id)
    and (p_sport is null or a.sport ilike p_sport)
    and (p_position is null or a.position ilike '%' || p_position || '%')
    -- country filter must not leak an athlete who hid their country
    and (p_country is null or (a.show_country and a.country ilike p_country))
    and (p_grad_year is null or a.grad_year = p_grad_year)
    and (p_gender is null or a.gender = p_gender)
    and (p_recruiting_status is null or a.recruiting_status = p_recruiting_status)
  order by a.created_at desc nulls last
  limit least(coalesce(p_limit, 10), 25);
$$;
