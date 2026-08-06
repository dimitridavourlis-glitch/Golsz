-- ============================================================
-- 066 — Temporarily disable the minor-restriction gate
-- Golsz Trust & Safety Moderation System (approved plan) follow-up.
--
-- is_restricted_minor() existed to gate exposure surfaces for a minor
-- with no approved parent link: appearing in Discover, posting to the
-- public Feed, receiving message requests, and (as of this session)
-- being viewable via a shared Passport link. With Feed/Discover/Events/
-- Messages launch-scoped off the nav (see golsz-app.html), the only one
-- of those still live is the Passport share link — and since Family &
-- Parent Access (the only way a minor could ever become unrestricted)
-- is also launch-scoped off, every minor who signs up right now is
-- permanently restricted with no path out, which silently breaks Share
-- for them.
--
-- Decision: rather than resurrect Family & Parent Access for a "no
-- contact between accounts" version of the app, disable the gate
-- itself for now — every RLS policy that calls this function keeps its
-- own logic untouched, so restoring real enforcement later (once
-- Discover/Messages come back) is just reverting this one function.
--
-- Does NOT touch the AI moderation minor-safety rules in api/moderate.js
-- (MINOR_CONTACT_SOLICITATION, MINOR_SECRECY, etc.) — that's a
-- different system protecting against unsafe language in the surfaces
-- that ARE live (Scout chat, Passport bio/timeline text), unrelated to
-- "contact between accounts."
-- ============================================================

create or replace function is_restricted_minor(p_user uuid)
returns boolean language sql security definer set search_path to 'public' as $$
  select false;
$$;
