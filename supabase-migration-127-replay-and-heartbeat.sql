-- ============================================================
-- 127 — Webhook replay protection, and a heartbeat the monitor cannot fake
--
-- WHY THIS FILE EXISTS
-- Two items the pre-launch audit deferred rather than closed. They are
-- different features with the same defect underneath: a guard that reads as
-- present in the code and is not present in fact.
--
-- 1. api/stripe-webhook.js verifies Stripe's signature and stops there. A
--    valid signature proves a request CAME FROM Stripe. It does not make
--    that request single-use. Anyone holding a captured POST — a proxy log,
--    a mis-shared payload, a debugging dump — can re-send it byte for byte
--    inside Stripe's 300-second timestamp tolerance and it verifies again,
--    every time, for as long as the window is open. Most branches of that
--    handler are idempotent (the same PATCH written twice), but a replayed
--    customer.subscription.deleted lands a SECOND downgrade to free, and a
--    replayed checkout.session.completed re-binds a Stripe customer id.
--    That file carried a TODO(owner) saying exactly this, and it could not
--    be closed there: refusing an event you have already handled means
--    remembering which events you have handled, and remembering is a table.
--    This is the table.
--
--    An in-memory Set was deliberately NOT shipped as a stopgap. Vercel
--    runs this handler on ephemeral, plural instances, so a Set would catch
--    a replay only in the case where it happened to land on the same warm
--    instance as the original — the worst possible outcome, being the
--    appearance of protection with none of the substance, and a green
--    review of a still-open hole.
--
-- 2. .github/workflows/health-alert.yml calls /api/health-alert every 15
--    minutes, and is the only thing that would notice a Scout outage
--    (the 2026-08-08 incident ran about an hour and was found by the
--    founder looking at his own phone). GitHub SILENTLY DISABLES `schedule:`
--    triggers after 60 days of repository inactivity, and a pre-launch repo
--    is precisely the kind that goes quiet for 60 days. Nothing inside that
--    workflow can detect this, because the thing that stops is the
--    workflow: no runs, no failures, nothing to notice. It has to leave a
--    trace that something ELSE reads.
--
--    ops_heartbeat below is that trace. api/health-alert.js stamps it on
--    every successful run; api/target-followup-reminders.js — the single
--    Vercel cron (vercel.json, daily 13:00 UTC), which runs whether or not
--    GitHub is still scheduling anything — reads the stamp on its way past
--    and pushes to admins when it has gone stale. No new service, no new
--    bill, no new credential, which was the owner's condition.
--
-- BOTH TABLES ARE SERVICE-ROLE ONLY: RLS ENABLED, ZERO POLICIES.
-- Same shape as scout_routing_log (039) and signup_attempts (074). The only
-- writers are server-side handlers holding SUPABASE_SERVICE_KEY, and no
-- anon/authenticated client has any business reading either one — a
-- stripe_events row would confirm to an attacker whether a captured event
-- had already been consumed, and a heartbeat row tells anyone watching
-- exactly when the outage detector is asleep.
--
-- Enabling RLS with no policies is not an oversight here, it is the point:
-- Supabase's default privileges hand anon/authenticated the usual table
-- grants on anything created in `public`, and RLS-with-no-policy is what
-- turns those grants into a deny for every row. The service role bypasses
-- RLS entirely, so it needs no policy to work. No explicit GRANT is issued
-- below for the same reason 039 and 074 issue none.
--
-- HOW TO APPLY
-- Paste into the Supabase SQL Editor and run once, top to bottom. Every
-- statement is idempotent — `create table if not exists`, `create index if
-- not exists`, guarded `do $$` for the ALTERs. Re-running is safe.
--
-- APPLY THIS BEFORE (or with) THE MATCHING api/ DEPLOY, but nothing breaks
-- if you don't. Both callers are written to degrade rather than fail:
-- stripe-webhook falls back to today's unprotected-but-loud behaviour if
-- the claim insert cannot be written (and says so in error_log), and the
-- reminders watchdog treats an unreadable heartbeat as "no opinion" rather
-- than as an outage. Neither turns a missing table into a billing outage or
-- a false page.
-- ============================================================


