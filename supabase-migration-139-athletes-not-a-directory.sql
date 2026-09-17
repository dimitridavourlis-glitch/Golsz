-- 139 — a signed-in account could read every visible athlete's FULL ROW.
--
-- athletes_read (migration 126) is:
--   for select to authenticated using (
--     (coalesce(scout_visible, true) or id = auth.uid() or is_parent_of(id) or is_admin())
--     and (not is_banned(id) or id = auth.uid() or is_admin()))
--
-- The scout_visible clause makes every athlete who has not hidden themselves —
-- the default is TRUE — readable by ANY authenticated account. Not a curated
-- subset of columns: the whole row. That row carries dob, age_reported,
-- home_city, home_country, current_city, citizenship and scout_context, the
-- jsonb file Scout builds about them from their own conversations.
--
-- These are 13-to-18-year-olds. Anyone who could complete a free signup could
-- read the date of birth and home city of every visible child on the platform.
-- That is the finding; the rest of this comment is why the fix is safe.
--
-- NOTHING IN THE LIVE APP READS ANOTHER ATHLETE'S ROW. The three components
-- that ever called onViewProfile — Feed, Discover and Messages — are all
-- retired and none is mounted (there is no page === "discover" or
-- page === "feed" branch, and Messages' openThread is an explicit no-op). The
-- one surviving caller is MyAthletes: a PARENT opening their own linked child,
-- which is_parent_of(id) already covers.
--
-- Shared Passports are unaffected. PublicPassport does not touch this table —
-- it calls get_public_passport_by_token / get_public_passport, security-definer
-- functions that choose their own columns and honour show_club / show_country.
-- Server code is unaffected too: api/*.js uses the service key, which bypasses
-- RLS entirely, so Scout's player search still works.
--
-- So the directory clause was granting a capability the product had already
-- withdrawn. Removing it costs nothing and closes the row.
--
-- WHAT IS DELIBERATELY KEPT: the ban check, verbatim. An athlete can always
-- read their own row even while banned, and an admin can read anyone's — both
-- exactly as before.
--
-- Idempotent. Safe to re-run.
drop policy if exists athletes_read on athletes;
create policy athletes_read on athletes for select to authenticated using (
  (id = auth.uid() or is_parent_of(id) or is_admin())
  and (not is_banned(id) or id = auth.uid() or is_admin())
);

comment on policy athletes_read on athletes is
  'Self, their linked parent, or an admin. NOT a directory: this row holds dob, home city, citizenship and scout_context for minors. Cross-athlete reads belong in a security-definer function that picks its own columns (see get_public_passport), never here.';
