// api/moderate.js — the minor-safety classifier endpoint.
//
// 27KB, and it had ZERO behavioural coverage. It is the enforcement point
// for the adult -> minor rules on a platform whose own prompt opens with
// "a significant share of athlete accounts belong to minors under 18".
//
// The two things this suite is most concerned with:
//
//  1. THE ADULT -> MINOR BLOCK DECISION. The policy itself lives in
//     MODERATION_SYSTEM_PROMPT and is enforced by the model, so what this
//     file must guarantee is the part the model cannot: that the author's
//     and recipient's minor status reaching the classifier is resolved
//     SERVER-SIDE from profiles, never taken from the request body. A caller
//     who can assert `author.is_minor = true` — or who can bend the
//     recipient lookup to a different row — defeats every rule in that
//     prompt at once, and the model would never know.
//
//  2. THE RATE-LIMIT PATH. This endpoint makes a paid Anthropic call per
//     request and was, by its own comment, "found during a full app audit as
//     a cost-abuse vector".
//
// EXTRACTION
// The module cannot be require()d here (it does `import webpush from
// "web-push"`, not installed for the test run), so the REAL source is read
// at run time, the import line is swapped for an injected stub, and the whole
// file — handler and every helper, otherwise untouched — is evaluated.
// Nothing is retyped. See tests/README.md, "the one rule that matters".

const path = require("path");
const fs = require("fs");
const REPO = path.join(__dirname, "..");
const SRC = fs.readFileSync(REPO + "/api/moderate.js", "utf8");

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

function rewrite(src, re, to, label) {
  if (!re.test(src)) throw new Error(`could not find ${label} in api/moderate.js — update this suite`);
  return src.replace(re, to);
}
let body = SRC;
body = rewrite(body, /^import webpush from "web-push";$/m, "const webpush = __webpush;", "the web-push import");
body = rewrite(body, /^export default async function handler/m, "async function handler", "the default export");

let pushes = [];
const webpushStub = {
  setVapidDetails() {},
  async sendNotification(sub, payload) { pushes.push(JSON.parse(payload)); },
};
// mapRole is also returned so the role mapping can be exercised directly.
const { handler, mapRole } =
  new Function("__webpush", body + "\nreturn { handler, mapRole };")(webpushStub);

process.env.ANTHROPIC_API_KEY = "sk-test";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
process.env.VAPID_PUBLIC_KEY = "vapid-public";
process.env.VAPID_PRIVATE_KEY = "vapid-private";
process.env.VAPID_SUBJECT = "mailto:admin@golsz.com";
process.env.MODERATION_DAILY_LIMIT = "5";

// ---- harness -------------------------------------------------------------
const ADULT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MINOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LOWTRUST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const PROFILES = {
  [ADULT]: { occupation: "Coach", is_minor: false, verified_tier: "pro", is_admin: false, trust_score: 80 },
  [MINOR]: { occupation: "Player", is_minor: true, verified_tier: null, is_admin: false, trust_score: 70 },
  [ADMIN]: { occupation: "Coach", is_minor: false, verified_tier: "elite", is_admin: true, trust_score: 90 },
  [LOWTRUST]: { occupation: "Player", is_minor: false, verified_tier: null, is_admin: false, trust_score: 0 },
};
const TOKENS = { "Bearer adult": ADULT, "Bearer minor": MINOR, "Bearer admin": ADMIN, "Bearer lowtrust": LOWTRUST };

