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
// PARENT-MANAGED CHILDREN (P1-5). The original behaviour here was to leave
// a managed child untouched, on the reasoning that deleting a parent must
// never silently destroy their athlete's profile. That reasoning was right
// about the danger and wrong about the outcome: a parent_managed child has a
// synthetic email and a random password nobody holds, so once the parent is
// gone NOBODY can sign in, correct the record, export it, or exercise
// erasure over it. The child's personal data — a minor's — would sit in the
// database forever with no controller. That is a worse failure than either
// alternative.
//
// So the deletion now REFUSES rather than orphaning, and says exactly what
// is in the way. The caller must resolve it deliberately, one of two ways:
//
//   confirm_delete_children: true   also delete every parent_managed child
//                                   (their data goes with the parent's)
//   ...or unlink/transfer the child first, e.g. a second approved parent
//
// A child with an independent login (parent_managed = false — a 16+ athlete
// who linked a parent for visibility) is NOT affected: they can still sign
// in, so removing the parent orphans nothing. Only accounts nobody can reach
// block the delete.
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

  // --- P1-5: never leave an unreachable managed child behind ---
  let managedChildren = [];
  try {
    const linkRes = await fetch(
      `${supaUrl}/rest/v1/parent_links?parent_id=eq.${userId}&approved_at=not.is.null&select=athlete_id`,
      { headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey } },
    );
    const links = linkRes.ok ? await linkRes.json() : [];
    const ids = Array.isArray(links) ? links.map((l) => l.athlete_id).filter(Boolean) : [];
    if (ids.length) {
      // Only accounts nobody can log into are blocking. A 16+ athlete who
      // linked a parent keeps their own credentials and is unaffected.
      const profRes = await fetch(
        `${supaUrl}/rest/v1/profiles?id=in.(${ids.join(",")})&parent_managed=is.true&select=id,full_name`,
        { headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey } },
      );
      managedChildren = profRes.ok ? (await profRes.json()) : [];
      if (!Array.isArray(managedChildren)) managedChildren = [];
    }
  } catch (e) {
    // Fail CLOSED. If we cannot establish whether this parent manages a
    // child, deleting anyway is exactly the orphaning this guard exists to
    // prevent — and unlike a rate limit, there is no undo afterwards.
    await logError(supaUrl, serviceKey, "api/delete-account.js", "Managed-children lookup failed", { detail: String(e), userId });
    return res.status(503).json({ error: "Couldn't check your linked athletes just now. Please try again in a moment." });
  }

  if (managedChildren.length && body.confirm_delete_children !== true) {
    return res.status(409).json({
      error: "This account manages athlete profiles that nobody else can sign in to. Deleting it would leave their data with no owner.",
      code: "managed_children_present",
      // Names only, so the client can show the athlete the actual decision
      // it is asking them to make instead of an abstract warning.
      children: managedChildren.map((c) => ({ id: c.id, full_name: c.full_name || null })),
    });
  }

  try {
    // Children first. If the parent were deleted first and a child delete
    // then failed, the child would be orphaned anyway — the exact outcome
    // this guard exists to prevent — and there would no longer be a
    // parent_links row to find them by.
    for (const child of managedChildren) {
      await deleteStoragePrefix(supaUrl, serviceKey, "avatars", child.id);
      await deleteStoragePrefix(supaUrl, serviceKey, "post-images", child.id);
      const childDel = await fetch(`${supaUrl}/auth/v1/admin/users/${child.id}`, {
        method: "DELETE",
        headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
      });
      if (!childDel.ok) {
        const detail = await childDel.text();
        await logError(supaUrl, serviceKey, "api/delete-account.js", "Managed-child delete failed", { detail, parentId: userId, childId: child.id });
        return res.status(502).json({ error: "Couldn't delete a linked athlete's account, so nothing was deleted. Please contact support." });
      }
    }

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
