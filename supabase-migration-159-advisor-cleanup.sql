-- ============================================================
-- 159 — Advisor cleanup: two real findings from Supabase's security
-- linter, and nothing else.
--
-- CONTEXT. After 158 was applied, the Security Advisor read 0 errors /
-- 64 warnings / 10 suggestions. Most of the 64 are the linter being
-- unable to see inside a function, and are NOT acted on here:
--
--   * ~15 "Signed-In Users Can Execute SECURITY DEFINER Function" on the
--     admin_* RPCs. Every one of them opens with
--         if not is_admin() then raise exception 'not authorized'; end if;
--     (checked in 052, 056, 058, 059, 064, 109). The linter sees the grant
--     to `authenticated` and cannot see the guard. Revoking the grant would
--     break the Admin Panel to silence a false positive.
--
--   * "Public Can Execute SECURITY DEFINER Function" on get_public_passport,
--     get_public_passport_by_token and log_client_error. Deliberate: a
--     logged-out coach opens a shared Passport, and client errors are
--     reported before sign-in.
--
--   * The same warning on handle_new_user, notify_send_push,
--     _post_likes_sync and check_event_fake_signals. All four RETURN
--     TRIGGER, and PostgreSQL refuses to invoke a trigger-returning
--     function directly ("trigger functions can only be called as
--     triggers"), so the grant has no exploit path. Revoking EXECUTE on
--     handle_new_user - the signup trigger - to quiet a linter is a bad
--     trade at any odds.
--
--   * "Extension in Public: pg_trgm". Standard for Supabase. Moving it
--     breaks every unqualified similarity() call, including 159.1 below.
--
-- A THIRD finding was fixed outside SQL. The `highlights` storage bucket
-- was public, listable, 50MB, "Any" MIME type, EMPTY, referenced by no
-- code (the app only touches avatars and post-images) and created by no
-- migration - someone made it in the dashboard, and 158.4 never knew it
-- existed. It was deleted on 2026-10-21. 159.2 clears what the delete
-- leaves behind.
--
-- HOW TO APPLY
-- Paste into the Supabase SQL Editor and run once, top to bottom. One
-- transaction; every statement is idempotent, so a second run is harmless.
-- ============================================================

begin;


-- ============================================================
-- 159.1 — match_scout_faq resolved its own tables through the caller's
-- search_path.
--
-- It is `language sql stable`, NOT security definer, so this is not the
-- privilege-escalation shape the advisor's rule is usually about: an
-- invoker-rights function already runs with the caller's privileges. What
-- it IS is a correctness risk. The body references `scout_faq` and
-- `similarity()` unqualified, so both resolve through whatever
-- search_path the caller happens to have. PostgREST sets a sane one, but
-- the function should not depend on its caller to find its own table.
--
-- `public` rather than `''`: pg_trgm lives in public on this project (the
-- advisor's "Extension in Public" note), so similarity() is only
-- resolvable there, and the body is unqualified by design.
-- ============================================================

alter function public.match_scout_faq(text, text, text) set search_path = public;


-- ============================================================
-- 159.2 — Policies left behind by the deleted `highlights` bucket.
--
-- Deleting a bucket removes its row from storage.buckets. It does NOT
-- remove the policies on storage.objects whose predicates name it, so
-- three of them are now matching a bucket_id that cannot occur. Harmless
-- at runtime - nothing satisfies them - but they are exactly the kind of
-- leftover that reads as intentional to whoever looks next, and that a
-- future "re-create the highlights bucket" would silently re-arm.
--
-- Dropped by predicate rather than by name: they were created in the
-- dashboard, so their names were never written down anywhere in this repo.
-- Finds nothing on a second run.
-- ============================================================

do $$
declare
  r record;
begin
  for r in
    select polname
      from pg_policy
     where polrelid = 'storage.objects'::regclass
       and (coalesce(pg_get_expr(polqual, polrelid), '') like '%highlights%'
         or coalesce(pg_get_expr(polwithcheck, polrelid), '') like '%highlights%')
  loop
    raise notice 'dropping orphaned storage policy: %', r.polname;
    execute format('drop policy %I on storage.objects', r.polname);
  end loop;
end
$$;


commit;


-- ============================================================
-- 159 — Verification. Run these AFTER the migration, separately.
-- ============================================================
--
-- 1) The function pins its own path:
--      select proconfig from pg_proc
--       where oid = 'public.match_scout_faq(text,text,text)'::regprocedure;
--      -- expected: {search_path=public}
--    And it still answers:
--      select count(*) from match_scout_faq('how do I get recruited');
--      -- expected: a number, not an error
--
-- 2) Nothing on storage.objects still names the deleted bucket:
--      select polname, pg_get_expr(polqual, polrelid) from pg_policy
--       where polrelid = 'storage.objects'::regclass
--         and pg_get_expr(polqual, polrelid) like '%highlights%';
--      -- expected: 0 rows
--
--    And the two real buckets are untouched:
--      select id, public, file_size_limit, allowed_mime_types
--        from storage.buckets order by id;
--      -- expected: avatars and post-images only, both 8MB, image types
--
-- 3) Re-run the Security Advisor. Expected to drop by 4: one
--    "Function Search Path Mutable" and one "Public Bucket Allows
--    Listing", plus the two storage policies that went with the bucket.
--    The ~15 admin_* warnings and the deliberate anon-callable ones
--    REMAIN, and should - see the header for why each is not a hole.
-- ============================================================