-- ============================================================
-- 127.1 — stripe_events: one row per Stripe event, claimed by INSERT.
--
-- THE CLAIM IS THE INSERT, NOT A SELECT.
-- The obvious implementation — "select the id; if absent, process it and
-- insert it" — is a race with a losing side that is exactly the case worth
-- protecting against: two concurrent deliveries of the same event (Stripe's
-- own retry overlapping the original, or a replay fired alongside the
-- genuine POST) both run the select, both see nothing, and both process.
-- The primary key below is the only thing in the system that can arbitrate
-- that, because the arbitration happens inside one statement. So the
-- handler INSERTs first and reads the outcome: accepted means this delivery
-- owns the event, a unique violation (SQLSTATE 23505, which PostgREST
-- returns as HTTP 409) means somebody else already does.
--
-- `id` is Stripe's own event id (evt_...), used verbatim as the primary
-- key. It is globally unique per Stripe account and stable across retries
-- of the same event — which is the property the whole mechanism rests on —
-- and it arrives inside the body the signature covers, so it cannot be
-- altered by anyone who does not hold the signing secret.
--
-- `type` is stored for diagnostics only. Nothing reads it in code; it is
-- here so that "which event did we refuse, and was refusing it right?" is
-- answerable after the fact without correlating against the Stripe
-- dashboard.
--
-- NO INDEX ON received_at, ON PURPOSE. The primary key already serves the
-- only query in the hot path (the claim itself). The one query that would
-- want a received_at index is the retention delete below, which runs at
-- most daily against a table taking a few thousand rows a month — a
-- sequential scan there is far cheaper than a second index maintained on
-- every webhook insert, which is the path that must stay fast because
-- Stripe times its deliveries out.
-- ============================================================

create table if not exists stripe_events (
  id text primary key,
  type text,
  received_at timestamptz not null default now()
);

alter table stripe_events enable row level security;
-- Deliberately zero policies. Written only by api/stripe-webhook.js with
-- the service-role key; never read by any client. See the file header.

comment on table stripe_events is
  'Replay guard for api/stripe-webhook.js: one row per Stripe event id, claimed by INSERT. A duplicate-key rejection means the event was already processed. Service-role only (RLS on, no policies). See migration 127.';

-- RETENTION — AN OPEN QUESTION, DELIBERATELY LEFT OPEN.
-- Nothing prunes this table, so it grows forever: one row per Stripe event,
-- retained long after any possibility of that event being re-delivered.
-- That is harmless for a long time (rows are ~60 bytes and pre-launch
-- traffic is zero) and it is not being solved automatically here, because a
-- scheduled job that silently deletes billing evidence is not something to
-- switch on without the owner choosing it.
--
-- When it matters, the pruning statement is one line:
--
--   delete from stripe_events where received_at < now() - interval '30 days';
--
-- 30 days is the recommendation and the reasoning is bounded, not a round
-- number: Stripe retries a failed webhook delivery for up to ~3 days, after
-- which it stops for good. An event older than that can never legitimately
-- arrive again, so keeping it is no longer replay protection — it is only
-- history. 30 days leaves a 10x margin over the retry window and keeps a
-- month of "did we handle this?" answerable by hand.
--
-- Three ways to run it, in ascending order of moving parts:
--   1. By hand in the SQL Editor, when someone notices. Adequate for years
--      at this volume, and honest about what it is.
--   2. Append it to an existing scheduled handler — api/health-alert.js
--      already runs every 15 minutes; a delete guarded to run once a day
--      costs nothing and needs no new infrastructure.
--   3. pg_cron, if the project ever enables it (it does not use it today —
--      no migration in this repo schedules anything in the database):
--        select cron.schedule('prune-stripe-events', '0 4 * * *',
--          $$delete from stripe_events where received_at < now() - interval '30 days'$$);
-- NOT implemented here on purpose: option 3 would be this file quietly
-- installing a recurring background job the owner never asked for, into an
-- extension the project has never turned on.


-- ============================================================
-- 127.2 — ops_heartbeat: proof that a scheduled job is still running.
--
-- WHAT THIS IS FOR
-- A monitor that has stopped and a monitor that has nothing to report look
-- identical from the outside — both are silent. This table is how the
-- health-alert cron says "I ran" to a reader that is not itself the
-- health-alert cron. The watchdog in api/target-followup-reminders.js reads
-- it once a day and pushes to admins when the stamp is old.
--
-- KEYED BY NAME, NOT A HARDCODED SINGLE ROW.
-- One row per scheduled job, rather than a one-row table with a fixed id.
-- The table is single-row TODAY (name = 'health-alert') and the cost of the
-- generality is one text column, but the alternative rots the first time a
-- second job wants the same treatment: either a second near-identical
-- table, or a column added to a table whose name says it holds one thing.
-- The PK doubles as the upsert conflict target — api/health-alert.js POSTs
-- with `?on_conflict=name` and `Prefer: resolution=merge-duplicates`, so
-- the write is a single statement with no read in front of it.
--
-- NOT SEEDED, ON PURPOSE.
-- There is no `insert ... values ('health-alert', now())` here. Seeding
-- would assert that the monitor has run when it has not, and would suppress
-- the alert for exactly the window in which a never-deployed or misconfigured
-- monitor is most likely to be caught. A missing row is a true statement
-- ("this job has never reported a successful run") and the watchdog treats
-- it as one.
--
-- `last_ok_at` MEANS "THE JOB COMPLETED", NOT "THE SYSTEM IS HEALTHY".
-- api/health-alert.js stamps this on every successful run including the runs
-- where it fires an outage alert. Conflating the two would mean a real
-- outage — the case where health-alert is doing its job loudest — also
-- looked like a dead monitor, and would page twice for one problem.
-- ============================================================

