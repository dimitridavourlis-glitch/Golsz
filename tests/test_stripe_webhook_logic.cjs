function planFromAmount(amount) {
  return amount >= 3000 ? "elite" : amount >= 1400 ? "pro" : amount >= 600 ? "starter" : null;
}

// Mirrors the customer.subscription.updated branch in api/stripe-webhook.js
function decideSubscriptionUpdatePatch(status, unitAmount) {
  if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") {
    return { plan: "free", payment_past_due: false };
  }
  const plan = unitAmount === null ? null : planFromAmount(unitAmount);
  const patch = { payment_past_due: status === "past_due" };
  if (plan) patch.plan = plan;
  return patch;
}

let failed = 0;
function check(name, got, expect) {
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} - ${name} (got ${JSON.stringify(got)}, expected ${JSON.stringify(expect)})`);
}

check("planFromAmount elite", planFromAmount(3000), "elite");
check("planFromAmount pro", planFromAmount(1400), "pro");
check("planFromAmount starter", planFromAmount(600), "starter");
check("planFromAmount below starter -> null", planFromAmount(599), null);

check("active status with pro price -> syncs plan, clears past_due", decideSubscriptionUpdatePatch("active", 1400), { payment_past_due: false, plan: "pro" });
check("past_due status -> flags past_due, keeps existing plan (no price change)", decideSubscriptionUpdatePatch("past_due", 1400), { payment_past_due: true, plan: "pro" });
check("past_due status with no price info -> flags past_due, doesn't touch plan", decideSubscriptionUpdatePatch("past_due", null), { payment_past_due: true });
check("canceled -> hard downgrade to free, clears past_due", decideSubscriptionUpdatePatch("canceled", 3000), { plan: "free", payment_past_due: false });
check("unpaid -> hard downgrade to free", decideSubscriptionUpdatePatch("unpaid", 3000), { plan: "free", payment_past_due: false });
check("incomplete_expired -> hard downgrade to free", decideSubscriptionUpdatePatch("incomplete_expired", 3000), { plan: "free", payment_past_due: false });
check("trialing -> not past_due, syncs plan if price known", decideSubscriptionUpdatePatch("trialing", 600), { payment_past_due: false, plan: "starter" });

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
