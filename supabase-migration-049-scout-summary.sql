-- ============================================================
-- 049 — Scout conversation summaries
-- Phase 2b of the AI Scout architecture plan (approved): stop resending
-- the entire conversation transcript to the model on every turn.
--
-- Scout()'s send() used to send its ENTIRE msgs array back to
-- api/scout.js every turn, growing unbounded within one conversation.
-- This adds a running per-conversation summary, produced as a byproduct
-- of the classifier call (classifyIntent()) that already runs on every
-- message — no new model call. The client now sends only the last few
-- turns plus this summary instead of full history.
--
-- Server-written only (service-role key, same pattern as
-- scout_routing_log / persistProfileUpdates in api/scout.js) — the only
-- client-side use is reading the summary back for the conversation being
-- restored on mount, so RLS only needs an owner-scoped SELECT policy.
-- ============================================================

create table if not exists scout_conversation_summaries (
  conversation_id uuid primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  summary text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists scout_conversation_summaries_user_idx on scout_conversation_summaries (user_id);

alter table scout_conversation_summaries enable row level security;

create policy scout_conversation_summaries_read on scout_conversation_summaries
  for select using (auth.uid() = user_id);
