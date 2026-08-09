// ============================================================
// GOLSZ — "acting for athlete" authorization (P0-4)
//
// Under-16 athletes cannot hold their own account: api/create-child-account.js
// creates them with a synthetic address and a random, never-disclosed
// password, and a parent manages them. That means server endpoints have to
// accept "do this for athlete X" from a caller whose token says Y — the one
// shape that is genuinely dangerous if it is done casually.
//
// The rule this module enforces, and the only one: an athlete id in a request
// body is a REQUEST, never a grant. Nothing here trusts the client for
// identity. Every call independently establishes, against the database:
//
//   1. who the caller actually is        (token -> /auth/v1/user, not a body field)
//   2. that a parent_links row exists    (parent_id = caller, athlete_id = requested)
//   3. that the link is APPROVED         (approved_at is not null)
//   4. that the requested id is THAT link's athlete, not any other
//   5. that the caller is asking about an athlete they manage, not themselves
//      impersonating someone (self is allowed and short-circuits)
//
// RLS remains the second line: profiles_self is "(id = auth.uid()) OR
// is_parent_of(id)", so even a bug here cannot reach an unrelated athlete's
// row through the anon key. This module exists because the service-role key
// bypasses RLS entirely, so any endpoint using it has no second line at all.
//
// Shared by api/scout.js. Kept as its own file rather than a copy in each
// endpoint: an authorization check that exists in two places is an
// authorization check that will disagree with itself eventually.
// ============================================================

// Resolves the caller's own user id from a bearer token. Returns null for
// anything that isn't a currently-valid session — expired, forged, absent.
async function resolveCaller(authHeader, supaUrl, serviceKey) {
  if (!authHeader || !supaUrl || !serviceKey) return null;
  try {
    const r = await fetch(supaUrl + "/auth/v1/user", {
      headers: { Authorization: authHeader, apikey: serviceKey },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  } catch {
    return null;
  }
}

// The approved-link check, isolated so it can be tested without a token.
// Deliberately queries on BOTH ids plus approved_at rather than fetching the
// parent's links and filtering in JS — a filter written in JS is a filter
// somebody can later loosen by accident. Postgres either returns a row or it
// does not.
async function hasApprovedLink(parentId, athleteId, supaUrl, serviceKey) {
  if (!parentId || !athleteId) return false;
  try {
    const url = `${supaUrl}/rest/v1/parent_links`
      + `?parent_id=eq.${encodeURIComponent(parentId)}`
      + `&athlete_id=eq.${encodeURIComponent(athleteId)}`
      + `&approved_at=not.is.null`
      + `&select=id&limit=1`;
    const r = await fetch(url, { headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey } });
    if (!r.ok) return false;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    // A lookup failure is NOT permission. Every other rate-limit and metering
    // path in this project fails open on purpose; authorization is the one
    // place where that would be indefensible, so this fails closed.
    return false;
  }
}

// Returns { ok, athleteId, callerId, reason }.
//
// athleteId is the id every downstream query should use. When the caller is
// acting for themselves it is simply their own id, so callers can use the
// return value unconditionally instead of branching.
async function resolveActingAthlete(authHeader, requestedAthleteId, supaUrl, serviceKey) {
  const callerId = await resolveCaller(authHeader, supaUrl, serviceKey);
  if (!callerId) return { ok: false, athleteId: null, callerId: null, reason: "unauthenticated" };

  // No request, or a request for oneself: the ordinary path, no link needed.
  if (!requestedAthleteId || requestedAthleteId === callerId) {
    return { ok: true, athleteId: callerId, callerId, reason: "self" };
  }
  // Reject malformed ids before they reach a query string. Supabase ids are
  // uuids; anything else is either a bug or someone probing.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(requestedAthleteId))) {
    return { ok: false, athleteId: null, callerId, reason: "malformed_athlete_id" };
  }
  const linked = await hasApprovedLink(callerId, requestedAthleteId, supaUrl, serviceKey);
  if (!linked) return { ok: false, athleteId: null, callerId, reason: "not_linked_or_unapproved" };
  return { ok: true, athleteId: requestedAthleteId, callerId, reason: "parent_managed" };
}

// ESM: package.json declares "type": "module" and every api/*.js handler is
// `export default async function handler` — a CommonJS export here would
// fail at import time on Vercel, not at deploy time.
export { resolveCaller, hasApprovedLink, resolveActingAthlete };