let calls = [];
let usageCount = 1;          // what increment_moderation_usage returns
let usageThrows = false;
let classifier = { decision: "allow", primary_reason_code: "CLEAN", reason_codes: [], confidence: 0.9, minor_safety_triggered: false, rationale: "fine" };
let anthropicOk = true;
let lastClassifierInput = null;

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = String(opts.method || "GET").toUpperCase();
  let parsed = null;
  try { parsed = opts.body ? JSON.parse(opts.body) : null; } catch { parsed = opts.body; }
  calls.push({ url: u, method, body: parsed });

  if (u.includes("api.anthropic.com")) {
    // The classifier only ever sees this one user message; capturing it is
    // how the "what did the server tell the model about these people"
    // assertions below are made.
    lastClassifierInput = JSON.parse(parsed.messages[0].content);
    if (!anthropicOk) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: JSON.stringify(classifier) }] }) };
  }
  if (u.includes("/auth/v1/user")) {
    const id = TOKENS[(opts.headers || {}).Authorization];
    return id ? { ok: true, json: async () => ({ id }) } : { ok: false, json: async () => ({}) };
  }
  if (u.includes("/rpc/increment_moderation_usage")) {
    if (usageThrows) throw new Error("rpc down");
    return { ok: true, json: async () => usageCount };
  }
  if (u.includes("/rest/v1/profiles?is_admin=eq.true")) {
    return { ok: true, json: async () => [{ id: ADMIN }] };
  }
  if (u.includes("/rest/v1/push_subscriptions")) {
    return { ok: true, json: async () => [{ endpoint: "https://push.example/1", p256dh: "k", auth: "a" }] };
  }
  if (method === "GET" && u.includes("/rest/v1/profiles")) {
    const m = /id=eq\.([^&]+)/.exec(u);
    const row = m ? PROFILES[m[1]] : undefined;
    return { ok: true, json: async () => (row ? [row] : []) };
  }
  return { ok: true, json: async () => [] };
};

