// Every consequential server-side write must be able to observe its own failure.
//
// THE BUG THIS ENFORCES AGAINST
// tests/test_write_error_checked.cjs covers the CLIENT, where supabase-js
// resolves with { error } instead of throwing. This is the server half, where
// the mechanism is different and the ending is the same:
//
//   1. `await fetch()` RESOLVES on 4xx and 5xx. It rejects only on a network
//      failure. So `try { await fetch(...) } catch {}` sees almost nothing,
//      and a rejected write is indistinguishable from a successful one.
//   2. `Prefer: return=minimal` answers 204 for a PATCH that matched ZERO
//      rows — byte-identical to the 204 for one that matched and updated.
//
// Found 2026-08-24 by scanning api/ after the same bug turned up twice by
// hand. 55 mutating fetch calls; 20 could not observe their own failure; 5
// of those were real:
//   api/stripe-webhook.js patchProfile ...... athlete paid, got no plan, and
//     Stripe was told 200 so it never retried
//   api/admin-user-action.js patchProfile ... auth-layer ban landed while
//     profiles.is_banned stayed false — split-brain, panel shows them active
//   api/create-child-account.js ............. a MINOR's account created
//     without its parent_managed flag
//   api/scout.js release{Scout,FreeAi}Question  a refund that silently failed,
//     billing an athlete for an answer they never got
//   api/target-followup-reminders.js supaPatch  reminder sent but not
//     recorded, so it repeats every run forever
//
// None logged anything. None failed a test. That is the entire point.
//
// HOW THE DETECTOR IS VALIDATED
// It parses to an AST rather than grepping, because the string "error" or
// "ok" appears near almost every one of these calls — the sibling suite's
// header records a grep-based first attempt that reported 4 when the answer
// was 36. Below, the scan is run against a known-broken and a known-good
// fixture BEFORE its result on the real files is allowed to mean anything.
//
// WHAT THIS CANNOT DO, STATED UP FRONT
// "Checked" here means `.ok` or `.status` is read off the bound response
// inside the same function. A write that instead checks a CONTRACT IN THE
// BODY is reported as unchecked even though it is correct — api/verify-
// turnstile.js is exactly that (Cloudflare answers 200 with success:false,
// and its catch fails closed on purpose). That is why the entries below are
// a REVIEWED list with a reason each, not a suppression list: the judgement
// is recorded here because the detector cannot make it.

const fs = require("fs");
const path = require("path");
const REPO = path.join(__dirname, "..");
const parser = require(path.join(REPO, "node_modules/@babel/parser"));
let traverse = require(path.join(REPO, "node_modules/@babel/traverse"));
traverse = traverse.default || traverse;

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

function scan(src, file) {
  const ast = parser.parse(src, { sourceType: "module", plugins: ["jsx"], errorRecovery: true });
  const out = [];
  traverse(ast, {
    CallExpression(p2) {
      const c = p2.node.callee;
      if (!(c.type === "Identifier" && c.name === "fetch")) return;

      let method = "GET";
      const opts = p2.node.arguments[1];
      if (opts && opts.type === "ObjectExpression") {
        for (const pr of opts.properties) {
          if (pr.type === "ObjectProperty" && (pr.key.name || pr.key.value) === "method") {
            method = pr.value.type === "StringLiteral" ? pr.value.value.toUpperCase() : "DYNAMIC";
          }
        }
      }
      // DYNAMIC is kept, not skipped. A method built at runtime could be a
      // write, and silently dropping it is how a detector goes blind.
      if (!MUTATING.has(method) && method !== "DYNAMIC") return;

      let fn = "(top level)";
      const fp = p2.getFunctionParent();
      if (fp) {
        if (fp.node.id && fp.node.id.name) fn = fp.node.id.name;
        else if (fp.parent && fp.parent.type === "VariableDeclarator" && fp.parent.id.name) fn = fp.parent.id.name;
        else if (fp.parent && fp.parent.type === "ObjectProperty") fn = fp.parent.key.name || "(obj)";
        else fn = "(arrow)";
      }

      // How is the result used? A response that is never bound to a name
      // cannot be inspected by anything, which is the common shape here.
      const a = p2.parentPath;
      let bound = null;
      if (a.node.type === "AwaitExpression") {
        const par = a.parentPath;
        if (par.node.type === "VariableDeclarator" && par.node.id.type === "Identifier") bound = par.node.id.name;
        else if (par.node.type === "AssignmentExpression" && par.node.left.type === "Identifier") bound = par.node.left.name;
      }

      let checked = false;
      if (bound && fp) {
        traverse(fp.node, {
          noScope: true,
          MemberExpression(q) {
            if (q.node.object.type === "Identifier" && q.node.object.name === bound &&
                (q.node.property.name === "ok" || q.node.property.name === "status")) checked = true;
          },
        });
      }
      out.push({ file, fn, method, line: p2.node.loc.start.line, checked });
    },
  });
  return out;
}

