-- ============================================================
-- PROBE — which hand-applied migrations are actually live?
--
-- READ-ONLY. It only reads the catalogs (pg_class, pg_policy, pg_proc,
-- pg_trigger, information_schema). It writes nothing, takes no locks that
-- matter, and is safe to run any number of times. It is NOT a migration and
-- does not belong in the ledger (supabase-schema.sql).
--
-- WHY IT EXISTS. This repo's migrations are run by hand in the Supabase SQL
-- Editor, so "is 158 applied?" had no answer except a person's memory
-- (CLAUDE.md said run it, supabase-schema.sql said pending, and migration
-- 159's header said it had run). The database is the only source of truth,
-- and per the repo's own rule it is asked with a select, never by
-- re-reading the migration file.
--
-- HOW TO RUN. Paste the whole file into the Supabase SQL Editor and run it
-- once. It returns one row per check. Read the `applied` column:
--   true   the marker for that migration is present in the live database
--   false  it is not: run that migration (in numeric order: 158, 159, 160, 161;
--          162 only after enrolling MFA, see its header)
--
-- ORDER MATTERS. 160 re-creates get_public_passport(uuid), a function 158
-- also defines. Run 158 AFTER 160 and it silently overwrites 160.1 with the
-- older version. If 158 shows false, run 158, then 159, then 160.
--
-- The 026 rows never print the webhook function's body: that body holds a
-- secret. They report only whether it is the unsubstituted placeholder, and
-- whether the triggers exist. They CANNOT tell you the secret matches
-- Vercel's SUPABASE_WEBHOOK_SECRET: prove that by sending a real message
-- from one test account to another and watching for the push.
-- ============================================================

with checks(ord, migration, check_name, applied, note) as (

  -- 158 ---------------------------------------------------------------
  select 10, '158.1', 'public_profile_names runs as the caller (security_invoker)',
    coalesce((select 'security_invoker=true' = any(coalesce(reloptions, '{}'))
                from pg_class where oid = 'public.public_profile_names'::regclass), false),
    'false means any signed-in account can list every member'
  union all
  select 11, '158.2', 'handle_new_user() refuses a signup with no date of birth',
    coalesce((select pg_get_functiondef(p.oid) like '%a date of birth is required%'
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'handle_new_user'), false),
    'false means the 18+ rule is enforced by the client only'
  union all
  select 12, '158.3', 'parent_links.requested_by exists',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'parent_links' and column_name = 'requested_by'),
    ''
  union all
  select 13, '158.4', 'avatars / post-images listing is limited to the owner folder',
    coalesce((select bool_and(pg_get_expr(polqual, polrelid) like '%foldername%')
                from pg_policy
               where polrelid = 'storage.objects'::regclass
                 and polname in ('avatars_read', 'post_images_read')), false)
      and (select count(*) from pg_policy
            where polrelid = 'storage.objects'::regclass
              and polname in ('avatars_read', 'post_images_read')) = 2,
    ''
  union all
  select 14, '158.5', 'events.visibility defaults to private',
    coalesce((select column_default like '%private%' from information_schema.columns
               where table_schema = 'public' and table_name = 'events' and column_name = 'visibility'), false),
    ''
  union all
  select 15, '158.6', 'get_public_passport_by_token honours show_club and banned accounts',
    coalesce((select pg_get_functiondef(p.oid) like '%show_club%' and pg_get_functiondef(p.oid) like '%is_banned%'
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'get_public_passport_by_token'), false),
    ''
  union all
  select 16, '158.8', 'claude-sonnet-5 is priced 2 / 10 in scout_model_config',
    coalesce((select bool_and(input_cost_per_million = 2 and output_cost_per_million = 10)
                from scout_model_config
               where provider = 'anthropic' and model_name = 'claude-sonnet-5'), false),
    'data check: false can also mean the price was changed on purpose later'

  -- 159 ---------------------------------------------------------------
  union all
  select 20, '159.1', 'match_scout_faq pins its search_path',
    coalesce((select 'search_path=public' = any(coalesce(p.proconfig, '{}'))
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'match_scout_faq' limit 1), false),
    ''
  union all
  select 21, '159.2', 'no storage policy still names the deleted highlights bucket',
    not exists (select 1 from pg_policy
                 where polrelid = 'storage.objects'::regclass
                   and (coalesce(pg_get_expr(polqual, polrelid), '') like '%highlights%'
                        or coalesce(pg_get_expr(polwithcheck, polrelid), '') like '%highlights%')),
    ''

  -- 160 ---------------------------------------------------------------
  union all
  select 30, '160.1', 'get_public_passport(uuid) honours show_benchmarks / show_timeline',
    coalesce((select pg_get_functiondef(p.oid) like '%shows_benchmarks%'
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'get_public_passport'
                 and pg_get_function_identity_arguments(p.oid) = 'p_user uuid'), false),
    'false means the two Settings toggles do nothing on the ?public=<uuid> link'
  union all
  select 31, '160.2', 'athlete_outcomes has read + insert policies only (append-only)',
    coalesce((select count(*) filter (where polcmd = 'r') = 1
                 and count(*) filter (where polcmd = 'a') = 1
                 and count(*) filter (where polcmd in ('w', 'd', '*')) = 0
                from pg_policy where polrelid = 'public.athlete_outcomes'::regclass), false),
    'false means an owner can still rewrite or delete their own availability history'

  -- 161 / 162 (admin roles, admin MFA) ----------------------------------
  union all
  select 50, '161.1', 'profiles.admin_role exists',
    exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'admin_role'),
    'false means every admin is still an owner (today''s behaviour)'
  union all
  select 51, '161.2', 'is_admin_owner() exists',
    exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'is_admin_owner'), ''
  union all
  select 52, '161.3', 'protect_profile_columns() pins owner-only columns and guards the last owner',
    coalesce((select pg_get_functiondef(p.oid) like '%cannot remove the last owner%'
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'protect_profile_columns' limit 1), false),
    ''
  union all
  select 60, '162', 'is_admin() requires an aal2 (second-factor) session',
    coalesce((select pg_get_functiondef(p.oid) like '%aal2%'
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'is_admin' limit 1), false),
    'RUN 162 ONLY AFTER ENROLLING MFA. false means the database does not yet check the second factor'

  -- 026 (push webhook) -------------------------------------------------
  union all
  select 40, '026', 'pg_net extension is installed',
    exists (select 1 from pg_extension where extname = 'pg_net'), ''
  union all
  select 41, '026', 'notify_send_push() exists and is NOT the unsubstituted placeholder',
    coalesce((select position('REPLACE_WITH_SUPABASE_WEBHOOK_SECRET' in p.prosrc) = 0
                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'notify_send_push'), false),
    'false = function missing or still holds the placeholder: pushes are failing. Body is never shown.'
  union all
  select 42, '026', 'trigger notify_new_message is enabled on messages',
    exists (select 1 from pg_trigger t where t.tgrelid = 'public.messages'::regclass
             and t.tgname = 'notify_new_message' and t.tgenabled <> 'D'), ''
  union all
  select 43, '026', 'trigger notify_new_follower is enabled on follows',
    exists (select 1 from pg_trigger t where t.tgrelid = 'public.follows'::regclass
             and t.tgname = 'notify_new_follower' and t.tgenabled <> 'D'), ''
)
select migration, check_name, applied, note
  from checks
 order by ord;

-- Summary line to read first: any `false` above names a migration to run.
-- All `true` in 158-160 means those three are live; update the ledger
-- (supabase-schema.sql: the 158 "pending" note and the 160 block).
