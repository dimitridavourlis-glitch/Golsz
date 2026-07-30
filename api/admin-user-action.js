// ============================================================
// GOLSZ — admin ban/unban/delete (Vercel serverless function)
// Deploy target: /api/admin-user-action.js (Vercel auto-detects it, same
// as api/scout.js — zero config, no new npm dependency needed).
//
// Closes a gap documented in CLAUDE.md: banning or deleting an account
// from the Admin Panel only ever touched `profiles` (is_banned) and the
// app-level tables (via the old admin_delete_profile RPC) — the actual
// Supabase Auth credential (auth.users) was untouched either way, so a
// banned/deleted account's real login still worked at the auth layer
// even though the app locked/removed everything else. This endpoint
// does the real thing too, using the Supabase Admin API (which needs the
// service role key — a client can never call this directly, only this
// server can).
//
// Required env vars (all already set for other functions in this repo):
//   SUPABASE_URL              same value used by api/scout.js
//   SUPABASE_SERVICE_KEY      service role key (server-only; never ship to the browser)
// ============================================================

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Verify the Supabase access token and return the user id (or null) —
// same pattern as api/scout.js's getUserId().
async function getUserId(authHeader, supaUrl, serviceKey) {
  if (!supaUrl || !authHeader) return null;
  try {
    const r = await fetch(supaUrl + "/auth/v1/user", {
      headers: { Authorization: authHeader, apikey: serviceKey || "" },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && u.id ? u.id : null;
  } catch {
    return null;
  }
}

async function isAdmin(supaUrl, serviceKey, userId) {
  const r = await fetch(`${supaUrl}/rest/v1/profiles?id=eq.${userId}&select=is_admin`, {
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
  });
  const rows = await r.json();
  return !!(Array.isArray(rows) && rows[0] && rows[0].is_admin);
}

async function patchProfile(supaUrl, serviceKey, targetId, body) {
  await fetch(`${supaUrl}/rest/v1/profiles?id=eq.${targetId}`, {
    method: "PATCH",
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey) return res.status(500).json({ error: "Server missing SUPABASE_URL/SUPABASE_SERVICE_KEY" });

  const callerId = await getUserId(req.headers.authorization, supaUrl, serviceKey);
  if (!callerId) return res.status(401).json({ error: "Sign in required." });
  if (!(await isAdmin(supaUrl, serviceKey, callerId))) return res.status(403).json({ error: "Admins only." });

  const { action, targetId } = req.body || {};
  // targetId gets embedded directly into an Admin API URL path and a
  // PostgREST filter below — validating it's actually a UUID first (not
  // just "a string") closes off any path-traversal/filter-injection
  // shape before it reaches either one.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!targetId || typeof targetId !== "string" || !UUID_RE.test(targetId)) {
    return res.status(400).json({ error: "Missing or invalid targetId" });
  }
  if (targetId === callerId) return res.status(400).json({ error: "Cannot act on your own account this way." });

  try {
    if (action === "ban" || action === "unban") {
      // ban_duration is Supabase Admin API's real, auth-layer ban — unlike
      // profiles.is_banned (which only gates app-level RLS/UI), this
      // actually stops the account from getting a new session at all.
      // Supabase doesn't support a literal "forever", so ~100 years is
      // the conventional stand-in for "until an admin lifts it".
      const banRes = await fetch(`${supaUrl}/auth/v1/admin/users/${targetId}`, {
        method: "PUT",
        headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
        body: JSON.stringify({ ban_duration: action === "ban" ? "876000h" : "none" }),
      });
      if (!banRes.ok) throw new Error(`Auth API ban update failed (${banRes.status})`);
      await patchProfile(supaUrl, serviceKey, targetId, { is_banned: action === "ban" });
      return res.status(200).json({ ok: true });
    }

    if (action === "delete") {
      // Clean up the app-level tables that don't cascade from profiles
      // first (same ordering the old admin_delete_profile RPC used) —
      // see migration 027. Then delete the real auth.users row, which
      // cascades to profiles and everything that already cascades from
      // profiles (posts, follows, messages, push_subscriptions, etc.).
      const rpcRes = await fetch(`${supaUrl}/rest/v1/rpc/admin_delete_profile_data`, {
        method: "POST",
        headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
        body: JSON.stringify({ p_target: targetId }),
      });
      if (!rpcRes.ok) throw new Error(`admin_delete_profile_data failed (${rpcRes.status})`);
      const delRes = await fetch(`${supaUrl}/auth/v1/admin/users/${targetId}`, {
        method: "DELETE",
        headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
      });
      if (!delRes.ok) throw new Error(`Auth API user delete failed (${delRes.status})`);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: "Action failed", detail: String(e) });
  }
}
