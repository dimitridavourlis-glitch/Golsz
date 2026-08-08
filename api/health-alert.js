// ============================================================
// GOLSZ — production health alert
// Deploy target: /api/health-alert.js
//
// Why this exists: on 2026-08-08 Scout returned 502 to every established
// athlete for roughly an hour, and the way it was discovered was the founder
// looking at his own phone. logError() has been writing to error_log the
// whole time — nobody reads error_log. Telemetry that nobody is paged on is
// a post-mortem tool, not monitoring.
//
// Runs on Vercel Cron every 15 minutes. It answers one question: "in the
// last window, did a meaningful share of Scout calls fail?" — and pushes to
// admins if so, using the same Web Push path alertAdmins() already uses for
// minor-safety events, so there is no new service, no new bill, and no new
// credential.
//
// TWO independent signals, because each misses something the other catches:
//
//   scout_routing_log.success = false
//     The model call itself failed. Rate-based, so one flaky request at 3am
//     doesn't wake anyone, but a broken deploy does.
//
//   error_log rows since the last window
//     Catches failures that never reach the routing log at all — which is
//     exactly what the storedAssessment ReferenceError did: it threw AFTER
//     the model answered, so from the routing log's point of view nothing
//     was wrong. A count-based alert on error_log would have fired within
//     15 minutes.
//
// Deliberately NOT clever: no baselines, no anomaly detection, no
// suppression windows beyond the interval itself. An alert that is hard to
// reason about at 2am is worse than one that occasionally over-fires.
//
// Secured exactly like api/target-followup-reminders.js: Vercel sends
// `Authorization: Bearer $CRON_SECRET` on scheduled invocations. Fails
// closed (401) when CRON_SECRET is unset or the header doesn't match, so
// the URL cannot be triggered by a random public request.
//
// Required env vars:
//   CRON_SECRET
//   SUPABASE_URL / SUPABASE_SERVICE_KEY
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
// Optional:
//   HEALTH_WINDOW_MINUTES   default 20 (cron runs every 15 — deliberate
//                           overlap so a failure straddling a boundary is
//                           still seen)
//   HEALTH_MIN_CALLS        default 5  — below this, a "rate" is noise
//   HEALTH_FAIL_RATE        default 0.5 — fraction of failed Scout calls
//   HEALTH_MAX_ERRORS       default 3  — error_log rows in the window
// ============================================================

import webpush from "web-push";

// Exported for tests: the whole decision, with no I/O in it.
export function shouldAlert({ totalCalls, failedCalls, errorCount }, cfg) {
  const minCalls = cfg.minCalls, failRate = cfg.failRate, maxErrors = cfg.maxErrors;
  const reasons = [];

  // Rate, not count: 3 failures out of 400 calls is a bad afternoon for three
  // athletes; 3 out of 4 is an outage. Only judged once there is enough
  // traffic for a rate to mean anything.
  if (totalCalls >= minCalls && failedCalls / totalCalls >= failRate) {
    reasons.push(`${failedCalls}/${totalCalls} Scout calls failed`);
  }

  // Count, not rate: error_log has no denominator, and a handful of thrown
  // exceptions is already worth looking at.
  if (errorCount >= maxErrors) {
    reasons.push(`${errorCount} errors logged`);
  }

  return { alert: reasons.length > 0, reasons };
}

async function supaCount(supaUrl, serviceKey, path) {
  // PostgREST returns the count in Content-Range as "*/N" with head+exact.
  const res = await fetch(`${supaUrl}/rest/v1/${path}`, {
    method: "HEAD",
    headers: {
      apikey: serviceKey,
      Authorization: "Bearer " + serviceKey,
      Prefer: "count=exact",
      Range: "0-0",
    },
  });
  const range = res.headers.get("content-range") || "";
  const n = Number(range.split("/")[1]);
  return Number.isFinite(n) ? n : 0;
}

async function pushAdmins(supaUrl, serviceKey, title, body) {
  const vapidPublic = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;
  if (!vapidPublic || !vapidPrivate || !vapidSubject) return 0;

  const adminsRes = await fetch(`${supaUrl}/rest/v1/profiles?is_admin=eq.true&select=id`, {
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
  });
  const admins = await adminsRes.json();
  const adminIds = (Array.isArray(admins) ? admins : []).map((a) => a.id);
  if (!adminIds.length) return 0;

  const subsRes = await fetch(
    `${supaUrl}/rest/v1/push_subscriptions?user_id=in.(${adminIds.join(",")})&select=endpoint,p256dh,auth`,
    { headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey } }
  );
  const subs = await subsRes.json();
  if (!Array.isArray(subs) || !subs.length) return 0;

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title, body, url: "/golsz-app.html" })
      );
      sent += 1;
    } catch (e) {
      // A dead subscription must not stop the others being notified. This is
      // the alert path; failing silently here defeats the entire point.
      console.error("GOLSZ health-alert push failed:", e && e.statusCode);
    }
  }
  return sent;
}

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const supaUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !serviceKey) return res.status(500).json({ error: "not configured" });

  const windowMinutes = Number(process.env.HEALTH_WINDOW_MINUTES || 20);
  const since = new Date(Date.now() - windowMinutes * 60000).toISOString();

  try {
    const [totalCalls, failedCalls, errorCount] = await Promise.all([
      supaCount(supaUrl, serviceKey, `scout_routing_log?created_at=gte.${since}&select=id`),
      supaCount(supaUrl, serviceKey, `scout_routing_log?created_at=gte.${since}&success=is.false&select=id`),
      supaCount(supaUrl, serviceKey, `error_log?created_at=gte.${since}&select=id`),
    ]);

    const cfg = {
      minCalls: Number(process.env.HEALTH_MIN_CALLS || 5),
      failRate: Number(process.env.HEALTH_FAIL_RATE || 0.5),
      maxErrors: Number(process.env.HEALTH_MAX_ERRORS || 3),
    };
    const { alert, reasons } = shouldAlert({ totalCalls, failedCalls, errorCount }, cfg);

    // Always logged, alert or not, so the cron itself is visibly alive in
    // Vercel's logs. A monitor that only speaks when something is wrong is
    // indistinguishable from a monitor that has stopped running.
    console.log("GOLSZ health check:", JSON.stringify({ windowMinutes, totalCalls, failedCalls, errorCount, alert, reasons }));

    let pushed = 0;
    if (alert) {
      pushed = await pushAdmins(
        supaUrl, serviceKey,
        "GOLSZ: Scout may be down",
        `${reasons.join("; ")} in the last ${windowMinutes} min.`
      );
    }

    return res.status(200).json({ ok: true, windowMinutes, totalCalls, failedCalls, errorCount, alert, reasons, pushed });
  } catch (e) {
    console.error("GOLSZ health-alert failed:", e);
    return res.status(500).json({ error: String(e) });
  }
}
