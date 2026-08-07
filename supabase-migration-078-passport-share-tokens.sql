-- ============================================================
-- 078 — Revocable Passport share links
-- The original share flow (046/047) was one global passport_public
-- boolean shared by every copy of the ?public=<uid> link — flipping it
-- off kills every link at once, and there's no way to tell who has which
-- link or revoke just one. This adds real per-link tokens: each Share tap
-- creates a new row, the URL becomes ?share=<token>, and any one link can
-- be individually revoked without touching the others.
-- get_public_passport_by_token() intentionally does NOT check
-- profiles.passport_public — a valid, non-revoked token IS the athlete's
-- per-link consent already; the old global boolean/RPC (046/047/067) is
-- left fully intact, just no longer the primary share path client-side.
-- ============================================================

create table if not exists passport_share_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  token text not null unique default encode(gen_random_bytes(16), 'hex'),
  label text,
  revoked boolean not null default false,
  created_at timestamptz not null default now(),
  last_accessed_at timestamptz
);

create index if not exists passport_share_tokens_user_idx on passport_share_tokens (user_id);
create index if not exists passport_share_tokens_token_idx on passport_share_tokens (token) where not revoked;

alter table passport_share_tokens enable row level security;

drop policy if exists passport_share_tokens_own_read on passport_share_tokens;
create policy passport_share_tokens_own_read on passport_share_tokens for select using (user_id = auth.uid());
-- Deliberately no insert/update/delete policies — creation and revocation
-- both go through the security-definer RPCs below so user_id is always
-- auth.uid(), never trusted from a client-supplied value.

create or replace function create_passport_share_token(p_label text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_row passport_share_tokens;
begin
  insert into passport_share_tokens (user_id, label)
  values (auth.uid(), nullif(trim(p_label), ''))
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'token', v_row.token, 'label', v_row.label, 'created_at', v_row.created_at);
end;
$$;

create or replace function revoke_passport_share_token(p_id uuid)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update passport_share_tokens set revoked = true where id = p_id and user_id = auth.uid();
end;
$$;

grant execute on function create_passport_share_token(text) to authenticated;
grant execute on function revoke_passport_share_token(uuid) to authenticated;

create or replace function get_public_passport_by_token(p_token text)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare
  v_user uuid;
begin
  select user_id into v_user from passport_share_tokens where token = p_token and not revoked;
  if v_user is null or is_restricted_minor(v_user) then return null; end if;
  update passport_share_tokens set last_accessed_at = now() where token = p_token;
  return (
    select jsonb_build_object(
      'full_name', p.full_name,
      'occupation', p.occupation,
      'verified_tier', p.verified_tier,
      'identity_verified', coalesce(p.identity_verified, false),
      'avatar_url', p.avatar_url,
      'sport', a.sport,
      'position', a.position,
      'club_name', a.club_name,
      'country', a.country,
      'grad_year', a.grad_year,
      'recruiting_status', a.recruiting_status,
      'foot', a.foot,
      'height_cm', a.height_cm,
      'weight_kg', a.weight_kg,
      'bio', a.bio,
      'highlights', coalesce(a.highlights, '[]'::jsonb)
    )
    from profiles p
    left join athletes a on a.id = p.id
    where p.id = v_user
  );
end;
$$;

grant execute on function get_public_passport_by_token(text) to anon, authenticated;
