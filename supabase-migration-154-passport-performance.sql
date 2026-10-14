-- ============================================================
-- 154 — the public Passport can finally carry performance
--
-- *** APPLIED 2026-10-14. Verified immediately after:
--     2 new columns, 0 athletes opted in, 15 athletes, 4 live share links —
--     so not one existing link changed what it reveals. ***
--
-- WHAT IS WRONG TODAY. get_public_passport_by_token() returns name, sport,
-- position, club, country, grad year, foot, height, weight, bio and highlight
-- links. That is everything EXCEPT what the athlete has actually done. A coach
-- opening a shared Passport sees a description and some video links, and not
-- one recorded number or a single line of career history — while the athlete,
-- looking at the same Passport inside the app, sees both. The one artifact
-- that leaves GOLSZ is the thinnest view of the athlete in it.
--
-- DEFAULT OFF, AND THAT IS DELIBERATE.
--
-- Share tokens already exist and are already out there. Adding fields to this
-- function would make every link an athlete created BEFORE today start
-- revealing more than it did when they sent it — a retroactive widening of a
-- disclosure they already made, with no notice and no action on their part.
-- That is not a thing a product gets to do quietly, however reasonable the
-- new fields are. So both columns default to false, nobody's existing link
-- changes, and the athlete turns each on from the privacy controls in
-- Settings that already govern show_club and show_country.
--
-- The cost is that the feature is invisible until someone opts in. That is the
-- right side to be wrong on.
--
-- BENCHMARKS CARRY THEIR METHOD. A number with no method is not evidence — it
-- is a claim, and the whole provenance ladder in this product exists to say
-- which is which. measured_by and protocol travel with the value so a reader
-- can see how it was taken, and metric_key travels so the reader's client can
-- label it. Nothing is scored, ranked or compared: BENCHMARK_BANDS is empty
-- and there is no population to compare against.
-- ============================================================

alter table public.athletes
  add column if not exists show_benchmarks boolean not null default false,
  add column if not exists show_timeline   boolean not null default false;

comment on column public.athletes.show_benchmarks is
  'Whether a shared Passport link includes recorded benchmarks WITH their stated method. Defaults false so links created before this existed never started revealing more than when they were sent.';
comment on column public.athletes.show_timeline is
  'Whether a shared Passport link includes the career timeline. Defaults false, same reason.';

create or replace function get_public_passport_by_token(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_user uuid;
begin
  select user_id into v_user from passport_share_tokens where token = p_token and not revoked;
  if v_user is null or is_restricted_minor(v_user) then return null; end if;
  update passport_share_tokens set last_accessed_at = now() where token = p_token;
  return (
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
      'highlights', coalesce(a.highlights, '[]'::jsonb),
      -- Each section is present ONLY when the athlete turned it on. An empty
      -- array would say "they have none"; absent says "not shared", and the
      -- reader is told which.
      'shows_benchmarks', coalesce(a.show_benchmarks, false),
      'shows_timeline', coalesce(a.show_timeline, false),
      'benchmarks', case when coalesce(a.show_benchmarks, false) then (
          select coalesce(jsonb_agg(jsonb_build_object(
            'metric', b.metric, 'metric_key', b.metric_key, 'value', b.value,
            'unit', b.unit, 'recorded_date', b.recorded_date,
            'measured_by', b.measured_by, 'protocol', b.protocol
          ) order by b.recorded_date desc), '[]'::jsonb)
          from athlete_benchmarks b where b.user_id = v_user
        ) else null end,
      'timeline', case when coalesce(a.show_timeline, false)
                       then coalesce(a.timeline, '[]'::jsonb) else null end
    )
    from profiles p
    left join athletes a on a.id = p.id
    where p.id = v_user
  );
end;
$$;

grant execute on function get_public_passport_by_token(text) to anon, authenticated;

-- ============================================================
-- VERIFY AFTER APPLYING
--   select count(*) from athletes where show_benchmarks or show_timeline;
--   -- expect 0: no existing link's disclosure changed
--   select (get_public_passport_by_token('<a live token>')) -> 'benchmarks';
--   -- expect null until that athlete opts in, then an array
-- ============================================================
