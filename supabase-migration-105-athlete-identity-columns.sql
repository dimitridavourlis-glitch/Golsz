-- Migration 105 — real columns for athlete identity, origin and location
--
-- Audit finding (Scout context/memory/routing directive, Step 1): the live
-- athletes table has exactly ONE geography column, `country`, and
-- PROFILE_FIELD_MAP in api/scout.js mapped BOTH of these onto it:
--
--     location:    { table: "athletes", column: "country" },
--     citizenship: { table: "athletes", column: "country" },
--
-- One column, three meanings (where they're from / where they are / what
-- passport they hold), last write wins. "I'm from Montreal", "I moved to
-- Cyprus" and "I'm Canadian" each silently overwrote the previous one. That
-- is the root cause of Scout confusing home location with current location:
-- no prompt rule can fix a schema that cannot represent the difference.
--
-- Two more fields were listed in SYSTEM_PROMPT as allowed profile_updates
-- keys but had NO PROFILE_FIELD_MAP entry at all, so every value the model
-- ever reported was silently discarded before it reached the database:
-- `age` and `budget`. Age in particular is then re-asked next session,
-- which reads to the athlete as Scout forgetting. Same class of bug as the
-- `goal` key fixed in migration 099.
--
-- `country` is deliberately NOT renamed or dropped. It is the athlete's
-- CURRENT country and is already load-bearing: search_players() filters on
-- it, the Passport and the show_country visibility flag read it, and
-- migration 100 wired it into scout_visible. Renaming it would be a
-- breaking change for no benefit. This adds the missing dimensions around
-- it instead.
--
-- Age is stored two ways on purpose. dob is exact and never goes stale, but
-- an athlete usually just says "I'm 16" in chat. age_reported +
-- age_reported_at lets the server age that forward correctly instead of
-- believing "16" forever; buildAuthoritativeContext() prefers dob when both
-- are present.
--
-- previous_clubs is jsonb (array of {name, from, to, level}) rather than a
-- separate table: it is read whole, written whole, never queried across
-- athletes, and matches how highlights/scout_context already work here.

alter table athletes add column if not exists home_city text;
alter table athletes add column if not exists home_country text;
alter table athletes add column if not exists current_city text;
alter table athletes add column if not exists citizenship text;
alter table athletes add column if not exists dob date;
alter table athletes add column if not exists age_reported int check (age_reported is null or (age_reported between 5 and 80));
alter table athletes add column if not exists age_reported_at date;
alter table athletes add column if not exists secondary_position text;
alter table athletes add column if not exists previous_clubs jsonb not null default '[]'::jsonb;

-- Backfill: whatever is in `country` today is the athlete's current country
-- (that is how the app and search have always used it). Home country starts
-- as null rather than being assumed equal to current country -- assuming
-- they match is exactly the conflation this migration exists to end. Scout
-- learns it, or it stays UNKNOWN.
comment on column athletes.country is 'CURRENT country. Home country is home_country. Passport/citizenship is citizenship. Do not overload.';
comment on column athletes.home_city is 'Where the athlete is from. Never overwritten by where they currently are.';
comment on column athletes.current_city is 'Where the athlete currently is. Pairs with country (current country).';
comment on column athletes.previous_clubs is 'jsonb array of {name, from, to, level}. Append-only in practice; current club stays in club_name.';
