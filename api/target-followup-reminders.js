// ============================================================
// GOLSZ — Target follow-up reminders (brief §14 build priority: "follow-
// up/reminder system for targets using existing push infrastructure")
// Deploy target: /api/target-followup-reminders.js
//
// Triggered by Vercel Cron (see vercel.json's "crons" entry) once a day.
// Finds outreach_targets an athlete has contacted/is preparing to contact
// but hasn't touched (status change, note edit) in REMINDER_DAYS, and
// hasn't already been reminded about recently, and sends one real Web
// Push notification per stale target via the same webpush pattern
// api/send-push.js already uses — duplicated here on purpose, matching
// that file's own "self-contained, duplicated per file" convention,
// since this is a different trigger (cron, not a Supabase webhook), not
// a shared code path.
//
// Secured the way Vercel's own docs describe for Cron Jobs: Vercel sends
// `Authorization: Bearer $CRON_SECRET` on scheduled invocations once the
// CRON_SECRET env var is set — this fails closed (401) if that var is
// unset or the header doesn't match, so the endpoint can't be triggered
// by a random public request to its URL.
//
// Required env vars:
//   CRON_SECRET               shared secret Vercel Cron sends automatically
//   SUPABASE_URL / SUPABASE_SERVICE_KEY
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
// Optional:
//   TARGET_REMINDER_DAYS       default 7 — how many days of no activity
//                               before a target counts as "stale"
// ============================================================

import webpush from "web-push";

const REMINDER_STATUSES = ["preparing", "contacted", "follow_up"];

async function supaSelect(supaUrl, serviceKey, path) {
  const res = await fetch(`${supaUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
  });
  if (!res.ok) return [];
  return res.json();
}

async function supaPatch(supaUrl, serviceKey, path, body) {
  await fetch(`${supaUrl}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}

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
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;
  if (!supaUrl || !serviceKey) return res.status(500).json({ error: "Server missing SUPABASE_URL/SUPABASE_SERVICE_KEY" });
  if (!vapidPublic || !vapidPrivate || !vapidSubject) return res.status(500).json({ error: "Server missing VAPID_* env vars" });

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const reminderDays = Number(process.env.TARGET_REMINDER_DAYS || 7);
  const staleCutoff = new Date(Date.now() - reminderDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const statusFilter = REMINDER_STATUSES.map((s) => `"${s}"`).join(",");
    const cutoffEnc = encodeURIComponent(staleCutoff);
    const targets = await supaSelect(
      supaUrl, serviceKey,
      `outreach_targets?status=in.(${statusFilter})&updated_at=lt.${cutoffEnc}&or=(last_reminded_at.is.null,last_reminded_at.lt.${cutoffEnc})&select=id,user_id,name,status,updated_at`
    );

    let sent = 0;
    for (const target of targets) {
      const subs = await supaSelect(supaUrl, serviceKey, `push_subscriptions?user_id=eq.${target.user_id}&select=id,endpoint,p256dh,auth`);
      if (!subs.length) continue;
      const payload = JSON.stringify({
        title: "Follow-up reminder",
        body: `It's been a while since you touched ${target.name} — worth a follow-up?`,
        url: "/golsz-app.html?page=targets",
      });
      await Promise.allSettled(
        subs.map((s) =>
          webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
            .catch(async (e) => {
              if (e && (e.statusCode === 404 || e.statusCode === 410)) {
                await fetch(`${supaUrl}/rest/v1/push_subscriptions?id=eq.${s.id}`, {
                  method: "DELETE", headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, Prefer: "return=minimal" },
                });
              }
              throw e;
            })
        )
      );
      await supaPatch(supaUrl, serviceKey, `outreach_targets?id=eq.${target.id}`, { last_reminded_at: new Date().toISOString() });
      sent++;
    }

    return res.status(200).json({ checked: targets.length, reminded: sent });
  } catch (e) {
    await logError("api/target-followup-reminders.js", "Reminder run failed", { detail: String(e) });
    return res.status(500).json({ error: "Reminder run failed", detail: String(e) });
  }
}
