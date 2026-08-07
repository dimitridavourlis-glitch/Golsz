// ============================================================
// GOLSZ — Self-service account deletion (GDPR right to erasure)
// Deploy target: /api/delete-account.js
//
// The authenticated caller deletes their OWN account only — userId always
// comes from the verified auth token (getUserId), never trusted from the
// request body, same discipline as every other endpoint in this project.
//
// profiles.id -> auth.users.id is ON DELETE CASCADE (confirmed live before
// writing this file: pg_constraint.confdeltype = 'c' on profiles_id_fkey),
// and every user-owned table this session added (outreach_targets,
// development_plan_items, pathway_plan, athlete_benchmarks,
// passport_share_tokens, parent_links, scout_history, etc.) follows the
// same "references profiles(id) on delete cascade" pattern established
// throughout this project's migration history — so deleting the
// auth.users row via the Admin API cascades through the whole database on
// its own. What that cascade does NOT reach is Supabase Storage (avatar
// images aren't rows in a cascading table) — cleaned up explicitly here
// first, before the account itself is gone and nothing can look up which
// files were theirs anymore.
//
// A parent deleting THEIR OWN account does not delete any child account
// they manage (parent_links.parent_id cascades, orphaning the link, not
// the child's own account/data) — deliberate: removing a parent's account
// must never silently destroy their athlete's profile.
//
// Required env vars:
//   SUPABASE_URL / SUPABASE_SERVICE_KEY
// ============================================================

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

async function deleteStoragePrefix(supaUrl, serviceKey, bucket, prefix) {
  try {
    const listRes = await fetch(`${supaUrl}/storage/v1/object/list/${bucket}`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({ prefix, limit: 1000 }),
    });
    if (!listRes.ok) return;
    const files = await listRes.json();
    if (!Array.isArray(files) || !files.length) return;
    const paths = files.map((f) => `${prefix}/${f.name}`);
    await fetch(`${supaUrl}/storage/v1/object/${bucket}`, {
      method: "DELETE",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: paths }),
    });
  } catch (e) { console.error(`GOLSZ storage cleanup (${bucket}) failed:`, e); }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey) return res.status(500).json({ error: "Server missing SUPABASE_URL/SUPABASE_SERVICE_KEY" });

  const userId = await getUserId(req.headers.authorization, supaUrl, serviceKey);
  if (!userId) return res.status(401).json({ error: "Sign in first." });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  // Explicit confirm flag required — a second, deliberate signal beyond
  // just hitting this URL, since there is no undo once auth.admin deletes
  // the user (the client's own confirmation UI is the primary guard; this
  // is the server-side backstop for it).
  if (!body || body.confirm !== true) return res.status(400).json({ error: "Confirmation required." });

  try {
    await deleteStoragePrefix(supaUrl, serviceKey, "avatars", userId);
    await deleteStoragePrefix(supaUrl, serviceKey, "post-images", userId);

    const delRes = await fetch(`${supaUrl}/auth/v1/admin/users/${userId}`, {
      method: "DELETE",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
    });
    if (!delRes.ok) {
      const delErr = await delRes.text();
      await logError(supaUrl, serviceKey, "api/delete-account.js", "Admin deleteUser failed", { detail: delErr, userId });
      return res.status(502).json({ error: "Couldn't delete the account. Please try again or contact support." });
    }

    return res.status(200).json({ success: true });
  } catch (e) {
    await logError(supaUrl, serviceKey, "api/delete-account.js", "Unhandled error", { detail: String(e), userId });
    return res.status(500).json({ error: "Couldn't delete the account. Please try again or contact support." });
  }
}
