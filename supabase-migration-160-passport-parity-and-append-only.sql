-- ============================================================
-- 160 — Two findings from the 2026-10-21 audit that can only be fixed in
-- SQL. Both are about a promise the database does not currently keep.
--
-- NEITHER WIDENS A DISCLOSURE THE ATHLETE HAS NOT ALREADY MADE. 160.1
-- honours two switches they have already set; 160.2 takes away a power
-- nothing in the app uses.
--
-- HOW TO APPLY
-- Paste into the Supabase SQL Editor and run once, top to bottom. One
-- transaction; every statement is idempotent, so a second run is harmless.
-- Verification queries are at the bottom — run them separately, after.
-- ============================================================

begin;


-- ============================================================
-- 160.1 — "Show my benchmarks" and "Show my timeline" are ignored on the
-- ?public=<uuid> share path.
--
-- Settings labels both toggles "On your shared Passport". There are two
-- share paths and only one of them obeys them:
--
--   get_public_passport_by_token(text)  — the link created by "Share my
--     Passport". Reads show_benchmarks / show_timeline and returns the
--     data plus the two shows_* flags (158, and the token variant it was
--     copied from). Correct today.
--
--   get_public_passport(p_user)         — ?public=<uuid>. Returns neither
--     the data nor the flags, so the toggles do nothing at all on this
--     path, forever, with the UI still saying they apply.
--
-- The second is the ONLY path a pre-078 account has, because accounts from
-- before share tokens existed have no token to create a link from. So the
-- athletes least able to notice are the ones it fails for.
--
-- THIS CANNOT LEAK ANYTHING NEW. Both columns are `not null default false`
-- (migration 154), the whole function is already gated on
-- profiles.passport_public, and an athlete who has never touched the
-- toggles gets exactly what they get today. The only behaviour that
-- changes is that switching one ON now does what its label says.
--
-- Copied verbatim from the token variant, with v_user replaced by p_user,
-- so the two paths cannot describe the same athlete differently.
-- ============================================================

create or replace function get_public_passport(p_user uuid)
returns jsonb language sql security definer set search_path to 'public' as $$
  select case
    when p_user is null then null
    when not coalesce((select passport_public from profiles where id = p_user), false) then null
    when is_banned(p_user) then null
    else (
      select jsonb_build_object(
        'full_name', p.full_name,
        'occupation', p.occupation,
        'verified_tier', p.verified_tier,
        'identity_verified', coalesce(p.identity_verified, false),
        'avatar_url', p.avatar_url,
        'sport', a.sport,
        'position', a.position,
        'club_name', case when a.show_club then a.club_name else null end,
        'country', case when a.show_country then a.country else null end,
        'grad_year', a.grad_year,
        'recruiting_status', a.recruiting_status,
        'foot', a.foot,
        'height_cm', a.height_cm,
        'weight_kg', a.weight_kg,
        'bio', a.bio,
        'highlights', coalesce(a.highlights, '[]'::jsonb),
        'shows_benchmarks', coalesce(a.show_benchmarks, false),
        'shows_timeline', coalesce(a.show_timeline, false),
        'benchmarks', case when coalesce(a.show_benchmarks, false) then (
            select coalesce(jsonb_agg(jsonb_build_object(
              'metric', b.metric, 'metric_key', b.metric_key, 'value', b.value,
              'unit', b.unit, 'recorded_date', b.recorded_date,
              'measured_by', b.measured_by, 'protocol', b.protocol
            ) order by b.recorded_date desc), '[]'::jsonb)
            from athlete_benchmarks b where b.user_id = p_user
          ) else null end,
        'timeline', case when coalesce(a.show_timeline, false)
                         then coalesce(a.timeline, '[]'::jsonb) else null end
      )
      from profiles p
      left join athletes a on a.id = p.id
      where p.id = p_user
    )
  end;
$$;

grant execute on function get_public_passport(uuid) to anon, authenticated;


-- ============================================================
-- 160.2 — athlete_outcomes is called append-only in three places and is not.
--
-- The table is the record of an athlete's availability changes — every
-- time they marked themselves hurt, limited or back. Migration 150 leans
-- on it in those words: "a reroute writes there, so pathway history is
-- never destroyed."
--
-- Its only policy is `for all`, which in PostgreSQL grants SELECT, INSERT,
-- UPDATE and DELETE. So the row owner — or anything holding their session,
-- including a compromised token or any future client bug — can rewrite or
-- erase their own injury history, and the rest of the schema is written as
-- though that cannot happen.
--
-- Split into exactly the two verbs the app uses. The client only ever
-- inserts (golsz-app.html, the availability change log) and reads. Nothing
-- in the repo updates or deletes a row here, so this removes a capability
-- that is used by nothing and contradicted by three comments.
--
-- Admin and service-role paths are unaffected: is_admin() routes go through
-- SECURITY DEFINER functions, and the service role bypasses RLS entirely,
-- so account deletion and moderation still work. The cascade from
-- profiles(id) on delete cascade is a foreign key, not a policy, and is
-- likewise untouched — deleting an account still removes these rows.
-- ============================================================

drop policy if exists athlete_outcomes_own on athlete_outcomes;
drop policy if exists athlete_outcomes_read on athlete_outcomes;
drop policy if exists athlete_outcomes_append on athlete_outcomes;

create policy athlete_outcomes_read on athlete_outcomes for select to authenticated
  using (athlete_id = auth.uid() or is_parent_of(athlete_id) or is_admin());

create policy athlete_outcomes_append on athlete_outcomes for insert to authenticated
  with check (athlete_id = auth.uid() or is_parent_of(athlete_id));

comment on table athlete_outcomes is
  'Append-only record of an athlete''s outcomes and availability changes. SELECT and INSERT only by policy (160.2) — the `for all` policy it replaced allowed the owner to UPDATE and DELETE their own history while migration 150 and two comments described the table as immutable. Service role and SECURITY DEFINER paths bypass RLS and are unaffected; the profiles cascade still removes rows on account deletion.';


commit;


-- ============================================================
-- 160 — Verification. Run these AFTER the migration, separately.
-- ============================================================
--
-- 1) The two share paths now agree. For an athlete with passport_public
--    true and show_benchmarks true:
--      select (get_public_passport('<their-uuid>'::uuid)) -> 'shows_benchmarks';
--      -- expected: true   (was: null — the key did not exist)
--      select jsonb_array_length((get_public_passport('<their-uuid>'::uuid)) -> 'benchmarks');
--      -- expected: their benchmark count
--    And an athlete with the toggle OFF is unchanged:
--      select (get_public_passport('<other-uuid>'::uuid)) -> 'benchmarks';
--      -- expected: null
--    And a private Passport still returns nothing at all:
--      select get_public_passport('<private-uuid>'::uuid);
--      -- expected: null
--
-- 2) athlete_outcomes is append-only:
--      select polname, polcmd from pg_policy
--       where polrelid = 'athlete_outcomes'::regclass order by polcmd;
--      -- expected: exactly two rows, cmd 'r' (select) and 'a' (insert).
--      --           No 'w' (update), no 'd' (delete), no '*' (all).
--
--    And the history is still readable and still writable by its owner —
--    run as a signed-in athlete, not as service role:
--      select count(*) from athlete_outcomes;        -- expected: their rows
--      update athlete_outcomes set detail = 'x'
--       where athlete_id = auth.uid();               -- expected: 0 rows
--      delete from athlete_outcomes
--       where athlete_id = auth.uid();               -- expected: 0 rows
--    A zero row count on the last two is the point: the statement succeeds
--    and changes nothing, because RLS gives it no rows to act on.
-- ============================================================
