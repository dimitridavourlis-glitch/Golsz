-- ============================================================
-- 033 — Moderation review queue
-- Additive on top of 002 + 004 + ... + 032.
--
-- api/moderate.js's classifier (a much richer replacement for the
-- earlier flagged/not-flagged check) now returns one of three
-- decisions: allow, review, or block. "allow" needs no record — the
-- content already exists in its normal table (posts/messages/etc).
-- "review" and "block" both get logged here, with the actual text,
-- since for "block" the content was never saved anywhere else at all —
-- this is the only record of what was rejected and why.
--
-- Same privacy/trust shape as admin_action_log (migration 030): no
-- `authenticated` insert/update policy at all. The only write path is
-- api/moderate.js itself, using the service role key (it already has
-- to look up the real author/recipient profile data server-side rather
-- than trust the client's claims about who's a minor). The only update
-- path is resolve_moderation_item(), security definer, admin-gated.
-- ============================================================

create table if not exists moderation_queue (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references profiles(id) on delete set null,
  content_type text not null,
  text text,
  surface text,
  decision text not null,
  primary_reason_code text,
  reason_codes jsonb,
  confidence numeric,
  minor_safety_triggered boolean not null default false,
  rationale text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references profiles(id) on delete set null
);

create index if not exists moderation_queue_created_idx on moderation_queue (created_at desc);
create index if not exists moderation_queue_unresolved_idx on moderation_queue (resolved_at) where resolved_at is null;

alter table moderation_queue enable row level security;

drop policy if exists moderation_queue_admin_read on moderation_queue;
create policy moderation_queue_admin_read on moderation_queue for select using (
  is_admin()
);

create or replace function resolve_moderation_item(p_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not is_admin() then
    raise exception 'not authorized';
  end if;
  update moderation_queue set resolved_at = now(), resolved_by = auth.uid() where id = p_id;
end;
$$;

grant execute on function resolve_moderation_item(uuid) to authenticated;

-- ============================================================
-- Done.
-- ============================================================
