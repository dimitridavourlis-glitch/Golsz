// Mirrors the exact guard condition inserted in api/scout.js's handler
// (line ~1503): "if (userPlan === 'free' && classification && classification.needs_tool && !userIsAdmin && !userAiUnlimited)"
function isBlocked(userPlan, needsTool, userIsAdmin, userAiUnlimited) {
  const classification = { needs_tool: needsTool };
  return !!(userPlan === "free" && classification && classification.needs_tool && !userIsAdmin && !userAiUnlimited);
}

const cases = [
  { name: "free + needs_tool -> BLOCKED", plan: "free", needsTool: true, admin: false, unlimited: false, expect: true },
  { name: "free + no tool -> allowed", plan: "free", needsTool: false, admin: false, unlimited: false, expect: false },
  { name: "starter + needs_tool -> allowed (paid tier)", plan: "starter", needsTool: true, admin: false, unlimited: false, expect: false },
  { name: "pro + needs_tool -> allowed", plan: "pro", needsTool: true, admin: false, unlimited: false, expect: false },
  { name: "elite + needs_tool -> allowed", plan: "elite", needsTool: true, admin: false, unlimited: false, expect: false },
  { name: "free + needs_tool + admin -> exempted", plan: "free", needsTool: true, admin: true, unlimited: false, expect: false },
  { name: "free + needs_tool + aiUnlimited -> exempted", plan: "free", needsTool: true, admin: false, unlimited: true, expect: false },
  { name: "null plan (unmetered deployment) + needs_tool -> allowed", plan: null, needsTool: true, admin: false, unlimited: false, expect: false },
];

let failed = 0;
for (const c of cases) {
  const got = isBlocked(c.plan, c.needsTool, c.admin, c.unlimited);
  const ok = got === c.expect;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} - ${c.name} (got ${got}, expected ${c.expect})`);
}
console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
