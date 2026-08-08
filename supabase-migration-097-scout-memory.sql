-- 097 — SCOUT MEMORY: the living athlete intelligence file
-- Scout Intelligence Architecture, layer 3 — the most important addition.
--
-- This does NOT replace athletes.scout_context (migration 050). That column
-- already holds 17 typed fields with {value, source, confidence} and is
-- still the fast "what does Scout know about the softer stuff" lookup.
-- scout_memory is the ADDITIVE part scout_context can't express: many rows
-- per subject, an explicit type taxonomy, supersession history, and
-- importance ranking for retrieval.
--
-- The critical rule from the spec — FACTS and INFERENCES must never be
-- treated as the same thing — is enforced by `type` being a hard CHECK
-- constraint, not a convention. A row's type cannot drift.
--
-- superseded_by implements the contradiction rule: when the athlete's club
-- changes, the old row goes active=false + superseded_by=<new row>, so
-- current state is unambiguous while career history is preserved.
-- ============================================================

create table if not exists scout_memory (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references profiles(id) on delete cascade,
  type text not null check (type in (
    'FACT','USER_STATED','SCOUT_INFERENCE','GOAL','PREFERENCE','CONCERN',
    'UNKNOWN','NEXT_DATA_NEEDED','ASSESSMENT','DECISION',
    'PATHWAY_CONSIDERED','PATHWAY_REJECTED','PATHWAY_ACTIVE','MILESTONE'
  )),
  sport text,
  subject text not null,
  content text not null,
  confidence numeric(3,2) not null default 0.5 check (confidence >= 0 and confidence <= 1),
  source text,                                  -- 'athlete_stated' | 'scout_inference' | 'profile' | 'research' | 'outcome'
  importance int not null default 3 check (importance between 1 and 5),
  active boolean not null default true,
  superseded_by uuid references scout_memory(id) on delete set null,
  last_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Reserved for optional semantic retrieval later. Nullable and unused for
  -- now: deterministic retrieval ships today, so enabling pgvector later is
  -- a backfill rather than a migration rewrite, and GOLSZ's intelligence
  -- stays model-independent (no embedding-provider dependency) meanwhile.
  embedding_pending boolean not null default false
);

-- Retrieval path: active memory for this athlete, most important first.
create index if not exists scout_memory_retrieval_idx
  on scout_memory (athlete_id, active, importance desc, updated_at desc);
create index if not exists scout_memory_type_idx on scout_memory (athlete_id, type) where active;
create index if not exists scout_memory_unknowns_idx
  on scout_memory (athlete_id, importance desc) where active and type in ('UNKNOWN','NEXT_DATA_NEEDED');

alter table scout_memory enable row level security;

-- Private to the athlete (and their guardian for a managed minor account) —
-- same self-service pattern pathway_plan/development_plan_items use. No
-- admin read policy: this is an athlete's private intelligence file, and
-- Level 1 of the spec's learning model says it must never leak sideways.
drop policy if exists scout_memory_own_read on scout_memory;
create policy scout_memory_own_read on scout_memory for select using (
  athlete_id = auth.uid() or is_parent_of(athlete_id)
);
drop policy if exists scout_memory_own_write on scout_memory;
create policy scout_memory_own_write on scout_memory for all
  using (athlete_id = auth.uid() or is_parent_of(athlete_id))
  with check (athlete_id = auth.uid() or is_parent_of(athlete_id));

-- Supersede-and-insert in one atomic step (the contradiction rule).
-- security definer so api/scout.js can call it with the verified user id;
-- p_athlete is never taken from the client request body.
create or replace function supersede_scout_memory(
  p_athlete uuid, p_type text, p_subject text, p_content text,
  p_confidence numeric default 0.6, p_source text default 'athlete_stated',
  p_importance int default 3
)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_new uuid;
begin
  insert into scout_memory (athlete_id, type, subject, content, confidence, source, importance, last_confirmed_at)
  values (p_athlete, p_type, p_subject, p_content, p_confidence, p_source, p_importance, now())
  returning id into v_new;
  -- Any earlier ACTIVE row on the same subject+type is now history, not a
  -- competing truth.
  update scout_memory
     set active = false, superseded_by = v_new, updated_at = now()
   where athlete_id = p_athlete and type = p_type
     and lower(subject) = lower(p_subject)
     and id <> v_new and active;
  return v_new;
end;
$$;
revoke execute on function supersede_scout_memory(uuid, text, text, text, numeric, text, int) from anon, authenticated;
