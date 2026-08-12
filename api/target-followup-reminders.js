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
// IT ALSO CARRIES A PASSENGER: the outage monitor's dead-man's switch.
// See checkHealthHeartbeat() below. This job has nothing to do with Scout's
// health, and is here for exactly one property — it is the only scheduled
// thing in this project that does NOT run on GitHub Actions (vercel.json's
// single cron entry), so it is still alive when the GitHub schedule is not.
// The watchdog is one GET on the day nothing is wrong, and it cannot fail
// this run — every outcome is a return value, never a throw.
//
// Required env vars:
//   CRON_SECRET               shared secret Vercel Cron sends automatically
//   SUPABASE_URL / SUPABASE_SERVICE_KEY
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
// Optional:
//   TARGET_REMINDER_DAYS       default 7 — how many days of no activity
//                               before a target counts as "stale"
//   HEARTBEAT_MAX_AGE_HOURS    default 6 — how old api/health-alert.js's
//                               heartbeat may get before this job alerts
//                               admins that the outage monitor has stopped
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

// alertAdmins() — the codebase's existing "wake an admin up" path, copied
// from api/moderate.js rather than imported, matching this project's
// per-file-helper convention (see that file's own note above its copy, and
// api/admin-user-action.js's). Same VAPID keys, same push_subscriptions
// rows, same deep link into the Admin Panel, so an alert from here looks
// like every other security alert an admin already receives.
async function alertAdmins(supaUrl, serviceKey, title, body) {
  try {
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

    const subsRes = await fetch(`${supaUrl}/rest/v1/push_subscriptions?user_id=in.(${adminIds.join(",")})&select=endpoint,p256dh,auth`, {
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
    });
    const subs = await subsRes.json();
    if (!Array.isArray(subs) || !subs.length) return 0;

    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    const payload = JSON.stringify({ title, body, url: "/golsz-app.html?page=admin" });
    const results = await Promise.allSettled(
      subs.map((s) => webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload))
    );
    return results.filter((r) => r.status === "fulfilled").length;
  } catch (e) {
    console.error("GOLSZ watchdog alert push error:", e);
    return 0;
  }
}

// ---- DEAD-MAN'S SWITCH, HALF TWO ---------------------------------------
//
// THE PROBLEM THIS SOLVES
// .github/workflows/health-alert.yml calls /api/health-alert every 15
// minutes and is the only thing that would notice a Scout outage. GitHub
// silently DISABLES `schedule:` triggers after 60 days of repository
// inactivity — no runs, no failures, no email anyone reads — and a
// pre-launch repo is exactly the kind that goes quiet for 60 days. Nothing
// inside that workflow can detect it, because the thing that stops IS the
// workflow. The detection has to come from a scheduler that is not GitHub.
//
// WHY THIS FILE, WHICH HAS NOTHING TO DO WITH SCOUT'S HEALTH
// It is the only other scheduled job in the project (vercel.json's single
// cron, daily at 13:00 UTC) and it runs on Vercel, which has no opinion
// about how quiet the GitHub repo has been. That independence is the entire
// qualification. An external heartbeat service (Healthchecks.io, Cronitor)
// would do the same job, and the owner's condition was no new external
// dependency — so the second scheduler we already pay for gets the job.
//
// THE THRESHOLD: 6 HOURS, and the reasoning rather than a round number.
//   * The floor is set by jitter, not cadence. health-alert runs every 15
//     minutes, but GitHub's scheduled runs are best-effort and are routinely
//     delayed under load — tens of minutes is ordinary, and an hour-plus
//     happens. A threshold near the cadence would page for weather.
//   * The ceiling is set by this job's own cadence: it runs ONCE A DAY, so
//     anything below ~24h detects at the same speed. Buying headroom above
//     the jitter therefore costs nothing in detection time — the real
//     detection latency is "the next 13:00 UTC" either way.
//   * 6 hours is ~24 consecutive missed runs. That is unmistakably a
//     stopped schedule and not a slow one, which is what makes the alert
//     worth trusting when it does arrive.
// Tunable via HEARTBEAT_MAX_AGE_HOURS. A non-numeric or non-positive value
// falls back to the default rather than disabling the watchdog: a typo in
// an env var must not silently switch off a monitor's monitor.
//
// FAILURE-TOLERANT BY CONSTRUCTION. Every outcome is a return value, never
// a throw — this rides along on the reminders job and must not be able to
// break it. It also refuses to guess: an unreadable ops_heartbeat (table
// not yet migrated, Supabase down) is reported as "unknown" and alerts
// nobody, because "I could not check" is not evidence that the monitor
// stopped, and a false page teaches people to ignore the real one.
const HEARTBEAT_NAME = "health-alert";
const HEARTBEAT_DEFAULT_MAX_AGE_HOURS = 6;

