-- ============================================================
-- 034 — Constrain clip-post URLs at the database level
-- Additive on top of 002 + 004 + ... + 033.
--
-- Found during a full app audit: `posts_write` only ever checked
-- `author_id = auth.uid()` (plus minor/ban restrictions) — nothing
-- constrained `kind` or `body`. Highlights.addHighlight() in
-- golsz-app.html validates a highlight's URL is http(s) before
-- inserting a matching 'clip' post, but that's client-side only. Any
-- signed-in user could bypass it entirely with a direct REST call —
-- e.g. POST kind:'clip', body:'javascript:...' — and that would later
-- render as a real, clickable <a href> in Feed and the post-detail
-- viewer for every user who sees it. Fixed on the client with a
-- render-time safeHref() guard (renders as plain text unless the value
-- is actually http(s)), and here at the database level so a bad row
-- can't even be inserted in the first place.
--
-- athletes.highlights (a jsonb array, also rendered as <a href>) isn't
-- given an equivalent constraint here — validating every element of a
-- jsonb array needs a trigger, not a plain CHECK, and the client-side
-- safeHref() guard already neutralizes the actual rendering risk there
-- too. Noted as a known gap, not an oversight.
-- ============================================================

alter table posts drop constraint if exists posts_clip_body_is_http;
alter table posts add constraint posts_clip_body_is_http check (
  kind <> 'clip' or body is null or body ~* '^https?://'
);

-- ============================================================
-- Done.
-- ============================================================
