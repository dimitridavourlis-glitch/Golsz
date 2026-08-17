-- 129 — close the world-readable read policies on posts and follows
--
-- WHY THIS IS URGENT AND NOT PART OF THE FEED RETIREMENT
-- `posts_read` was `using (true)` — no condition at all. The anon key ships
-- inside the client bundle by design, so anyone holding it could read every
-- row. And Passport HIGHLIGHTS are stored in `posts` as kind='clip' with the
-- video URL in `body` (golsz-app.html, the highlight insert). So every
-- athlete's highlight reel URL was readable by a stranger who never signed up.
-- These are minors.
--
-- Precise wording, because it matters if this is ever described to a
-- regulator: `using (true)` does not mean "readable without credentials". It
-- means the policy imposes no condition, so the `anon` role passes it. The
-- anon key is public by design. The practical effect is the same.
--
-- `follows` was also `using (true)`: the entire follow graph, including who
-- follows which minor. Lower severity than video URLs, same category.
--
-- WHY TIGHTENING BREAKS NOTHING
-- Checked before writing this. The only pre-login surface, PublicPassport,
-- reads through get_public_passport() / get_public_passport_by_token(), both
-- SECURITY DEFINER — they bypass RLS entirely, so shared Passports keep
-- working. Every direct table read of posts is authenticated: Feed,
-- PostsGrid (the athlete's own highlights) and the admin panel. Feed,
-- Discover and Messages are being retired, so nothing needs to read another
-- athlete's posts at all.
--
-- NO DATA IS TOUCHED. This changes who may read, nothing else. Retiring a
-- feature must not delete what athletes already wrote.

-- ---- posts: your own, your child's, or admin ------------------------------
drop policy if exists posts_read on posts;
create policy posts_read on posts for select using (
  author_id = auth.uid()
  or is_parent_of(author_id)
  or is_admin()
);

-- ---- follows: only rows you are part of -----------------------------------
-- Kept rather than dropped: the table is Feed/Discover machinery, and this
-- migration is about read access, not about removing the feature. The
-- retirement commit decides the table's future.
drop policy if exists follows_read on follows;
create policy follows_read on follows for select using (
  follower_id = auth.uid()
  or followed_id = auth.uid()
  or is_admin()
);

-- ---- VERIFY (run separately; do not trust this file) ----------------------
-- Expect no row for posts or follows to come back as `true`:
--   select tablename, policyname, cmd, qual from pg_policies
--    where tablename in ('posts','follows') and cmd = 'SELECT';
--
-- Expect a shared Passport to still resolve (security definer bypasses RLS):
--   select get_public_passport('<some athlete uuid>') is not null;
--
-- Two other tables are deliberately left `using (true)`:
--   product_capabilities — plan/feature config, public by design
--   platform_insights    — keyed insight content, reads as intentional
-- Neither contains athlete data. Confirm that judgement before trusting it.
