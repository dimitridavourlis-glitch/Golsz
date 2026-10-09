// api/send-push.js must send only what the DATABASE says, never what the
// payload says.
//
// The x-webhook-secret guarding this endpoint was committed to a public
// repository (migration 126's header records it). Until the owner rotates it,
// anyone can POST here. The endpoint used to take recipient_id and body
// straight from the payload, so a forged request put any text on the lock
// screen of any user. Now the payload only names a row; the row is read back
// with the service key, and nothing is sent unless it exists and is fresh.
//
// The real handler is loaded with fetch and web-push stubbed.

const path = require("path");
const REPO = path.join(__dirname, "..");

process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "service-key";
process.env.SUPABASE_WEBHOOK_SECRET = "test-secret";
process.env.VAPID_PUBLIC_KEY = "pub";
process.env.VAPID_PRIVATE_KEY = "priv";
process.env.VAPID_SUBJECT = "mailto:test@example.com";

const sent = [];
const webpushPath = require.resolve("web-push", { paths: [REPO] });
require.cache[webpushPath] = {
  id: webpushPath, filename: webpushPath, loaded: true,
  exports: {
    setVapidDetails() {},
    async sendNotification(sub, payload) { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); },
  },
};

const handler = require(REPO + "/api/send-push.js").default;

let p = 0, f = 0;
const ck = (l, a, e) => {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { p++; console.log("PASS  " + l); }
  else { f++; console.log(`FAIL  ${l}\n   exp ${E}\n   got ${A}`); }
};

const SENDER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECIPIENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VICTIM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MSG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let messages = {};   // id -> row
let follows = [];    // rows
const subs = {
  [RECIPIENT]: [{ id: "s1", endpoint: "https://push.example/recipient", p256dh: "k", auth: "a" }],
  [VICTIM]: [{ id: "s2", endpoint: "https://push.example/victim", p256dh: "k", auth: "a" }],
};

global.fetch = async (url) => {
  const u = decodeURIComponent(String(url));
  const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });
  let m;
  if ((m = /\/rest\/v1\/messages\?id=eq\.([^&]+)/.exec(u))) return ok(messages[m[1]] ? [messages[m[1]]] : []);
  if ((m = /\/rest\/v1\/follows\?follower_id=eq\.([^&]+)&followed_id=eq\.([^&]+)/.exec(u))) {
    return ok(follows.filter((r) => r.follower_id === m[1] && r.followed_id === m[2]));
  }
  if (/\/rest\/v1\/public_profile_names/.test(u)) return ok([{ full_name: "Real Sender" }]);
  if ((m = /\/rest\/v1\/push_subscriptions\?user_id=eq\.([^&]+)/.exec(u))) return ok(subs[m[1]] || []);
  if (/\/rest\/v1\/error_log/.test(u)) return ok([]);
  throw new Error("unexpected fetch " + u);
};

function call(body, secret = "test-secret") {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(j) { resolve({ status: this.statusCode, body: j }); return this; },
    };
    handler({ method: "POST", headers: { "x-webhook-secret": secret }, body }, res);
  });
}

(async () => {
  const now = new Date().toISOString();

  console.log("\n-- the secret still gates the endpoint --");
  let r = await call({ table: "messages", record: { id: MSG } }, "wrong");
  ck("wrong secret is refused", r.status, 401);

  console.log("\n-- a forged message is not sent --");
  sent.length = 0;
  r = await call({ table: "messages", record: { id: MSG, sender_id: SENDER, recipient_id: VICTIM, body: "Your account is locked, log in at evil.example" } });
  ck("no row with that id: skipped", r.body.reason, "no_such_row");
  ck("...and nothing reached any device", sent.length, 0);

  r = await call({ table: "messages", record: { sender_id: SENDER, recipient_id: VICTIM, body: "no id at all" } });
  ck("a payload without a row id is skipped", r.body.reason, "invalid_id");
  ck("...and still nothing was sent", sent.length, 0);

  console.log("\n-- a real row is sent, from the ROW, not the payload --");
  messages[MSG] = { sender_id: SENDER, recipient_id: RECIPIENT, body: "See you at training", created_at: now };
  r = await call({ table: "messages", record: { id: MSG, sender_id: SENDER, recipient_id: VICTIM, body: "forged text" } });
  ck("one notification sent", sent.length, 1);
  ck("...to the row's recipient, not the payload's", sent[0] && sent[0].endpoint, "https://push.example/recipient");
  ck("...with the row's text, not the payload's", sent[0] && sent[0].payload.body, "Real Sender: See you at training");

  console.log("\n-- a real but old row is not replayed --");
  sent.length = 0;
  messages[MSG].created_at = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  r = await call({ table: "messages", record: { id: MSG, sender_id: SENDER, recipient_id: RECIPIENT, body: "See you at training" } });
  ck("an hour-old message is skipped", r.body.reason, "no_such_row");
  ck("...and nothing was sent", sent.length, 0);

  console.log("\n-- follows: same rule --");
  r = await call({ table: "follows", record: { follower_id: SENDER, followed_id: VICTIM } });
  ck("a follow that does not exist is skipped", r.body.reason, "no_such_row");
  ck("...and nothing was sent", sent.length, 0);
  follows.push({ follower_id: SENDER, followed_id: RECIPIENT, created_at: now });
  r = await call({ table: "follows", record: { follower_id: SENDER, followed_id: RECIPIENT } });
  ck("a real, fresh follow is sent", sent.length, 1);

  console.log("\n-- failures do not leak internals --");
  const src = require("fs").readFileSync(REPO + "/api/send-push.js", "utf8");
  ck("the 500 response carries no detail", /status\(500\)\.json\(\{[^}]*detail/.test(src), false);

  console.log(`\n${p}/${p + f} passed`);
  if (f) process.exit(1);
})();
