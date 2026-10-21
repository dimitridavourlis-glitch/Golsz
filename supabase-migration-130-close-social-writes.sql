-- 130 — close writes to posts and post_likes
--
-- The Feed, Discover and Messages surfaces were removed from the client in
-- 805278e. Hiding a screen is not closing a door: the anon key ships in the
-- bundle, so anything the RLS policies still permit remains writable by a
-- direct PostgREST call. This closes the tables the retired surfaces wrote to.
--
-- WHY posts CAN BE CLOSED OUTRIGHT
-- Adding a Passport highlight used to also insert into posts as kind='clip'.
-- Production had ZERO clip rows — it had been failing silently since it
-- shipped, swallowed by a console.error — and highlights persist to
-- athletes.highlights, which was never affected. That insert is deleted, so
-- posts has no Passport dependency and needs no kind='clip' carve-out.
--
-- NO DATA IS DELETED. 7 posts, 3 likes, 21 messages, 1 request and 6 follows
-- all remain. Reads stay as migration 129 scoped them (author / participant /
-- parent / admin), so nothing becomes unrecoverable — retiring a feature must
-- not silently destroy what athletes already wrote.
--
-- REVERSIBLE. The policies are dropped, not the tables or the columns. When
-- the one-on-one product grows a social layer again, this is re-granting
-- policies rather than restoring data.

-- ---- posts: no client may write ------------------------------------------
drop policy if exists posts_write  on posts;
drop policy if exists posts_update on posts;
drop policy if exists posts_delete on posts;

-- Admins keep the ability to remove content that is already there. The
-- moderation queue still holds 11 post entries, and resolving one may mean
-- deleting the row it points at.
create policy posts_admin_delete on posts for delete using (is_admin());

-- ---- post_likes: no client may write ------------------------------------
drop policy if exists post_likes_write  on post_likes;
drop policy if exists post_likes_delete on post_likes;

-- ---- messages: no client may write --------------------------------------
-- messages_write already required can_message() plus both parties
-- unrestricted, which limits WHO may write. With the surface retired the
-- question is whether writing should be possible at all, and it should not:
-- a retired surface that still accepts data is how rows nobody can explain
-- get created. 237 of the 262 moderation_queue entries came through here.
drop policy if exists messages_write  on messages;
drop policy if exists messages_update on messages;   -- read receipts
drop policy if exists messages_delete on messages;

-- Same reasoning as posts: an admin must be able to action the 237 queue
-- entries that point at these rows.
create policy messages_admin_delete on messages for delete using (is_admin());

-- ---- message_requests: the policies were never the door ------------------
-- THIS TABLE HAS NO WRITE POLICY AT ALL. Its only writers are two
-- SECURITY DEFINER functions, which bypass RLS by definition — so dropping
-- policies here would have looked like closure while the door stayed open.
-- Revoking execute is what actually closes it.
revoke execute on function ensure_message_request(uuid) from authenticated;
revoke execute on function respond_to_message_request(uuid, boolean) from authenticated;

-- Reads stay: participants can still see their own request rows, and nothing
-- is deleted.

-- ---- VERIFY (run separately; do not trust this file) ---------------------
--   select tablename, policyname, cmd, qual, with_check from pg_policies
--    where tablename in ('posts','post_likes','messages') order by tablename, cmd;
-- Expect: posts has SELECT (scoped, from 129) and DELETE (is_admin) only.
--         post_likes has SELECT only.
--         messages has SELECT (from 129) and DELETE (is_admin) only.
--
--   select has_function_privilege('authenticated',
--            'ensure_message_request(uuid)', 'execute') as ensure_open,
--          has_function_privilege('authenticated',
--            'respond_to_message_request(uuid, boolean)', 'execute') as respond_open;
-- Expect: both false.
--
-- Confirm nothing was destroyed:
--   select count(*) from posts;        -- expect 7
--   select count(*) from post_likes;   -- expect 3
--   select count(*) from messages;     -- unchanged; no row is deleted here
--
-- WHAT THIS MIGRATION DID, CORRECTED 2026-10-21.
--
-- This note used to read "DELIBERATELY NOT IN THIS MIGRATION: messages and
-- message_requests ... closing it is a separate decision. Ask before
-- assuming." That was false the moment it was written: the body above drops
-- messages_write, messages_update and messages_delete, and revokes execute on
-- ensure_message_request and respond_to_message_request from `authenticated`.
-- Both were closed here, twenty-five lines above the sentence saying they
-- were not.
--
-- The error mattered because this file IS the record of what was closed. A
-- reader checking whether direct messages still accept writes would have
-- concluded yes and could have built on that, and a later migration could
-- have "closed" them again or reopened them believing nothing was there.
--
-- WHAT IS DELIBERATELY KEPT, which is the reasoning the old note attached to
-- the wrong claim: admin DELETE on messages, and every read. 237 of the 262
-- moderation_queue rows are direct_message entries, so an admin must still be
-- able to action them and a moderator must still be able to read the message
-- a report points at. The direct-message surface may be revisited; if it is,
-- it needs new write policies and the two function grants back, not the
-- removal of something still standing.
