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

// The loops below are strictly sequential and do three or more round trips
// per row, so a busy night is minutes of work, not seconds. Without this the
// platform's default kills the function mid-loop: the pushes already sent
// are stamped, the rest are not, and the response never arrives to say which.
// ONE NUMBER, TWO READERS. The platform's kill deadline and the loops' own
// budget have to come from the same place, or the loops plan for a window
// they do not have and the platform cuts them off mid-iteration — pushes
// already sent, last_reminded_at not yet stamped, and no response to say
// which. 60 is the Hobby ceiling; on a plan that allows more, raise this and
// both loops get the room automatically.
const MAX_SECONDS = 60;
// Headroom to finish the in-flight row, write the response and return. A
// budget equal to the ceiling is a budget that ends in a kill.
const BUDGET_MS = (MAX_SECONDS - 8) * 1000;
// Vercel reads `config` statically and accepts only literals here (an identifier fails the
// build with "Unhandled type: Identifier"), so the number is written out; tests keep it equal
// to MAX_SECONDS.
export const config = { maxDuration: 60 };

const REMINDER_STATUSES = ["preparing", "contacted", "follow_up"];

async function supaSelect(supaUrl, serviceKey, path) {
  const res = await fetch(`${supaUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
  });
  if (!res.ok) return [];
  return res.json();
}

// THE SAME READ, BUT ABLE TO SAY IT FAILED.
//
// supaSelect above answers a failed read with [], which reads as "there is
// nothing there". That is harmless where an empty result and a failure lead
// to the same safe action - no subscriptions, no push - and dangerous where
// EMPTY MEANS GO. The availability lookup is the second kind: [] there means
// "nobody is injured", so one failed request turned the injury pause off for
// the whole run and pushed "the day you set has passed" to every hurt
// athlete on the platform. Callers that would act on emptiness use this and
// decide for themselves.
async function supaSelectOrNull(supaUrl, serviceKey, path) {
  const res = await fetch(`${supaUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey },
  });
  if (!res.ok) return null;
  return res.json();
}

