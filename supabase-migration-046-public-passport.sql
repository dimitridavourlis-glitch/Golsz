-- ============================================================
-- 046 — Public, shareable Passport pages + a small minor-safety gap fix
-- Additive on top of 002 + ... + 045.
--
-- PART 1: get_public_passport(p_user)
-- A real athlete asked for their Passport to be shareable outside the app
-- (a link they can text a coach, no GOLSZ account required). This is the
-- one narrow, anon-readable RPC that makes that possible, returning only
-- what any signed-in GOLSZ member already sees on someone else's Passport
-- (see toPassport() in golsz-app.html) minus a few fields that are fine
-- inside the app's own logged-in walls but not worth exposing to an
-- unauthenticated, unaccountable public link: gpa, license (agent/coach
-- license numbers), and looking_for_players.
--
-- Gated by is_restricted_minor() — the exact same gate already used for
-- athletes_read, public_profile_names (migration 038), and
-- search_players (migration 022). A minor whose parent hasn't approved
-- them yet gets null here, full stop, same as every other public-facing
-- read path in this schema. This was written and checked against that
-- existing pattern specifically so it doesn't reintroduce the migration
-- 038 bug in a new place.
--
-- PART 2: ensure_message_request() gets the same is_restricted_minor
-- check the real `messages` insert already had (migration 007) but this
-- function never did. Today, an adult can already create a *request* row
-- targeting a restricted minor — sending them a "wants to message you"
-- notification — even though the real message content is correctly
-- blocked afterward by messages_write. That's a narrower gap than a real
-- open DM, but a stranger's contact request reaching an unapproved minor
-- at all is still worth closing.
-- ============================================================

create or replace function get_public_passport(p_user uuid)
returns jsonb language sql security definer set search_path to 'public' as $$
  select case
    when p_user is null or is_restricted_minor(p_user) then null
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

grant execute on function get_public_passport(uuid) to anon, authenticated;

create or replace function ensure_message_request(p_recipient uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null or p_recipient is null or p_recipient = auth.uid() then
    return;
  end if;
  if is_restricted_minor(auth.uid()) or is_restricted_minor(p_recipient) then
    return;
  end if;
  if exists (
    select 1 from message_requests
    where (sender_id = auth.uid() and recipient_id = p_recipient)
       or (sender_id = p_recipient and recipient_id = auth.uid())
  ) then
    return;
  end if;
  insert into message_requests (sender_id, recipient_id, status)
  values (auth.uid(), p_recipient, 'pending');
end;
$$;

-- ============================================================
-- Done.
-- ============================================================