async function checkHealthHeartbeat(supaUrl, serviceKey) {
  const configured = Number(process.env.HEARTBEAT_MAX_AGE_HOURS);
  const maxAgeHours = Number.isFinite(configured) && configured > 0 ? configured : HEARTBEAT_DEFAULT_MAX_AGE_HOURS;
  try {
    // Deliberately not supaSelect(): that helper returns [] on any non-OK
    // response, which would make "the table does not exist yet" look
    // identical to "the monitor has never run" and page an admin about a
    // migration. The distinction is the whole reliability of this alert, so
    // the request is made here where the status can be seen.
    const resp = await fetch(`${supaUrl}/rest/v1/ops_heartbeat?name=eq.${HEARTBEAT_NAME}&select=last_ok_at`, {
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
    });
    if (!resp.ok) {
      console.error("GOLSZ heartbeat watchdog could not read ops_heartbeat:", resp.status, "(migration 127 applied?)");
      return { status: "unknown", reason: `read failed (${resp.status})` };
    }
    const rows = await resp.json();
    const last = Array.isArray(rows) && rows.length ? rows[0].last_ok_at : null;

    if (!last) {
      // The table is readable and holds no row for this job. Migration 127
      // ships no seed row on purpose, so this is a true statement: the
      // outage monitor has never completed a run. Worth the same alert as a
      // monitor that stopped — arguably more, since it means it never
      // started.
      const pushed = await alertAdmins(
        supaUrl, serviceKey,
        "GOLSZ: Scout outage monitor is not reporting",
        "The health check has never recorded a successful run. Check the health-alert workflow in GitHub Actions and CRON_SECRET in Vercel."
      );
      console.warn("GOLSZ heartbeat watchdog: no heartbeat row at all for", HEARTBEAT_NAME);
      return { status: "never_ran", alerted: true, pushed };
    }

    const ageHours = (Date.now() - new Date(last).getTime()) / 3600000;
    if (!Number.isFinite(ageHours)) {
      console.error("GOLSZ heartbeat watchdog: unparseable last_ok_at:", last);
      return { status: "unknown", reason: "unparseable last_ok_at" };
    }
    if (ageHours <= maxAgeHours) {
      return { status: "ok", ageHours: Number(ageHours.toFixed(2)), maxAgeHours };
    }

    // At most one push per day, because this job runs once a day. No
    // suppression logic is needed or wanted — compare with the GitHub
    // workflow's issue step, which had to dedupe explicitly because it runs
    // every 15 minutes and would otherwise open ~96 issues a day and train
    // everyone to ignore them.
    const pushed = await alertAdmins(
      supaUrl, serviceKey,
      "GOLSZ: Scout outage monitor has stopped",
      `No health check has run for ${Math.round(ageHours)}h (expected every 15 min). GitHub disables scheduled workflows after 60 days of repo inactivity — re-enable health-alert in the Actions tab.`
    );
    console.warn("GOLSZ heartbeat watchdog: STALE", JSON.stringify({ lastOkAt: last, ageHours: Number(ageHours.toFixed(2)), maxAgeHours, pushed }));
    return { status: "stale", stale: true, ageHours: Number(ageHours.toFixed(2)), maxAgeHours, alerted: true, pushed };
  } catch (e) {
    // Never rethrown. This is a passenger on someone else's job.
    console.error("GOLSZ heartbeat watchdog failed:", e);
    return { status: "unknown", reason: String(e) };
  }
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

  // The watchdog runs FIRST and outside the reminders try/catch, so that a
  // failure in the reminder query — the thing this endpoint is actually for
  // — cannot take the outage monitor's monitor down with it. It never
  // throws, so there is nothing here to catch.
  const watchdog = await checkHealthHeartbeat(supaUrl, serviceKey);

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

    return res.status(200).json({ checked: targets.length, reminded: sent, watchdog });
  } catch (e) {
    await logError("api/target-followup-reminders.js", "Reminder run failed", { detail: String(e) });
    // The watchdog result is reported on this path too: it ran before the
    // reminders and its verdict is independent of them, so a failed
    // reminder run must not also hide whether the outage monitor is alive.
    return res.status(500).json({ error: "Reminder run failed", detail: String(e), watchdog });
  }
}
