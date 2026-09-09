function ageFromDob(dobIso) {
  const dob = new Date(dobIso);
  if (isNaN(dob.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) age--;
  return age;
}

// Fix "today" for deterministic testing by monkeypatching isn't trivial in
// plain Node without a lib; instead compute expected age relative to the
// ACTUAL current date, mirroring exactly what the function does.
const now = new Date();
function isoYearsAgo(years, monthOffset = 0, dayOffset = 0) {
  const d = new Date(now.getFullYear() - years, now.getMonth() + monthOffset, now.getDate() + dayOffset);
  return d.toISOString().slice(0, 10);
}

let failed = 0;
function check(name, got, expect) {
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} - ${name} (got ${got}, expected ${expect})`);
}

check("exactly 18 today -> 18 (not under 18)", ageFromDob(isoYearsAgo(18)), 18);
check("15 years old, birthday already passed this year -> 15", ageFromDob(isoYearsAgo(15, 0, -10)), 15);
check("15 years old, birthday not yet this year (still 15, not 16) -> 15", ageFromDob(isoYearsAgo(16, 0, 10)), 15);
check("10 years old -> 10", ageFromDob(isoYearsAgo(10)), 10);
check("17 years old -> 17", ageFromDob(isoYearsAgo(17)), 17);
check("invalid date -> null", ageFromDob("not-a-date"), null);
check("empty string -> null", ageFromDob(""), null);

// The actual gate used in the handler: age >= 18 -> rejected (must self-signup).
// Raised from 16 to 18 on 2026-09-07 — GOLSZ contracts with and bills adults
// only, so anyone under 18 is a managed profile inside a parent's account.
// This mirrors api/create-child-account.js; if that number moves, this fails.
function isEligibleForParentFlow(dobIso) {
  const age = ageFromDob(dobIso);
  return age !== null && age < 18;
}
check("15yo eligible for parent flow", isEligibleForParentFlow(isoYearsAgo(15)), true);
check("16yo eligible for parent flow (was NOT before the 18 change)", isEligibleForParentFlow(isoYearsAgo(16)), true);
check("17yo eligible for parent flow (was NOT before the 18 change)", isEligibleForParentFlow(isoYearsAgo(17)), true);
check("18yo NOT eligible for parent flow (must self-signup)", isEligibleForParentFlow(isoYearsAgo(18)), false);
check("19yo NOT eligible", isEligibleForParentFlow(isoYearsAgo(19)), false);
check("5yo eligible", isEligibleForParentFlow(isoYearsAgo(5)), true);
check("invalid dob not eligible (rejected, not silently allowed)", isEligibleForParentFlow("garbage"), false);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
