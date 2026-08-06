-- ============================================================
-- 067 — Expose real identity_verified on the public Passport link
-- get_public_passport() (046/047) predates identity_verified (058) and
-- still only returns verified_tier, which is a subscription badge, not
-- proof of identity. PublicPassport's badge/"VERIFIED MEDIA" label now
-- read identity_verified (matching the same fix already applied to the
-- in-app Highlights component this session) — the RPC needs to return it.
-- ============================================================

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
        'identity_verified', coalesce(p.identity_verified, false),
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
