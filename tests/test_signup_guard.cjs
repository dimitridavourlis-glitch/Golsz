// Mirrors api/signup-guard.js's IP-parsing line exactly.
function parseIp(forwarded) {
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded || "").split(",")[0].trim();
}

const cases = [
  { name: "single IP", input: "203.0.113.5", expect: "203.0.113.5" },
  { name: "chained proxy IPs -> first wins", input: "203.0.113.5, 10.0.0.1, 10.0.0.2", expect: "203.0.113.5" },
  { name: "array header (some runtimes) -> first element", input: ["203.0.113.5", "10.0.0.1"], expect: "203.0.113.5" },
  { name: "missing header -> empty string, not crash", input: undefined, expect: "" },
  { name: "empty string header", input: "", expect: "" },
];

let failed = 0;
for (const c of cases) {
  const got = parseIp(c.input);
  const ok = got === c.expect;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} - ${c.name} (got "${got}", expected "${c.expect}")`);
}

// Mirrors reserve_signup_attempt()'s allowed = count <= limit logic.
function allowed(count, limit) { return count <= limit; }
const limitCases = [
  { count: 1, limit: 10, expect: true },
  { count: 10, limit: 10, expect: true },
  { count: 11, limit: 10, expect: false },
];
for (const c of limitCases) {
  const got = allowed(c.count, c.limit);
  const ok = got === c.expect;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} - count=${c.count} limit=${c.limit} (got ${got}, expected ${c.expect})`);
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
