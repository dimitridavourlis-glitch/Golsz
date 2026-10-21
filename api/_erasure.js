// SHARED ERASURE, BECAUSE THERE ARE TWO WAYS AN ACCOUNT DIES.
//
// An athlete deleting their own account (api/delete-account.js) swept their
// photos out of both buckets and their cached Scout replies out of
// scout_response_cache. An ADMIN deleting the same account did neither: the
// RPC clears the app tables that do not cascade, the Auth API removes the
// credential, and the files and the cached replies stayed. privacy.html tells
// the athlete those are deleted, so which promise they got depended on which
// button was pressed, and nothing said so.
//
// Both routines live here now and both routes import them. An erasure routine
// that exists in two copies is one that will eventually disagree with itself,
// and the direction it disagrees in is data outliving the account.
//
// Prefixed with _ so Vercel treats this as a module, not a thirteenth
// serverless function — the budget is full at twelve.
//
// Neither throws. Deletion must continue even when a sweep fails, because the
// alternative is an account that is half gone with no way to finish it. What
// they do instead is name the leftover in error_log, where a human looks.

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
    if (!listRes.ok) {
      const detail = await listRes.text().catch(() => "");
      throw new Error(`storage LIST ${bucket} failed: ${listRes.status} ${detail.slice(0, 200)}`);
    }
    const files = await listRes.json();
    if (!Array.isArray(files) || !files.length) return;
    const paths = files.map((f) => `${prefix}/${f.name}`);
    // The one write in this flow whose silent failure LEAVES DATA BEHIND: the
    // account is gone but the athlete's photos are still in the bucket. On a
    // platform serving minors that is a retention problem, and the old bare
    // catch could not see it, because `await fetch()` resolves on 4xx/5xx.
    //
    // Does not throw - account deletion must continue even if a bucket sweep
    // fails - but the orphaned files are now named somewhere a human looks.
    const delRes = await fetch(`${supaUrl}/storage/v1/object/${bucket}`, {
      method: "DELETE",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: paths }),
    });
    if (!delRes.ok) {
      const detail = await delRes.text().catch(() => "");
      throw new Error(`storage DELETE ${bucket} failed: ${delRes.status} ${detail.slice(0, 200)}`);
    }
  } catch (e) {
    console.error(`GOLSZ storage cleanup (${bucket}) failed:`, e);
    await logError(supaUrl, serviceKey, "api/delete-account.js", "Storage files were NOT deleted with the account", { detail: String(e), bucket, prefix });
  }
}

async function deleteScoutReplyCache(supaUrl, serviceKey, uid) {
  for (const pattern of [`req:${uid}:*`, `*:u:${uid}|*`]) {
    try {
      const r = await fetch(`${supaUrl}/rest/v1/scout_response_cache?cache_key=like.${encodeURIComponent(pattern)}`, {
        method: "DELETE",
        headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, Prefer: "return=minimal" },
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        throw new Error(`scout_response_cache DELETE failed: ${r.status} ${detail.slice(0, 200)}`);
      }
    } catch (e) {
      console.error("GOLSZ scout cache cleanup failed:", e);
      await logError(supaUrl, serviceKey, "api/delete-account.js", "Cached Scout replies were NOT deleted with the account", { detail: String(e), userId: uid, pattern });
    }
  }
}

export { deleteStoragePrefix, deleteScoutReplyCache };