// ---- the detector must fire on the real bug, and stay silent on the fix ---
// Without both halves, a scan that returns nothing is indistinguishable from
// a scan that is broken.
console.log("-- the detector discriminates before its result is believed --");
const BROKEN = 'async function bad(){ await fetch(u, { method: "PATCH" }); }';
const FIXED  = 'async function good(){ const r = await fetch(u, { method: "PATCH" }); if (!r.ok) throw new Error("x"); }';
const READ   = 'async function read(){ const r = await fetch(u); return r.json(); }';
ck("it flags a write whose response is discarded", scan(BROKEN, "<fx>").map((x) => x.checked), [false]);
ck("...and does NOT flag the same write once r.ok is checked", scan(FIXED, "<fx>").map((x) => x.checked), [true]);
ck("...and ignores reads entirely, which are not writes", scan(READ, "<fx>").length, 0);

// ---------------------------------------------------------------------------
// REVIEWED: writes that cannot observe their own failure, and why that is OK.
// Keyed by file + function + method, NOT by line number, so ordinary edits
// above them do not invalidate the review.
// ---------------------------------------------------------------------------
const REVIEWED = {
  // Terminal loggers. error_log IS the place failures are reported to, so a
  // failure here has nowhere left to go. Swallowing is the only option.
  "admin-user-action.js|logError|POST": "terminal logger",
  "create-child-account.js|logError|POST": "terminal logger",
  "delete-account.js|logError|POST": "terminal logger",
  "moderate.js|logError|POST": "terminal logger",
  "scout.js|logError|POST": "terminal logger",
  "send-push.js|logError|POST": "terminal logger",
  "stripe-webhook.js|logError|POST": "terminal logger",
  "target-followup-reminders.js|logError|POST": "terminal logger",
  "scout.js|logFaqMiss|POST": "terminal logger — records why the FAQ path did not fire",

  // Checked, but against a contract in the BODY rather than the status line.
  // The detector cannot see this; a human read it.
  "verify-turnstile.js|handler|POST":
    "reads data.success — Cloudflare answers 200 with success:false — and its catch fails CLOSED (502)",

  // Deliberate fail-open, documented at the call site.
  "moderate.js|incrementModerationUsage|POST":
    "fails open on the limiter by design: a hiccup must not block a real moderation check",

  // Metrics only. A lost hit_count is a blip in a dashboard, not lost data.
  "scout.js|getCachedResponse|PATCH": "hit_count bump, deliberately not awaited",
  "scout.js|getResearchCache|PATCH": "hit_count bump, deliberately not awaited",

  // Best-effort pruning of a push subscription the provider just told us is
  // dead (404/410). Failure means it is retried next run. Self-correcting.
  "send-push.js|supaDelete|DELETE": "prunes a dead push subscription; retried next run",
  "target-followup-reminders.js|(arrow)|DELETE": "prunes a dead push subscription; retried next run",
};

const files = fs.readdirSync(path.join(REPO, "api")).filter((x) => x.endsWith(".js")).sort();
ck("api/ source files were found", files.length > 5, true);

let all = [];
for (const file of files) all = all.concat(scan(fs.readFileSync(path.join(REPO, "api", file), "utf8"), file));
ck("mutating writes were found at all", all.length > 20, true);

const key = (x) => `${x.file}|${x.fn}|${x.method}`;
const unchecked = all.filter((x) => !x.checked);

// An ambiguous key would let one reviewed entry silently cover a second,
// unreviewed write that happens to share a name. Fail rather than guess.
const seen = new Map();
for (const x of unchecked) seen.set(key(x), (seen.get(key(x)) || 0) + 1);
ck("no two unreviewed writes share a key", [...seen].filter(([, n]) => n > 1).map(([k]) => k), []);

// THE ASSERTION. An unlisted write fails. This repo has been bitten more than
// once by allowlists where the unlisted case was the silent one, so the
// default here is failure, not omission.
ck("every write that cannot observe its failure has been reviewed",
   unchecked.filter((x) => !REVIEWED[key(x)]).map((x) => `${x.file}:${x.line} ${x.method} ${x.fn}`), []);

// The anti-rot half. A reviewed entry that no longer matches anything means
// the list has started describing code that does not exist — which is how it
// quietly stops being a review of the real thing.
const live = new Set(unchecked.map(key));
ck("no reviewed entry describes a write that is gone",
   Object.keys(REVIEWED).filter((k) => !live.has(k)), []);

// A count, so a large silent drift shows up as a number even if both lists
// still reconcile. Stated rather than derived on purpose.
console.log(`\n-- ${all.length} mutating writes in api/: ${all.length - unchecked.length} check their own result, ${unchecked.length} reviewed --`);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
