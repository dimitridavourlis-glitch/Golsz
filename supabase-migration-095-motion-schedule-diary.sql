-- ============================================================
-- 095 — schema-only shells: GOLSZ Motion, Athlete Schedule, Athlete Diary
-- (same directive §17/§12/§14 + §27: "create the database space now, do
-- not build the complete UI/workflow yet"). No client UI reads or writes
-- these yet — that's explicitly Build Next, not this pass. Self-service
-- RLS only, same pattern as pathway_plan/development_plan_items (no admin
-- visibility policy — personal development/health-adjacent data).
-- ============================================================

create table if not exists golsz_motion_exercises (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique not null,
  category text not null check (category in (
    'strength', 'speed', 'acceleration', 'agility', 'power', 'endurance',
    'mobility', 'flexibility', 'balance', 'coordination', 'core',
    'warmup', 'recovery', 'sport_specific'
  )),
  subcategory text,
  description text,
  purpose text,
  instructions text,
  video_url text,
  animation_url text,
  thumbnail_url text,
  equipment_required text,
  difficulty text check (difficulty in ('beginner', 'intermediate', 'advanced')),
  sport_tags text[],
  position_tags text[],
  age_guidance text,
  duration_or_reps_guidance text,
  common_mistakes text,
  safety_notes text,
  contraindication_notes text,
  active boolean not null default true,
  approved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table golsz_motion_exercises enable row level security;
create policy golsz_motion_exercises_read on golsz_motion_exercises for select using (active and approved);
-- write is service-role/admin only — no insert/update/delete policy for
-- regular users; content is curated, never athlete- or AI-authored.

create table if not exists athlete_schedule (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  day_of_week int not null check (day_of_week between 0 and 6),
  activity_type text not null check (activity_type in (
    'wake', 'meal', 'school', 'work', 'training', 'gym', 'game',
    'travel', 'study', 'recovery', 'sleep', 'other'
  )),
  title text,
  start_time time,
  end_time time,
  location text,
  recurrence text,
  notes text,
  reminder_enabled boolean not null default false,
  reminder_offset_minutes int,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table athlete_schedule enable row level security;
create policy athlete_schedule_rw on athlete_schedule for all using (
  (user_id = auth.uid()) or is_parent_of(user_id)
) with check (
  (user_id = auth.uid()) or is_parent_of(user_id)
);

create table if not exists athlete_diary_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  entry_date date not null default current_date,
  training_session text,
  energy int check (energy between 1 and 10),
  effort int check (effort between 1 and 10),
  sleep_hours numeric,
  sleep_quality int check (sleep_quality between 1 and 10),
  soreness int check (soreness between 1 and 10),
  readiness int check (readiness between 1 and 10),
  nutrition_check boolean,
  hydration_check boolean,
  notes text,
  created_at timestamptz not null default now(),
  unique(user_id, entry_date)
);
alter table athlete_diary_entries enable row level security;
create policy athlete_diary_entries_rw on athlete_diary_entries for all using (
  (user_id = auth.uid()) or is_parent_of(user_id)
) with check (
  (user_id = auth.uid()) or is_parent_of(user_id)
);
-- Done.
