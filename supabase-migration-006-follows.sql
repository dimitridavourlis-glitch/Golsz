-- ============================================================
-- 006 — Follows (profiles can follow each other)
-- Additive on top of 002 + 004 + 005.
-- ============================================================

create table if not exists follows (
  follower_id  uuid not null references profiles(id) on delete cascade,
  followed_id  uuid not null references profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (follower_id, followed_id),
  check (follower_id <> followed_id)
);
alter table follows enable row level security;

-- public read (same "public directory" pattern as posts/athletes) — needed
-- so follower/following counts can be shown on any profile, not just your own
drop policy if exists follows_read on follows;
create policy follows_read on follows for select using (true);

drop policy if exists follows_write on follows;
create policy follows_write on follows for insert with check (follower_id = auth.uid());

drop policy if exists follows_delete on follows;
create policy follows_delete on follows for delete using (follower_id = auth.uid());

-- ============================================================
-- Done. No minor-safety special case needed here: a restricted minor
-- already can't post (posts_write) and is hidden from Discover
-- (athletes_read), so there's no UI path to follow one anyway — the
-- existing gates already cover it.
-- ============================================================
