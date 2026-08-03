-- ============================================================
-- 041 — Scout FAQ: a real $0-AI-cost answer path
-- Additive on top of 002 + 004 + ... + 040.
--
-- scout_faq holds pre-written answers to the most common questions
-- athletes ask across sports (recruiting steps, eligibility basics,
-- general career advice, etc.). api/scout.js checks every incoming
-- Scout message against this table BEFORE calling any model — a match
-- is served directly, logged as answered_by='database' in
-- scout_routing_log (migration 039) with $0 cost, and never touches
-- Haiku or Sonnet at all. This is the real implementation of the
-- "database" bucket in the Admin Panel's AI Model Usage card, which
-- has shown 0% since that card shipped.
--
-- Matching uses Postgres's built-in trigram similarity (pg_trgm) —
-- free, no embeddings model, no extra API call. It catches close
-- rephrasings of a stored question well. It will NOT catch a question
-- that means the same thing in very different words (e.g. "how do I
-- get recruited" vs "what's the best way to get on a coach's radar")
-- — that needs real semantic (embeddings) matching, a separate future
-- upgrade if trigram matching's real hit rate turns out too low once
-- there's real traffic to check it against.
--
-- `lang` matters: a French-phrased question should only ever match a
-- French-language row, both so the trigram comparison is meaningful
-- (it's comparing raw text, not meaning) and so a matched answer comes
-- back in the athlete's own language, same as every other Scout reply.
-- ============================================================

create extension if not exists pg_trgm;

create table if not exists scout_faq (
  id bigint generated always as identity primary key,
  sport text,        -- null = applies across all sports
  lang text not null default 'en',
  question text not null,
  answer text not null,
  created_at timestamptz not null default now()
);

create index if not exists scout_faq_question_trgm_idx on scout_faq using gin (question gin_trgm_ops);

alter table scout_faq enable row level security;
-- Admins can browse the table directly (same is_admin() pattern as
-- everywhere else) if a "Manage FAQ" view gets added later. No other
-- role can read/write it directly — api/scout.js only ever calls it
-- through match_scout_faq() below via the service-role key.
create policy scout_faq_admin_read on scout_faq for select using (is_admin());

-- Returns the single best-matching FAQ row for p_question in p_lang,
-- restricted to p_sport when given (rows with sport = null apply to
-- every sport). No row comes back below a 0.30 similarity floor —
-- deliberately conservative: a wrong "$0 answer" that doesn't actually
-- address the question is worse than just paying for a real one.
create or replace function match_scout_faq(p_question text, p_lang text default 'en', p_sport text default null)
returns table(id bigint, question text, answer text, similarity real)
language sql stable as $$
  select id, question, answer, similarity(question, p_question) as similarity
  from scout_faq
  where lang = p_lang
    and (p_sport is null or sport is null or sport = p_sport)
    and similarity(question, p_question) > 0.30
  order by similarity(question, p_question) desc
  limit 1;
$$;

grant execute on function match_scout_faq(text, text, text) to service_role, authenticated;

-- ============================================================
-- Done.
-- ============================================================
