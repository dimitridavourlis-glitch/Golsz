// ============================================================
// GOLSZ — push notification sender (Vercel serverless function)
// Deploy target: /api/send-push.js
//
// Triggered by Supabase Database Webhooks (Database -> Webhooks in the
// Dashboard — see supabase-migration-014-push-notifications.sql), one on
// messages INSERT and one on follows INSERT. Supabase POSTs the new row as
// { type, table, record, old_record }; this reads who to notify and what
// happened, looks up their stored push subscriptions, and sends a real
// Web Push notification to each of their devices/browsers.
//
// Uses the `web-push` npm package for the VAPID signing + payload
// encryption (RFC 8291/8292) — unlike api/scout.js and
// api/stripe-webhook.js, this one isn't worth hand-rolling: getting ECDH/
// HKDF/AES-GCM subtly wrong fails silently (no notification, no error a
// user would ever report), so a maintained implementation is safer here.
//
// Required env vars:
//   VAPID_PUBLIC_KEY          same value embedded in golsz-app.html (safe to be public)
//   VAPID_PRIVATE_KEY         server-only — never ship to the browser
//   VAPID_SUBJECT             mailto:you@yourdomain.com (contact for push services)
//   SUPABASE_URL              same value used by api/scout.js
//   SUPABASE_SERVICE_KEY      service role key (server-only; never ship to the browser)
//   SUPABASE_WEBHOOK_SECRET   shared secret — must match the x-webhook-secret
//                             header you configure on the Supabase Database Webhook
// ============================================================

import webpush from "web-push";
import crypto from "crypto";

// Constant-time comparison of the shared webhook secret. The `!==` this
// replaces short-circuits on the first differing byte, so response timing
// leaks a prefix-match oracle: an attacker who can send requests can
// recover the secret one character at a time instead of brute-forcing it.
// api/stripe-webhook.js already uses crypto.timingSafeEqual for exactly
// this; the two auth paths in this codebase should not disagree about it.
//
// The length check is required, not decorative — timingSafeEqual THROWS on
// a length mismatch. It does leak the secret's length, which is a far
// weaker disclosure than the per-byte oracle and is unavoidable with this
// primitive.
function secretMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Supabase ids are UUIDs. record.* comes from a Database Webhook payload,
// which is trusted only as far as the shared secret above — and these values
// are interpolated straight into service-role PostgREST URLs, which bypass
// RLS entirely. An unvalidated value could smuggle extra query parameters
// through the "&" that separates PostgREST filters (e.g. an id of
// `x&select=*` or one adding an `or=` clause) and turn a scoped lookup into
// a wider one. Same pattern, and the same reason, as the UUID_RE check in
// api/stripe-webhook.js and api/admin-user-action.js.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

async function supaSelect(supaUrl, serviceKey, path) {
  const res = await fetch(`${supaUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
  });
  if (!res.ok) return [];
  return res.json();
}

async function supaDelete(supaUrl, serviceKey, path) {
  await fetch(`${supaUrl}/rest/v1/${path}`, {
    method: "DELETE",
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, Prefer: "return=minimal" },
  });
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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const webhookSecret = process.env.SUPABASE_WEBHOOK_SECRET;
  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;
  if (!webhookSecret) return res.status(500).json({ error: "Server missing SUPABASE_WEBHOOK_SECRET" });
  if (!supaUrl || !serviceKey) return res.status(500).json({ error: "Server missing SUPABASE_URL/SUPABASE_SERVICE_KEY" });
  if (!vapidPublic || !vapidPrivate || !vapidSubject) return res.status(500).json({ error: "Server missing VAPID_* env vars" });

  if (!secretMatches(req.headers["x-webhook-secret"], webhookSecret)) {
    return res.status(401).json({ error: "Invalid webhook secret" });
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const { table, record } = req.body || {};
  if (!table || !record) return res.status(200).json({ skipped: true });

  let targetUserId = null, title = "GOLSZ", body = "", url = "/golsz-app.html";

  try {
    if (table === "messages") {
      // Both ids are validated BEFORE either reaches a URL. A bad shape is a
      // skip, not a 500: a malformed row is not worth failing the webhook
      // over, and Supabase retries would just replay it.
      if (!isUuid(record.recipient_id) || !isUuid(record.sender_id)) {
        console.warn("GOLSZ send-push: non-UUID id on messages row, skipping");
        return res.status(200).json({ skipped: true, reason: "invalid_id" });
      }
      targetUserId = record.recipient_id;
      const [sender] = await supaSelect(supaUrl, serviceKey, `public_profile_names?id=eq.${record.sender_id}&select=full_name`);
      title = "New message";
      body = `${(sender && sender.full_name) || "Someone"}: ${String(record.body || "").slice(0, 120)}`;
      url = "/golsz-app.html?page=messages";
    } else if (table === "follows") {
      if (!isUuid(record.followed_id) || !isUuid(record.follower_id)) {
        console.warn("GOLSZ send-push: non-UUID id on follows row, skipping");
        return res.status(200).json({ skipped: true, reason: "invalid_id" });
      }
      targetUserId = record.followed_id;
      const [follower] = await supaSelect(supaUrl, serviceKey, `public_profile_names?id=eq.${record.follower_id}&select=full_name`);
      title = "New follower";
      body = `${(follower && follower.full_name) || "Someone"} started following you`;
      url = "/golsz-app.html?page=profile";
    } else {
      return res.status(200).json({ skipped: true });
    }

    if (!isUuid(targetUserId)) return res.status(200).json({ skipped: true });

    const subs = await supaSelect(supaUrl, serviceKey, `push_subscriptions?user_id=eq.${targetUserId}&select=id,endpoint,p256dh,auth`);
    const payload = JSON.stringify({ title, body, url });

    const results = await Promise.allSettled(
      subs.map((s) =>
        webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
          .catch(async (e) => {
            if (e && (e.statusCode === 404 || e.statusCode === 410)) {
              // subscription is gone (uninstalled, permission revoked, etc.) — clean it up
              await supaDelete(supaUrl, serviceKey, `push_subscriptions?id=eq.${s.id}`);
            }
            throw e;
          })
      )
    );

    return res.status(200).json({ sent: results.filter((r) => r.status === "fulfilled").length, total: subs.length });
  } catch (e) {
    await logError("api/send-push.js", "Push send handling failed", { detail: String(e), table });
    return res.status(500).json({ error: "Push send handling failed", detail: String(e) });
  }
}
