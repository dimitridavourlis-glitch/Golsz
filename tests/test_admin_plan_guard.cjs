// A PLAN DOWNGRADE IN THE ADMIN PANEL DOES NOT CANCEL A SUBSCRIPTION.
//
// The plan dropdown wrote profiles.plan straight from a <select> with no
// confirmation, so an admin could move a paying subscriber to free: they lose
// everything they are paying for and Stripe keeps charging them, with nothing
// on screen saying those are two separate systems.
//
// What made that a defect rather than a policy choice is that both sibling
// paths into the same consequence already refuse it:
//
//   * the athlete's own plan switch in Settings routes an active subscriber
//     to the billing portal instead of writing the column;
//   * ban and delete get a 409 from api/admin-user-action.js until the admin
//     confirms in as many words that billing was cancelled in Stripe.
//
// This was the third door and the only one standing open. It asks now rather
// than blocking — an admin fixing a webhook that never landed has a real
// reason to set the column — and records the acknowledgement in the audit
// row, so "they were warned" is a fact on file rather than a recollection.
const REPO = require("path").join(__dirname, "..");
const fs = require("fs");
const APP = fs.readFileSync(REPO + "/golsz-app.html", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const at = APP.indexOf("  async function setUserPlan(id, val) {");
ck("setUserPlan was found", at > 0, true);
const fn = APP.slice(at, APP.indexOf("\n  }", at));

// It cannot guard what it cannot see: the column has to be in the select.
ck("the panel reads who is actually subscribed",
   /select\("id, full_name, plan,[^"]*stripe_customer_id, created_at"\)/.test(APP), true);

// A downgrade, not any change. Raising a plan takes nothing away and bills
// nobody, so it must not nag — a confirmation that fires on everything is one
// an admin learns to dismiss without reading.
ck("a downgrade is decided by rank, not by inequality",
   /PLAN_RANK\[val\] < PLAN_RANK\[u\.plan\]/.test(fn), true);
ck("...and only for an account with a Stripe customer",
   /if \(u && u\.stripe_customer_id && downgrade\)/.test(fn), true);
ck("...using the warning the ban path already uses",
   /t\("admin_billing_cancel_first"\)\.replace\("\{customer\}", u\.stripe_customer_id\)/.test(fn), true);

// Declining must leave the account alone AND put the dropdown back, or it
// keeps showing the plan the admin chose and not the one on file.
ck("declining writes nothing", /if \(!window\.confirm\([\s\S]{0,120}?\)\) \{\n\s*loadUsers\(userQuery\);\s*\/\/[^\n]*\n\s*return;/.test(fn), true);
ck("...and the write only happens after the branch",
   fn.indexOf("window.confirm") < fn.indexOf('update({ plan: val })'), true);

// The acknowledgement is the point of asking. An audit row that does not
// carry it cannot tell a warned downgrade from an unwarned one later.
ck("the audit row records that billing was acknowledged",
   /logAdmin\("set_plan", id, acknowledged \? \{ plan: val, billing_acknowledged: true \} : \{ plan: val \}\)/.test(fn), true);

// The sibling defect in the same panel: refreshing without the active search
// drops the admin back to the unfiltered first 100 rows, so the account they
// just changed vanishes out from under them.
ck("every row action refreshes with the active search",
   (APP.match(/loadUsers\(\);/g) || []).length, 1);
ck("...and the one that does not is the initial load of every panel",
   /loadStats\(\); loadUsers\(\); loadAuditLog\(\)/.test(APP), true);

console.log(`\n${p}/${p + f} passed`); process.exit(f ? 1 : 0);
