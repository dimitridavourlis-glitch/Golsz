-- 133 — record who moderated content was aimed at
--
-- moderation_queue stores author_id, content_type, text, surface and the
-- decision — but never who the content was FOR. The client already sends
-- recipientId, the server already resolves it to a role and is_minor for the
-- classifier, and then it is thrown away.
--
-- HONEST ABOUT THE VALUE TODAY: this column will be NULL on every row that can
-- currently be written. The only call site that passes a recipient is the DM
-- send in Messages, which is unreachable — the component does not render and
-- direct_message is retired. Scout deliberately omits it. profile_field and
-- media_caption have no recipient by nature.
--
-- SO WHY ADD IT NOW. Because the absence of exactly this column is why 237
-- direct_message rows are permanently unattributable: Scout text and
-- user-to-user DMs shared a content_type, and a null recipient would have
-- separated them for free. That was discovered after the rows existed, when
-- nothing could be done about it. If any recipient-bearing content type ever
-- returns — messaging, connection requests, comments — the record captures it
-- from the first row rather than from the day someone notices it is missing.
--
-- Additive, nullable, no backfill, no RLS change. moderation_queue is
-- admin-read-only and service-role-write; adding a column does not widen that.

alter table moderation_queue add column if not exists recipient_id uuid references profiles(id) on delete set null;

-- on delete set null, not cascade: a deleted account must not erase the
-- moderation record of content that was aimed at them. The row survives with
-- the recipient unknown, which is the honest state.

-- ---- VERIFY (run separately; do not trust this file) ----------------------
--   select column_name, data_type, is_nullable from information_schema.columns
--    where table_name = 'moderation_queue' and column_name = 'recipient_id';
--   select count(*) from moderation_queue;                      -- expect 262
--   select count(*) from moderation_queue where recipient_id is not null;  -- expect 0
