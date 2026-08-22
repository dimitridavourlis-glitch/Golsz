-- 132 — close the last account-to-account write path
--
-- GOLSZ is one-to-one: an athlete, their parent, and Scout. There is no
-- communication between accounts. Feed, Discover and Messages were removed in
-- 805278e; posts, post_likes, messages and the message-request RPCs were closed
-- in 130. `follows` was missed — 129 scoped who could READ the graph, but the
-- insert and delete policies were left in place, so following another athlete
-- was still fully possible with a direct PostgREST call.
--
-- NOTHING IS DELETED. The 6 existing follow rows stay. This may come back when
-- the social product does; re-granting two policies is a one-line migration,
-- rebuilding a graph from nothing is not.
--
-- DELIBERATELY LEFT OPEN, because none of these is account-to-account
-- communication:
--   blocks                      — protective, and asked to be kept
--   request_parent_link         — the parent/child flow
--   create_passport_share_token — a link the athlete generates for a coach;
--                                 one-directional, with no reply path
--   content_reports             — safety machinery, same reasoning as blocks

drop policy if exists follows_write  on follows;
drop policy if exists follows_delete on follows;

-- Reads stay as 129 scoped them: your own rows, or admin.

-- ---- VERIFY (run separately; do not trust this file) ---------------------
--   select policyname, cmd, qual from pg_policies where tablename = 'follows';
--     expect: follows_read [SELECT] only.
--   select count(*) from follows;   -- expect 6, unchanged.
--
-- NOTE ON supabase-schema.sql: it does not reflect migrations 129, 130 or this
-- one — it still shows follows_read as `using (true)` and still shows the
-- ensure_message_request grant to authenticated. The FILE AND THE DATABASE
-- DISAGREE. pg_policies is the authority; read the file for intent, not state.