create table if not exists ops_heartbeat (
  name text primary key,
  last_ok_at timestamptz not null default now()
);

alter table ops_heartbeat enable row level security;
-- Deliberately zero policies. Written by api/health-alert.js and read by
-- api/target-followup-reminders.js, both with the service-role key. A
-- client that could read this would know precisely when nobody is watching.

comment on table ops_heartbeat is
  'One row per scheduled job (name = job), stamped with last_ok_at on each successful run. Dead-man''s switch for the GitHub Actions health-alert schedule, which GitHub disables silently after 60 days of repo inactivity. Read by api/target-followup-reminders.js. Service-role only (RLS on, no policies). See migration 127.';


-- ============================================================
-- 127.3 — VERIFICATION
-- Run after applying. Every expectation is stated, so a wrong answer is
-- visible without knowing what the right one was supposed to be.
--
-- 1) Both tables exist with RLS on and NO policies:
--      select c.relname, c.relrowsecurity,
--             (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
--        from pg_class c join pg_namespace n on n.oid = c.relnamespace
--       where n.nspname = 'public' and c.relname in ('stripe_events','ops_heartbeat');
--      -- expected: 2 rows, relrowsecurity = t, policies = 0 for both.
--      -- policies > 0 on either one is a defect, not a hardening step.
--
-- 2) The claim is actually atomic — the second insert must RAISE, not
--    return zero rows or overwrite the first:
--      insert into stripe_events (id, type) values ('evt_verify_127', 'test');
--      insert into stripe_events (id, type) values ('evt_verify_127', 'test');
--      -- expected: ERROR duplicate key value violates unique constraint
--      --           "stripe_events_pkey"  (SQLSTATE 23505 -> PostgREST 409)
--      delete from stripe_events where id = 'evt_verify_127';
--
-- 3) An anon/authenticated client cannot read either table. With the ANON
--    key (not the service key):
--      curl -s "$SUPABASE_URL/rest/v1/stripe_events?select=id" -H "apikey: $ANON_KEY"
--      curl -s "$SUPABASE_URL/rest/v1/ops_heartbeat?select=name" -H "apikey: $ANON_KEY"
--      -- expected: [] from both (RLS denies every row; the request itself
--      --           is not an error, which is why the empty array is the
--      --           pass condition and a populated array is the failure).
--
-- 4) The heartbeat is live, once api/health-alert.js has run at least once
--    (within 15 minutes of deploying it):
--      select name, last_ok_at, now() - last_ok_at as age from ops_heartbeat;
--      -- expected: one row, name = 'health-alert', age < 20 minutes.
--      -- ZERO ROWS after the monitor has had time to run means the stamp
--      -- is not being written — which is the dead-man's switch itself
--      -- being dead, and is worth the same urgency as an outage.
--
-- 5) The watchdog end to end, without waiting 60 days for GitHub to
--    disable anything: age the stamp past the threshold and invoke the
--    reminders cron by hand.
--      update ops_heartbeat set last_ok_at = now() - interval '12 hours'
--       where name = 'health-alert';
--      curl -s -H "Authorization: Bearer $CRON_SECRET" \
--        "$PROD_BASE_URL/api/target-followup-reminders"
--      -- expected: the JSON response carries
--      --           "watchdog":{"status":"stale","stale":true,...,"pushed":N}
--      --           and every admin device with a push subscription gets a
--      --           "Scout outage monitor has stopped" notification.
--      --           Deleting the row instead of ageing it gives
--      --           "status":"never_ran" and the "is not reporting" wording.
--      -- The next health-alert run (<= 15 min) restores the stamp on its
--      -- own; no cleanup needed.
-- ============================================================
