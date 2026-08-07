// ============================================================
// GOLSZ — Parent-created child account (migration 080, corrected
// pre-launch directive)
// Deploy target: /api/create-child-account.js
//
// Policy: an athlete under 16 may NOT independently create or control a
// GOLSZ account. A parent/guardian must create it. This endpoint is the
// only way a profile for an under-16 athlete ever comes into existence —
// there is no client-side self-signup path for age < 16 (golsz-app.html's
// Auth blocks it and routes here instead).
//
// The already-authenticated PARENT calls this with the athlete's name and
// date of birth. It creates a real auth.users row for the child (Admin
// API, service role) with a random, never-disclosed password and a
// synthetic email the child never sees and can never use to log in
// independently — the child's account only exists as a data owner for
// their profile row; it is never a login the child (or anyone but the
// parent, via parent_links) can use. handle_new_user() fires normally on
// that insert (profiles/athletes rows, is_minor computed from the DOB
// metadata). A parent_links row is inserted pre-approved (approved_at set
// immediately) — unlike request_parent_link()'s deliberately-pending
// design for a self-reported link to an already-existing, independently-
// controlled account (see that migration's own comment), there is no
// existing independent child account here to protect: the parent created
// this row themselves, right now, so immediate approval is correct, not a
// bypass of the child's own consent.
//
// profiles_self ("(id = auth.uid()) OR is_parent_of(id)") and athletes_rw
// already grant the parent full read/write on the resulting rows once
// parent_links is approved — confirmed live before writing this file, no
// RLS changes needed.
//
// Required env vars:
//   SUPABASE_URL / SUPABASE_SERVICE_KEY
// ============================================================

import crypto from "crypto";

const MAX_CHILDREN_PER_PARENT = 10;

async function getUserId(authHeader, supaUrl, serviceKey) {
  if (!authHeader) return null;
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

async function logError(supaUrl, serviceKey, source, message, detail) {
  try {
    await fetch(`${supaUrl}/rest/v1/error_log`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ source, message: String(message).slice(0, 2000), detail: detail || null }),
    });
  } catch (e) { console.error("GOLSZ error-log write failed:", e); }
}

// Same age-calc as the client's own (see golsz-app.html Auth) — full
// year/month/day comparison, not a naive year-subtraction, so a birthday
// later this calendar year doesn't undercount age by one.
function ageFromDob(dobIso) {
  const dob = new Date(dobIso);
  if (isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey) return res.status(500).json({ error: "Server missing SUPABASE_URL/SUPABASE_SERVICE_KEY" });

  const parentId = await getUserId(req.headers.authorization, supaUrl, serviceKey);
  if (!parentId) return res.status(401).json({ error: "Sign in as the parent/guardian first." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const childFullName = (body && typeof body.childFullName === "string") ? body.childFullName.trim().slice(0, 120) : "";
  const childDob = (body && typeof body.childDob === "string") ? body.childDob : "";
  if (!childFullName) return res.status(400).json({ error: "Athlete's full name is required." });

  const age = ageFromDob(childDob);
  if (age === null) return res.status(400).json({ error: "A valid date of birth is required." });
  if (age >= 16) return res.status(400).json({ error: "This is only for athletes under 16 — they can sign up for their own GOLSZ account directly.", code: "not_under_16" });

  try {
    // Sanity cap — a parent legitimately manages a small number of kids,
    // not an unbounded number; blunt basic abuse of this endpoint.
    const countRes = await fetch(`${supaUrl}/rest/v1/parent_links?parent_id=eq.${parentId}&select=id`, {
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, Prefer: "count=exact" },
    });
    const existingCount = Number((countRes.headers.get("content-range") || "0/0").split("/")[1] || 0);
    if (existingCount >= MAX_CHILDREN_PER_PARENT) {
      return res.status(400).json({ error: "Too many linked athletes on this account. Contact support if you need more." });
    }

    const syntheticEmail = `child-${crypto.randomUUID()}@managed.golsz.internal`;
    const randomPassword = crypto.randomBytes(24).toString("base64url");

    const createRes = await fetch(`${supaUrl}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: syntheticEmail,
        password: randomPassword,
        email_confirm: true,
        user_metadata: { full_name: childFullName, date_of_birth: childDob, managed_by_parent: true },
      }),
    });
    const createData = await createRes.json();
    if (!createRes.ok || !createData || !createData.id) {
      await logError(supaUrl, serviceKey, "api/create-child-account.js", "Admin createUser failed", { detail: JSON.stringify(createData), parentId });
      return res.status(502).json({ error: "Couldn't create the athlete's account. Please try again." });
    }
    const childId = createData.id;

    // handle_new_user() runs synchronously on the auth.users insert above
    // (it's a database trigger), so profiles/athletes rows already exist
    // by the time we get here — safe to PATCH/insert against them next.
    await fetch(`${supaUrl}/rest/v1/profiles?id=eq.${childId}`, {
      method: "PATCH",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ parent_managed: true }),
    });

    const linkRes = await fetch(`${supaUrl}/rest/v1/parent_links`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ parent_id: parentId, athlete_id: childId, relationship: "parent", approved_at: new Date().toISOString() }),
    });
    if (!linkRes.ok) {
      const linkErr = await linkRes.text();
      await logError(supaUrl, serviceKey, "api/create-child-account.js", "parent_links insert failed", { detail: linkErr, parentId, childId });
      // The auth/profile rows already exist at this point — surface the
      // failure rather than silently leaving an unlinked child account.
      return res.status(502).json({ error: "Account created but linking failed — contact support.", childId });
    }

    return res.status(200).json({ success: true, childId, childFullName });
  } catch (e) {
    await logError(supaUrl, serviceKey, "api/create-child-account.js", "Unhandled error", { detail: String(e), parentId });
    return res.status(500).json({ error: "Couldn't create the athlete's account. Please try again." });
  }
}
