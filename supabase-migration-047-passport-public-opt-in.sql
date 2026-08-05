-- ============================================================
-- 047 — Passport sharing is opt-in, not on-by-default
-- Additive on top of 002 + ... + 046.
--
-- Migration 046 shipped get_public_passport(), callable for any non-
-- restricted-minor user id — meaning every non-minor account was already
-- reachable via its link the moment 046 landed, with no owner action
-- required. The actual ask was narrower: let an athlete deliberately
-- share their own Passport, not make every account public by default.
--
-- profiles.passport_public starts false for everyone. get_public_passport()
-- now requires it to be true (in addition to the existing
-- is_restricted_minor() gate, which still applies regardless — a
-- restricted minor's passport can never be made public no matter what
-- this flag is set to). The "Share" button in golsz-app.html sets this
-- true as its own first step, then copies the link — sharing only ever
-- happens because the athlete clicked something that says so.
-- ============================================================

alter table profiles add column if not exists passport_public boolean not null default false;

create or replace function get_public_passport(p_user uuid)
returns jsonb language sql security definer set search_path to 'public' as $$
  select case
    when p_user is null or is_restricted_minor(p_user) then null
    when not coalesce((select passport_public from profiles where id = p_user), false) then null
    else (
      select jsonb_build_object(
        'full_name', p.full_name,
        'occupation', p.occupation,
        'verified_tier', p.verified_tier,
        'avatar_url', p.avatar_url,
        'sport', a.sport,
        'position', a.position,
        'club_name', a.club_name,
        'country', a.country,
        'grad_year', a.grad_year,
        'recruiting_status', a.recruiting_status,
        'foot', a.foot,
        'height_cm', a.height_cm,
        'weight_kg', a.weight_kg,
        'bio', a.bio,
        'highlights', coalesce(a.highlights, '[]'::jsonb)
      )
      from profiles p
      left join athletes a on a.id = p.id
      where p.id = p_user
    )
  end;
$$;

-- ============================================================
-- Done.
-- ============================================================
