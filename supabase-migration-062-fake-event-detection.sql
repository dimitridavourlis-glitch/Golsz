-- ============================================================
-- 062 — Fake-opportunity heuristics for events
-- Golsz Trust & Safety Moderation System (approved plan).
--
-- Rule-based, no AI call — events are created directly client-side
-- (AddToEventsModal for private saves, Admin Panel for public listings),
-- with no serverless proxy function to hook a server-side check into, so
-- this runs as a BEFORE INSERT trigger, the same pattern already used for
-- protect_profile_columns(). Flags (via the existing is_blocked column,
-- same one the Admin Panel's manual block button already uses) a new
-- event as high-risk — pending review, never silently deleted — when
-- either:
--   (a) a near-duplicate (same title/location/date) already exists from
--       a DIFFERENT account, AND the creating account is under 48h old
--       (the spec's "newly created accounts" + "duplicate postings"
--       combination), or
--   (b) the free-text notes contain a common link-shortener domain (often
--       used to obscure a scam destination) or an upfront-payment phrase
--       ("wire transfer", "processing fee", "registration fee", "western
--       union" — the spec's "requests for upfront payment").
-- Real GOLSZ contact for a flagged event still goes through the existing
-- Admin Panel review path (unblock is just flipping is_blocked back).
-- ============================================================

create or replace function check_event_fake_signals()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  v_creator_created_at timestamptz;
  v_is_new_account boolean;
  v_duplicate_exists boolean;
  v_suspicious_text boolean;
begin
  if new.created_by is null then
    return new;
  end if;

  select created_at into v_creator_created_at from profiles where id = new.created_by;
  v_is_new_account := v_creator_created_at is not null and v_creator_created_at > now() - interval '48 hours';

  select exists (
    select 1 from events e
    where e.created_by is distinct from new.created_by
      and lower(e.title) = lower(new.title)
      and coalesce(lower(e.location), '') = coalesce(lower(new.location), '')
      and e.event_date = new.event_date
  ) into v_duplicate_exists;

  v_suspicious_text := coalesce(new.notes, '') ~* '(bit\.ly|tinyurl|wire transfer|processing fee|registration fee|upfront payment|western union)';

  if (v_is_new_account and v_duplicate_exists) or v_suspicious_text then
    new.is_blocked := true;
  end if;

  return new;
end;
$$;

drop trigger if exists events_fake_signals_check on events;
create trigger events_fake_signals_check before insert on events
  for each row execute function check_event_fake_signals();
