-- 10) ADDITIVE — POSTS (Feed) + POST_LIKES + EVENTS
--     Feed and Events had no backing tables at all (golsz-app.html rendered
--     hardcoded FEED/EVENTS arrays). This section adds them, following the
--     same "public directory read, owner (or parent) write" pattern used by
--     athletes/coaches/clubs above. Safe to append/re-run on top of the
--     tables created earlier in this file.
-- ============================================================
alter table athletes add column if not exists gender text;

create table if not exists posts (
  id           uuid primary key default gen_random_uuid(),
  author_id    uuid not null references profiles(id) on delete cascade,
  kind         text not null default 'post' check (kind in ('post','commit','clip','perf','call')),
  headline     text not null,
  body         text,
  likes_count  int not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists posts_created_at_idx on posts (created_at desc);

create table if not exists post_likes (
  post_id     uuid not null references posts(id) on delete cascade,
  profile_id  uuid not null references profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (post_id, profile_id)
);

-- keep posts.likes_count in sync with post_likes rows instead of trusting the client
create or replace function _post_likes_sync()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT') then
    update posts set likes_count = likes_count + 1 where id = new.post_id;
    return new;
  elsif (tg_op = 'DELETE') then
    update posts set likes_count = greatest(likes_count - 1, 0) where id = old.post_id;
    return old;
  end if;
  return null;
end $$;

drop trigger if exists post_likes_sync on post_likes;
create trigger post_likes_sync
  after insert or delete on post_likes
  for each row execute function _post_likes_sync();

create table if not exists events (
  id               uuid primary key default gen_random_uuid(),
  title            text not null,
  sport            text,
  location         text,
  level            text,
  event_date       date not null,
  spots_available  int,
  created_by       uuid references profiles(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists events_date_idx on events (event_date);

alter table posts       enable row level security;
alter table post_likes  enable row level security;
alter table events      enable row level security;

-- posts: public directory read, owner (or parent) write — same pattern as athletes
drop policy if exists posts_read on posts;
create policy posts_read on posts for select using (true);
drop policy if exists posts_write on posts;
create policy posts_write on posts for insert with check (author_id = auth.uid() or is_parent_of(author_id));
drop policy if exists posts_update on posts;
create policy posts_update on posts for update using (author_id = auth.uid() or is_parent_of(author_id));
drop policy if exists posts_delete on posts;
create policy posts_delete on posts for delete using (author_id = auth.uid() or is_parent_of(author_id));

-- post_likes: you can only see/create/remove your own like rows (posts.likes_count is the public number)
drop policy if exists post_likes_read on post_likes;
create policy post_likes_read on post_likes for select using (profile_id = auth.uid());
drop policy if exists post_likes_write on post_likes;
create policy post_likes_write on post_likes for insert with check (profile_id = auth.uid());
drop policy if exists post_likes_delete on post_likes;
create policy post_likes_delete on post_likes for delete using (profile_id = auth.uid());

-- events: public directory read, creator write (no admin/club-only gate yet — anyone signed in can post one)
drop policy if exists events_read on events;
create policy events_read on events for select using (true);
drop policy if exists events_write on events;
create policy events_write on events for insert with check (created_by = auth.uid());
drop policy if exists events_update on events;
create policy events_update on events for update using (created_by = auth.uid());
drop policy if exists events_delete on events;
create policy events_delete on events for delete using (created_by = auth.uid());

-- ============================================================
-- Done. Follow-ups, still true here:
--  - Discover now has a `gender` column on athletes to match golsz-app.html's
--    filter UI; it's nullable and unset for existing rows.
--  - Feed/Discover/Events in golsz-app.html fetch from posts/athletes/events
--    when Supabase is configured, falling back to the hardcoded arrays when
--    a query returns zero rows (so the app still looks alive pre-launch).
--  - There's still no UI to create a post or an event — posts/events tables
--    exist and are queried, but nothing writes to them yet apart from
--    post_likes (the Feed's like button).
--  - Scout()'s chat in golsz-app.html doesn't write to scout_history yet —
--    only increment_scout_usage() (called server-side by api/scout.js) logs
--    'usage' rows today. Insert 'user'/'assistant' rows from the client via
--    supabase-js if you want a real transcript, not just a call count.
--  - parent_links.approved_at is set to null on insert (pending) — an
--    actual verification step (email confirmation to the parent, admin
--    review, etc.) should set it before a parent gets real access to a
--    minor's data. Don't let a self-reported parent_links row auto-approve.
-- ============================================================
