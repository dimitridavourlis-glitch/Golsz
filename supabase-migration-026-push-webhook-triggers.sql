-- ============================================================
-- 026 — Push notification triggers (messages/follows -> api/send-push)
-- Additive on top of 002 + 004 + ... + 025.
--
-- Migration 014 created push_subscriptions and left the actual delivery
-- wiring as a manual step: create two Database Webhooks in the Supabase
-- Dashboard (Database -> Webhooks), one on `messages` INSERT and one on
-- `follows` INSERT, pointed at the deployed api/send-push.js. That
-- Dashboard page has since been removed/renamed on at least some
-- Supabase projects (only "Database -> Triggers" remains) — but the
-- underlying mechanism that page always used is just a Postgres trigger
-- calling `net.http_post()` (from the `pg_net` extension), which is still
-- fully available via plain SQL regardless of what the Dashboard shows.
-- This migration creates that trigger by hand instead of relying on the
-- Dashboard wizard.
--
-- One shared trigger function (not one per table) since the URL, header,
-- and payload shape are identical either way — TG_TABLE_NAME and NEW
-- already vary correctly per table. The payload shape
-- ({type, table, schema, record, old_record}) matches exactly what
-- api/send-push.js already expects (it was written against the
-- Dashboard-generated Webhook payload shape, so no server-side code
-- changes needed).
--
-- net.http_post() is async (queued by pg_net's background worker, not
-- awaited inline) — same as the Dashboard-based Webhooks were, so this
-- doesn't add latency to a real message/follow insert.
--
-- Trade-off worth knowing: the x-webhook-secret value below is embedded
-- as a literal in this function body, in cleartext, because a Postgres
-- trigger has no way to read a Vercel environment variable at runtime —
-- this is the same trade-off the old Dashboard-generated Webhook UI had
-- (it stored the header value in cleartext in the generated trigger too).
-- Anyone with SQL access to this database (i.e. you, via the Supabase
-- SQL Editor / a service-role connection) can read it back out of
-- pg_proc — that's an accepted constraint here, not a bug, but if you
-- ever rotate SUPABASE_WEBHOOK_SECRET in Vercel, re-run this file with
-- the new value so the two stay in sync.
-- ============================================================

create extension if not exists pg_net schema extensions;

create or replace function notify_send_push()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  perform net.http_post(
    url := 'https://golsz.vercel.app/api/send-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- SUBSTITUTE AT PASTE TIME — DO NOT COMMIT A REAL SECRET HERE.
      -- Replace REPLACE_WITH_SUPABASE_WEBHOOK_SECRET with the live value in
      -- the Supabase SQL Editor immediately before running this statement.
      -- It must match Vercel's SUPABASE_WEBHOOK_SECRET env var exactly —
      -- api/send-push.js compares the incoming x-webhook-secret header
      -- against that env var and rejects the call if they differ, so a
      -- mismatch silently kills every push notification.
      -- The real value lives in Vercel's env settings and nowhere else in
      -- this repo: a secret committed to git is a leaked secret, even after
      -- it is later removed, because the history keeps it.
      'x-webhook-secret', 'REPLACE_WITH_SUPABASE_WEBHOOK_SECRET'
    ),
    body := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'schema', TG_TABLE_SCHEMA,
      'record', to_jsonb(NEW),
      'old_record', null
    )
  );
  return NEW;
end;
$$;

drop trigger if exists notify_new_message on public.messages;
create trigger notify_new_message
  after insert on public.messages
  for each row execute function notify_send_push();

drop trigger if exists notify_new_follower on public.follows;
create trigger notify_new_follower
  after insert on public.follows
  for each row execute function notify_send_push();

-- ============================================================
-- Done.
-- ============================================================
