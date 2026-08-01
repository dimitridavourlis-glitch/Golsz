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

import webpush from "web-push";

// Defaults cover both real origins this app is actually served from today
// (golsz.com once its DNS is fixed, golsz.vercel.app in the meantime) —
// a single hardcoded origin would risk breaking the app's current live
// traffic, which is still on the .vercel.app domain. Override/extend via
// a comma-separated ALLOWED_ORIGIN env var if needed.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "https://golsz.com,https://golsz.vercel.app")
  .split(",").map((s) => s.trim()).filter(Boolean);
function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
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

// Writes directly via service role (bypasses RLS the same way every
// other write in this function does) rather than the log_admin_action()
// RPC — that RPC exists for the client-side admin actions, which don't
// otherwise have a trusted way to write this table at all.
async function logAdminAction(supaUrl, serviceKey, adminId, action, targetId, detail) {
  try {
    await fetch(`${supaUrl}/rest/v1/admin_action_log`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ admin_id: adminId, action, target_id: targetId, detail: detail || null }),
    });
  } catch (e) { console.error("GOLSZ admin audit log error:", e); }
}

// See api/scout.js for the full rationale — writes a real failure to
// error_log (migration 036) so it surfaces in the Admin Panel's
// "Errors" tab. Self-contained, duplicated per file on purpose.
async function logError(source, message, detail) {
  try {
    const supaUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supaUrl || !serviceKey) return;
    await fetch(`${supaUrl}/rest/v1/error_log`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ source, message: String(message).slice(0, 2000), detail: detail || null }),
    });
  } catch (e) { console.error("GOLSZ error-log write failed:", e); }
}

// Real-time security alert — pushes straight to every admin's device the
// moment someone (signed in, but not an admin) tries to hit this
// privileged endpoint. Reuses the exact same Web Push machinery as
// api/send-push.js (VAPID keys, push_subscriptions), just triggered from
// here instead of from a Supabase Database Webhook, since "a non-admin
// was rejected" isn't a table INSERT anything can hook a webhook to —
// it only ever happens inside this function's own logic. Awaited (not
// fire-and-forget) so Vercel doesn't tear the function down before the
// push actually goes out; wrapped in try/catch so a push failure can
// never block the real 403 response this always still returns.
async function alertAdmins(supaUrl, serviceKey, title, body) {
  try {
    const vapidPublic = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    const vapidSubject = process.env.VAPID_SUBJECT;
    if (!vapidPublic || !vapidPrivate || !vapidSubject) return; // push not configured on this deploy

    const adminsRes = await fetch(`${supaUrl}/rest/v1/profiles?is_admin=eq.true&select=id`, {
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
    });
    const admins = await adminsRes.json();
    const adminIds = (Array.isArray(admins) ? admins : []).map((a) => a.id);
    if (!adminIds.length) return;

    const subsRes = await fetch(`${supaUrl}/rest/v1/push_subscriptions?user_id=in.(${adminIds.join(",")})&select=endpoint,p256dh,auth`, {
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
    });
    const subs = await subsRes.json();
    if (!Array.isArray(subs) || !subs.length) return;

    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    const payload = JSON.stringify({ title, body, url: "/golsz-app.html?page=admin" });
    await Promise.allSettled(
      subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload))
    );
  } catch (e) {
    console.error("GOLSZ security alert push error:", e);
  }
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey) return res.status(500).json({ error: "Server missing SUPABASE_URL/SUPABASE_SERVICE_KEY" });

  const callerId = await getUserId(req.headers.authorization, supaUrl, serviceKey);
  if (!callerId) return res.status(401).json({ error: "Sign in required." });
  if (!(await isAdmin(supaUrl, serviceKey, callerId))) {
    await alertAdmins(supaUrl, serviceKey, "Security alert", "A signed-in user attempted an admin action without permission.");
    return res.status(403).json({ error: "Admins only." });
  }

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
      await logAdminAction(supaUrl, serviceKey, callerId, action, targetId);
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
      await logAdminAction(supaUrl, serviceKey, callerId, "delete", targetId);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    await logError("api/admin-user-action.js", "Action failed", { detail: String(e), action, targetId });
    return res.status(500).json({ error: "Action failed", detail: String(e) });
  }
}
