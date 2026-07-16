-- ============================================================
-- 014 — Push notification subscriptions
-- Additive on top of 002 + 004 + 005 + 006 + 007 + 008 + 009 + 010 + 011 +
-- 012 + 013.
--
-- Stores each browser/device's Web Push subscription so the server (a
-- Vercel function, using the service role key) can send a real OS-level
-- notification when something happens for that user — a new message, or a
-- new follower. The subscription itself (endpoint + keys) is not secret in
-- the sense of a password, but it's still personal (it identifies a
-- specific device), so it's owner-only like everything else per-user here.
-- ============================================================

create table if not exists push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;

drop policy if exists push_subscriptions_rw on push_subscriptions;
create policy push_subscriptions_rw on push_subscriptions for all using (
  user_id = auth.uid()
) with check (
  user_id = auth.uid()
);

-- ============================================================
-- Done. Next: create two Database Webhooks in the Supabase Dashboard
-- (Database -> Webhooks -> Create a new hook), both pointed at your
-- deployed /api/send-push endpoint:
--   1. Table: messages, Event: Insert
--   2. Table: follows,  Event: Insert
-- For each, add an HTTP header  x-webhook-secret: <same value you set as
-- the SUPABASE_WEBHOOK_SECRET env var in Vercel>  so the endpoint can
-- reject requests that don't actually come from Supabase.
-- ============================================================
