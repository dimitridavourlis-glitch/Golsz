-- ============================================================
-- 043 — Scout FAQ misses: what to add to scout_faq next
-- Additive on top of 002 + 004 + ... + 042.
--
-- Powers a new "Commonly Asked Questions" view under Admin Panel ->
-- Analytics -> Scout AI, so the FAQ database (041/042) can grow over
-- the next 1-6 months based on real gaps instead of guessing — the
-- more real questions get added, the higher the $0-cost "database"
-- share of Scout traffic gets, which is the actual cost lever here.
--
-- PRIVACY: this app has been deliberate all along about never letting
-- admins browse real Scout/DM conversation content (scout_history and
-- messages both have no admin-read policy; scout_routing_log stores
-- routing metadata only, never question/answer text — see migration
-- 038's audit). This table is a narrow, deliberate exception scoped to
-- the minimum needed to find real FAQ gaps:
--   - Only logged when a message did NOT match any existing FAQ
--     (faq_id was null) — a matched question doesn't need its raw text
--     logged, since its canonical form already exists in scout_faq.
--   - Only for intents that could plausibly become a static FAQ answer
--     (simple_knowledge, career_advice, scouting_analysis,
--     player_comparison) — never off_topic, profile_assist,
--     agent_workflow, or db_lookup, which are either personal,
--     action-oriented, or inherently not FAQ-shaped.
--   - No user_id or any other identifying column at all — these rows
--     can never be traced back to who asked.
--   - Question text truncated to 500 characters (same spirit as
--     error_log's truncation in api/scout.js's logError()).
-- ============================================================

create table if not exists scout_faq_misses (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  intent text,
  question text not null
);

alter table scout_faq_misses enable row level security;
-- Same direct-admin-read pattern as error_log — the Admin Panel queries
-- this table straight via `sb.from("scout_faq_misses")`, no RPC needed,
-- since it holds no content sensitive enough to require aggregation.
create policy scout_faq_misses_admin_read on scout_faq_misses for select using (is_admin());

-- ============================================================
-- Done.
-- ============================================================
