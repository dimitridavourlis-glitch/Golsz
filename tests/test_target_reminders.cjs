const REMINDER_STATUSES = new Set(["preparing", "contacted", "follow_up"]);
const REMINDER_DAYS = 7;

function isEligible(target, now) {
  if (!REMINDER_STATUSES.has(target.status)) return false;
  const cutoff = now - REMINDER_DAYS * 24 * 60 * 60 * 1000;
  if (new Date(target.updated_at).getTime() >= cutoff) return false;
  if (target.last_reminded_at && new Date(target.last_reminded_at).getTime() >= cutoff) return false;
  return true;
}

const now = Date.parse("2026-08-07T13:00:00Z");
const daysAgo = (n) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

let failed = 0;
function check(name, got, expect) {
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} - ${name} (got ${got}, expected ${expect})`);
}

check("fresh contacted target (2 days old) -> not eligible",
  isEligible({ status: "contacted", updated_at: daysAgo(2), last_reminded_at: null }, now), false);

check("stale contacted target (10 days old, never reminded) -> eligible",
  isEligible({ status: "contacted", updated_at: daysAgo(10), last_reminded_at: null }, now), true);

check("stale preparing target (8 days old) -> eligible",
  isEligible({ status: "preparing", updated_at: daysAgo(8), last_reminded_at: null }, now), true);

check("stale follow_up target (30 days old) -> eligible",
  isEligible({ status: "follow_up", updated_at: daysAgo(30), last_reminded_at: null }, now), true);

check("stale but already reminded 2 days ago -> not eligible (avoid daily spam)",
  isEligible({ status: "contacted", updated_at: daysAgo(20), last_reminded_at: daysAgo(2) }, now), false);

check("stale, reminded 10 days ago -> eligible again (reminder interval elapsed)",
  isEligible({ status: "contacted", updated_at: daysAgo(20), last_reminded_at: daysAgo(10) }, now), true);

check("researching status -> never eligible (athlete hasn't reached out yet)",
  isEligible({ status: "researching", updated_at: daysAgo(30), last_reminded_at: null }, now), false);

check("opportunity status -> never eligible (deal already progressed)",
  isEligible({ status: "opportunity", updated_at: daysAgo(30), last_reminded_at: null }, now), false);

check("exactly at 7-day boundary -> not yet eligible (>= cutoff means still fresh)",
  isEligible({ status: "contacted", updated_at: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(), last_reminded_at: null }, now), false);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