// Its one caller writes `last_reminded_at` AFTER the push has already gone
// out. So a silent failure is not "nothing happened" - it is sent-but-not-
// recorded, and the next run sees a target that looks un-reminded and pushes
// the identical notification again. And the run after that. Unbounded spam
// from a write nobody watched.
//
// Returns a boolean instead of throwing: the caller is mid-loop over every
// target, and one failed bookkeeping write must not abandon the rest.
async function supaPatch(supaUrl, serviceKey, path, body) {
  try {
    const r = await fetch(`${supaUrl}/rest/v1/${path}`, {
      method: "PATCH",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      throw new Error(`PATCH ${path} failed: ${r.status} ${detail.slice(0, 200)}`);
    }
    let rows = null;
    try { rows = await r.json(); } catch { rows = null; }
    if (!Array.isArray(rows) || rows.length === 0) throw new Error(`PATCH ${path} matched no rows`);
    return true;
  } catch (e) {
    console.error("GOLSZ supaPatch failed:", e);
    await logError("api/target-followup-reminders.js", "A reminder was sent but not recorded — it will repeat", { detail: String(e), path });
    return false;
  }
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


// ONE PUSH SENDER, because there are now two callers.
//
// Copying the send-and-prune loop for the second one left two identical
// DELETEs that test_server_write_error_checked could not tell apart — it keys
// a write by file, function and method, and both were
// "target-followup-reminders.js|(arrow)|DELETE". That collision is the test
// reporting a duplication, and the fix is to have one implementation rather
// than to describe two.
//
// A 404 or 410 means the browser threw the subscription away: the endpoint is
// gone for good, and retrying it every day forever is how a cron slowly fills
// with work that can never succeed.
async function pushToAll(supaUrl, serviceKey, webpush, subs, payload) {
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
}

// ---- STEPS THAT ARE DUE, NUDGED ONCE --------------------------------------
//
// Nothing in GOLSZ told an athlete a step was due. The date passed and the
// first they heard was the word "overdue" next time they happened to open the
// app. This rides the cron that already runs daily rather than taking one of
// the twelve Vercel function slots, which are full.
//
// THE RULE IT MUST NOT BREAK: GOLSZ does not call an athlete late on a date it
// chose for them. due_src marks a date that came from Scout or from tapping
// Retest — one tap on a confirm card is consent to a plan, not to twelve
// individual deadlines — and the client has refused to call such a date late
// since suggestedDate() was written. A push notification is the most punitive
// surface there is: it arrives uninvited, on their phone, when they are not
// even using the product. So this nudges ONLY steps whose date the athlete set
// themselves, enforced in the query by due_src=is.null and asserted by
// tests/test_action_reminders.cjs.
//
// ONE nudge per step, ever. last_reminded_at (migration 153) is never
// backfilled, so a step that was already overdue when this shipped still gets
// its first reminder — but only its first. A plan that nags daily is a plan
// an athlete turns notifications off for.
async function remindDueSteps(supaUrl, serviceKey, webpush, deadline) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await supaSelect(
    supaUrl, serviceKey,
    `athlete_actions?status=eq.open&due_src=is.null&last_reminded_at=is.null` +
    // ORDERED as well as capped, for the reason the outreach scan 110 lines
    // below already states: a cap with no ORDER BY drops an ARBITRARY set,
    // which can differ between two nights, so a step past the cut-off is not
    // merely late — it may never be reached at all. Oldest due first means
    // the longest-overdue step is the one that gets its nudge.
    `&due_on=lte.${today}&select=id,user_id,title,due_on,category&order=due_on.asc&limit=500`
  );
  // NOBODY IS TOLD THEY ARE LATE WHILE THEY ARE INJURED.
  //
  // The app stopped calling these steps late the moment the athlete tapped
  // Hurt (canCallLate in golsz-app.html). Without the same rule here, the one
  // surface that reaches them when the app is CLOSED would still push "the day
  // you set has passed" at someone who cannot train - and it would be the only
  // thing in GOLSZ still saying it.
  //
  // One query, not one per row. Recovery work is excluded from the pause for
  // the same reason it is excluded in the client: a physio appointment is
  // exactly the date that still matters when you are hurt.
  // ASKED ABOUT THE CANDIDATES, NOT ABOUT THE WHOLE USER BASE.
  //
  // This used to be `profiles?availability_status=eq.out&select=id` with no
  // limit. PostgREST silently truncates an uncapped select at its configured
  // max-rows (1000 on Supabase) and still returns 200 - so once more than
  // that many athletes were marked out, the ones past the cut-off would fall
  // out of this Set and be pushed "the day you set has passed" while injured.
  // A guarantee that quietly stops holding at scale is worse than one that
  // was never claimed.
  //
  // Scoping it to the ids already in hand makes truncation impossible: the
  // candidate query above is capped at 500, and each chunk asks for at most
  // the 100 ids it names.
  //
  // AND IT FAILS CLOSED. This read decides who is NOT told they are late, so
  // an empty answer means "push to everyone". Through supaSelect a failed
  // request was indistinguishable from "nobody is injured", and the one
  // surface that reaches an athlete with the app shut would have told every
  // hurt athlete on the platform that the day they set had passed. A missed
  // nudge is recoverable on the next run; that push is not. So a failure
  // abandons the whole loop and says so in the response.
  const candidateIds = [...new Set(rows.map((r) => r && r.user_id).filter(Boolean))];
  const resting = new Set();
  for (let i = 0; i < candidateIds.length; i += 100) {
    const chunk = candidateIds.slice(i, i + 100);
    const got = await supaSelectOrNull(supaUrl, serviceKey,
      `profiles?id=in.(${chunk.join(",")})&availability_status=eq.out&select=id`);
    if (got === null) {
      await logError("api/target-followup-reminders.js",
        "Availability read failed — due-step reminders skipped rather than risk telling injured athletes they are late",
        { candidates: candidateIds.length });
      return { checked: rows.length, reminded: 0, paused: 0,
        skipped: "availability unreadable" };
    }
    (got || []).forEach((r) => { if (r && r.id) resting.add(r.id); });
  }
  let sent = 0;
  let paused = 0;
  let truncated = false;
  for (const row of rows) {
    // STOPPED ON PURPOSE, AND SAID SO. Three-plus round trips per row,
    // strictly sequential, so a busy night does not fit. Breaking here leaves
    // the remaining rows un-stamped, which means the next run picks them up
    // first rather than skipping them — the one property that makes stopping
    // safe. Being killed by the platform instead gives up the same work AND
    // the response that would have reported it.
    if (Date.now() > deadline) { truncated = true; break; }
    // BEFORE the subscription lookup and before any stamp. Stamping
    // last_reminded_at here would burn the athlete's single nudge on a day
    // they were never told about it, and that step would never be raised
    // again - the same trap the no-subscription case below avoids.
    if (resting.has(row.user_id) && row.category !== "recovery") { paused++; continue; }
    const subs = await supaSelect(supaUrl, serviceKey, `push_subscriptions?user_id=eq.${row.user_id}&select=id,endpoint,p256dh,auth`);
    // No subscription is not a failure, and must NOT stamp last_reminded_at:
    // doing so would burn the athlete's one nudge on a device that never
    // received it, and they would never be told about that step again.
    if (!subs.length) continue;
    const dueToday = row.due_on === today;
    const payload = JSON.stringify({
      title: dueToday ? "Due today" : "Still on your plan",
      body: dueToday ? row.title : `${row.title} — the day you set has passed.`,
      url: "/golsz-app.html",
    });
    await pushToAll(supaUrl, serviceKey, webpush, subs, payload);
    await supaPatch(supaUrl, serviceKey, `athlete_actions?id=eq.${row.id}`, { last_reminded_at: new Date().toISOString() });
    sent++;
  }
  return truncated
    ? { checked: rows.length, reminded: sent, paused, truncated: true, remaining: rows.length - sent - paused }
    : { checked: rows.length, reminded: sent, paused };
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

  // NEITHER LOOP MAY STARVE THE OTHER. They run in sequence and the due-step
  // nudge is second, so on a busy night the platform's kill always landed on
  // the same half — the one that is injury-aware and tells an athlete about
  // their own plan, which is the half that matters more. A share each means
  // the outreach scan cannot consume the whole window, and whatever either
  // leaves undone is first in line on the next run because nothing it skipped
  // was stamped.
  const startedAt = Date.now();
  const outreachDeadline = startedAt + Math.floor(BUDGET_MS * 0.5);
  const stepsDeadline = startedAt + BUDGET_MS;

  const reminderDays = Number(process.env.TARGET_REMINDER_DAYS || 7);
  const staleCutoff = new Date(Date.now() - reminderDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const statusFilter = REMINDER_STATUSES.map((s) => `"${s}"`).join(",");
    const cutoffEnc = encodeURIComponent(staleCutoff);
    // CAPPED AND ORDERED, like the due-step query 70 lines above and for the
    // reason that query already documents: an uncapped PostgREST select stops
    // at max-rows (1000 on Supabase) and still returns 200, so the rows past
    // the cut-off were dropped from the run with nothing saying so - and with
    // no ORDER BY, WHICH athletes were dropped was arbitrary and could differ
    // between two nights. Oldest-first means the longest-waiting target is
    // the one that gets its nudge, and anything beyond the cap is simply
    // first in line tomorrow rather than permanently invisible.
    const targets = await supaSelectOrNull(
      supaUrl, serviceKey,
      `outreach_targets?status=in.(${statusFilter})&updated_at=lt.${cutoffEnc}&or=(last_reminded_at.is.null,last_reminded_at.lt.${cutoffEnc})&select=id,user_id,name,status,updated_at&order=updated_at.asc&limit=500`
    );
    if (targets === null) throw new Error("outreach target scan failed");

    let sent = 0;
    let outreachTruncated = false;
    for (const target of targets) {
      if (Date.now() > outreachDeadline) { outreachTruncated = true; break; }
      const subs = await supaSelect(supaUrl, serviceKey, `push_subscriptions?user_id=eq.${target.user_id}&select=id,endpoint,p256dh,auth`);
      if (!subs.length) continue;
      const payload = JSON.stringify({
        title: "Follow-up reminder",
        body: `It's been a while since you touched ${target.name} — worth a follow-up?`,
        url: "/golsz-app.html?page=targets",
      });
      await pushToAll(supaUrl, serviceKey, webpush, subs, payload);
      await supaPatch(supaUrl, serviceKey, `outreach_targets?id=eq.${target.id}`, { last_reminded_at: new Date().toISOString() });
      sent++;
    }

    // Its own try: a failure here must not lose the outreach run that already
    // succeeded, nor the watchdog verdict. Reported either way so a silent
    // zero cannot be mistaken for "no steps were due".
    let steps = { checked: 0, reminded: 0 };
    try {
      steps = await remindDueSteps(supaUrl, serviceKey, webpush, stepsDeadline);
    } catch (e) {
      steps = { checked: 0, reminded: 0, error: String(e) };
      await logError("api/target-followup-reminders.js", "Due-step reminders failed", { detail: String(e) });
    }

    // A run that stopped early reports it. A quiet 200 saying "reminded: 3"
    // is indistinguishable from a night with three stale targets, and that is
    // the reading that lets a permanently-truncated run look healthy.
    return res.status(200).json(outreachTruncated
      ? { checked: targets.length, reminded: sent, truncated: true, remaining: targets.length - sent, steps, watchdog }
      : { checked: targets.length, reminded: sent, steps, watchdog });
  } catch (e) {
    await logError("api/target-followup-reminders.js", "Reminder run failed", { detail: String(e) });
    // The watchdog result is reported on this path too: it ran before the
    // reminders and its verdict is independent of them, so a failed
    // reminder run must not also hide whether the outage monitor is alive.
    return res.status(500).json({ error: "Reminder run failed", detail: String(e), watchdog });
  }
}