const mkRes = () => {
  const r = { statusCode: null, payload: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.payload = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
};

async function post(reqBody, { auth = "Bearer adult", method = "POST" } = {}) {
  calls = [];
  pushes = [];
  lastClassifierInput = null;
  const res = mkRes();
  await handler({ method, headers: { authorization: auth }, body: reqBody }, res);
  return {
    status: res.statusCode,
    payload: res.payload,
    calls,
    pushes,
    sent: lastClassifierInput,
    anthropicCalls: calls.filter((c) => c.url.includes("api.anthropic.com")),
    queued: calls.filter((c) => c.url.includes("/rest/v1/moderation_queue")),
    profileLookups: calls.filter((c) => c.method === "GET" && c.url.includes("/rest/v1/profiles?id=eq.")),
  };
}

(async () => {
  console.log("-- the harness reaches the handler --");
  // Same trap test_handler_smoke.cjs documents: a suite that 401s on every
  // scenario passes all its "nothing happened" assertions while testing
  // nothing. Prove the happy path first.
  let r = await post({ text: "Great session today, hit a new PB on the 10m." });
  ck("a signed-in adult gets a decision", r.status, 200);
  ck("...the classifier was actually called", r.anthropicCalls.length, 1);
  ck("...and the decision comes back", r.payload.decision, "allow");
  ck("...a clean allow is NOT queued for review", r.queued.length, 0);

  console.log("\n-- role mapping --");
  ck("Player -> athlete", mapRole("Player"), "athlete");
  ck("Coach -> coach", mapRole("Coach"), "coach");
  ck("Scout -> scout", mapRole("Scout"), "scout");
  ck("Agent -> agent", mapRole("Agent"), "agent");
  ck("no occupation defaults to athlete (every profile gets an athletes row)", mapRole(null), "athlete");
  ck("an unrecognised occupation is null, not silently an athlete", mapRole("Physio"), null);

  console.log("\n-- ADULT -> MINOR: the context the model judges on is SERVER-RESOLVED --");
  r = await post({
    text: "Send me your number, let's keep this between us.",
    contentType: "direct_message", surface: "private_thread", recipientId: MINOR,
  });
  ck("the recipient's minor status is looked up, not taken from the body", r.sent.recipient, { role: "athlete", is_minor: true });
  ck("the author is described from their own profile row", r.sent.author, { role: "coach", is_minor: false, verified: true });
  ck("...so the model sees a genuine adult-to-minor DM", [r.sent.author.is_minor, r.sent.recipient.is_minor], [false, true]);
  ck("...on the surface the caller declared", r.sent.surface, "private_thread");
  ck("two profile lookups happened: author and recipient", r.profileLookups.length, 2);

  // THE ATTACK. A caller who can assert their own or the recipient's minor
  // status defeats the entire minor-safety rule, because the rule is keyed
  // on exactly those two booleans.
  r = await post({
    text: "hi", contentType: "direct_message", surface: "private_thread", recipientId: MINOR,
    author: { role: "athlete", is_minor: true, verified: true },
    recipient: { role: "athlete", is_minor: false },
  });
  ck("a body-supplied author claim is ignored entirely",
     r.sent.author, { role: "coach", is_minor: false, verified: true });
  ck("a body-supplied recipient claim is ignored entirely",
     r.sent.recipient, { role: "athlete", is_minor: true });
  ck("...an adult cannot claim to be a minor to dodge the adult-to-minor rule",
     r.sent.author.is_minor, false);
  ck("...and cannot declare the minor an adult", r.sent.recipient.is_minor, true);
  ck("a self-declared 'verified' is likewise ignored",
     (await post({ text: "hi", author: { verified: true } }, { auth: "Bearer minor" })).sent.author.verified, false);

  // The recipient id is interpolated into a PostgREST filter. A crafted
  // value could otherwise widen or reroute that filter and resolve a
  // DIFFERENT profile's minor status than the one the message is going to.
  for (const bad of ["not-a-uuid", MINOR + "&is_admin=eq.true", MINOR + " or 1=1", "", 12345, { id: MINOR }]) {
    r = await post({ text: "hi", contentType: "direct_message", recipientId: bad });
    ck(`a non-UUID recipientId (${JSON.stringify(bad)}) resolves to no recipient`, r.sent.recipient, null);
    ck("...and only the author was looked up", r.profileLookups.length, 1);
  }

  console.log("\n-- minor-safety escalation is acted on, not just returned --");
  classifier = { decision: "block", primary_reason_code: "MINOR_CONTACT_SOLICITATION",
                 reason_codes: ["MINOR_CONTACT_SOLICITATION", "MINOR_SECRECY"], confidence: 0.97,
                 minor_safety_triggered: true, rationale: "asked a minor for private contact details" };
  r = await post({ text: "give me your number, don't tell your dad", contentType: "direct_message",
                   surface: "private_thread", recipientId: MINOR });
  ck("a block is returned as a block", r.payload.decision, "block");
  ck("...the reason codes survive", r.payload.reason_codes, ["MINOR_CONTACT_SOLICITATION", "MINOR_SECRECY"]);
  ck("...it is written to the moderation queue", r.queued.length, 1);
  ck("...with the author recorded", r.queued[0].body.author_id, ADULT);
  ck("...and the minor-safety flag persisted", r.queued[0].body.minor_safety_triggered, true);
  ck("...and every admin is pushed immediately", r.pushes.length, 1);
  ck("...with a message pointing at the moderation tab", /Moderation tab/.test(r.pushes[0].body), true);

  classifier = { decision: "review", primary_reason_code: "MINOR_ADULT_DM_UNSUPERVISED",
                 reason_codes: ["MINOR_ADULT_DM_UNSUPERVISED"], confidence: 0.8,
                 minor_safety_triggered: false, rationale: "adult to minor DM outside parent thread" };
  r = await post({ text: "hello", contentType: "direct_message", surface: "private_thread", recipientId: MINOR });
  ck("a review is queued too", r.queued.length, 1);
  ck("...but without a minor-safety flag it does not page anyone", r.pushes.length, 0);

  console.log("\n-- the classifier's output is sanitised, and fails toward review --");
  classifier = { decision: "definitely_fine", primary_reason_code: 42, reason_codes: "nope",
                 confidence: "high", minor_safety_triggered: "yes", rationale: 7 };
  r = await post({ text: "hi" });
  ck("an invalid decision becomes 'review', NOT 'allow'", r.payload.decision, "review");
  ck("a non-string reason code falls back to CONTEXT_INSUFFICIENT", r.payload.primary_reason_code, "CONTEXT_INSUFFICIENT");
  ck("a non-array reason_codes becomes []", r.payload.reason_codes, []);
  ck("a non-numeric confidence becomes 0", r.payload.confidence, 0);
  ck("a truthy non-boolean minor_safety flag is coerced, not trusted as-is", r.payload.minor_safety_triggered, true);
  ck("a non-string rationale becomes ''", r.payload.rationale, "");

  classifier = { decision: "allow", primary_reason_code: "CLEAN", reason_codes: [], confidence: 0.9,
                 minor_safety_triggered: false, rationale: "ok", sports_relevance: "low" };
  // REWRITTEN 2026-08-13, and NOT relaxed. The low-sports-relevance escalation
  // fires only for content_type "post" on surface "public_feed". Both are
  // retired — Feed was removed from the client and "post" is no longer in
  // VALID_CONTENT_TYPES — so the rule is DORMANT, not broken, and a test that
  // still asserted it escalates would be asserting something the server can no
  // longer be asked to do.
  //
  // What is worth testing now is the retirement itself, and the property that
  // makes it safe: an unrecognised type lands as "unknown" rather than quietly
  // wearing the name of a real category.
  r = await post({ text: "buy crypto here", contentType: "post", surface: "public_feed" });
  ck("a retired content_type is not silently accepted", r.sent.content_type, "unknown");
  ck("...and the dormant escalation does not fire for it", r.payload.decision, "allow");
  r = await post({ text: "buy crypto here", contentType: "direct_message", surface: "private_thread" });
  ck("direct_message is retired too", r.sent.content_type, "unknown");
  ck("...and is still not force-blocked", r.payload.decision, "allow");
  // A LIVE type must still pass through under its own name.
  r = await post({ text: "buy crypto here", contentType: "scout_message", surface: "scout" });
  ck("a live content_type survives intact", r.sent.content_type, "scout_message");
  // The rule itself must remain in the source, ready for a posting surface to
  // return. Deleting it would mean rediscovering the requirement, not
  // re-enabling it.
  const MOD = require("fs").readFileSync(require("path").join(__dirname, "..", "api/moderate.js"), "utf8");
  ck("the low-sports-relevance rule is still present, just unreachable",
     /sports_relevance === "low" && classifierInput\.content_type === "post"/.test(MOD), true);

  classifier = { decision: "allow", primary_reason_code: "CLEAN", reason_codes: [], confidence: 0.9,
                 minor_safety_triggered: false, rationale: "ok" };
  r = await post({ text: "nice run" }, { auth: "Bearer lowtrust" });
  ck("a very-low-trust account's clean content is queued for review", r.payload.decision, "review");
  ck("...with LOW_TRUST_ACCOUNT as the reason", r.payload.primary_reason_code, "LOW_TRUST_ACCOUNT");
  r = await post({ text: "nice run" });
  ck("...while a normal-trust account is left alone", r.payload.decision, "allow");

  console.log("\n-- THE RATE-LIMIT PATH (cost-abuse control) --");
  usageCount = 1;
  r = await post({ text: "hi" });
  ck("the first call of the day is allowed", r.status, 200);
  ck("...and usage was incremented", r.calls.some((c) => c.url.includes("increment_moderation_usage")), true);

  usageCount = 5;   // MODERATION_DAILY_LIMIT
  r = await post({ text: "hi" });
  ck("exactly at the limit is still allowed", r.status, 200);
  usageCount = 6;
  r = await post({ text: "hi" });
  ck("one over the limit is a 429", r.status, 429);
  ck("...with an honest message", r.payload, { error: "Daily moderation check limit reached." });
  ck("...and CRUCIALLY the paid Anthropic call is never made", r.anthropicCalls.length, 0);

  usageCount = 9999;
  r = await post({ text: "hi" }, { auth: "Bearer admin" });
  ck("admins are exempt from the limit, same as Scout's metering", r.status, 200);
  ck("...and are not metered at all", r.calls.some((c) => c.url.includes("increment_moderation_usage")), false);

  // The limiter failing must not become an outage on the moderation path —
  // but it also must not be silently uncounted forever, which is why the
  // RPC returning 0 is the documented fail-open value.
  usageThrows = true;
  r = await post({ text: "hi" });
  ck("a limiter outage fails OPEN rather than blocking every post", r.status, 200);
  usageThrows = false;
  usageCount = 1;

  console.log("\n-- auth, input handling, and failing open --");
  r = await post({ text: "hi" }, { auth: "Bearer forged" });
  ck("an unauthenticated caller is refused", r.status, 401);
  ck("...before any paid call is made", r.anthropicCalls.length, 0);

  for (const bad of [undefined, null, "", "   ", 12345, {}]) {
    r = await post({ text: bad });
    ck(`empty/invalid text (${JSON.stringify(bad)}) short-circuits to allow`, r.payload, { decision: "allow" });
    ck("...with no paid call", r.anthropicCalls.length, 0);
  }
  r = await post({ text: "x".repeat(9000) });
  ck("oversized text is truncated to 4000 before the model sees it", r.sent.text.length, 4000);
  r = await post({ text: "hi", contentType: "nonsense", surface: "nonsense" });
  // The fallback is now "unknown", not "post". "post" was itself retired, so
  // the old default would have written a value outside VALID_CONTENT_TYPES —
  // and more importantly a mislabelled row was indistinguishable from a real
  // one. "unknown" is an alarm, not a category.
  ck("an unrecognised content_type lands as 'unknown', not a real category", r.sent.content_type, "unknown");
  ck("...and it is a value the contract actually allows",
     /VALID_CONTENT_TYPES = \[[^\]]*"unknown"/.test(require("fs").readFileSync(require("path").join(__dirname, "..", "api/moderate.js"), "utf8")), true);
  ck("an unknown surface falls back to 'public_feed'", r.sent.surface, "public_feed");
  r = await post(JSON.stringify({ text: "a string body still parses" }));
  ck("a raw string body is parsed", r.status, 200);

  anthropicOk = false;
  r = await post({ text: "hi" });
  ck("an upstream classifier failure FAILS OPEN, deliberately", r.payload, { decision: "allow", primary_reason_code: "CLEAN" });
  ck("...with a 200, so posting is not blocked by a moderation outage", r.status, 200);
  ck("...and the failure is written to error_log",
     r.calls.some((c) => c.url.includes("/rest/v1/error_log")), true);
  anthropicOk = true;

  {
    const res = mkRes();
    await handler({ method: "GET", headers: {} }, res);
    ck("GET is refused", res.statusCode, 405);
    const res2 = mkRes();
    await handler({ method: "OPTIONS", headers: {} }, res2);
    ck("OPTIONS preflight is a 204", res2.statusCode, 204);
  }

  console.log("\n-- the model is never handed the server-only signals --");
  r = await post({ text: "hi" }, { auth: "Bearer lowtrust" });
  ck("trust_score is not shown to the classifier", "trust_score" in r.sent.author, false);
  ck("is_admin is not shown to the classifier", "is_admin" in r.sent.author, false);
  ck("the author object is exactly the documented contract",
     Object.keys(r.sent.author).sort(), ["is_minor", "role", "verified"]);

  console.log("\n-- this suite runs the shipping handler --");
  ck("handler came out of api/moderate.js", typeof handler, "function");
  ck("the minor-safety rule is still in the shipped prompt", /# The minor-safety rule/.test(SRC), true);
  ck("...including the adult-to-minor DM floor",
     /An adult-to-minor direct message on any surface other than "parent_linked_thread" is at minimum "review"/.test(SRC), true);
  ck("no reimplementation lives in this file",
     /^(async )?function handler\(req, res\)/m.test(fs.readFileSync(__filename, "utf8")), false);

  
// ---- the moderation record captures WHO content was aimed at -------------
// NULL on every row today: the only caller passing a recipient is the
// unreachable DM send, and Scout deliberately omits it. Asserted anyway,
// because the ABSENCE of this field is why 237 direct_message rows are
// permanently unattributable — Scout text and user-to-user DMs shared a
// content_type, and a null recipient would have told them apart for free.
// That was discovered after the rows existed. This captures it from row one
// if a recipient-bearing type ever returns.
const MODSRC = require("fs").readFileSync(require("path").join(__dirname, "..", "api/moderate.js"), "utf8");
ck("logModerationItem writes recipient_id", /recipient_id: recipientId \|\| null/.test(MODSRC), true);
ck("...and the caller passes it", /logModerationItem\([^)]*result, recipientId\)/.test(MODSRC), true);

// THE ID IS VALIDATED BEFORE IT REACHES A UUID COLUMN.
// A malformed value would fail the WHOLE insert, losing the entire moderation
// record rather than one field on it. Losing the row is far worse.
ck("a non-uuid recipient never reaches the write",
   /if \(typeof body\.recipientId === "string" && UUID_RE\.test\(body\.recipientId\)\) recipientId = body\.recipientId;/.test(MODSRC), true);
ck("...and the raw body value is not passed to the logger",
   /logModerationItem\([^)]*body\.recipientId\)/.test(MODSRC), false);

console.log(`\n${p}/${p + f} passed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.error("FAIL  suite threw:", e); process.exit(1); });
